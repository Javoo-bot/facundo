import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import TestingClient, { type TestShop, type CityOption } from "@/components/testing/TestingClient";
import OrderSandboxPanel, { type DemoOrder } from "@/components/testing/OrderSandboxPanel";
import { listDemoOrders } from "@/lib/testing/demoSandbox";

export const dynamic = "force-dynamic";

// Admin-only. This page creates and deletes florists and fires real sends, so
// it sits behind the same gate as Settings rather than the general staff gate.
export default async function TestingPage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "admin") return <Forbidden reason="Test stores are only available to Admins." />;

  const admin = createServiceClient();
  const [{ data: shops, error }, { data: cities }, { data: settings }, demoOrders] = await Promise.all([
    admin
      .from("florists")
      .select(
        "id, name, email, locale, joined_at, ingested_at, cities(city), sequence_enrolments(id, sequence_id, status, track, step_index, next_action_at, engaged_at, touches_email, stop_reason)"
      )
      .eq("is_test_shop", true)
      .is("deleted_at", null)
      .order("ingested_at", { ascending: false })
      .limit(50),
    admin.from("cities").select("id, city, country").order("city").limit(200),
    admin
      .from("app_settings")
      .select("sequence_enabled, cx_agent_enabled, test_mode, test_email, test_phone")
      .eq("id", 1)
      .maybeSingle(),
    listDemoOrders(admin),
  ]);

  return (
    <>
      <TestingClient
        initialShops={(shops ?? []) as unknown as TestShop[]}
        cities={(cities ?? []) as CityOption[]}
        defaultEmail={user.email ?? ""}
        engineOn={Boolean(settings?.sequence_enabled)}
        agentOn={Boolean(settings?.cx_agent_enabled)}
        testMode={Boolean(settings?.test_mode)}
        error={error?.message ?? null}
      />
      <div className="mx-auto max-w-4xl px-6">
        <OrderSandboxPanel
          initialOrders={(demoOrders.ok ? demoOrders.orders : []) as unknown as DemoOrder[]}
          cities={(cities ?? []) as CityOption[]}
          testEmailConfigured={Boolean(settings?.test_email)}
          testEmail={settings?.test_email ?? null}
          testPhone={settings?.test_phone ?? null}
        />
      </div>
    </>
  );
}
