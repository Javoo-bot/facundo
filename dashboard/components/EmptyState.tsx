import type { ReactNode } from "react";

export interface EmptyStateCta {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
}

// Generalized (not forked) so both the Overview "no cities yet" state and
// the city page's "no florists ingested yet" state share one component —
// per docs/superpowers/specs/2026-07-02-city-page-redesign-brief.md
// "Generalize (add props, don't duplicate)".
export default function EmptyState({
  icon,
  title,
  description,
  cta,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  /** Simple stateless CTA button — most callers (e.g. "+ Add city"). */
  cta?: EmptyStateCta;
  /** Escape hatch for a CTA that needs its own state/side-effects (e.g. the
   * city page's re-run button, which owns a busy flag and a toast queue) —
   * rendered instead of `cta` when provided. */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface px-6 py-16 text-center">
      {icon}
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="max-w-sm text-sm text-ink-soft">{description}</p>
      {action ? (
        <div className="mt-2">{action}</div>
      ) : cta ? (
        <button
          type="button"
          onClick={cta.onClick}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-ink active:scale-[0.98]"
        >
          {cta.icon}
          {cta.label}
        </button>
      ) : null}
    </div>
  );
}
