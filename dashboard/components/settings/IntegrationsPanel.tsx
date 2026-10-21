"use client";

import { Hint, PanelCard, SelectField, Toggle } from "@/components/settings/fields";
import type { PanelProps } from "@/components/settings/types";

/**
 * Short vetted list for the Statistics page's LLM chat (app/api/stats/chat/route.ts).
 * Kept in sync with STATS_CHAT_MODELS in app/api/settings/route.ts, which is the
 * real (server-side) validation — this list only drives the dropdown.
 */
const STATS_CHAT_MODELS = [
  { value: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "openai/gpt-5", label: "GPT-5" },
];

/** The two settings that reach a third party: Shopify and OpenRouter. */
export default function IntegrationsPanel({ form, set }: PanelProps) {
  return (
    <div className="space-y-5">
      <PanelCard title="Shopify" tone={form.shopify_writeback_enabled ? "crit" : "normal"}>
        <Toggle
          label="Write status back to Shopify orders"
          checked={form.shopify_writeback_enabled}
          onChange={(v) => set("shopify_writeback_enabled", v)}
          danger
          hint={
            form.shopify_writeback_enabled
              ? "🔴 ON — writes to the REAL Shopify orders on accept, delivery and escalation: notes, tags and metafields, AND the order's customer-visible fulfilment status (accept → fulfilled, delivery photo → out for delivery)."
              : "Safe default: OFF. We record the intent in the operations log but never touch Shopify orders. Turn on only when you want real write-backs."
          }
        />
      </PanelCard>

      <PanelCard title="Statistics chat">
        <SelectField
          label="Model"
          value={form.stats_chat_model}
          onChange={(v) => set("stats_chat_model", v)}
          options={STATS_CHAT_MODELS}
        />
        <Hint>
          The OpenRouter model the “Ask about the data” chat on the Statistics page uses to answer free-form
          questions.
        </Hint>
      </PanelCard>
    </div>
  );
}
