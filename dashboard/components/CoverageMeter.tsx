import { coverageBand, type CoverageBand } from "@/lib/bands";

const FILL_CLASSES: Record<CoverageBand, string> = {
  emerald: "bg-accent",
  amber: "bg-warn",
  red: "bg-crit",
  slate: "bg-neutral",
};

const TEXT_CLASSES: Record<CoverageBand, string> = {
  emerald: "text-accent",
  amber: "text-warn",
  red: "text-crit",
  slate: "text-ink-faint",
};

export default function CoverageMeter({
  pct,
  reachable,
  total,
}: {
  pct: number | null;
  /** Raw counts, rendered as a native `title` tooltip ("N of M reachable")
   * rather than a second visible label — the meter + % label already carry
   * the number. */
  reachable?: number;
  total?: number;
}) {
  const band = coverageBand(pct);
  const width = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const title =
    total != null && reachable != null ? `${reachable} of ${total} reachable` : undefined;

  return (
    <span className="inline-flex items-center gap-2" title={title}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
        <span
          className={`block h-full rounded-full ${FILL_CLASSES[band]}`}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className={`text-xs tabular-nums ${TEXT_CLASSES[band]}`}>
        {pct == null ? "—" : `${Math.round(pct)}%`}
      </span>
    </span>
  );
}
