import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      // One typeface for the whole product. Overriding `sans` (rather than
      // adding a new key) is what makes this global: Tailwind's preflight
      // sets `html { font-family: theme('fontFamily.sans') }`, so every page
      // outside the `.ds` scope picks Inter up without a per-page change.
      // The variable comes from next/font in app/layout.tsx; the same stack
      // is mirrored onto `--sans` in app/design-system.css for `.ds` pages.
      fontFamily: {
        sans: [
          'var(--font-sans, "Inter")',
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
      },
      // Bridges Tailwind utilities to the `.ds` botanical design-system CSS
      // variables (dashboard/app/design-system.css). These only resolve
      // inside an element carrying `className="ds"` — utilities built from
      // them (e.g. `bg-surface`, `text-ink-soft`) render as transparent/inherit
      // outside that scope, so any component using them must be a descendant
      // of the `.ds` root (see components/shell/StaffShell.tsx).
      colors: {
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        ink: "var(--ink)",
        "ink-soft": "var(--ink-soft)",
        "ink-faint": "var(--ink-faint)",
        line: "var(--line)",
        "line-strong": "var(--line-strong)",
        accent: "var(--accent)",
        "accent-ink": "var(--accent-ink)",
        bloom: "var(--tB)",
        warn: "var(--warn)",
        amber: "var(--tC)",
        crit: "var(--crit)",
        ok: "var(--ok)",
        neutral: "var(--neutral)",
      },
      borderRadius: {
        card: "var(--radius)",
      },
      boxShadow: {
        card: "var(--shadow)",
      },
    },
  },
  plugins: [],
};

export default config;
