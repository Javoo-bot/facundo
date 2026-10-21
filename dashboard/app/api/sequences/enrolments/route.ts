import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { enrol, stop } from "@/lib/sequences/enrol";
import { isSequenceId } from "@/lib/sequences/definitions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Staff control over who is in an outreach funnel.
//
// POST   enrol florists (no day-0 send — that is /api/outreach/send's job, and
//        keeping them separate means "put them in the funnel" never
//        accidentally fires an email nobody reviewed).
// PATCH  stop a run.

const MAX_ITEMS = 200;

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { floristIds?: unknown; sequenceId?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const ids = body.floristIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ITEMS) {
    return jsonError(`floristIds must be an array of 1..${MAX_ITEMS} ids.`, 400);
  }
  if (!ids.every((i) => typeof i === "string" && i.length > 0)) {
    return jsonError("floristIds must all be strings.", 400);
  }
  const sequenceId = typeof body.sequenceId === "string" ? body.sequenceId : "recruit_cold";
  if (!isSequenceId(sequenceId)) return jsonError("Unknown sequenceId.", 400);

  const admin = createServiceClient();

  // Sequential, not Promise.all: the contact-level dedupe in enrol() reads the
  // enrolments this same loop is writing. Run in parallel and two listings
  // sharing one inbox would both see "nobody enrolled yet" and both get in —
  // which is the exact failure the dedupe exists to prevent.
  const results: { floristId: string; ok: boolean; reason?: string }[] = [];
  for (const floristId of ids as string[]) {
    const r = await enrol(admin, { floristId, sequenceId });
    results.push({ floristId, ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) });
  }

  return Response.json({
    enrolled: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => !r.ok).length,
    results,
  });
}

export async function PATCH(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { enrolmentId?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  const enrolmentId = body.enrolmentId;
  if (typeof enrolmentId !== "string" || !enrolmentId) return jsonError("enrolmentId is required.", 400);

  const admin = createServiceClient();
  // `staff` rather than a generic stop: the stop_reason is what /statistics
  // uses to tell "we ended it" apart from "they opted out".
  await stop(admin, enrolmentId, "staff");
  return Response.json({ ok: true });
}
