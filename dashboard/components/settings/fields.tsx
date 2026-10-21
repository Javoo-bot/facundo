import type { ReactNode } from "react";

/** Small print under a control. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs text-ink-faint">{children}</p>;
}

/**
 * A bordered group inside a panel. `tone="crit"` tints it red — used for the
 * switches that have real-world consequences (payments paused, Shopify
 * write-back, live SMS), so a dangerous state is visible without reading.
 */
export function PanelCard({
  title,
  tone = "normal",
  children,
}: {
  title: string;
  tone?: "normal" | "crit" | "accent";
  children: ReactNode;
}) {
  const borderColor = tone === "crit" ? "var(--crit)" : tone === "accent" ? "var(--accent)" : "var(--line)";
  return (
    <section
      className="rounded-lg border p-4"
      style={{
        borderColor,
        background: tone === "crit" ? "color-mix(in srgb, var(--crit) 10%, transparent)" : "transparent",
      }}
    >
      <h3 className="mb-2 text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

/** Uppercase divider inside a card, for sub-groups of toggles. */
export function GroupLabel({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return (
    <div
      className={
        first
          ? "text-xs font-semibold uppercase tracking-wide text-ink-faint"
          : "mt-4 border-t border-line pt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint"
      }
    >
      {children}
    </div>
  );
}

/** Checkbox + label, with optional hint and a red label when `danger` is on. */
export function Toggle({
  label,
  checked,
  onChange,
  hint,
  danger = false,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  /** Colour the label red while `checked` — the state itself is the warning. */
  danger?: boolean;
}) {
  return (
    <div>
      <label className="flex items-center gap-3">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span
          className="text-sm font-medium"
          style={{ color: danger && checked ? "var(--crit)" : "var(--ink)" }}
        >
          {label}
        </span>
      </label>
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

/** Labelled text/email/tel input spanning the panel width. */
export function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "tel";
  placeholder?: string;
  hint?: ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-ink-soft">
        {label}
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
        />
      </label>
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

/** Labelled number input with a trailing unit, e.g. "30 minutes". */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  unit,
  labelWidth,
  step = 1,
}: {
  label: ReactNode;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  unit: string;
  /** Fixed label column width, so a stack of these aligns. */
  labelWidth?: string;
  /** Increment. Defaults to 1 (whole minutes/counts); the matching weights pass
   *  0.05, since a weight of 1.2 has to be expressible. */
  step?: number;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink">
      <span className={labelWidth ?? ""}>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 rounded-md border border-line px-3 py-1.5 text-sm text-ink"
      />
      <span className="text-sm text-ink-faint">{unit}</span>
    </label>
  );
}

/** Labelled `<select>` spanning the panel width. */
export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  hint?: ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-ink-soft">
        {label}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}
