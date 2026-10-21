import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { isAllowed } from "@/lib/allowlist";
import { currentFlorist } from "@/lib/floristAuth";
import { logLoginEvent, type LoginMethod } from "@/lib/loginEvents";

const METHODS: LoginMethod[] = ["password", "otp"];

/** Fired by the browser right after a successful email/password or OTP
 * sign-in (staff SignInScreen, florist login page). Determines surface and
 * identity itself from the now-set session cookie rather than trusting the
 * client's word for it — the client only tells us HOW they signed in. */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { method?: string } | null;
  const method = body?.method;
  if (!method || !METHODS.includes(method as LoginMethod)) {
    return new Response(JSON.stringify({ error: "invalid method" }), { status: 400 });
  }

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response(JSON.stringify({ ok: false }), { status: 200 });

  const admin = createServiceClient();
  const userAgent = request.headers.get("user-agent");

  if (user.email && (await isAllowed(user.email))) {
    await logLoginEvent(admin, { surface: "staff", method: method as LoginMethod, userEmail: user.email, userAgent });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  const florist = await currentFlorist();
  if (florist) {
    await logLoginEvent(admin, { surface: "florist", method: method as LoginMethod, floristId: florist.floristId, userAgent });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  return new Response(JSON.stringify({ ok: false }), { status: 200 });
}
