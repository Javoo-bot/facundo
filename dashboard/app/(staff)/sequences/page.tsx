import SignInScreen from "@/components/SignInScreen";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import SequencesClient, { type EnrolmentRow } from "@/components/sequences/SequencesClient";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 200;

// app/(staff)/layout.tsx gates on first load, but a soft navigation doesn't
// re-run a layout — so this re-checks inline, same as every other staff page.
export default async function SequencesPage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }

  // Read under RLS with the user's JWT (the allow-listed read policy on
  // sequence_enrolments), not the service role — nothing here needs to bypass it.
  const { data, error } = await supabase
    .from("sequence_enrolments")
    .select(
      "id, sequence_id, status, track, step_index, next_action_at, engaged_at, last_touch_at, touches_email, touches_sms, stop_reason, created_at, florists(name, email)"
    )
    .order("next_action_at", { ascending: true, nullsFirst: false })
    .limit(PAGE_SIZE);

  // The engine's master switch: without this the page would show frozen runs
  // with due dates in the past and no explanation for why nothing is moving.
  const { data: settings } = await supabase
    .from("app_settings")
    .select("sequence_enabled")
    .eq("id", 1)
    .maybeSingle();

  return (
    <SequencesClient
      initialRows={(data ?? []) as unknown as EnrolmentRow[]}
      error={error?.message ?? null}
      engineOn={Boolean(settings?.sequence_enabled)}
    />
  );
}
