import { requireRole } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { chatWithStats } from "@/lib/statsChat";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireRole("ops", "admin");
  if (!auth.ok) return auth.res;

  const body = (await request.json().catch(() => null)) as { messages?: { role: "user" | "assistant"; content: string }[] } | null;
  if (!body?.messages?.length) {
    return new Response(JSON.stringify({ error: "messages is required" }), { status: 400 });
  }

  const admin = createServiceClient();
  const { data: settings } = await admin.from("app_settings").select("stats_chat_model").eq("id", 1).single();
  // Fallback matches the migration default (supabase/migrations/2026-08-05-stats-chat-settings.sql) —
  // 'anthropic/claude-sonnet-5', per CLAUDE.md's model convention, not the plan snapshot's '-4.5'.
  const model = settings?.stats_chat_model ?? "anthropic/claude-sonnet-5";

  try {
    const reply = await chatWithStats(admin, model, body.messages, auth.email);
    return new Response(JSON.stringify({ reply }), { status: 200 });
  } catch (err) {
    console.error("stats chat failed", err);
    return new Response(JSON.stringify({ error: "The chat failed to respond. Try again." }), { status: 502 });
  }
}
