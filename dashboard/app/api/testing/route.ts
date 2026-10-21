import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { assertTestShop, TEST_PLACE_PREFIX } from "@/lib/testing/guard";
import { scenarioById, isScenarioId, fastForwardMs } from "@/lib/testing/scenarios";
import { enrol, stop } from "@/lib/sequences/enrol";
import { recordEngagement } from "@/lib/sequences/engagement";
import { runSequences } from "@/lib/sequences/tick";
import { ingestInbound } from "@/lib/conversations";
import { isSequenceId } from "@/lib/sequences/definitions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The test-store harness.
//
// Admin-only, and every action that touches a florist goes through
// assertTestShop first — the check is on `is_test_shop` in the database, not on
// which button was pressed, so a wrong id in a request body cannot reach one of
// the 6,481 real shops.
//
// It fires REAL sends at the shop's address. That is the point: a harness that
// mocks the send tests the harness, not the funnel. The address is yours to
// choose at creation.

const DAY_MS = 24 * 60 * 60 * 1000;

function isoAgo(days: number | null): string | null {
  if (days === null) return null;
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const action = String(body.action ?? "");
  const admin = createServiceClient();

  // ---- create ----
  if (action === "create") {
    const scenarioId = body.scenario;
    if (!isScenarioId(scenarioId)) return jsonError("Unknown scenario.", 400);
    const s = scenarioById(scenarioId)!;

    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return jsonError("A real address you can read is required — the harness sends to it.", 400);
    }
    const cityId = typeof body.cityId === "string" && body.cityId ? body.cityId : null;
    if (!cityId) return jsonError("Pick a city — locale and offer matching both derive from it.", 400);
    const locale = typeof body.locale === "string" && body.locale ? body.locale : null;

    const { data: city, error: cityErr } = await admin
      .from("cities")
      .select("id, city, center_lat, center_lng")
      .eq("id", cityId)
      .maybeSingle();
    // Surface the real failure. A lookup that errors and a city that genuinely
    // doesn't exist are different problems, and collapsing them into "No such
    // city" sends you looking in the wrong place — which is exactly what a bad
    // column name in this select did the first time.
    if (cityErr) return jsonError(`Could not read the city: ${cityErr.message}`, 500);
    if (!city) return jsonError("No such city.", 400);

    const suffix = Math.floor(Date.now() / 1000).toString(36).toUpperCase();
    const { data: florist, error } = await admin
      .from("florists")
      .insert({
        place_id: `${TEST_PLACE_PREFIX}${s.id.toUpperCase()}_${suffix}`,
        name: `[TEST] ${s.label}`,
        email,
        city_id: cityId,
        locale,
        // The authority for every guard in this harness.
        is_test_shop: true,
        lifecycle_stage: s.joinedDaysAgo === null ? "contacted" : "onboarding",
        joined_at: isoAgo(s.joinedDaysAgo),
        join_token: crypto.randomUUID(),
        join_token_expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
        unsubscribe_token: crypto.randomUUID(),
        // The cold-offer eligibility check needs coordinates; the city centre
        // is close enough for a shop that only has to be plausibly nearby.
        ...(s.needsCoords ? { lat: city.center_lat, lng: city.center_lng } : {}),
        // A joined shop needs a tier + radius or the matcher's hard filter
        // rejects it and the "dormant partner" scenario silently can't be offered
        // anything.
        ...(s.joinedDaysAgo !== null ? { trust_tier: "2", delivery_radius_km: 15 } : {}),
      })
      .select("id")
      .single();
    if (error || !florist) return jsonError(`Could not create: ${error?.message}`, 500);

    const floristId = florist.id as string;

    // A declined assignment is what makes a shop count as "has been offered" —
    // without it the reactivation classifier correctly refuses to ask why they
    // never accepted, and the scenario tests nothing.
    if (s.seedDeclinedOffer || s.lastAcceptedDaysAgo !== null) {
      const { data: order } = await admin
        .from("orders")
        .select("id")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (order) {
        if (s.seedDeclinedOffer) {
          await admin.from("order_assignments").insert({
            order_id: order.id, florist_id: floristId, status: "declined", rank: 99,
            declined_at: isoAgo(s.joinedDaysAgo ?? 30),
          });
        }
        if (s.lastAcceptedDaysAgo !== null) {
          await admin.from("order_assignments").insert({
            order_id: order.id, florist_id: floristId, status: "delivered", rank: 98,
            accepted_at: isoAgo(s.lastAcceptedDaysAgo),
          });
        }
      }
    }

    if (s.enrolIn && isSequenceId(s.enrolIn)) {
      const r = await enrol(admin, { floristId, sequenceId: s.enrolIn });
      if (r.ok && s.engaged) {
        await recordEngagement(admin, floristId, new Date().toISOString());
      }
    }

    return Response.json({ ok: true, floristId });
  }

  // ---- everything below acts on an existing shop ----
  const floristId = String(body.floristId ?? "");
  const check = await assertTestShop(admin, floristId);
  if (!check.ok) return jsonError(check.reason, 403);

  switch (action) {
    case "enrol": {
      const sequenceId = String(body.sequenceId ?? "recruit_cold");
      if (!isSequenceId(sequenceId)) return jsonError("Unknown sequence.", 400);
      const r = await enrol(admin, { floristId, sequenceId });
      return Response.json({ ok: r.ok, reason: r.reason ?? null });
    }

    case "click": {
      // Goes through the same function the webhooks call, so this exercises the
      // real branch switch rather than a testing-only shortcut.
      const flipped = await recordEngagement(admin, floristId, new Date().toISOString());
      return Response.json({ ok: true, flipped });
    }

    case "fastForward": {
      // Shift the enrolment's anchors backwards rather than shortening the
      // intervals: the funnel you test must be the funnel you ship.
      const shift = fastForwardMs(Number(body.days ?? 0));
      if (shift === 0) return jsonError("Give it some days.", 400);
      const { data: rows } = await admin
        .from("sequence_enrolments")
        .select("id, created_at, last_touch_at, engaged_at")
        .eq("florist_id", floristId)
        .in("status", ["active", "paused"]);
      for (const r of rows ?? []) {
        const back = (v: string | null) => (v ? new Date(Date.parse(v) - shift).toISOString() : null);
        await admin
          .from("sequence_enrolments")
          .update({
            created_at: back(r.created_at as string),
            last_touch_at: back(r.last_touch_at as string | null),
            engaged_at: back(r.engaged_at as string | null),
            next_action_at: new Date(Date.now() - 60_000).toISOString(),
          })
          .eq("id", r.id);
      }
      return Response.json({ ok: true, shifted: (rows ?? []).length });
    }

    case "tick": {
      // The real tick, not a test double. It is global by nature — it will also
      // advance any other due run — which is honest: that is what the cron does.
      const result = await runSequences(50);
      return Response.json({ ok: true, result });
    }

    case "reply": {
      const text = String(body.text ?? "").trim();
      if (!text) return jsonError("Write something for the florist to say.", 400);
      const f = check.florist as { email?: string };
      const r = await ingestInbound({
        channel: "email",
        providerEventId: `testkit:${floristId}:${Date.now()}`,
        provider: "resend",
        fromAddress: String(f.email ?? ""),
        toAddress: null,
        subject: "Re: Facundo",
        bodyText: text,
        headers: null,
      });
      return Response.json({ ok: r.ok, result: r.action });
    }

    case "stopRuns": {
      const { data: rows } = await admin
        .from("sequence_enrolments")
        .select("id")
        .eq("florist_id", floristId)
        .in("status", ["active", "paused"]);
      for (const r of rows ?? []) await stop(admin, r.id as string, "staff");
      return Response.json({ ok: true, stopped: (rows ?? []).length });
    }

    case "reset": {
      // Back to the state it was created in, without deleting the shop — so a
      // scenario can be re-run without re-typing the address.
      await admin.from("sequence_enrolments").delete().eq("florist_id", floristId);
      const { data: convos } = await admin.from("conversations").select("id").eq("florist_id", floristId);
      for (const c of convos ?? []) {
        await admin.from("conversation_messages").delete().eq("conversation_id", c.id);
      }
      await admin.from("conversations").delete().eq("florist_id", floristId);
      await admin
        .from("florists")
        .update({ order_emails_opt_out: false, order_sms_opt_out: false })
        .eq("id", floristId);
      return Response.json({ ok: true });
    }

    case "delete": {
      await admin.from("sequence_enrolments").delete().eq("florist_id", floristId);
      const { data: convos } = await admin.from("conversations").select("id").eq("florist_id", floristId);
      for (const c of convos ?? []) {
        await admin.from("conversation_messages").delete().eq("conversation_id", c.id);
      }
      await admin.from("conversations").delete().eq("florist_id", floristId);
      await admin.from("order_assignments").delete().eq("florist_id", floristId);
      // communications keeps its rows: they are the audit of what this harness
      // actually sent, and deleting them would make a test run unreviewable
      // afterwards. They carry the florist id, which is about to disappear, so
      // they are detached rather than removed.
      await admin.from("communications").update({ florist_id: null }).eq("florist_id", floristId);
      await admin.from("florists").delete().eq("id", floristId);
      return Response.json({ ok: true });
    }

    default:
      return jsonError("Unknown action.", 400);
  }
}
