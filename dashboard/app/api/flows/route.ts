import { requireRole } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { FLOWS, editableTimingKeys, withCustomSteps, MESSAGE_TOGGLE_COLUMN } from "@/lib/flows/catalog";
import { SEQUENCES, isSequenceId } from "@/lib/sequences/definitions";
import { flattenKeys, LOCALES, t } from "@/lib/i18n";
import { isCopy, sourceOf, nextCopyKey, parseCustomStepRows, canMoveCustomStep, DEFAULT_COPY_DAYS } from "@/lib/flows/customSteps";
import {
  isValidWaitDays,
  parseTimingRows,
  parseEnabledRows,
  timingKey,
  MAX_WAIT_DAYS,
  type StepConfigRow,
} from "@/lib/flows/timing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The funnel editor's own state: what the three funnels look like, what wait
// each step is actually running on, and the two order-loop numbers that belong
// to a funnel rather than to a settings page.
//
//   GET                     the flows, the current waits, the timing settings
//   POST {action:"wait"}    set (or clear) one step's wait
//   POST {action:"timing"}  set the response-window ladder + the cut-off offset
//   POST {action:"enabled"} switch one step on or off
//   POST {action:"duplicate"}    add a copy of one message, below it
//   POST {action:"deleteCustom"} remove a copy
//   POST {action:"moveCustom"}   drag a copy to a new position
//   POST {action:"messageToggle"} switch an event-driven message on or off
//
// Copy (subject + body) is NOT here. It goes through /api/messages/drafts and
// /api/messages/preview exactly as the message editor's does, so an edit made
// on this page follows the same draft → publish discipline and cannot produce
// a second, divergent way for words to reach a florist.

/** The response-window ladder, in the order the page shows it. Keys are
 *  app_settings columns; the bounds match app/api/settings/route.ts, which is
 *  the other writer of these columns. */
const WINDOW_KEYS = [
  "offer_window_rush_min",
  "offer_window_sameday_min",
  "offer_window_standard_min",
  "offer_window_far_min",
  "offer_window_nodate_min",
] as const;

const WINDOW_DEFAULTS: Record<(typeof WINDOW_KEYS)[number], number> = {
  offer_window_rush_min: 15,
  offer_window_sameday_min: 30,
  offer_window_standard_min: 60,
  offer_window_far_min: 120,
  offer_window_nodate_min: 60,
};

/** Enough duplicates to be useful, few enough that a stuck button cannot
 *  turn a three-touch funnel into a mailing list. */
const MAX_COPIES_PER_FUNNEL = 10;

/** May this step be retimed or switched off from /flows? True for a step some
 *  funnel shows, and for a DUPLICATE of one — a copy inherits its source's
 *  editability rather than needing its own entry in a static list. */
function isEditableStepKey(sequenceId: string, stepKey: string): boolean {
  const source = sourceOf(stepKey);
  return editableTimingKeys().some((k) => k.sequenceId === sequenceId && k.stepKey === source);
}

function bad(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function GET(): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  const admin = createServiceClient();
  const [{ data: rows }, { data: s }, { data: customRows }] = await Promise.all([
    admin.from("sequence_step_timing").select("sequence_id,step_key,days,enabled"),
    admin
      .from("app_settings")
      // Literal, not a template built from WINDOW_KEYS — Supabase parses this
      // string at the TYPE level, and a template collapses the result to an
      // untyped row. Same reason lib/sequences/tick.ts spells its select out.
      .select(
        "offer_window_rush_min, offer_window_sameday_min, offer_window_standard_min, offer_window_far_min, offer_window_nodate_min, cx_reserve_hours, sequence_enabled, test_email, email_offer_enabled, offer_short_variant_enabled, sms_offer_enabled, email_accept_confirm_enabled, sms_accept_confirm_enabled"
      )
      .eq("id", 1)
      .maybeSingle(),
    admin
      .from("sequence_custom_steps")
      .select("sequence_id,step_key,source_step_key,after_step_key"),
  ]);

  const settings = (s ?? {}) as Record<string, unknown>;
  const windows = Object.fromEntries(
    WINDOW_KEYS.map((k) => [k, Number(settings[k] ?? WINDOW_DEFAULTS[k])])
  ) as Record<(typeof WINDOW_KEYS)[number], number>;

  // The funnels as they actually run, duplicates included and in send order.
  // Done here rather than in the client so the page, the API and the tick all
  // read one arrangement of the steps.
  const custom = parseCustomStepRows(customRows as Record<string, unknown>[] | null);

  return Response.json({
    flows: FLOWS.map((f) => withCustomSteps(f, custom)),
    customSteps: custom,
    timing: parseTimingRows(rows as StepConfigRow[] | null),
    // Only the steps that are switched OFF. Absent = on, so the list never
    // has to carry a copy of the default.
    stepEnabled: parseEnabledRows(rows as StepConfigRow[] | null),
    // The event-driven messages' switches, by message id. These are
    // app_settings columns, not funnel steps — see MESSAGE_TOGGLE_COLUMN.
    messageEnabled: Object.fromEntries(
      Object.entries(MESSAGE_TOGGLE_COLUMN).map(([id, col]) => [id, settings[col] !== false])
    ),
    windows,
    cxReserveHours: Number(settings.cx_reserve_hours ?? 2),
    // The engine's master switch. A page full of editable waits that nothing
    // is acting on needs to say so, the way /sequences already does.
    sequenceEnabled: Boolean(settings.sequence_enabled),
    // Where a test send lands. Shown on the button, so nobody has to guess.
    testEmail: typeof settings.test_email === "string" ? settings.test_email : null,
  });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Invalid JSON body.");
  }
  const { action } = (body ?? {}) as { action?: unknown };
  const admin = createServiceClient();

  if (action === "wait") {
    const { sequenceId, stepKey, days } = body as { sequenceId?: unknown; stepKey?: unknown; days?: unknown };
    if (typeof sequenceId !== "string" || typeof stepKey !== "string") {
      return bad("sequenceId and stepKey are required.");
    }
    // Only a step some funnel actually shows. Without this the page could
    // write a wait for a step no engine reads, which looks like a saved change
    // and behaves like nothing at all.
    if (!isEditableStepKey(sequenceId, stepKey)) {
      return bad(`Not an editable funnel step: ${sequenceId}/${stepKey}`);
    }

    // null means "go back to the built-in wait" — a DELETE, not a stored copy
    // of the default. A step with no row is a step whose code default is
    // visibly the truth.
    if (days === null) {
      const { error } = await admin
        .from("sequence_step_timing")
        .delete()
        .eq("sequence_id", sequenceId)
        .eq("step_key", stepKey);
      if (error) return bad(`Could not reset the wait: ${error.message}`, 500);
      return Response.json({ ok: true, cleared: true });
    }

    if (!isValidWaitDays(days)) {
      return bad(`The wait must be between 0 and ${MAX_WAIT_DAYS} days.`);
    }

    const { error } = await admin.from("sequence_step_timing").upsert(
      {
        sequence_id: sequenceId,
        step_key: stepKey,
        days,
        updated_at: new Date().toISOString(),
        updated_by: gate.email,
      },
      { onConflict: "sequence_id,step_key" }
    );
    if (error) return bad(`Could not save the wait: ${error.message}`, 500);
    return Response.json({ ok: true, key: timingKey(sequenceId, stepKey), days });
  }

  if (action === "enabled") {
    const { sequenceId, stepKey, enabled } = body as {
      sequenceId?: unknown; stepKey?: unknown; enabled?: unknown;
    };
    if (typeof sequenceId !== "string" || typeof stepKey !== "string") {
      return bad("sequenceId and stepKey are required.");
    }
    if (typeof enabled !== "boolean") return bad("enabled must be true or false.");
    if (!isEditableStepKey(sequenceId, stepKey)) {
      return bad(`Not a step that can be switched off: ${sequenceId}/${stepKey}`);
    }

    if (enabled) {
      // Back on. If the row was only ever there to hold the OFF flag (no wait
      // override), delete it — a step with nothing overridden should have no
      // row, so the built-in stays visibly the truth. If a custom wait is on
      // the row, keep the row and just flip the flag.
      const { data: existing } = await admin
        .from("sequence_step_timing")
        .select("days")
        .eq("sequence_id", sequenceId)
        .eq("step_key", stepKey)
        .maybeSingle();

      const hasWait = existing != null && existing.days != null;
      const { error } = hasWait
        ? await admin
            .from("sequence_step_timing")
            .update({ enabled: true, updated_at: new Date().toISOString(), updated_by: gate.email })
            .eq("sequence_id", sequenceId)
            .eq("step_key", stepKey)
        : await admin
            .from("sequence_step_timing")
            .delete()
            .eq("sequence_id", sequenceId)
            .eq("step_key", stepKey);
      if (error) return bad(`Could not switch it back on: ${error.message}`, 500);
      return Response.json({ ok: true, enabled: true });
    }

    // Off. Upsert, leaving `days` alone — null means "still the built-in
    // wait", which is exactly right for a step switched off without retiming.
    const { error } = await admin.from("sequence_step_timing").upsert(
      {
        sequence_id: sequenceId,
        step_key: stepKey,
        enabled: false,
        updated_at: new Date().toISOString(),
        updated_by: gate.email,
      },
      { onConflict: "sequence_id,step_key", ignoreDuplicates: false }
    );
    if (error) return bad(`Could not switch it off: ${error.message}`, 500);
    return Response.json({ ok: true, enabled: false });
  }


  // ---- duplicate ----
  //
  // Adds a real touch to the funnel, below the one it copies, with that
  // message's words copied in. See lib/flows/customSteps.ts for why a copy
  // borrows a shape rather than inventing one.
  if (action === "duplicate") {
    const { sequenceId, stepKey } = body as { sequenceId?: unknown; stepKey?: unknown };
    if (typeof sequenceId !== "string" || typeof stepKey !== "string") {
      return bad("sequenceId and stepKey are required.");
    }
    if (!isSequenceId(sequenceId)) return bad(`Unknown funnel: ${sequenceId}`);
    // Only a step some funnel actually shows, and never a copy of a copy —
    // one level keeps the list readable and the source unambiguous.
    if (isCopy(stepKey)) return bad("A duplicate cannot itself be duplicated.");
    if (!editableTimingKeys().some((k) => k.sequenceId === sequenceId && k.stepKey === stepKey)) {
      return bad(`Not a message that can be duplicated: ${sequenceId}/${stepKey}`);
    }

    const def = SEQUENCES[sequenceId];
    const source = def.steps.find((s) => s.key === stepKey);
    if (!source) return bad(`Unknown step: ${stepKey}`);
    const ns = source.ns ?? "recruit";

    const { data: existingRows } = await admin
      .from("sequence_custom_steps")
      .select("step_key")
      .eq("sequence_id", sequenceId);
    const existing = (existingRows ?? []).map((r) => r.step_key as string);
    if (existing.length >= MAX_COPIES_PER_FUNNEL) {
      return bad(`A funnel can hold ${MAX_COPIES_PER_FUNNEL} duplicates. Delete one first.`);
    }
    const copyKey = nextCopyKey(stepKey, existing);

    // The copy's words: whatever the original SAYS today, in every language,
    // written under the copy's own keys. Copied rather than referenced, so
    // editing the original afterwards leaves the duplicate alone — which is
    // what "duplicate" means everywhere else.
    const prefix = `email.${ns}.${stepKey}.`;
    const leaves = flattenKeys().filter((k) => k.startsWith(prefix));
    if (leaves.length === 0) return bad("That message has no copy to duplicate.");

    const { data: overrideRows } = await admin.from("message_overrides").select("locale,key,value");
    const live = new Map<string, string>();
    for (const r of (overrideRows ?? []) as { locale: string; key: string; value: string }[]) {
      live.set(`${r.locale}|${r.key}`, r.value);
    }

    const now = new Date().toISOString();
    const inserts: { locale: string; key: string; value: string; updated_at: string; updated_by: string }[] = [];
    for (const locale of LOCALES) {
      for (const leaf of leaves) {
        const value = live.get(`${locale}|${leaf}`) ?? t(locale, leaf);
        // `t` returns the key itself when a leaf is missing everywhere; writing
        // that as the copy's text would put a dotted path in a florist's inbox.
        if (!value || value === leaf) continue;
        inserts.push({
          locale,
          key: `email.${ns}.${copyKey}.${leaf.slice(prefix.length)}`,
          value,
          updated_at: now,
          updated_by: gate.email,
        });
      }
    }

    // The step row first: if the copy write fails after it, the duplicate
    // exists with no words and renders blank — visibly wrong and fixable. The
    // other order would leave orphan overrides that nothing reads.
    // Sit after the LAST copy of this message, not after the message itself.
    // Anchoring every copy to the source makes each new one insert directly
    // under it, so a second duplicate pushes the first one down and the list
    // reads newest-first — which looks like a bug the moment you make two.
    const { data: siblingRows } = await admin
      .from("sequence_custom_steps")
      .select("step_key,after_step_key")
      .eq("sequence_id", sequenceId);
    const chain = new Set(
      (siblingRows ?? [])
        .filter((r) => sourceOf(r.step_key as string) === stepKey)
        .map((r) => r.step_key as string)
    );
    // The tail of the chain: the copy nothing else sits after.
    const pointedAt = new Set(
      (siblingRows ?? []).map((r) => r.after_step_key as string).filter((k) => chain.has(k))
    );
    const tail = [...chain].find((k) => !pointedAt.has(k));

    const { error: stepErr } = await admin.from("sequence_custom_steps").insert({
      sequence_id: sequenceId,
      step_key: copyKey,
      source_step_key: stepKey,
      after_step_key: tail ?? stepKey,
      created_by: gate.email,
    });
    if (stepErr) return bad(`Could not duplicate: ${stepErr.message}`, 500);

    if (inserts.length > 0) {
      const { error: copyErr } = await admin
        .from("message_overrides")
        .upsert(inserts, { onConflict: "locale,key" });
      if (copyErr) return bad(`Duplicated, but its words could not be copied: ${copyErr.message}`, 500);
    }

    // Its wait. A row rather than a code default, because a duplicate has no
    // code default — DEFAULT_COPY_DAYS is what applyCustomSteps gives it, and
    // writing it here means the number the page shows is the number stored.
    const { error: waitErr } = await admin.from("sequence_step_timing").upsert(
      {
        sequence_id: sequenceId,
        step_key: copyKey,
        days: DEFAULT_COPY_DAYS,
        enabled: true,
        updated_at: now,
        updated_by: gate.email,
      },
      { onConflict: "sequence_id,step_key", ignoreDuplicates: false }
    );
    if (waitErr) return bad(`Duplicated, but its wait could not be set: ${waitErr.message}`, 500);

    return Response.json({ ok: true, stepKey: copyKey, copiedKeys: inserts.length });
  }

  // ---- delete a duplicate ----
  //
  // Only a duplicate. A built-in email cannot be deleted because the code
  // sends it; the tick in the list switches it off instead, which is the same
  // outcome and reversible.
  if (action === "deleteCustom") {
    const { sequenceId, stepKey } = body as { sequenceId?: unknown; stepKey?: unknown };
    if (typeof sequenceId !== "string" || typeof stepKey !== "string") {
      return bad("sequenceId and stepKey are required.");
    }
    if (!isCopy(stepKey)) return bad("Only a duplicate can be deleted.");
    if (!isSequenceId(sequenceId)) return bad(`Unknown funnel: ${sequenceId}`);

    const { data: row } = await admin
      .from("sequence_custom_steps")
      .select("source_step_key")
      .eq("sequence_id", sequenceId)
      .eq("step_key", stepKey)
      .maybeSingle();
    if (!row) return bad("That duplicate no longer exists.", 404);

    const def = SEQUENCES[sequenceId];
    const ns = def.steps.find((s) => s.key === row.source_step_key)?.ns ?? "recruit";
    const prefix = `email.${ns}.${stepKey}.`;

    // Its words go too. They belong to nothing else — a copy's keys are its
    // own — and leaving them behind would be silently re-adopted if the same
    // key were ever handed out again (which nextCopyKey avoids, but this is
    // the cheap second guard).
    await admin.from("message_overrides").delete().like("key", `${prefix}%`);
    await admin.from("message_override_drafts").delete().like("key", `${prefix}%`);
    await admin.from("sequence_step_timing").delete().eq("sequence_id", sequenceId).eq("step_key", stepKey);

    const { error } = await admin
      .from("sequence_custom_steps")
      .delete()
      .eq("sequence_id", sequenceId)
      .eq("step_key", stepKey);
    if (error) return bad(`Could not delete: ${error.message}`, 500);
    return Response.json({ ok: true, deleted: stepKey });
  }

  // ---- move a duplicate ----
  //
  // Only a duplicate moves: the built-in order is the funnel's shape, which is
  // code. `afterStepKey` is the step it should now sit under.
  if (action === "moveCustom") {
    const { sequenceId, stepKey, afterStepKey } = body as {
      sequenceId?: unknown; stepKey?: unknown; afterStepKey?: unknown;
    };
    if (typeof sequenceId !== "string" || typeof stepKey !== "string" || typeof afterStepKey !== "string") {
      return bad("sequenceId, stepKey and afterStepKey are required.");
    }
    if (!isSequenceId(sequenceId)) return bad(`Unknown funnel: ${sequenceId}`);

    const { data: allRows } = await admin
      .from("sequence_custom_steps")
      .select("sequence_id,step_key,source_step_key,after_step_key")
      .eq("sequence_id", sequenceId);
    const rows = parseCustomStepRows(allRows as Record<string, unknown>[] | null);
    if (!rows.some((r) => r.step_key === stepKey)) return bad("That duplicate no longer exists.", 404);

    // The target must be a step this funnel actually has — a built-in one, or
    // another duplicate.
    const known =
      SEQUENCES[sequenceId].steps.some((st) => st.key === afterStepKey) ||
      rows.some((r) => r.step_key === afterStepKey);
    if (!known) return bad(`Nothing to put it after: ${afterStepKey}`);

    // Refuses a cycle, which applyCustomSteps would resolve by placing neither
    // copy — silently dropping both out of the funnel.
    if (!canMoveCustomStep(rows, sequenceId, stepKey, afterStepKey)) {
      return bad("A copy cannot be moved there.");
    }

    const { error } = await admin
      .from("sequence_custom_steps")
      .update({ after_step_key: afterStepKey })
      .eq("sequence_id", sequenceId)
      .eq("step_key", stepKey);
    if (error) return bad(`Could not move it: ${error.message}`, 500);
    return Response.json({ ok: true, stepKey, afterStepKey });
  }

  if (action === "messageToggle") {
    const { messageId, enabled } = body as { messageId?: unknown; enabled?: unknown };
    if (typeof messageId !== "string") return bad("messageId is required.");
    if (typeof enabled !== "boolean") return bad("enabled must be true or false.");
    const column = MESSAGE_TOGGLE_COLUMN[messageId];
    // An allowlist, not a passthrough: this writes an app_settings column, and
    // the caller must not get to choose which one.
    if (!column) return bad(`That message has no switch: ${messageId}`);

    // A NARROW update, like the response windows above — never the full-form
    // overwrite /api/settings does.
    const { error } = await admin.from("app_settings").update({ [column]: enabled }).eq("id", 1);
    if (error) return bad(`Could not switch it: ${error.message}`, 500);
    return Response.json({ ok: true, messageId, enabled });
  }

  if (action === "timing") {
    const patch = body as Record<string, unknown>;
    const update: Record<string, number> = {};

    for (const key of WINDOW_KEYS) {
      if (!(key in patch)) continue;
      const n = Number(patch[key]);
      // The same rails app/api/settings/route.ts applies: under a minute is a
      // window nobody can answer, over a day and the wave engine is the wrong
      // tool for the job.
      if (!Number.isInteger(n) || n < 1 || n > 1440) {
        return bad("Each response window must be a whole number of minutes between 1 and 1440.");
      }
      update[key] = n;
    }

    if ("cx_reserve_hours" in patch) {
      const n = Number(patch.cx_reserve_hours);
      if (!Number.isInteger(n) || n < 0 || n > 72) {
        return bad("The cut-off offset must be a whole number of hours between 0 and 72.");
      }
      update.cx_reserve_hours = n;
    }

    if (Object.keys(update).length === 0) return bad("Nothing to change.");

    // A NARROW update, not the full-form overwrite app/api/settings/route.ts
    // does. Two pages now write these columns; if this one sent a whole row,
    // saving a response window here would quietly reset every unrelated
    // setting to whatever this page happened to know about.
    const { error } = await admin.from("app_settings").update(update).eq("id", 1);
    if (error) return bad(`Could not save: ${error.message}`, 500);
    return Response.json({ ok: true, ...update });
  }

  return bad(`Unknown action: ${String(action)}`);
}
