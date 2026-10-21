"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { timeOptions } from "@/lib/timeOptions";

/** Roughly the menu's max-height plus its offset. Below this much room under
 * the trigger we flip the menu above it instead — without this the last row's
 * menu (Sunday, at the bottom of a long form) opens off-screen. */
const FLIP_THRESHOLD_PX = 280;

/** Digits typed within this window count as one number: "9" then "3" then "0"
 * is 09:30, not three separate jumps to 09:00. */
const TYPEAHEAD_MS = 900;

/** A time picker that looks like the rest of the product.
 *
 * This replaces `<input type="time">`, which was the last stock-blue control in
 * an otherwise green app: Chromium paints the highlight on the hour/minute
 * segment as a selection overlay, and it is unreachable from CSS — `::selection`,
 * `::-webkit-datetime-edit-*-field:focus` and `:focus::-webkit-datetime-edit-*`
 * were each measured against Chrome 151 and either did nothing or composited
 * underneath the blue. `accent-color` only reaches the picker popup. A native
 * `<select>` is no better: its popup is drawn by the OS in the user's system
 * accent, blue for most people.
 *
 * So the menu is ours: same `.ac-list`/`.ac-item` markup the address
 * autocomplete uses, which means it inherits the design system's surface, line
 * and green-wash tokens and follows dark mode for free.
 *
 * Times are shown in 24h, matching what we store and what the cutoff buttons
 * on the same form already display — not the browser's locale format, which
 * would have shown a US visitor AM/PM for a value stored as "09:00". */
export default function TimeSelect({
  value,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  /** "HH:MM", 24-hour. */
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [flip, setFlip] = useState(false);

  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ buffer: "", at: 0 });

  const options = timeOptions(value);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openMenu = () => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    setFlip(!!rect && window.innerHeight - rect.bottom < FLIP_THRESHOLD_PX && rect.top > FLIP_THRESHOLD_PX);
    // Start where the current value is, so the first arrow press steps off it
    // rather than jumping to midnight.
    setActive(Math.max(0, options.indexOf(value)));
    setOpen(true);
  };

  // Click-away. mousedown rather than click, and on the document, so a press
  // that starts outside closes the menu before it can land on anything.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted option visible. Layout effect, not a plain one: the
  // menu opens already scrolled to the current value instead of visibly
  // jumping to it on the next frame.
  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLLIElement>(`#${CSS.escape(`${listId}-${active}`)}`)?.scrollIntoView({
      block: "nearest",
    });
  }, [open, active, listId]);

  const commit = (next: string) => {
    onChange(next);
    close(true);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Digits jump to a time from any state: "930" lands on 09:30. The buffer is
    // matched against "HHMM" so a partial "9" finds the first 09:xx.
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      const now = Date.now();
      const buffer = (now - typed.current.at > TYPEAHEAD_MS ? "" : typed.current.buffer) + e.key;
      typed.current = { buffer, at: now };
      const hit = options.findIndex((t) => t.replace(":", "").startsWith(buffer));
      if (hit >= 0) {
        if (!open) openMenu();
        setActive(hit);
      }
      return;
    }

    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(options[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      // Let focus leave, but don't leave a menu hanging over the next field.
      setOpen(false);
    }
  };

  return (
    <div className="ac-wrap fc-time" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="fc-time-trigger"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
      >
        {value}
      </button>
      {open && (
        <ul
          ref={listRef}
          className={`ac-list fc-time-menu${flip ? " is-flipped" : ""}`}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.map((t, i) => (
            <li
              key={t}
              id={`${listId}-${i}`}
              className={`ac-item fc-time-item${i === active ? " is-active" : ""}`}
              role="option"
              aria-selected={t === value}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()} // keep focus on the trigger so the click lands
              onClick={() => commit(t)}
            >
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
