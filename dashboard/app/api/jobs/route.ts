import { isAllowed } from "@/lib/allowlist";
import { createServerClient } from "@/lib/supabase";
import type { IngestJob } from "@/lib/types";

// Reads via the session-scoped Supabase client below (never a service-role
// key) — no OS process spawned here, but keep it on the Node runtime and
// dynamic for consistency with the other auth-gated API routes and so the
// session cookie is always re-checked.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RECENT_JOBS_LIMIT = 20;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(request: Request): Promise<Response> {
  // AUTH GATE — same pattern as app/api/ingest/route.ts.
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return jsonError("Not signed in.", 401);
  }
  if (!(await isAllowed(user.email))) {
    return jsonError("This account is not authorized to view ingest jobs.", 403);
  }

  // Optional ?limit= for the /jobs history page (defaults to the drawer's
  // RECENT_JOBS_LIMIT). Clamped to [1, 100] so a bad/huge value can't force
  // an unbounded scan.
  // NB: only take the explicit branch when the param is actually present.
  // `Number(null)` is 0 (not NaN), so parsing an absent param would otherwise
  // clamp to limit=1 and silently truncate the drawer's paramless fetch.
  const url = new URL(request.url);
  const rawParam = url.searchParams.get("limit");
  const rawLimit = rawParam == null || rawParam === "" ? NaN : Number(rawParam);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(100, Math.max(1, Math.trunc(rawLimit)))
    : RECENT_JOBS_LIMIT;

  // RLS-scoped read only — `ingest_jobs` has a select policy for allow-listed
  // authenticated users and no insert/update policy (only the service-role
  // ingest CLI writes it). See supabase/schema.sql.
  const { data, error } = await supabase
    .from("ingest_jobs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) {
    return jsonError(`Failed to load ingest jobs: ${error.message}`, 500);
  }

  return Response.json({ jobs: (data ?? []) as IngestJob[] });
}
