"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { StatsRange } from "@/lib/opsStats";
import {
  WEEKDAY_INITIALS, formatRangeLabel, isDaySelectable, monthLabel, monthMatrix,
  parseIsoDay, presetForRange, rangeLengthDays, shiftMonth, todayIso, yesterdayIso,
} from "@/lib/dateRange";
import { IconCalendar, IconChevronDown, IconChevronLeft, IconChevronRight } from "@/components/icons";

// The statistics date control, rebuilt on Shopify's analytics date picker
// (2026-09-04, the owner's brief): a closed trigger reading the current range, and
// a popover offering **Today | Yesterday | Custom** over a two-month calendar.
//
// What went, and why:
//  - The 7d / 30d / 90d presets. They answered "how have we been trending",
//    which is not the question this page gets opened with; "how did we do
//    today / on the 12th / over the launch weekend" is, and none of the three
//    could express it.
//  - `presetsOnly`. It existed to keep a custom range off the funnel view, on
//    the reasoning that a custom range was a power move belonging on the
//    General tab. That reasoning is inverted now: picking the day IS the
//    primary interaction, so both views get the same full control.
//
// Selection is staged, exactly as Shopify does it: clicking days or a preset
// edits a draft, and nothing re-queries until Apply. On a page where every
// change costs a round-trip of server queries, a picker that fired on each of
// the two clicks of a range would run one guaranteed-wrong query in between.
// Cancel (and Escape, and an outside click) drops the draft.
//
// defaultRange() itself lives in lib/opsStats.ts and the calendar arithmetic in
// lib/dateRange.ts, not here — page.tsx is a Server Component and Next.js can't
// call a "use client" file's export from server code.

type Mode = "today" | "yesterday" | "custom";

export default function DateRangePicker({
  value,
  onChange,
  activeDays,
}: {
  value: StatsRange;
  onChange: (r: StatsRange) => void;
  /** Days we hold data for, from getStatsActiveDays(). `null` = we could not
   * find out, and the calendar then offers every past day (see
   * lib/dateRange.ts::isDaySelectable for why that is the safe direction). */
  activeDays?: string[] | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const label = formatRangeLabel(value.from, value.to);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="filter-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <IconCalendar width={15} height={15} />
        <span style={{ color: "var(--ink)" }}>{label}</span>
        <IconChevronDown width={13} height={13} />
      </button>
      {open && (
        <RangePopover
          value={value}
          activeDays={activeDays ?? null}
          onCancel={() => setOpen(false)}
          onApply={(r) => {
            setOpen(false);
            // Don't spend a round-trip re-rendering the range that is already on
            // screen — Apply on an untouched popover is a no-op by design.
            if (r.from !== value.from || r.to !== value.to) onChange(r);
          }}
        />
      )}
    </div>
  );
}

function RangePopover({
  value,
  activeDays,
  onApply,
  onCancel,
}: {
  value: StatsRange;
  activeDays: string[] | null;
  onApply: (r: StatsRange) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<StatsRange>(value);
  // Set when the next calendar click should CLOSE a range rather than start a
  // new one. Reset by every preset and by each completed pair, so a third click
  // always begins a fresh range instead of extending the last one forever.
  const [anchoring, setAnchoring] = useState(false);

  // Open the calendar on the month the range starts in — the month someone is
  // about to adjust — falling back to the current one for an unparseable URL.
  const start = parseIsoDay(draft.from) ?? parseIsoDay(todayIso())!;
  const [view, setView] = useState({ year: start.year, month: start.month });
  const rightView = useMemo(() => shiftMonth(view.year, view.month, 1), [view]);

  // "Custom" can't be derived from the range alone: someone who clicks Custom
  // and then picks today by hand has chosen custom, even though the range is
  // indistinguishable from the Today preset. So the calendar's own use latches
  // it, and only the two real presets clear it — otherwise pressing Custom
  // would leave Today lit and the click would look like it did nothing.
  const [pinnedCustom, setPinnedCustom] = useState(presetForRange(value.from, value.to) === "custom");
  const mode: Mode = pinnedCustom ? "custom" : presetForRange(draft.from, draft.to);
  const today = todayIso();
  // A Set, built once per open rather than per rendered day: two months is ~62
  // cells and the list is one entry per trading day, so the linear scan an
  // array would cost is paid 62 times for nothing.
  const activeSet = useMemo(() => (activeDays ? new Set(activeDays) : null), [activeDays]);

  function choosePreset(next: Mode) {
    if (next === "custom") {
      // Custom means "use the calendar"; it invents no range of its own, so the
      // draft is left exactly where it was for the calendar to edit.
      setPinnedCustom(true);
      setAnchoring(false);
      return;
    }
    const day = next === "today" ? todayIso() : yesterdayIso();
    const p = parseIsoDay(day)!;
    setDraft({ from: day, to: day });
    setView({ year: p.year, month: p.month });
    setPinnedCustom(false);
    setAnchoring(false);
  }

  function clickDay(iso: string) {
    if (!isDaySelectable(iso, activeSet)) return;
    setPinnedCustom(true);
    if (!anchoring) {
      setDraft({ from: iso, to: iso });
      setAnchoring(true);
      return;
    }
    // Second click: whichever side of the anchor it lands on becomes that end,
    // so dragging "backwards" works without the range ever going inverted.
    setDraft(iso < draft.from ? { from: iso, to: draft.from } : { from: draft.from, to: iso });
    setAnchoring(false);
  }

  /** The two typed inputs are the escape hatch for a far-away date nobody wants
   * to page a calendar to. They only commit a value that keeps the range
   * ordered — a half-typed year would otherwise collapse or invert it. */
  function typeEnd(which: "from" | "to", iso: string) {
    if (!parseIsoDay(iso)) return;
    const next = which === "from" ? { from: iso, to: draft.to } : { from: draft.from, to: iso };
    if (next.from > next.to) return;
    setDraft(next);
    setPinnedCustom(true);
    setAnchoring(false);
    const p = parseIsoDay(which === "from" ? next.from : next.to)!;
    setView(which === "from" ? { year: p.year, month: p.month } : shiftMonth(p.year, p.month, -1));
  }

  const days = rangeLengthDays(draft.from, draft.to);

  return (
    <div className="card dp-pop" role="dialog" aria-label="Choose a date range">
      <div className="dp-body">
        <div className="dp-presets" role="group" aria-label="Quick ranges">
          {(["today", "yesterday", "custom"] as const).map((m) => {
            // Yesterday can be a day we hold nothing for, and the calendar
            // greys it out when so. The button has to agree with the grid
            // beside it — offering a day the cell below refuses is the kind of
            // small contradiction that makes people distrust the numbers.
            // Today and Custom are always live: today is always selectable by
            // rule, and Custom only hands control to the calendar.
            const disabled = m === "yesterday" && !isDaySelectable(yesterdayIso(), activeSet);
            return (
              <button
                key={m}
                type="button"
                className={`dp-preset${mode === m ? " on" : ""}`}
                aria-pressed={mode === m}
                disabled={disabled}
                title={disabled ? "No data recorded for yesterday" : undefined}
                onClick={() => choosePreset(m)}
              >
                {m === "today" ? "Today" : m === "yesterday" ? "Yesterday" : "Custom"}
              </button>
            );
          })}
        </div>

        <div className="dp-cal-side">
          <div className="dp-inputs">
            <label>
              <span>Starting</span>
              <input type="date" value={draft.from} max={draft.to} onChange={(e) => typeEnd("from", e.target.value)} />
            </label>
            <label>
              <span>Ending</span>
              <input type="date" value={draft.to} min={draft.from} max={today} onChange={(e) => typeEnd("to", e.target.value)} />
            </label>
          </div>

          <div className="dp-months">
            <MonthGrid
              year={view.year}
              month={view.month}
              draft={draft}
              activeSet={activeSet}
              onPick={clickDay}
              onPrev={() => setView(shiftMonth(view.year, view.month, -1))}
              onNext={() => setView(shiftMonth(view.year, view.month, 1))}
              nav="prev-and-narrow-next"
            />
            <div className="dp-month-second">
              <MonthGrid
                year={rightView.year}
                month={rightView.month}
                draft={draft}
                activeSet={activeSet}
                onPick={clickDay}
                onPrev={() => setView(shiftMonth(view.year, view.month, -1))}
                onNext={() => setView(shiftMonth(view.year, view.month, 1))}
                nav="next"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="dp-foot">
        <span className="dp-summary">
          {formatRangeLabel(draft.from, draft.to)}
          <span className="dp-days"> · {days} {days === 1 ? "day" : "days"}</span>
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-solid" onClick={() => onApply(draft)}>Apply</button>
        </div>
      </div>
    </div>
  );
}

function MonthGrid({
  year, month, draft, activeSet, onPick, onPrev, onNext, nav,
}: {
  year: number;
  month: number;
  draft: StatsRange;
  activeSet: ReadonlySet<string> | null;
  onPick: (iso: string) => void;
  onPrev: () => void;
  onNext: () => void;
  /** Both grids move together, so one arrow per month on the outer edge is
   * enough — two full pairs would be four controls doing two things. The left
   * month carries a second, forward arrow that CSS reveals only below 760px,
   * where the right month is hidden and would otherwise take the only way
   * forward with it. */
  nav: "prev-and-narrow-next" | "next";
}) {
  const weeks = monthMatrix(year, month);
  const today = todayIso();
  return (
    <div className="dp-month">
      <div className="dp-month-head">
        {nav === "prev-and-narrow-next" ? (
          <button type="button" className="dp-nav" onClick={onPrev} aria-label="Previous month">
            <IconChevronLeft width={15} height={15} />
          </button>
        ) : <span className="dp-nav-spacer" />}
        <span className="dp-month-label">{monthLabel(year, month)}</span>
        {nav === "next" ? (
          <button type="button" className="dp-nav" onClick={onNext} aria-label="Next month">
            <IconChevronRight width={15} height={15} />
          </button>
        ) : (
          <button type="button" className="dp-nav dp-nav-narrow" onClick={onNext} aria-label="Next month">
            <IconChevronRight width={15} height={15} />
          </button>
        )}
      </div>
      <div className="dp-week dp-week-head" aria-hidden="true">
        {WEEKDAY_INITIALS.map((w, i) => <span key={i}>{w}</span>)}
      </div>
      {weeks.map((week, wi) => (
        <div className="dp-week" key={wi}>
          {week.map((iso, di) => {
            if (!iso) return <span key={di} className="dp-day dp-day-blank" />;
            const inRange = iso >= draft.from && iso <= draft.to;
            const isEnd = iso === draft.from || iso === draft.to;
            // One disabled state for both reasons — a day in the future and a
            // day we have nothing for are the same answer to the person
            // clicking: there is nothing here to show you.
            const blocked = !isDaySelectable(iso, activeSet);
            const cls = [
              "dp-day",
              inRange ? "in" : "",
              isEnd ? "end" : "",
              iso === today ? "today" : "",
            ].filter(Boolean).join(" ");
            return (
              <button
                key={di}
                type="button"
                className={cls}
                disabled={blocked}
                aria-pressed={inRange}
                onClick={() => onPick(iso)}
              >
                {Number(iso.slice(8, 10))}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
