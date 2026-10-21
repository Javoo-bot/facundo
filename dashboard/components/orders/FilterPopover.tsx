"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** A `.filter-trigger` button that opens a small `.card` popover panel below
 * it — closes on outside click or Escape. Used for every Orders-list filter
 * except the Attention toggle pill (which is a plain on/off button). */
export default function FilterPopover({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: (close: () => void) => ReactNode;
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

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className={`filter-trigger${count > 0 ? " on" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        {count > 0 && <span className="count">{count}</span>}
      </button>
      {open && (
        <div
          className="card"
          style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 30, minWidth: 200, maxWidth: 280, padding: 12 }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
