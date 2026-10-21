import { isAllowed } from "@/lib/allowlist";
import { createServiceClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Public self-registration endpoint. Intentionally has NO caller-session
// check — there is no session yet when someone is registering. The only
// gate is isAllowed(submittedEmail): only allow-listed emails can create an
// account, mirroring the same allow-list Google sign-in enforces.
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  const b = (body ?? {}) as { email?: unknown; password?: unknown };
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const password = typeof b.password === "string" ? b.password : "";

  if (!EMAIL_RE.test(email)) return jsonError("Enter a valid email address.", 400);
  if (password.length < 8) return jsonError("Password must be at least 8 characters.", 400);

  // GATE: only allow-listed emails may register. Checked on the SUBMITTED email
  // (this route is public — there is no caller session).
  if (!(await isAllowed(email))) {
    return jsonError("This email isn't authorized — ask an admin to add it in Settings.", 403);
  }

  const admin = createServiceClient();
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) {
    const msg = (error.message ?? "").toLowerCase();
    if (msg.includes("already") && (msg.includes("registered") || msg.includes("exists"))) {
      return jsonError("An account already exists — sign in instead.", 409);
    }
    return jsonError(`Registration failed: ${error.message}`, 500);
  }
  return Response.json({ ok: true });
}
