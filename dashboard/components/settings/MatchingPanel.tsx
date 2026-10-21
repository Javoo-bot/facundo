"use client";

import { Field, Hint, NumberField, PanelCard, SelectField, Toggle } from "@/components/settings/fields";
import type { PanelProps } from "@/components/settings/types";

/** The within-ring score weights, in the order they're worth explaining. */
const WEIGHTS = [
  { key: "match_weight_distance", label: "Distance", hint: "Subtracted, per km. Breaks ties inside a ring — this is what stops the far edge of a ring beating the near edge." },
  { key: "match_weight_onboarded", label: "Onboarded", hint: "Bonus for a production/onboarding shop over a cold prospect." },
  { key: "match_weight_emailable", label: "Reachable by email", hint: "Bonus when the address identifies THIS shop (not a network head office, not shared, not bounced)." },
  { key: "match_weight_quality", label: "Rating & reviews", hint: "Applied to (rating − 3.0 + log₁₀(reviews + 1))." },
  { key: "match_weight_source", label: "Existing relationship", hint: "Applied to existing (2) / known (1) / new (0)." },
  { key: "match_weight_tier", label: "Trust tier", hint: "Applied to tier 1 (2) / 2 (1) / 3 (0) / 4 (−3)." },
  { key: "match_weight_performance", label: "Track record", hint: "Acceptance + on-time rate, smoothed so a brand-new shop scores neutral rather than badly." },
] as const;

/** How much the loop does on its own, and which orders/florists it may touch. */
export default function MatchingPanel({
  form,
  set,
}: PanelProps) {
  return (
    <div className="space-y-5">
      <PanelCard title="Automation">
        <SelectField
          label="Automation mode"
          value={form.workflow_mode}
          onChange={(v) => set("workflow_mode", v as typeof form.workflow_mode)}
          options={[
            { value: "manual", label: "Manual — you drive every step (send each offer, release each payout)" },
            { value: "semi", label: "Semi-automatic — the system proposes each step; you approve, edit or skip" },
            { value: "auto", label: "Automatic — the loop runs unattended (auto-offers, releases per trust tier)" },
          ]}
          hint={
            form.workflow_mode === "manual"
              ? "Nothing sends or pays automatically. You send each offer and approve every delivery photo before the 30% releases."
              : form.workflow_mode === "semi"
              ? "Offers wait for your approval (approve / edit the mail / skip to the next florist) in the CX queue; every delivery photo is held for your approval."
              : "The wave engine offers florists in turn on its own (incl. the first offer) and releases the 30% per trust tier. Manual overrides still work anytime."
          }
        />
      </PanelCard>

      <PanelCard title="Test shops" tone={form.test_shop_matching === "only" ? "crit" : "normal"}>
        <SelectField
          label="Test-shop matching"
          value={form.test_shop_matching}
          onChange={(v) => set("test_shop_matching", v as typeof form.test_shop_matching)}
          options={[
            { value: "exclude", label: "Exclude test shops — real orders never match a shop we own (default)" },
            { value: "only", label: "Only test shops — matching routes exclusively to shops we own" },
          ]}
          hint={
            form.test_shop_matching === "only"
              ? "TESTING MODE. Automatic matching ignores every real florist, so any order outside a test shop's delivery radius will match nobody and escalate to CX. Switch back to Exclude when you're done."
              : "A florist flagged as a test shop is skipped by automatic matching, so a paying customer's order can never be routed to one. You can still attach one by hand with “Add florist”."
          }
        />
      </PanelCard>

      <PanelCard title="Working set" tone={form.run_all_orders ? "crit" : "normal"}>
        <Hint>
          Orders are always ingested, but only orders in the working set are matched, worked,
          and shown by default. An order is in the working set if it matches a target country,
          OR a target tag, OR “Run all orders” is on.
        </Hint>
        <div className="mt-3 space-y-3">
          <Field
            label="Target countries"
            value={form.activeOrderCountriesText}
            onChange={(v) => set("activeOrderCountriesText", v)}
            placeholder="e.g. ES, FR"
            hint="Shopify shipping-country codes for the order's delivery address."
          />
          <Field
            label="Target Shopify tags"
            value={form.activeOrderTagsText}
            onChange={(v) => set("activeOrderTagsText", v)}
            placeholder="e.g. fulfillment-tookan, priority"
            hint="Comma-separated Shopify tags that enter the working set."
          />
          <Toggle
            label="Run all orders through the system"
            checked={form.run_all_orders}
            onChange={(v) => set("run_all_orders", v)}
            hint={
              form.run_all_orders
                ? "ON — every incoming order enters the working set, ignoring the country/tag filters above."
                : "Off by default. Leaving countries and tags both empty means NO order is worked — empty filters are safe, not “everything”."
            }
          />
          {form.run_all_orders && form.workflow_mode === "auto" && (
            <Hint>
              <strong>Automatic mode + Run all orders:</strong> every order that comes in will be matched and offered to florists with no human step.
            </Hint>
          )}
          {!form.run_all_orders && !form.activeOrderCountriesText.trim() && !form.activeOrderTagsText.trim() && form.workflow_mode === "auto" && (
            <Hint>
              <strong>Automatic mode is on, but the working set is empty:</strong> no orders will be worked until you add a country, a tag, or turn on Run all orders.
            </Hint>
          )}
          <NumberField
            label="Candidate search radius"
            value={form.working_set_radius_km}
            onChange={(v) => set("working_set_radius_km", v)}
            min={0.5}
            max={100}
            step={0.5}
            unit="km"
            labelWidth="w-44"
          />
          <Hint>
            If an order enters the working set with no florist candidate within this radius,
            we request ingest for that city instead of escalating immediately.
          </Hint>
        </div>
      </PanelCard>

      <PanelCard title="Distance rings">
        <Field
          label="Ring edges"
          value={form.matchRingEdgesText}
          onChange={(v) => set("matchRingEdgesText", v)}
          placeholder="5, 10, 20"
          hint="Kilometres, ascending. Florists are sorted by which ring they fall in BEFORE anything else, so a shop in a nearer ring always outranks a better one further out. The last edge is also the hard cap — nothing beyond it is ever offered, however large a radius the shop itself claims."
        />
        <Hint>
          A shop&apos;s own delivery radius still applies when it&apos;s smaller than the cap. A shop
          that hasn&apos;t set one is treated as covering the full cap.
        </Hint>
      </PanelCard>

      <PanelCard title="Within-ring score">
        <Hint>
          Only decides the order of florists inside the same ring. Raising any of these can never
          move a shop into a nearer ring.
        </Hint>
        <div className="mt-3 space-y-3">
          {WEIGHTS.map((w) => (
            <div key={w.key}>
              <NumberField
                label={w.label}
                value={form[w.key]}
                onChange={(v) => set(w.key, v)}
                min={0}
                max={20}
                step={0.05}
                unit="×"
                labelWidth="w-44"
              />
              <div className="ml-44 pl-2">
                <Hint>{w.hint}</Hint>
              </div>
            </div>
          ))}
        </div>
      </PanelCard>

      <PanelCard title="Candidates per match">
        <NumberField
          label="Florists to offer"
          value={form.match_top_n}
          onChange={(v) => set("match_top_n", v)}
          min={1}
          max={25}
          unit="florists"
          labelWidth="w-44"
        />
        <Hint>
          How many candidates a match writes. The wave engine works down this list one at a time —
          a larger number is a longer fallback chain, not more simultaneous offers.
        </Hint>
        <div className="mt-3">
          <NumberField
            label="Maximum waves"
            value={form.match_max_waves}
            onChange={(v) => set("match_max_waves", v)}
            min={1}
            max={20}
            unit="waves"
            labelWidth="w-44"
          />
        </div>
        <Hint>
          When every candidate has gone quiet, the engine fetches this many more — up to{" "}
          <strong>{form.match_max_waves} waves in all, so {form.match_max_waves * form.match_top_n} shops</strong> —
          before handing the order to CX. It stops sooner if there is no florist left in range, or if there
          isn’t time for another window (see the CX reserve under Offers). Set 1 to escalate after the first
          wave, as it did before. Waves after the first go to shops that haven’t onboarded, so they are sent
          as cold offers and obey those limits.
        </Hint>
      </PanelCard>

      <PanelCard title="Quality floor" tone={form.match_require_trust_tier ? "normal" : "crit"}>
        <div className="space-y-3">
          <Field
            label="Minimum rating"
            value={form.match_min_rating}
            onChange={(v) => set("match_min_rating", v)}
            placeholder="no floor"
            hint="Leave empty for no floor. A shop below this is never offered, however near it is."
          />
          <Field
            label="Minimum reviews"
            value={form.match_min_review_count}
            onChange={(v) => set("match_min_review_count", v)}
            placeholder="no floor"
            hint="Leave empty for no floor. A shop with no review count counts as zero."
          />
          <Toggle
            label="Allow unrated florists"
            checked={form.match_allow_unrated}
            onChange={(v) => set("match_allow_unrated", v)}
            hint="A freshly ingested shop often has no rating yet. Unrated is not the same as bad — off means the minimum rating rejects them too."
          />
          <Toggle
            label="Never offer to trust tier 4"
            checked={form.match_exclude_tier4}
            onChange={(v) => set("match_exclude_tier4", v)}
            hint="Tier 4 (Flagged) already scores −3 and has its payouts held. This drops them from matching outright."
          />
          <Toggle
            label="Require a trust tier"
            checked={form.match_require_trust_tier}
            onChange={(v) => set("match_require_trust_tier", v)}
            hint={
              form.match_require_trust_tier
                ? "On (recommended). A florist with no trust tier has no payout split, so there is no way to pay them for a delivered order."
                : "OFF — orders can now reach florists with no payout split configured. They can accept and deliver, but paying them will fail. Intended for deliberate recruiting runs only."
            }
          />
        </div>
      </PanelCard>
    </div>
  );
}
