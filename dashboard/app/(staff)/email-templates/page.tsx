import EmailTemplatesClient, { type OverrideRow } from "@/components/email-templates/EmailTemplatesClient";
import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { flattenKeys, LOCALES, type Locale } from "@/lib/i18n";
import { en } from "@/lib/i18n/messages/en";
import { fr } from "@/lib/i18n/messages/fr";
import { es } from "@/lib/i18n/messages/es";
import { it } from "@/lib/i18n/messages/it";
import { de } from "@/lib/i18n/messages/de";
import { pt } from "@/lib/i18n/messages/pt";
import type { MessageTree } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// Every email string across all 5 locales — VIEW + EDIT, runtime DB overrides
// layered on the static TS catalog (dashboard/lib/i18n/messages/*.ts). Admin-
// gated the same way Settings is (this is what florists/customers actually
// receive) — same request-cached getSessionUser/getStaffAccess checks every
// (staff) page repeats (defense in depth against a session outliving an
// allow-list edit; see the (staff) layout's own comment).
export default async function EmailTemplatesPage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  if (!allowed) {
    const supabase = await createServerClient();
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "admin") return <Forbidden reason="Email templates is only available to Admins." />;

  // message_overrides has no RLS read policy for authenticated beyond the
  // allow-list check (see the migration) — the anon+JWT read would work too,
  // but the service client is already what every other admin-only page in
  // this codebase reads through, so it's used consistently here.
  const admin = createServiceClient();
  const { data } = await admin.from("message_overrides").select("locale,key,value,updated_at,updated_by").order("key");
  const overrides = (data ?? []) as OverrideRow[];

  const keys = flattenKeys();
  const catalogs: Record<Locale, MessageTree> = { en, fr, es, it, de, pt };

  return (
    <EmailTemplatesClient
      keys={keys}
      locales={LOCALES}
      catalogs={catalogs}
      overrides={overrides}
    />
  );
}
