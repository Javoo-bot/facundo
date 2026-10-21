"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import BrandLogo from "@/components/BrandLogo";
import { BRAND, BRAND_NAME } from "@/lib/brand";
import { applyTheme, getStoredTheme } from "@/lib/theme";
import { useT } from "@/components/florist/LocaleProvider";

type IconProps = React.SVGProps<SVGSVGElement>;
const iconBase = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function IconTray(props: IconProps) {
  return (
    <svg {...iconBase} aria-hidden="true" {...props}>
      <path d="M3.75 13.5h4.2l1.3 2.25h5.5l1.3-2.25h4.2" />
      <path d="M5.2 6.75h13.6a1.5 1.5 0 011.47 1.2l1.43 7.05a1.5 1.5 0 01-1.47 1.8H4.27a1.5 1.5 0 01-1.47-1.8l1.43-7.05a1.5 1.5 0 011.47-1.2z" />
    </svg>
  );
}
function IconHistory(props: IconProps) {
  return (
    <svg {...iconBase} aria-hidden="true" {...props}>
      <path d="M3 12a9 9 0 109-9 9 9 0 00-8.5 6" />
      <path d="M3 4.5V8h3.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}
function IconWallet(props: IconProps) {
  return (
    <svg {...iconBase} aria-hidden="true" {...props}>
      <rect x="3" y="6.75" width="18" height="12" rx="2" />
      <path d="M3 10.5h18" />
      <circle cx="16.5" cy="14.75" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconUserCircle(props: IconProps) {
  return (
    <svg {...iconBase} aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <circle cx="12" cy="10" r="2.75" />
      <path d="M6.5 18.2a5.9 5.9 0 0111 0" />
    </svg>
  );
}
function IconHelp(props: IconProps) {
  return (
    <svg {...iconBase} aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M9.6 9.4a2.45 2.45 0 114.15 1.85c-.9.7-1.75 1.15-1.75 2.35" />
      <circle cx="12" cy="16.8" r=".85" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconChat(props: IconProps) {
  return (
    <svg {...iconBase} aria-hidden="true" {...props}>
      <path d="M4.5 5.25h15a1.5 1.5 0 011.5 1.5v8a1.5 1.5 0 01-1.5 1.5H9l-4.5 3.5v-3.5A1.5 1.5 0 013 14.75v-8a1.5 1.5 0 011.5-1.5z" />
    </svg>
  );
}

interface TabDef {
  href: string;
  labelKey: string;
  Icon: (p: IconProps) => React.ReactElement;
  active: (pathname: string) => boolean;
  badge?: "offers" | "messages";
}

// Labels are resolved via `t(tab.labelKey)` at each render site — this array
// is a module-level const (evaluated once, outside any component) so it
// can't call `t()` itself.
const TABS: TabDef[] = [
  { href: "/florist", labelKey: "ui.shell.nav.orders", Icon: IconTray, active: (p) => p === "/florist" || p.startsWith("/florist/orders"), badge: "offers" },
  { href: "/florist/messages", labelKey: "ui.shell.nav.messages", Icon: IconChat, active: (p) => p.startsWith("/florist/messages"), badge: "messages" },
  { href: "/florist/history", labelKey: "ui.shell.nav.history", Icon: IconHistory, active: (p) => p.startsWith("/florist/history") },
  { href: "/florist/balance", labelKey: "ui.shell.nav.balance", Icon: IconWallet, active: (p) => p === "/florist/balance" },
  { href: "/florist/account", labelKey: "ui.shell.nav.account", Icon: IconUserCircle, active: (p) => p === "/florist/account" },
];

const TAB_BAR_HEIGHT = 56;
const DESKTOP_NAV_HEIGHT = 60;
const MOBILE_HEAD_HEIGHT = 52;
// Keep in sync with the `md:` breakpoint (768px) used inline below — both the
// mobile bottom bar and the desktop top bar are always rendered; CSS decides
// which is visible so there's no client-only viewport check (no hydration
// mismatch, no layout flash).
const DESKTOP_BREAKPOINT = 768;

function NavBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        top: -4,
        right: -8,
        minWidth: 15,
        height: 15,
        padding: "0 3px",
        borderRadius: 999,
        background: "var(--crit)",
        color: "#fff",
        fontSize: ".55rem",
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
      }}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

/**
 * PWA shell for the florist app.
 *
 * - Below 768px: the original phone-app layout — a 480px-capped centered
 *   column plus a fixed bottom tab bar (Orders / History / Balance / Account).
 * - At ≥768px: a top nav bar (brand + horizontal nav items + open-offers
 *   badge) and a wider centered content area (~1040px), no bottom tab bar.
 *
 * Both bars are always rendered server + client side; `@media` rules (via
 * the `fc-shell-*` classes below, injected once with a plain <style> tag)
 * toggle visibility. That keeps this SSR-safe — no `window` viewport check,
 * so there's nothing for hydration to disagree about.
 */
export default function FloristShell({
  children,
  openOffersCount = 0,
  unreadMessagesCount = 0,
}: {
  children: React.ReactNode;
  openOffersCount?: number;
  unreadMessagesCount?: number;
}) {
  const pathname = usePathname() ?? "/florist";
  const { t } = useT();
  const badgeFor = (tab: TabDef) => (tab.badge === "offers" ? openOffersCount : tab.badge === "messages" ? unreadMessagesCount : 0);
  // Help sits in the header rather than the tab bar: six 60px targets don't fit
  // a phone, and a florist reaches for help from wherever they already are, not
  // by navigating to a section. It keeps its own active state so the page it
  // opens doesn't look orphaned from the nav.
  //
  // Spelled out rather than a "?" glyph: a question mark is a convention people
  // have to already know, and this is read by florists who have used the app
  // twice. The words are their own accessible name, so no aria-label.
  const helpActive = pathname.startsWith("/florist/help");
  const helpLink = (style: React.CSSProperties) => (
    <Link
      href="/florist/help"
      aria-current={helpActive ? "page" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: ".72rem",
        fontWeight: 600,
        lineHeight: 1.15,
        textAlign: "right",
        color: helpActive ? "var(--accent)" : "var(--ink-faint)",
        ...style,
      }}
    >
      <IconHelp style={{ width: 16, height: 16, flexShrink: 0 }} />
      {t("ui.shell.nav.help")}
    </Link>
  );

  // Apply the stored theme (light/dark/system) to the `.ds` roots. Re-run on
  // route change: each florist page renders its own `.ds` main that re-declares
  // the tokens and would otherwise fall back to the OS theme. Default is
  // "system" (getStoredTheme returns "system" when unset).
  useEffect(() => {
    applyTheme(getStoredTheme());
  }, [pathname]);

  return (
    <div className="fc-shell-root" style={{ minHeight: "100dvh", position: "relative" }}>
      <style>{`
        .fc-shell-col { max-width: 480px; margin: 0 auto; }
        .fc-shell-content { padding-top: calc(${MOBILE_HEAD_HEIGHT}px + env(safe-area-inset-top)); padding-bottom: calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom)); }
        .fc-shell-topnav { display: none; }
        .fc-shell-mobilehead { display: flex; }
        .fc-shell-bottomnav { display: flex; }
        /* Per-page content width + responsive grids. On mobile everything is a
           single column inside the 480px shell col; on desktop the inbox fills
           the wide col with a card grid, and reading pages use a comfortable
           760px. The .ds prefix matches .ds .page specificity and loads after
           design-system.css, so it wins the max-width. */
        .fc-card-grid { display: grid; gap: 10px; margin-top: 8px; }
        .fc-bouquet-grid { display: grid; gap: 14px; }
        @media (min-width: ${DESKTOP_BREAKPOINT}px) {
          .fc-shell-col { max-width: 1040px; }
          .fc-shell-content { padding-bottom: 24px; padding-top: calc(${DESKTOP_NAV_HEIGHT}px + 24px); }
          .fc-shell-topnav { display: flex; }
          .fc-shell-mobilehead { display: none; }
          .fc-shell-bottomnav { display: none; }
          .ds .fc-readable { max-width: 760px; }
          .fc-card-grid { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
          .fc-bouquet-grid { grid-template-columns: 1fr 1fr; }
        }
      `}</style>

      {/* Desktop top nav (≥768px) */}
      <nav
        aria-label="Florist navigation"
        className="fc-shell-topnav"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: DESKTOP_NAV_HEIGHT,
          alignItems: "center",
          justifyContent: "center",
          gap: 32,
          background: "var(--surface)",
          borderBottom: "1px solid var(--line)",
          zIndex: 40,
        }}
      >
        <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: "100%", maxWidth: 1040, padding: "0 24px" }}>
          {/* Brand pinned left so the nav items stay centered in the bar. */}
          <Link href="/florist" aria-label={BRAND_NAME[BRAND]} style={{ position: "absolute", left: 24, display: "inline-flex", alignItems: "center", color: "var(--ink)" }}>
            <BrandLogo size={22} style={{ height: 20, width: "auto" }} />
          </Link>
          <div style={{ display: "flex", gap: 6 }}>
            {TABS.map((tab) => {
              const active = tab.active(pathname);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  style={{
                    position: "relative",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "8px 14px",
                    borderRadius: 8,
                    fontSize: ".88rem",
                    fontWeight: 600,
                    color: active ? "var(--accent)" : "var(--ink-soft)",
                    background: active ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "transparent",
                  }}
                >
                  <tab.Icon style={{ width: 18, height: 18 }} />
                  {t(tab.labelKey)}
                  <NavBadge count={badgeFor(tab)} />
                </Link>
              );
            })}
          </div>
          {helpLink({ position: "absolute", right: 24, fontSize: ".8rem" })}
        </div>
      </nav>

      {/* Mobile top header (<768px) — brand + the Q&A link; nav lives in the
          bottom bar. The brand sits LEFT rather than centred now that a
          spelled-out label shares the bar: centred, the two collide below about
          380px, and a truncated "Questions and A…" is worse than either. */}
      <header
        className="fc-shell-mobilehead"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: `calc(${MOBILE_HEAD_HEIGHT}px + env(safe-area-inset-top))`,
          paddingTop: "env(safe-area-inset-top)",
          padding: "env(safe-area-inset-top) 16px 0",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          background: "var(--surface)",
          borderBottom: "1px solid var(--line)",
          zIndex: 40,
        }}
      >
        <Link href="/florist" aria-label={BRAND_NAME[BRAND]} style={{ display: "inline-flex", alignItems: "center", color: "var(--ink)" }}>
          <BrandLogo size={22} style={{ height: 20, width: "auto" }} />
        </Link>
        {helpLink({ flexShrink: 0 })}
      </header>

      <div className="fc-shell-col fc-shell-content">{children}</div>

      {/* Mobile bottom tab bar (<768px) */}
      <nav
        aria-label="Florist navigation"
        className="fc-shell-bottomnav"
        style={{
          position: "fixed",
          left: "50%",
          bottom: 0,
          transform: "translateX(-50%)",
          width: "100%",
          maxWidth: 480,
          height: `calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom))`,
          paddingBottom: "env(safe-area-inset-bottom)",
          background: "var(--accent)",
          borderTop: "1px solid rgba(0,0,0,.12)",
          boxShadow: "0 -2px 10px rgba(20,40,30,.18)",
          zIndex: 40,
        }}
      >
        {TABS.map((tab) => {
          const active = tab.active(pathname);
          const count = badgeFor(tab);
          const offersKey = count === 1 ? "ui.shell.nav.openOffersOne" : "ui.shell.nav.openOffersOther";
          const unreadKey = count === 1 ? "ui.shell.nav.unreadOne" : "ui.shell.nav.unreadOther";
          const label = count > 0
            ? `${t(tab.labelKey)}, ${t(tab.badge === "offers" ? offersKey : unreadKey, { count })}`
            : undefined;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              aria-label={label}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                position: "relative",
                color: active ? "#fff" : "rgba(255,255,255,.68)",
                fontSize: ".68rem",
                fontWeight: 600,
                height: TAB_BAR_HEIGHT,
              }}
            >
              {active && (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: 0,
                    left: "22%",
                    right: "22%",
                    height: 2,
                    background: "#fff",
                    borderRadius: "0 0 2px 2px",
                  }}
                />
              )}
              <span style={{ position: "relative", display: "inline-flex" }}>
                <tab.Icon style={{ width: 22, height: 22 }} />
                <NavBadge count={count} />
              </span>
              <span aria-hidden={!!label}>{t(tab.labelKey)}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
