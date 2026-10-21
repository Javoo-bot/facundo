"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { signOut } from "@/lib/auth";
import { applyTheme, getStoredTheme, type ThemeMode } from "@/lib/theme";

const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
  { mode: "system", label: "System" },
];

/** Derives up to two uppercase initials from an email address —
 * "jane.doe@x.com" -> "JD", "staff@x.com" -> "YO". Falls back to "?" for an
 * empty/garbled address so the avatar never renders blank. */
function initialsFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[.\-_+]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return (letters || "?").toUpperCase();
}

export default function UserMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("system");
  const containerRef = useRef<HTMLDivElement>(null);

  // Reflect the stored theme in the control after mount (SSR-safe).
  useEffect(() => {
    setTheme(getStoredTheme());
  }, []);

  function chooseTheme(mode: ThemeMode) {
    applyTheme(mode);
    setTheme(mode);
  }

  // Close on outside click or Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        title={email}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white shadow-sm transition hover:bg-accent-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      >
        {initialsFromEmail(email)}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-lg border border-line bg-surface py-1 text-sm shadow-lg"
        >
          <p className="truncate px-3 py-2 text-xs text-ink-soft" title={email}>
            Signed in as <span className="font-medium text-ink">{email}</span>
          </p>
          <div className="my-1 border-t border-line" />
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-ink hover:bg-surface-2"
          >
            Settings
          </Link>
          <Link
            href="/auth/reset"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-ink hover:bg-surface-2"
          >
            Change password
          </Link>
          <div className="my-1 border-t border-line" />
          <div className="px-3 py-2">
            <p className="mb-1.5 text-xs text-ink-soft">Theme</p>
            <div className="segmented" role="group" aria-label="Theme">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.mode}
                  type="button"
                  className={theme === opt.mode ? "on" : ""}
                  aria-pressed={theme === opt.mode}
                  onClick={() => chooseTheme(opt.mode)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => signOut()}
            className="block w-full px-3 py-2 text-left text-crit hover:bg-surface-2"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
