import { cache } from "react";
import { createServerClient } from "./supabase";
import { resolveActingFlorist } from "./floristActing";
import { createServiceClient } from "./supabaseAdmin";
import { DEFAULT_LOCALE, type Locale } from "./i18n";
import { resolveFloristSendLocale } from "./floristLocale";
import { resolveViewAs } from "./viewAs";

export const currentFlorist = cache(async (): Promise<{ floristId: string; email: string; role: "owner" | "member" } | null> => {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // WHICH SHOP, when the session cannot say on its own.
  //
  // A florist signs in by email, and `florist_users` keys one auth user to one
  // shop. Where two shops share an inbox — 686 shops behind real chains on this
  // project — that mapping names the wrong one, and where a shop's address has
  // changed it names none at all. The magic link always knew which shop it was
  // for; lib/floristActing.ts is that answer carried on a signed, user-bound
  // cookie, and it wins when present.
  //
  // Role is `member`, not `owner`, deliberately: the link proves "you can work
  // this shop's orders", not "you can invite people into it" — the one thing
  // owner gates (app/api/florist/invite). A real owner still resolves through
  // florist_users below and keeps their rights.
  const acting = await resolveActingFlorist(user.id);
  if (acting) return { floristId: acting, email: user.email ?? "", role: "member" };

  const { data } = await supabase.from("florist_users").select("florist_id, role").eq("user_id", user.id).maybeSingle();
  if (!data) return null;
  return { floristId: data.florist_id, email: user.email ?? "", role: data.role as "owner" | "member" };
});

/** Resolves the signed-in florist's locale for server-rendered copy. Cached
 * per-request (same as currentFlorist) so multiple call sites — the layout
 * plus any Server Component further down the tree — share one extra query
 * instead of each re-fetching. Reads `florists.locale` via the service-role
 * client because that table's RLS is staff-only (supabase/schema.sql:84);
 * a signed-in florist can't read their own row through the anon+JWT client. */
export const currentFloristLocale = cache(async (): Promise<Locale> => {
  // In a staff "view as florist" session, resolve the VIEWED florist's locale so
  // server-rendered copy matches what that florist actually sees. Otherwise the
  // signed-in florist's own locale. (resolveViewAs re-verifies the staff session.)
  const va = await resolveViewAs();
  const floristId = va ? va.floristId : (await currentFlorist())?.floristId ?? null;
  if (!floristId) return DEFAULT_LOCALE;
  const admin = createServiceClient();
  const { data } = await admin.from("florists").select("locale, address").eq("id", floristId).maybeSingle();
  return resolveFloristSendLocale({ locale: data?.locale ?? null, address: data?.address ?? null });
});
