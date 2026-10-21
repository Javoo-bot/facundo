export default function StageTile({
  label,
  count,
  sub,
  active,
  onClick,
}: {
  label: string;
  count: number;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded-lg border p-3 text-left transition ${
        active ? "border-accent ring-1 ring-[var(--accent)]" : "border-line hover:border-line-strong"
      } bg-surface`}
    >
      <div className="text-2xl font-bold leading-none text-ink tabular-nums">{count}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-ink-soft">{label}</div>
      <div className="mt-0.5 text-[10px] text-ink-faint">{sub}</div>
    </button>
  );
}
