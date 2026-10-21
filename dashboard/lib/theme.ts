// Client-side theme control for the .ds design system.
//
// design-system.css defines light tokens on `.ds`, a dark override under
// `@media (prefers-color-scheme: dark) .ds:not([data-theme="light"])`, and an
// explicit `.ds[data-theme="dark"]`. So:
//   - data-theme absent  → follow the OS (prefers-color-scheme)  ["system"]
//   - data-theme="dark"  → force dark
//   - data-theme="light" → force light
// Setting the attribute on the `.ds` root(s) is all that's needed. On the staff
// console the shell is a single `.ds` root that persists across client
// navigation, so the choice sticks without re-applying per route.

export type ThemeMode = "light" | "dark" | "system";
const STORAGE_KEY = "fc-theme";

export function getStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* localStorage unavailable */
  }
  return "system";
}

/** Applies `mode` to every `.ds` root in the document and persists the choice.
 * "system" clears the attribute so the tokens follow prefers-color-scheme. */
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.querySelectorAll<HTMLElement>(".ds").forEach((el) => {
    if (mode === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", mode);
  });
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* localStorage unavailable */
  }
}
