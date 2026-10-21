import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The test-store list, refetched after every harness action so the page reflects
// what actually happened rather than what the client hoped happened.
export async function GET(): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("florists")
    .select(
      "id, name, email, locale, joined_at, ingested_at, cities(city), sequence_enrolments(id, sequence_id, status, track, step_index, next_action_at, engaged_at, touches_email, stop_reason)"
    )
    .eq("is_test_shop", true)
    .is("deleted_at", null)
    .order("ingested_at", { ascending: false })
    .limit(50);
  if (error) return jsonError(error.message, 500);
  return Response.json({ shops: data ?? [] });
}
