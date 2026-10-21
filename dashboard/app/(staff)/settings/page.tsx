import SettingsClient from "@/components/SettingsClient";
import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import type { AppSettings } from "@/lib/types";
import type { StaffRole } from "@/lib/staffRoles";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "admin") return <Forbidden reason="Settings is only available to Admins." />;

  const { data } = await supabase.from("app_settings").select("*").eq("id", 1).single();

  // The allow-list table has no RLS read policy for anon/authenticated (it's
  // the security boundary itself, deliberately unreadable by those roles —
  // see supabase/schema.sql) — service-role is required to read it here.
  const admin = createServiceClient();
  const { data: allowedRows } = await admin.from("allowed_emails").select("email, role").order("email");
  const allowedEmails = (allowedRows ?? []).map((row) => ({ email: row.email as string, role: row.role as StaffRole }));

  return (
    <SettingsClient
      initial={(data ?? null) as AppSettings | null}
      userEmail={user.email ?? ""}
      allowedEmails={allowedEmails}
    />
  );
}
