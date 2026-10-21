"use client";

import { useState } from "react";
import TimeSelect from "@/components/florist/TimeSelect";
import { WEEKDAYS, weekdaysAgree, type DayRow, type HourDay } from "@/lib/businessHours";

export interface HoursLabels {
  title: string;
  note: string;
  weekdays: string;
  /** The open/closed STATE, for the per-day switch. */
  open: string;
  closed: string;
  /** The two time fields. Distinct from `open`/`closed` above: a closing-time
   * field labelled "Closed" reads to a screen reader as the shut state. */
  opensAt: string;
  closesAt: string;
  expand: string;
  collapse: string;
  /** Short day names, keyed by day — used by the expanded per-day grid. */
  days: Record<HourDay, string>;
  /** Full names for the two rows the collapsed view shows on their own. */
  saturday: string;
  sunday: string;
}

function TimePair({
  label,
  row,
  labels,
  disabled,
  onChange,
}: {
  /** The row's localized day name, for the screen-reader labels. Was the raw
   * `row.day` key ("mon"), which read out as English on every locale. */
  label: string;
  row: DayRow;
  labels: HoursLabels;
  disabled: boolean;
  onChange: (patch: Partial<DayRow>) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
      <TimeSelect
        value={row.open}
        disabled={disabled}
        ariaLabel={`${label}, ${labels.opensAt}`}
        onChange={(open) => onChange({ open })}
      />
      <span style={{ color: "var(--ink-faint)" }}>–</span>
      <TimeSelect
        value={row.close}
        disabled={disabled}
        ariaLabel={`${label}, ${labels.closesAt}`}
        onChange={(close) => onChange({ close })}
      />
    </div>
  );
}

function Row({
  label,
  row,
  labels,
  onChange,
  toggleable = true,
}: {
  label: string;
  row: DayRow;
  labels: HoursLabels;
  onChange: (patch: Partial<DayRow>) => void;
  /** The Mon–Fri summary row has no switch: closing the whole working week
   * from a collapsed control is a decision that deserves the per-day view. */
  toggleable?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 0",
        borderBottom: "1px solid var(--line)",
        opacity: row.closed ? 0.55 : 1,
      }}
    >
      <span style={{ fontSize: ".85rem", minWidth: 0 }}>{label}</span>
      {toggleable && (
        <input
          type="checkbox"
          className="switch"
          checked={!row.closed}
          aria-label={`${label}, ${row.closed ? labels.closed : labels.open}`}
          onChange={(e) => onChange({ closed: !e.target.checked })}
        />
      )}
      {row.closed ? (
        <span style={{ marginLeft: "auto", fontSize: ".82rem", color: "var(--ink-soft)" }}>{labels.closed}</span>
      ) : (
        <TimePair label={label} row={row} labels={labels} disabled={false} onChange={onChange} />
      )}
    </div>
  );
}

/** Opening hours for the join form.
 *
 * Collapsed by default: one "Monday to Friday" row plus Saturday and Sunday,
 * because that covers almost every shop in three controls instead of seven.
 * The disclosure opens the full per-day grid for anyone it doesn't fit.
 *
 * It starts EXPANDED when pre-filled weekday hours disagree — a summary row
 * that averaged real, differing stored hours away would be a lie, and the
 * florist would have no way to see what we actually held. */
export default function OpeningHours({
  rows,
  setRows,
  labels,
}: {
  rows: DayRow[];
  setRows: (next: DayRow[]) => void;
  labels: HoursLabels;
}) {
  const [expanded, setExpanded] = useState(() => !weekdaysAgree(rows));

  const patchDay = (day: HourDay, patch: Partial<DayRow>) =>
    setRows(rows.map((r) => (r.day === day ? { ...r, ...patch } : r)));

  const patchWeekdays = (patch: Partial<DayRow>) =>
    setRows(rows.map((r) => (WEEKDAYS.includes(r.day) ? { ...r, ...patch } : r)));

  const byDay = (day: HourDay) => rows.find((r) => r.day === day) as DayRow;

  return (
    <div>
      <p style={{ fontWeight: 600, fontSize: ".95rem", marginBottom: 2 }}>{labels.title}</p>
      <p style={{ fontSize: ".78rem", color: "var(--ink-soft)", margin: "0 0 8px" }}>{labels.note}</p>

      {expanded ? (
        rows.map((row) => (
          <Row
            key={row.day}
            label={labels.days[row.day]}
            row={row}
            labels={labels}
            onChange={(patch) => patchDay(row.day, patch)}
          />
        ))
      ) : (
        <>
          <Row
            label={labels.weekdays}
            row={byDay("mon")}
            labels={labels}
            onChange={patchWeekdays}
            toggleable={false}
          />
          <Row
            label={labels.saturday}
            row={byDay("sat")}
            labels={labels}
            onChange={(patch) => patchDay("sat", patch)}
          />
          <Row
            label={labels.sunday}
            row={byDay("sun")}
            labels={labels}
            onChange={(patch) => patchDay("sun", patch)}
          />
        </>
      )}

      {/* Collapsing is only offered while the five weekdays actually agree.
          Otherwise the summary row would show Monday and quietly hide that
          Wednesday is different — the same lie the expanded-by-default rule
          above exists to prevent. */}
      {(!expanded || weekdaysAgree(rows)) && (
        <button
          type="button"
          className="link-subtle"
          onClick={() => setExpanded((v) => !v)}
          style={{ background: "none", border: "none", padding: "8px 0 0", cursor: "pointer", fontSize: ".8rem" }}
        >
          {expanded ? `▴ ${labels.collapse}` : `▾ ${labels.expand}`}
        </button>
      )}
    </div>
  );
}
