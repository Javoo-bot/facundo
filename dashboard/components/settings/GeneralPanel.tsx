"use client";

import { Field, Hint, PanelCard, Toggle } from "@/components/settings/fields";
import type { PanelProps } from "@/components/settings/types";

/**
 * Test mode and the addresses everything else routes to. Test phone lives here
 * beside test mode and test email — the SMS toggles under Notifications point
 * back at it, but it is the same "where does test traffic go" concept.
 */
export default function GeneralPanel({ form, set }: PanelProps) {
  return (
    <div className="space-y-5">
      <PanelCard title="Operator view">
        <Toggle
          label="Short sidebar for operators"
          checked={form.operator_view}
          onChange={(v) => set("operator_view", v)}
        />
      </PanelCard>

      <PanelCard title="Test mode">
        <Toggle
          label="Test mode"
          checked={form.test_mode}
          onChange={(v) => set("test_mode", v)}
          hint="While on, every outreach email and SMS is redirected to the test address and phone below. Real florists are never contacted."
        />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label={<>Test email {form.test_mode && <span className="text-crit">*</span>}</>}
            type="email"
            value={form.test_email}
            onChange={(v) => set("test_email", v)}
            placeholder="you@example.com"
          />
          <Field
            label="Test phone"
            type="tel"
            value={form.test_phone}
            onChange={(v) => set("test_phone", v)}
            placeholder="+34600000000"
          />
        </div>
        <Hint>All SMS is routed to the test phone while test mode is on.</Hint>
      </PanelCard>

      <PanelCard title="Contact addresses">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="CX / ops inbox"
            type="email"
            value={form.cx_email}
            onChange={(v) => set("cx_email", v)}
            placeholder="ops@fc.example.com"
            hint="Where florist-reported issues are emailed (LIVE mode). In test mode they route to the test email above."
          />
          <Field
            label="Florist support email"
            type="email"
            value={form.florist_support_email}
            onChange={(v) => set("florist_support_email", v)}
            placeholder="florists@fc.example.com"
            hint="Shown to florists in the order-offer email footer, for questions about an order."
          />
        </div>
      </PanelCard>
    </div>
  );
}
