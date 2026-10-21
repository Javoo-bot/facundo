"use client";
import { useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";

/** Colour cue. Headings and items are toned independently: a "Take off the
 *  table" heading can read as a warning while its items stay neutral. */
export type Tone = "default" | "warn" | "crit";
const TONE_COLOR: Record<Tone, string> = { default: "var(--ink)", warn: "var(--warn)", crit: "var(--crit)" };
const HEADING_COLOR: Record<Tone, string> = { default: "var(--ink-soft)", warn: "var(--warn)", crit: "var(--crit)" };

export type ActionItem = {
  key: string;
  label: string;
  tone?: Tone;
  disabled?: boolean;
  /** Native tooltip — the place for "why", since a menu row has no room for it. */
  title?: string;
  onSelect: () => void;
};

export type ActionGroup = {
  key: string;
  /** Omit for an unlabelled group — still renders as its own separated block. */
  heading?: string;
  tone?: Tone;
  items: ActionItem[];
};

/** One dropdown for every "too many buttons" cluster in the staff UI: a single
 *  trigger that opens grouped actions, closing on outside-click or Escape.
 *  Callers pass only the actions that are legal right now — an empty menu
 *  disables the trigger rather than opening onto nothing. */
export default function ActionMenu({
  label,
  groups,
  busy = false,
  align = "left",
  variant = "default",
}: {
  label: string;
  groups: ActionGroup[];
  busy?: boolean;
  align?: "left" | "right";
  variant?: "default" | "solid" | "ghost" | "warn";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const live = groups.filter((g) => g.items.length > 0);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // Nothing legal to do → the trigger stays visible (so rows stay aligned) but
  // dead, rather than opening an empty panel.
  const empty = live.length === 0;

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <Button
        variant={variant}
        disabled={busy || empty}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label} ▾
      </Button>
      {open && !empty && (
        <div
          role="menu"
          style={{
            position: "absolute", top: "calc(100% + 4px)", zIndex: 40, minWidth: 200,
            ...(align === "right" ? { right: 0 } : { left: 0 }),
            background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 10,
            boxShadow: "var(--shadow)", padding: 6,
          }}
        >
          {live.map((g) => (
            <div key={g.key} style={{ padding: "4px 2px" }}>
              {g.heading && (
                <div className="mini-h" style={{ padding: "2px 8px", color: HEADING_COLOR[g.tone ?? "default"] }}>{g.heading}</div>
              )}
              {g.items.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  title={it.title}
                  onClick={() => { setOpen(false); it.onSelect(); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left", padding: "7px 8px",
                    borderRadius: 7, fontSize: ".85rem", color: TONE_COLOR[it.tone ?? "default"],
                    background: "transparent", border: "none",
                    cursor: it.disabled ? "not-allowed" : "pointer", opacity: it.disabled ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = "var(--surface-2)"; }}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
