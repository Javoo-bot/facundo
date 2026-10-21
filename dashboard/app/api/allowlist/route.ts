import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { STAFF_ROLES, wouldRemoveLastAdmin, type StaffRole } from "@/lib/staffRoles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function parseEmail(body: unknown): { ok: true; email: string } | { ok: false; message: string } {
  const email = (body as { email?: unknown })?.email;
  if (typeof email !== "string" || email.trim().length === 0) {
    return { ok: false, message: "email must be a non-empty string." };
  }
  const trimmed = email.trim();
  if (!EMAIL_RE.test(trimmed)) {
    return { ok: false, message: "email must be a valid email address." };
  }
  return { ok: true, email: trimmed.toLowerCase() };
}

function parseRole(body: unknown): { ok: true; role: StaffRole } | { ok: false; message: string } {
  const role = (body as { role?: unknown })?.role;
  if (typeof role !== "string" || !STAFF_ROLES.includes(role as StaffRole)) {
    return { ok: false, message: `role must be one of: ${STAFF_ROLES.join(", ")}.` };
  }
  return { ok: true, role: role as StaffRole };
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const email = parseEmail(rawBody);
  if (!email.ok) return jsonError(email.message, 400);
  const role = parseRole(rawBody);
  if (!role.ok) return jsonError(role.message, 400);

  // Service-role write (allowed_emails has no RLS policy at all — only the
  // service role may read/write it). on-conflict-do-update: re-adding an
  // already-allowed email updates its role rather than erroring.
  const admin = createServiceClient();
  const { error } = await admin
    .from("allowed_emails")
    .upsert({ email: email.email, role: role.role }, { onConflict: "email" });
  if (error) return jsonError(`Failed to add email: ${error.message}`, 500);

  return Response.json({ ok: true });
}

export async function PATCH(request: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const email = parseEmail(rawBody);
  if (!email.ok) return jsonError(email.message, 400);
  const role = parseRole(rawBody);
  if (!role.ok) return jsonError(role.message, 400);

  const admin = createServiceClient();
  const { data: rows, error: readError } = await admin.from("allowed_emails").select("email, role");
  if (readError) return jsonError(`Failed to read allow-list: ${readError.message}`, 500);
  if (wouldRemoveLastAdmin(rows ?? [], email.email, role.role)) {
    return jsonError("Can't demote the last remaining admin.", 400);
  }

  const { error } = await admin.from("allowed_emails").update({ role: role.role }).eq("email", email.email);
  if (error) return jsonError(`Failed to update role: ${error.message}`, 500);

  return Response.json({ ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const parsed = parseEmail(rawBody);
  if (!parsed.ok) return jsonError(parsed.message, 400);

  // Server-enforced guard — never let the caller remove their own access,
  // regardless of what the client UI does (a disabled button is not a
  // security boundary). Checked BEFORE touching the DB.
  if (parsed.email === gate.email.toLowerCase()) {
    return jsonError("You can't remove your own access.", 400);
  }

  const admin = createServiceClient();
  const { data: rows, error: readError } = await admin.from("allowed_emails").select("email, role");
  if (readError) return jsonError(`Failed to read allow-list: ${readError.message}`, 500);
  if (wouldRemoveLastAdmin(rows ?? [], parsed.email, null)) {
    return jsonError("Can't remove the last remaining admin.", 400);
  }

  const { error } = await admin.from("allowed_emails").delete().eq("email", parsed.email);
  if (error) return jsonError(`Failed to remove email: ${error.message}`, 500);

  return Response.json({ ok: true });
}
