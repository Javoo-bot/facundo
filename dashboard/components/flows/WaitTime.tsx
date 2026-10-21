"use client";

import { useCallback, useEffect, useState } from "react";
import {
  humanWait,
  waitToDays,
  messageName,
  chainPositions,
  listedMessageIds,
  type FlowDef,
  type FlowStep,
} from "@/lib/flows/catalog";
import { timingKey, MAX_WAIT_DAYS, type StepEnabled, type StepTiming } from "@/lib/flows/timing";

// Every clock in the order flows, on its own page, away from the words.
//
// One setting per box. The first version of this page was a flat column of
// label-input-unit rows, which reads as a form you have to fill in rather than
// a set of separate decisions you can make one at a time.
//
// Nothing here has a Save button: each field writes when you leave it. A wait
// and a response window are bounded numbers with no draft state — there is no
// half-finished version of "three days" to protect anyone from.

interface Payload {
  flows: FlowDef[];
  timing: StepTiming;
  stepEnabled: StepEnabled;
  /** The event-driven messages' switches, by message id. */
  messageEnabled: Record<string, boolean>;
  windows: Record<string, number>;
  cxReserveHours: number;
}

const WINDOW_ROWS: { key: string; label: string }[] = [
  { key: "offer_window_rush_min", label: "Delivery within 6h" },
  { key: "offer_window_sameday_min", label: "Within 24h" },
  { key: "offer_window_standard_min", label: "Within 72h" },
  { key: "offer_window_far_min", label: "Beyond 72h" },
  { key: "offer_window_nodate_min", label: "No delivery date" },
];

/** "3 days" after WHAT is the whole question, so every box answers it. */
function anchorPhrase(step: FlowStep): string {
  return step.anchor === "engaged" ? "after they click something"
    : step.anchor === "prevStep" ? "after the message before"
    : "after the shop enters the funnel";
}

/** A chapter. The first version used a small grey line for this, and the page
 *  read as one long list of boxes with no shape — you could not tell where the
 *  offer windows ended and a funnel began. */
function Chapter({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 34 }}>
      <h2
        style={{
          margin: "0 0 12px",
          paddingBottom: 8,
          borderBottom: "1px solid var(--line)",
          fontSize: "1rem",
          fontWeight: 600,
          color: "var(--ink)",
        }}
      >
        {title}
      </h2>
      <div style={{ display: "grid", gap: 8 }}>{children}</div>
    </section>
  );
}

/** One setting, in its own box. */
function Box({
  label, hint, muted = false, children,
}: {
  label: string;
  hint?: string;
  /** Switched off: still readable, no longer looks like something in use. */
  muted?: boolean;
  /** Optional: an email that fires on an event has a name and a sentence, and
   *  nothing to set. */
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 10,
        background: muted ? "transparent" : "var(--surface)",
        padding: "12px 14px",
        opacity: muted ? 0.55 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ flex: 1, minWidth: "11rem", fontSize: ".86rem", color: "var(--ink)" }}>{label}</span>
        {children}
      </div>
      {hint && (
        <p style={{ margin: "8px 0 0", fontSize: ".76rem", color: "var(--ink-faint)", lineHeight: 1.55 }}>{hint}</p>
      )}
    </div>
  );
}

/** A number that saves when you leave it. */
function NumberBox({
  value, min, max, unit, disabled = false, onCommit,
}: {
  value: number;
  min: number;
  max: number;
  unit: string;
  disabled?: boolean;
  onCommit: (value: number) => void | Promise<void>;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: "none" }}>
      <input
        type="number"
        min={min}
        max={max}
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(Number(e.target.value))}
        onBlur={() => void onCommit(local)}
        className="w-20 rounded-md border border-line px-2 py-1 text-sm text-ink"
      />
      <span style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>{unit}</span>
    </span>
  );
}

function WaitBox({
  label, step, timing, off, onChanged, say,
}: {
  /** "3. We are short here" — built by the caller from the same numbering the
   *  funnel page uses, so the two screens cannot drift apart. */
  label: string;
  step: FlowStep;
  /** Switched off on its funnel. NOT a control here — Wait time is numbers —
   *  but it has to SHOW, or an operator who switched three emails off comes
   *  here, sees eight live-looking boxes, and concludes it did not work. */
  off: boolean;
  timing: StepTiming;
  onChanged: () => void;
  say: (t: string) => void;
}) {
  const t = step.timing!;
  const key = timingKey(t.sequenceId, t.stepKey);
  const current = key in timing ? timing[key] : t.defaultDays;
  const initial = humanWait(current);
  const [value, setValue] = useState(initial.value);
  const [unit, setUnit] = useState<"hours" | "days">(initial.unit);

  useEffect(() => {
    const h = humanWait(current);
    setValue(h.value);
    setUnit(h.unit);
  }, [current]);

  const commit = async (days: number | null) => {
    if (days !== null && days === current) return;
    const res = await fetch("/api/flows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "wait", sequenceId: t.sequenceId, stepKey: t.stepKey, days }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return say(json.error ?? "Could not save.");
    onChanged();
    say("Saved.");
  };

  return (
    <Box
      label={label}
      muted={off}
      hint={off ? "Switched off on its funnel — not being sent." : anchorPhrase(step)}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
        <input
          type="number"
          min={0}
          max={unit === "hours" ? MAX_WAIT_DAYS * 24 : MAX_WAIT_DAYS}
          step={unit === "hours" ? 1 : 0.5}
          value={value}
          disabled={off}
          onChange={(e) => setValue(Number(e.target.value))}
          onBlur={() => void commit(waitToDays(value, unit))}
          className="w-20 rounded-md border border-line px-2 py-1 text-sm text-ink"
        />
        <select
          value={unit}
          disabled={off}
          onChange={(e) => setUnit(e.target.value as "hours" | "days")}
          onBlur={() => void commit(waitToDays(value, unit))}
          className="rounded-md border border-line px-2 py-1 text-sm text-ink"
        >
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </span>
    </Box>
  );
}

/** What governs an email that has no wait of its own. These fire on an event,
 *  so there is no number to set — but leaving them off this page made the
 *  chain incomplete: "1. The offer" simply wasn't here, and the funnel it
 *  belongs to had no entry at all. */
function governedBy(step: FlowStep): string {
  return step.anchor === "fixed"
    ? "When the answer window below lapses"
    : "Goes out straight away";
}

export default function WaitTime() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const say = useCallback((t: string) => {
    setNote(t);
    window.setTimeout(() => setNote(null), 3000);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/flows", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load.");
      setData(json as Payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // One narrow write per field — never the whole settings form, which
  // /api/settings overwrites wholesale.
  const commitSetting = useCallback(
    async (field: string, value: number) => {
      if (!data) return;
      const was = field === "cx_reserve_hours" ? data.cxReserveHours : data.windows[field];
      if (value === was) return;
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "timing", [field]: value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) say(json.error ?? "Could not save.");
      await load();
      if (res.ok) say("Saved.");
    },
    [data, load, say]
  );

  if (error) return <p className="text-sm" style={{ color: "var(--crit)" }}>{error}</p>;
  if (!data) return <p className="text-sm text-ink-faint">Loading…</p>;

  return (
    <div style={{ maxWidth: "38rem" }}>
      <h1 style={{ margin: "0 0 6px", fontSize: "1.2rem" }}>Wait time</h1>
      <p style={{ margin: "0 0 24px", fontSize: ".8rem", color: "var(--ink-faint)" }}>
        Numbers only. Whether an email is sent at all is a tick on its own funnel.
      </p>

      {/* One chapter per funnel, listing its WHOLE chain in the same order and
          under the same numbers the funnel page uses — including the emails
          that fire on an event and have no number to set. Showing only the
          ones with an editable wait left "1. The offer" missing and the
          assignment funnel absent entirely. */}
      {data.flows.map((flow) => {
        const positions = chainPositions(flow);
        return (
          <Chapter key={flow.id} title={flow.label}>
            {listedMessageIds(flow).map((messageId) => {
              const step = flow.steps.find((st) => st.messageIds.includes(messageId));
              if (!step) return null;
              const label = `${positions[messageId] ?? "?"}. ${messageName(messageId)}`;
              return step.timing ? (
                <WaitBox
                  key={messageId}
                  label={label}
                  step={step}
                  timing={data.timing}
                  off={
                    data.stepEnabled?.[
                      timingKey(step.timing.sequenceId, step.timing.stepKey)
                    ] === false
                  }
                  onChanged={load}
                  say={say}
                />
              ) : (
                <Box
                  key={messageId}
                  label={label}
                  muted={data.messageEnabled?.[messageId] === false}
                  hint={
                    data.messageEnabled?.[messageId] === false
                      ? "Switched off on its funnel — not being sent."
                      : governedBy(step)
                  }
                />
              );
            })}

            {/* The answer window belongs to the funnel that uses it, so it sits
                under that funnel rather than floating above all three. */}
            {flow.showsResponseWindow && (
              <>
                <p
                  style={{
                    margin: "10px 0 2px",
                    fontSize: ".78rem",
                    fontWeight: 600,
                    color: "var(--ink-soft)",
                  }}
                >
                  How long a florist gets to answer
                </p>
                {WINDOW_ROWS.map(({ key, label }) => (
                  <Box key={key} label={label}>
                    <NumberBox
                      value={data.windows[key] ?? 0}
                      min={1}
                      max={1440}
                      unit="minutes"
                      onCommit={(v) => commitSetting(key, v)}
                    />
                  </Box>
                ))}
                <Box
                  label="Stop trying and hand to CX"
                  hint="The engine stops offering this long before delivery, so a person still has time to place the order by hand."
                >
                  <NumberBox
                    value={data.cxReserveHours}
                    min={0}
                    max={72}
                    unit="hours before delivery"
                    onCommit={(v) => commitSetting("cx_reserve_hours", v)}
                  />
                </Box>
              </>
            )}
          </Chapter>
        );
      })}

      {note && <p style={{ fontSize: ".78rem", color: "var(--accent)" }}>{note}</p>}
    </div>
  );
}
