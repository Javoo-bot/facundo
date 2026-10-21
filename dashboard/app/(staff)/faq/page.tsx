import FaqEditorClient from "@/components/faq/FaqEditorClient";
import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { LOCALES, type Locale, type MessageTree } from "@/lib/i18n";
import type { OverrideRow } from "@/lib/useCopyOverrides";
import { en } from "@/lib/i18n/messages/en";
import { fr } from "@/lib/i18n/messages/fr";
import { es } from "@/lib/i18n/messages/es";
import { it } from "@/lib/i18n/messages/it";
import { de } from "@/lib/i18n/messages/de";
import { pt } from "@/lib/i18n/messages/pt";

export const dynamic = "force-dynamic";

// The florist Q&A, editable answer by answer. Same storage as
// /email-templates (message_overrides, layered on lib/i18n/messages/*.ts) —
// this page just presents it the way the page reads instead of as a flat list
// of ui.help.* keys, which is what an editor of long-form copy actually needs.
//
// It lives at /faq rather than /help because /help is the PUBLIC page (app/help)
// and the two would collide at the same URL. `faq` is registered in
// lib/hostRouting.ts::STAFF_SEGMENTS so it 404s on the florist host.
//
// Admin-gated exactly as /email-templates and /messages are — this decides what
// real florists read. The request-cached getSessionUser/getStaffAccess pair is
// repeated here as every (staff) page does (defence in depth against a session
// outliving an allow-list edit).
export default async function FaqEditorPage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  if (!allowed) {
    const supabase = await createServerClient();
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "admin") return <Forbidden reason="The florist Q&A editor is only available to Admins." />;

  // Only this page's own keys, not the whole override table: the Q&A editor has
  // no use for the ~450 other ui.* rows and there's no reason to ship them to
  // the browser.
  const admin = createServiceClient();
  const { data } = await admin
    .from("message_overrides")
    .select("locale,key,value,updated_at,updated_by")
    .like("key", "ui.help.%")
    .order("key");
  const overrides = (data ?? []) as OverrideRow[];

  const catalogs: Record<Locale, MessageTree> = { en, fr, es, it, de, pt };

  return <FaqEditorClient locales={LOCALES} catalogs={catalogs} overrides={overrides} />;
}
