"use client";

import { Hint, NumberField, PanelCard } from "@/components/settings/fields";
import type { PanelProps, SettingsForm } from "@/components/settings/types";

/** Offer window per urgency tier — keys match app_settings columns. */
const WINDOWS: { key: keyof SettingsForm & `offer_window_${string}`; label: string }[] = [
  { key: "offer_window_rush_min", label: "Delivery within 6h" },
  { key: "offer_window_sameday_min", label: "Within 24h" },
  { key: "offer_window_standard_min", label: "Within 72h" },
  { key: "offer_window_far_min", label: "Beyond 72h" },
  { key: "offer_window_nodate_min", label: "No delivery date" },
];

/** How long to leave a shop alone after they did not pick up the phone. Same
 *  tiers as the offer window above, because it is the same judgement: how much
 *  time is there to be patient with. */
const CALL_BACK: { key: keyof SettingsForm & `call_back_gap_${string}`; label: string }[] = [
  { key: "call_back_gap_rush_min", label: "Delivery within 6h" },
  { key: "call_back_gap_sameday_min", label: "Within 24h" },
  { key: "call_back_gap_standard_min", label: "Within 72h" },
  { key: "call_back_gap_far_min", label: "Beyond 72h" },
  { key: "call_back_gap_nodate_min", label: "No delivery date" },
];

/** How long a florist has to answer, and how late a lapsed yes still counts. */
export default function OffersPanel({ form, set }: PanelProps) {
  return (
    <div className="space-y-5">
      <PanelCard title="Parallel offer fan-out">
        <NumberField
          label="Live offers per order"
          labelWidth="w-44"
          value={form.offer_parallel_sends}
          onChange={(v) => set("offer_parallel_sends", v)}
          min={1}
          max={10}
          unit="florists"
        />
        <Hint>
          How many florists may hold a live offer for the same order at once in auto mode. 1 keeps the
          current sequential funnel. Higher values reduce waiting time by sending to the next ranked candidates
          in parallel, while accept/decline/expiry and the wave/refill guards still decide who wins and when to move on.
        </Hint>
      </PanelCard>

      <PanelCard title="Response windows">
        <Hint>
          How long a florist has to respond, by how soon the delivery is. A rush order gets a short fuse
          automatically — widen the whole ladder for a peak weekend without a deploy. Each offer’s window is
          locked in when it’s sent; changing these only affects offers sent from now on.
        </Hint>
        <div className="mt-3 grid gap-2">
          {WINDOWS.map(({ key, label }) => (
            <NumberField
              key={key}
              label={label}
              labelWidth="w-44"
              value={form[key] as number}
              onChange={(v) => set(key, v as SettingsForm[typeof key])}
              min={1}
              max={1440}
              unit="minutes"
            />
          ))}
        </div>
      </PanelCard>

      <PanelCard title="Calling back after no answer">
        <Hint>
          When an operator phones a shop and nobody picks up, that shop drops below the ones nobody has
          tried yet — for this long. It is not a block: if every shop is on cooldown the operator still
          gets the best one, with “you called 20 minutes ago” on the card. Short on a rush order, longer
          when there is time to be patient.
        </Hint>
        <div className="mt-3 grid gap-2">
          {CALL_BACK.map(({ key, label }) => (
            <NumberField
              key={key}
              label={label}
              labelWidth="w-44"
              value={form[key] as number}
              onChange={(v) => set(key, v as SettingsForm[typeof key])}
              min={1}
              max={1440}
              unit="minutes"
            />
          ))}
        </div>
      </PanelCard>

      <PanelCard title="Hand-over to CX">
        <NumberField
          label="CX reserve"
          labelWidth="w-44"
          value={form.cx_reserve_hours}
          onChange={(v) => set("cx_reserve_hours", v)}
          min={0}
          max={72}
          unit="hours before delivery"
        />
        <Hint>
          Time kept back for a person. The engine won’t start an offer whose window would end later than
          this before delivery — it escalates instead, so CX inherits the order while there’s still time to
          place it by hand. This is what stops a long chain of waves from using up the whole day. Set 0 to
          keep offering right up to the delivery moment.
        </Hint>
      </PanelCard>

      <PanelCard title="Late accepts">
        <NumberField
          label="Late-accept buffer"
          labelWidth="w-44"
          value={form.late_accept_buffer_hours}
          onChange={(v) => set("late_accept_buffer_hours", v)}
          min={0}
          max={72}
          unit="hours before delivery"
        />
        <Hint>
          A florist whose window lapsed can still accept while nobody else has taken the order and we haven’t
          withdrawn the offer — but not inside this buffer, when there’s no longer time to actually deliver.
          Set 0 to allow an accept right up to the delivery moment.
        </Hint>
      </PanelCard>
    </div>
  );
}
