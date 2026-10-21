import { randomUUID } from "node:crypto";
import { getStaffRole } from "@/lib/allowlist";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { repairTargetsByCity } from "@/lib/repairTargets";

// Enqueue enrichment-repair jobs — re-enrich florists ALREADY stored for a
// city, with no Apify scrape (ingest-worker/src/workflow.ts::runRepair).
//
// Its own route rather than a flag on POST /api/ingest, because the two asks
// have nothing in common at the edges: a repair takes no radius, no limit, no
// keywords and no city list. "All" resolves the city list SERVER-side from the
// florists that actually need repairing, so nobody pastes 60 lines (and nobody
// hits the batch form's 50-city cap).
//
// GET  -> what a repair WOULD do: { totalFlorists, cities: [...] }
// POST -> enqueue. { scope: "all" } or { country, city }.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Ops/admin only — same gate as POST /api/ingest. Returns the email on
 * success so the caller can attribute, or a Response to return as-is. */
async function requireOps(): Promise<{ email: string } | Response> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return jsonError("Not signed in.", 401);
  const role = await getStaffRole(user.email);
  if (!role || !["ops", "admin"].includes(role)) {
    return jsonError("Your role doesn't allow this.", 403);
  }
  return { email: user.email };
}

export async function GET(): Promise<Response> {
  const gate = await requireOps();
  if (gate instanceof Response) return gate;

  try {
    const admin = createServiceClient();
    const cities = await repairTargetsByCity(admin);
    return json({
      totalFlorists: cities.reduce((sum, c) => sum + c.florists, 0),
      cities,
    });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to count repair targets.", 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requireOps();
  if (gate instanceof Response) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  const { scope, country, city } = (body ?? {}) as Record<string, unknown>;

  const admin = createServiceClient();
  const supabase = await createServerClient();

  // Resolve the city list. "all" asks the data, so a city with nothing to
  // repair is never enqueued — an empty job is a minute of cron and a
  // confusing zero row on /jobs.
  let targets: { country: string; city: string; florists: number }[];
  try {
    const byCity = await repairTargetsByCity(admin);
    if (scope === "all") {
      targets = byCity;
    } else {
      if (typeof country !== "string" || typeof city !== "string" || !country.trim() || !city.trim()) {
        return jsonError("Pass either { scope: 'all' } or { country, city }.", 400);
      }
      const match = byCity.find(
        (c) =>
          c.country.toLowerCase() === country.trim().toLowerCase() &&
          c.city.toLowerCase() === city.trim().toLowerCase()
      );
      if (!match) {
        return jsonError(
          `Nothing to repair in ${city}, ${country} — no florist there has a website, a missing email and a failed enrichment.`,
          409
        );
      }
      targets = [match];
    }
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Failed to resolve repair targets.", 500);
  }

  if (targets.length === 0) {
    return jsonError("Nothing to repair — every florist with a website already has an email.", 409);
  }

  const enqueued: { country: string; city: string; jobId: string; florists: number }[] = [];
  const skipped: { country: string; city: string; reason: string }[] = [];

  for (const t of targets) {
    // A city already queued or running is skipped, never fails the batch —
    // the same guard POST /api/ingest applies, and for the same reason: two
    // concurrent runs over one city would enrich every florist twice.
    const { data: pending, error: pendingError } = await supabase
      .from("ingest_jobs")
      .select("id")
      .eq("country", t.country)
      .eq("city", t.city)
      .in("status", ["queued", "running"])
      .limit(1);
    if (pendingError) {
      skipped.push({ country: t.country, city: t.city, reason: `check failed: ${pendingError.message}` });
      continue;
    }
    if (pending && pending.length > 0) {
      skipped.push({ country: t.country, city: t.city, reason: "already queued or running" });
      continue;
    }

    const jobId = randomUUID();
    const { error } = await admin.from("ingest_jobs").insert({
      id: jobId,
      country: t.country,
      city: t.city,
      // Persisted for the row's shape only — repair mode reads neither.
      radius_km: null,
      limit_per_keyword: null,
      keywords: null,
      language: null,
      reset_existing: false,
      mode: "repair",
      status: "queued",
    });
    if (error) {
      skipped.push({ country: t.country, city: t.city, reason: `enqueue failed: ${error.message}` });
      continue;
    }
    enqueued.push({ country: t.country, city: t.city, jobId, florists: t.florists });
  }

  if (enqueued.length === 0) {
    // Report the REAL reasons. The batch route used to collapse every skip
    // into "already running", which sent someone hunting for a running job
    // when the actual cause was a failing insert.
    const reasons = [...new Set(skipped.map((s) => s.reason))].join("; ");
    return jsonError(`No repair jobs were enqueued. ${reasons || "No cities matched."}`, 409);
  }

  return json({
    enqueued,
    skipped,
    totalFlorists: enqueued.reduce((sum, c) => sum + c.florists, 0),
  });
}
