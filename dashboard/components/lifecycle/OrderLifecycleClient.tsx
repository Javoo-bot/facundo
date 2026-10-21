"use client";

import { useEffect, useMemo, useState } from "react";
import {
  IconAlertTriangle,
  IconCheckCircle,
  IconClock,
  IconXCircle,
} from "@/components/icons";
import {
  CROSS_CUTTING,
  PHASES,
  summarize,
  type Branch,
  type BranchStatus,
  type BuildStatus,
  type Milestone,
  type Phase,
  type Stage,
} from "@/lib/lifecycle";

// --- status → presentation -------------------------------------------------

const STATUS_META: Record<BuildStatus, { label: string; badge: string; dot: string }> = {
  shipped: { label: "Shipped", badge: "badge-accent", dot: "var(--ok)" },
  "in-progress": { label: "In progress", badge: "badge-warn", dot: "var(--warn)" },
  planned: { label: "Planned", badge: "badge-neutral", dot: "var(--neutral)" },
};

const BRANCH_META: Record<
  BranchStatus,
  { label: string; color: string; Icon: typeof IconCheckCircle }
> = {
  handled: { label: "Handled", color: "var(--ok)", Icon: IconCheckCircle },
  "in-progress": { label: "Hardening", color: "var(--warn)", Icon: IconClock },
  planned: { label: "Planned", color: "var(--neutral)", Icon: IconClock },
  open: { label: "Help wanted", color: "var(--bloom)", Icon: IconAlertTriangle },
};

const TONE_VAR: Record<Phase["tone"], string> = {
  tA: "var(--tA)",
  tB: "var(--tB)",
  tC: "var(--tC)",
  neutral: "var(--neutral)",
};

const KIND_GLYPH: Record<Stage["kind"], string> = {
  start: "▷",
  step: "•",
  decision: "◇",
  endpoint: "✓",
};

type Filter = "all" | Milestone;

function washBorder(color: string) {
  return `color-mix(in srgb, ${color} 42%, transparent)`;
}
function washBg(color: string) {
  return `color-mix(in srgb, ${color} 9%, transparent)`;
}

function branchesFor(stage: Stage, filter: Filter): Branch[] {
  const bs = stage.branches ?? [];
  return filter === "all" ? bs : bs.filter((b) => b.milestone === filter);
}

const WORST_ORDER: BranchStatus[] = ["open", "planned", "in-progress", "handled"];
function worstOf(branches: Branch[]): BranchStatus | null {
  if (branches.length === 0) return null;
  return branches
    .map((b) => b.status)
    .sort((a, b) => WORST_ORDER.indexOf(a) - WORST_ORDER.indexOf(b))[0];
}
// MVP failure modes not yet fully handled — the "must-fix before go-live" count.
function mvpGaps(stage: Stage): number {
  return (stage.branches ?? []).filter((b) => b.milestone === "mvp" && b.status !== "handled").length;
}

// --- component -------------------------------------------------------------

type Selection = { kind: "stage"; id: string } | { kind: "cross"; id: string } | null;

const ALL_STAGES = PHASES.flatMap((p) => p.stages);

export default function OrderLifecycleClient() {
  const [selected, setSelected] = useState<Selection>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const summary = summarize();

  const stage = selected?.kind === "stage" ? ALL_STAGES.find((s) => s.id === selected.id) ?? null : null;
  const cross = selected?.kind === "cross" ? CROSS_CUTTING.find((b) => b.id === selected.id) ?? null : null;

  const crossVisible = useMemo(
    () => (filter === "all" ? CROSS_CUTTING : CROSS_CUTTING.filter((b) => b.milestone === filter)),
    [filter],
  );

  // Close the drawer on Escape.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);

  return (
    <main className="ds min-h-screen">
      <div className="page" style={{ maxWidth: 940 }}>
        {/* Header */}
        <header className="mb-6">
          <p className="eyebrow">Phase 0 · Order loop</p>
          <h1 className="mt-1">Order lifecycle</h1>
          <p className="mt-2 max-w-[44rem] text-[0.95rem] leading-relaxed text-ink-soft">
            The journey of one order down the spine — Shopify checkout to a florist paid 70/30 against a
            verified delivery photo. Each stage shows its build status and how ready its error handling is.
            Click any stage for the full detail: what happens, where it lives, and — for every way it can
            break — the manual and the automated fix.
          </p>

          {/* Summary tiles */}
          <div className="mt-5 flex flex-wrap gap-2.5">
            <StatTile value={`${summary.stagesShipped}/${summary.stages}`} label="Stages shipped" color="var(--ok)" />
            <StatTile value={summary.branchesHandled} label="Error modes handled" color="var(--ok)" />
            <StatTile value={summary.mvpGaps} label="MVP gaps to close" color="var(--warn)" />
            <StatTile value={summary.branchesOpen} label="Open — help wanted" color="var(--bloom)" />
          </div>

          {/* Milestone filter + legend */}
          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="inline-flex items-center gap-1.5">
              <span className="mini-h mr-1" style={{ letterSpacing: ".07em" }}>Show</span>
              {(["all", "mvp", "later"] as Filter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                  className="rounded-full border px-2.5 py-1 text-[0.72rem] font-semibold capitalize transition-colors"
                  style={{
                    borderColor: filter === f ? "var(--accent)" : "var(--line-strong)",
                    background: filter === f ? "var(--tA-wash)" : "var(--surface)",
                    color: filter === f ? "var(--accent)" : "var(--ink-soft)",
                  }}
                >
                  {f === "all" ? "All" : f === "mvp" ? "MVP" : "Later"}
                </button>
              ))}
            </div>
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.72rem] text-ink-soft">
              <span className="mini-h" style={{ letterSpacing: ".07em" }}>Build</span>
              <LegendDot color="var(--ok)" label="Shipped" />
              <LegendDot color="var(--warn)" label="In progress" />
              <LegendDot color="var(--neutral)" label="Planned" />
            </span>
          </div>
        </header>

        {/* Flow */}
        <div className="space-y-7">
          {PHASES.map((phase) => (
            <PhaseBlock
              key={phase.id}
              phase={phase}
              filter={filter}
              selectedId={selected?.kind === "stage" ? selected.id : null}
              onSelect={(id) => setSelected({ kind: "stage", id })}
            />
          ))}
        </div>

        {/* Cross-cutting exceptions — compact clickable rows */}
        {crossVisible.length > 0 && (
          <section className="mt-9">
            <h2 className="text-base font-semibold tracking-tight text-ink">Exceptions at any stage</h2>
            <p className="mt-1 text-sm text-ink-soft">
              These can fire while an order is anywhere on the path. Click for the manual + automated fix.
            </p>
            <div className="mt-3 space-y-2">
              {crossVisible.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setSelected({ kind: "cross", id: b.id })}
                  className="flex w-full items-center gap-3 rounded-lg border bg-surface p-3 text-left transition-colors hover:border-[var(--accent)]"
                  style={{ borderColor: "var(--line)" }}
                >
                  <MilestonePill milestone={b.milestone} />
                  <span className="flex-1 text-sm font-medium text-ink">{b.trigger}</span>
                  <BranchPill status={b.status} />
                </button>
              ))}
            </div>
          </section>
        )}

        <p className="mt-8 text-xs text-ink-faint">
          Source of truth: <code className="font-mono">dashboard/lib/lifecycle.ts</code>. Statuses track the
          Phase-0 roadmap and a code inventory of the dashboard + ingest worker.
        </p>
      </div>

      {/* Detail drawer */}
      {stage && <StageDrawer stage={stage} filter={filter} onClose={() => setSelected(null)} />}
      {cross && <CrossDrawer branch={cross} onClose={() => setSelected(null)} />}
    </main>
  );
}

// --- sub-components ---------------------------------------------------------

function StatTile({ value, label, color }: { value: string | number; label: string; color: string }) {
  return (
    <div className="rounded-lg border px-3.5 py-2.5" style={{ borderColor: washBorder(color), background: washBg(color) }}>
      <div className="text-xl font-bold leading-none" style={{ color }}>{value}</div>
      <div className="mt-1 text-[0.68rem] font-medium leading-tight text-ink-soft">{label}</div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function MilestonePill({ milestone }: { milestone: Milestone }) {
  const mvp = milestone === "mvp";
  const color = mvp ? "var(--accent)" : "var(--neutral)";
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-mono text-[0.56rem] font-bold uppercase tracking-wide"
      style={{ color, background: washBg(color), border: `1px solid ${washBorder(color)}` }}
    >
      {mvp ? "MVP" : "Later"}
    </span>
  );
}

function BranchPill({ status }: { status: BranchStatus }) {
  const meta = BRANCH_META[status];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[0.58rem] font-bold uppercase tracking-wide"
      style={{ color: meta.color, background: washBg(meta.color), border: `1px solid ${washBorder(meta.color)}` }}
    >
      <meta.Icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

// Compact "error handling" readiness meter for the main-view stage row.
function ErrorMeter({ branches }: { branches: Branch[] }) {
  if (branches.length === 0) {
    return <span className="text-[0.7rem] text-ink-faint">No known failure modes</span>;
  }
  const resolved = branches.filter((b) => b.status === "handled").length;
  const worst = worstOf(branches)!;
  const color = BRANCH_META[worst].color;
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.7rem] text-ink-soft">
      <span className="inline-flex gap-0.5" aria-hidden="true">
        {branches.map((b) => (
          <span
            key={b.id}
            className="h-1.5 w-3.5 rounded-full"
            style={{ background: b.status === "handled" ? "var(--ok)" : washBorder(BRANCH_META[b.status].color) }}
          />
        ))}
      </span>
      <span style={{ color }}>{resolved}/{branches.length} handled</span>
    </span>
  );
}

function PhaseBlock({
  phase,
  filter,
  selectedId,
  onSelect,
}: {
  phase: Phase;
  filter: Filter;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const tone = TONE_VAR[phase.tone];
  return (
    <section>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="h-5 w-1.5 rounded-full" style={{ background: tone }} />
        <span className="font-mono text-[0.68rem] font-bold uppercase tracking-[0.12em]" style={{ color: tone }}>
          {phase.label}
        </span>
        <span className="text-[0.8rem] text-ink-soft">{phase.blurb}</span>
      </div>
      <div>
        {phase.stages.map((s, i) => (
          <StageRow
            key={s.id}
            stage={s}
            filter={filter}
            isFirst={i === 0}
            isLast={i === phase.stages.length - 1}
            selected={selectedId === s.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function StageRow({
  stage,
  filter,
  isFirst,
  isLast,
  selected,
  onSelect,
}: {
  stage: Stage;
  filter: Filter;
  isFirst: boolean;
  isLast: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const st = STATUS_META[stage.status];
  const branches = branchesFor(stage, filter);
  const gaps = mvpGaps(stage);
  return (
    <div className="grid grid-cols-[40px_1fr] gap-3 pb-3">
      {/* Spine + marker */}
      <div className="relative flex justify-center">
        <span
          className="absolute w-0.5"
          style={{
            background: "var(--line-strong)",
            top: isFirst ? 14 : 0,
            bottom: isLast ? "auto" : 0,
            height: isLast ? 14 : undefined,
          }}
        />
        <span
          className="relative z-10 mt-1 flex h-6 w-6 items-center justify-center rounded-full border-2 text-[0.6rem] font-bold"
          style={{ borderColor: st.dot, background: "var(--surface)", color: st.dot }}
          aria-hidden="true"
        >
          {KIND_GLYPH[stage.kind]}
        </span>
      </div>

      {/* Card */}
      <button
        type="button"
        onClick={() => onSelect(stage.id)}
        className="w-full rounded-xl border p-3.5 text-left shadow-[var(--shadow)] transition-colors hover:border-[var(--accent)]"
        style={{
          borderColor: selected ? "var(--accent)" : "var(--line)",
          background: "var(--surface)",
          boxShadow: selected ? "0 0 0 3px var(--tA-wash)" : undefined,
        }}
      >
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: st.dot }} />
          <span className="text-[0.95rem] font-semibold text-ink">{stage.label}</span>
          <span className={`badge ${st.badge}`}>{st.label}</span>
          <MilestonePill milestone={stage.milestone} />
          {stage.surface && stage.surface !== "—" && (
            <span className="font-mono text-[0.62rem] uppercase tracking-wide text-ink-faint">{stage.surface}</span>
          )}
        </div>
        <p className="mt-1.5 text-[0.82rem] leading-relaxed text-ink-soft">{stage.short}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t pt-2.5" style={{ borderColor: "var(--line)" }}>
          <span className="mini-h" style={{ letterSpacing: ".06em" }}>Error handling</span>
          <ErrorMeter branches={branches} />
          {gaps > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.64rem] font-semibold"
              style={{ color: "var(--warn)", background: washBg("var(--warn)"), border: `1px solid ${washBorder("var(--warn)")}` }}
            >
              <IconAlertTriangle className="h-3 w-3" />
              {gaps} MVP gap{gaps > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </button>
    </div>
  );
}

function DrawerShell({
  title,
  headerMeta,
  onClose,
  children,
}: {
  title: string;
  headerMeta: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="fixed inset-0 z-[1200] bg-black/30 animate-overview-backdrop-fade" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-y-0 right-0 z-[1300] flex w-full max-w-md flex-col overflow-y-auto border-l"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <div>
            <div className="flex flex-wrap items-center gap-2">{headerMeta}</div>
            <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-ink">{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded-md p-1 text-ink-faint hover:bg-surface-2 hover:text-ink-soft">
            <IconXCircle className="h-5 w-5" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </aside>
    </>
  );
}

// The manual + automated handling for a single failure branch. `compact` drops
// the trigger + pills header (used by the CrossDrawer, whose title/header
// already carry them).
function BranchDetail({ branch, compact = false }: { branch: Branch; compact?: boolean }) {
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      {!compact && (
        <div className="flex items-start justify-between gap-2">
          <p className="text-[0.85rem] font-semibold text-ink">{branch.trigger}</p>
          <div className="flex shrink-0 items-center gap-1.5">
            <MilestonePill milestone={branch.milestone} />
            <BranchPill status={branch.status} />
          </div>
        </div>
      )}
      <div className={`${compact ? "" : "mt-2.5 "}grid gap-2 sm:grid-cols-2`}>
        <div className="rounded-md border p-2.5" style={{ borderColor: washBorder("var(--tB)"), background: washBg("var(--tB)") }}>
          <p className="mini-h mb-1" style={{ color: "var(--tB)" }}>Manual first</p>
          <p className="text-[0.78rem] leading-relaxed text-ink-soft">{branch.manual}</p>
        </div>
        <div className="rounded-md border p-2.5" style={{ borderColor: washBorder("var(--tA)"), background: washBg("var(--tA)") }}>
          <p className="mini-h mb-1" style={{ color: "var(--tA)" }}>Automated</p>
          <p className="text-[0.78rem] leading-relaxed text-ink-soft">{branch.automated}</p>
        </div>
      </div>
      {branch.plan && (
        <p className="mt-2 font-mono text-[0.6rem] uppercase tracking-wide text-ink-faint">{branch.plan}</p>
      )}
    </div>
  );
}

function StageDrawer({ stage, filter, onClose }: { stage: Stage; filter: Filter; onClose: () => void }) {
  const st = STATUS_META[stage.status];
  const branches = branchesFor(stage, filter);
  return (
    <DrawerShell
      title={stage.label}
      onClose={onClose}
      headerMeta={
        <>
          <span className={`badge ${st.badge}`}>{st.label}</span>
          <MilestonePill milestone={stage.milestone} />
          {stage.plan && <span className="badge badge-neutral">{stage.plan}</span>}
        </>
      }
    >
      {stage.surface && stage.surface !== "—" && (
        <p className="mb-3 font-mono text-[0.62rem] uppercase tracking-wide text-ink-faint">Runs on · {stage.surface}</p>
      )}

      <p className="mini-h mb-1.5">Happy flow</p>
      <p className="text-[0.9rem] leading-relaxed text-ink">{stage.description}</p>

      {stage.code && stage.code.length > 0 && (
        <div className="mt-4">
          <p className="mini-h mb-1.5">Where it lives</p>
          <ul className="space-y-1">
            {stage.code.map((c) => (
              <li key={c} className="font-mono text-[0.72rem] leading-snug text-ink-soft">{c}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5">
        <p className="mini-h mb-2">
          Error handling{branches.length > 0 ? ` (${branches.length})` : ""}
        </p>
        {branches.length === 0 ? (
          <p className="text-[0.8rem] text-ink-faint">
            {(stage.branches ?? []).length === 0
              ? "No known failure modes for this stage."
              : "No failure modes in this milestone filter."}
          </p>
        ) : (
          <div className="space-y-2.5">
            {branches.map((b) => <BranchDetail key={b.id} branch={b} />)}
          </div>
        )}
      </div>
    </DrawerShell>
  );
}

function CrossDrawer({ branch, onClose }: { branch: Branch; onClose: () => void }) {
  return (
    <DrawerShell
      title={branch.trigger}
      onClose={onClose}
      headerMeta={
        <>
          <span className="badge badge-neutral">Any stage</span>
          <MilestonePill milestone={branch.milestone} />
          <BranchPill status={branch.status} />
        </>
      }
    >
      <p className="mini-h mb-1.5">How it&apos;s handled</p>
      <p className="text-[0.9rem] leading-relaxed text-ink">{branch.handling}</p>
      <div className="mt-4">
        <BranchDetail branch={branch} compact />
      </div>
    </DrawerShell>
  );
}
