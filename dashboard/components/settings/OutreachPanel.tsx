"use client";

import { Hint, GroupLabel, NumberField, PanelCard, Toggle } from "@/components/settings/fields";
import type { PanelProps } from "@/components/settings/types";

/**
 * The switches for the multi-touch outreach program.
 *
 * These columns shipped with the program itself but had no UI, which meant the
 * whole funnel could only be turned on with hand-written SQL — the funnel would
 * accept enrolments through /testing and then send nothing, with no visible
 * reason anywhere in the app. This panel is that missing surface.
 *
 * Every switch here fails CLOSED (default false) and each one is checked again
 * server-side at send time; this panel is the operator's control, not the
 * enforcement.
 */
export default function OutreachPanel({ form, set }: PanelProps) {
  return (
    <div className="space-y-5">
      <PanelCard title="Recruiting funnel" tone={form.sequence_enabled ? "accent" : "normal"}>
        <div className="space-y-3">
          <Toggle
            label="Run the multi-touch funnel"
            checked={form.sequence_enabled}
            onChange={(v) => set("sequence_enabled", v)}
            hint="The master switch. Off, enrolling a florist still records them but the tick sends nothing — which is exactly what it looks like when a test seems to do nothing. On, due touches send on the cron."
          />

          <Toggle
            label="Auto-enrol freshly scraped shops"
            checked={form.sequence_auto_enrol_scraped}
            onChange={(v) => set("sequence_auto_enrol_scraped", v)}
            hint="Shops an ingest discovered in the last 14 days that have an email and nobody has touched yet enter the funnel on their own, a few per minute, instead of waiting for someone to press Send on /discovery. Needs the master switch on; the daily cap still applies; one per inbox."
          />
          <Toggle
            label="Limit how many send per day"
            checked={form.sequence_daily_send_cap !== null}
            // Turning the limit back ON restores the default rather than
            // whatever number was there before it was switched off — the old
            // value is not on the form once it is null, and silently
            // resurrecting a half-remembered number is worse than a visible 200
            // the operator can edit.
            onChange={(on) => set("sequence_daily_send_cap", on ? 200 : null)}
            hint="Off means the funnel sends everything that is due, however many that is — a 1,500-shop scrape sends 1,500 emails. On caps the day, and sends resume at midnight UTC."
          />
          {form.sequence_daily_send_cap !== null && (
            <NumberField
              label="Daily send cap"
              labelWidth="w-44"
              value={form.sequence_daily_send_cap}
              onChange={(v) => set("sequence_daily_send_cap", v)}
              min={0}
              max={100000}
              unit="messages per day, across the whole funnel — 0 sends nothing"
            />
          )}
          <NumberField
            label="Minimum gap"
            labelWidth="w-44"
            value={form.sequence_min_gap_hours}
            onChange={(v) => set("sequence_min_gap_hours", v)}
            min={0}
            max={720}
            unit="hours between two touches to the same florist"
          />
        </div>
        <Hint>
          When it is on, the cap is a blast-radius limit rather than a target: it exists so a
          scheduling bug can&apos;t empty the whole prospect list into one afternoon. Off, nothing
          bounds a day&apos;s volume but the size of the funnel itself, so the sending domain&apos;s
          reputation is the thing to watch — a send that fails is retried on the next tick, never
          dropped.
        </Hint>
      </PanelCard>

      <PanelCard title="Cold offers" tone={form.cold_offer_enabled ? "accent" : "normal"}>
        <div className="space-y-3">
          <Toggle
            label="Offer real orders to shops that haven't joined"
            checked={form.cold_offer_enabled}
            onChange={(v) => set("cold_offer_enabled", v)}
            hint="A shop we only scraped can claim a live order. Accepting is what joins them — so they take a real order having passed no vetting at all."
          />
          <GroupLabel>Limits</GroupLabel>
          <NumberField
            label="Max payout"
            labelWidth="w-44"
            value={form.cold_offer_max_payout_eur}
            onChange={(v) => set("cold_offer_max_payout_eur", v)}
            min={0}
            max={10000}
            unit="€ — above this, an order is never offered cold"
          />
          <NumberField
            label="Auto-pay up to"
            labelWidth="w-44"
            value={form.cold_offer_auto_payout_cap_eur}
            onChange={(v) => set("cold_offer_auto_payout_cap_eur", v)}
            min={0}
            max={10000}
            unit="€ — above this, the 70% waits for CX to release it"
          />
          <NumberField
            label="Assumed radius"
            labelWidth="w-44"
            value={form.cold_offer_default_radius_km}
            onChange={(v) => set("cold_offer_default_radius_km", v)}
            min={1}
            max={200}
            unit="km — the delivery radius a cold shop starts with"
          />
        </div>
        <Hint>
          The auto-pay cap is the one that spends money: below it the 70% moves the instant an
          unvetted shop accepts, which is the promise the recruiting email makes. Above it the leg
          parks on /cx for a human. Start it low.
        </Hint>
      </PanelCard>

      <PanelCard title="Florist chat" tone={form.florist_chat_enabled ? "accent" : "normal"}>
        <Toggle
          label="Show the support chat on a florist's order page"
          checked={form.florist_chat_enabled}
          onChange={(v) => set("florist_chat_enabled", v)}
          hint="Off, the chat launcher and panel don't render at all. Separate from whether the AI answers (below) — this only controls whether florists see a chat entry point."
        />
      </PanelCard>

      <PanelCard title="AI replies" tone={form.cx_agent_enabled ? "accent" : "normal"}>
        <div className="space-y-3">
          <Toggle
            label="Let the CX agent answer florist replies"
            checked={form.cx_agent_enabled}
            onChange={(v) => set("cx_agent_enabled", v)}
            hint="Off, every inbound reply lands on /cx for a human. On, the agent answers the ones it's confident about and escalates the rest."
          />
          {/* Its own switch, because the two answer different people about
              different things: this one is a JOINED florist asking about an
              order we hold the facts for. It shipped with no control at all, so
              the only way to turn it on was to edit the row by hand — and until
              someone did, every question in the order chat escalated with
              "agent-disabled" while the panel promised an answer straight away. */}
          <Toggle
            label="Let the support agent answer order questions"
            checked={form.support_agent_enabled}
            onChange={(v) => set("support_agent_enabled", v)}
            hint="The chat on a florist's own order. Off, every question goes to a colleague. On, it answers from that order's payouts, photo and dates, and escalates anything else."
          />
          <NumberField
            label="Minimum confidence"
            labelWidth="w-44"
            value={form.cx_agent_min_confidence}
            onChange={(v) => set("cx_agent_min_confidence", v)}
            min={0}
            max={1}
            step={0.05}
            unit="0–1 — below this the reply is escalated, never sent"
          />
          <NumberField
            label="Auto-reply turns"
            labelWidth="w-44"
            value={form.cx_agent_max_auto_turns}
            onChange={(v) => set("cx_agent_max_auto_turns", v)}
            min={0}
            max={20}
            unit="replies before the thread goes to a human regardless"
          />
        </div>
        <Hint>
          Confidence is the agent&apos;s own estimate, so it is a filter and not a guarantee. The
          hard backstops are separate and always on: anything touching money, a promise, or a
          request for a person escalates whatever the score says, and &ldquo;are you a bot?&rdquo; is
          always answered honestly.
        </Hint>
      </PanelCard>
    </div>
  );
}
