"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import BrandLogo from "@/components/BrandLogo";
import JobsPanel from "@/components/JobsPanel";
import UserMenu from "@/components/UserMenu";
import GlobalSearch from "@/components/shell/GlobalSearch";
import { applyTheme, getStoredTheme } from "@/lib/theme";
import {
  IconBuildingStorefront,
  IconChartBar,
  IconChatBubble,
  IconChevronRight,
  IconActivity,
  IconClock,
  IconCompass,
  IconCreditCard,
  IconFlow,
  IconGlobe,
  IconHome,
  IconMail,
  IconPhone,
  IconMenu,
  IconReceipt,
  IconSettings,
  IconShieldCheck,
  type IconProps,
} from "@/components/icons";
import type { StaffRole } from "@/lib/staffRoles";
import { BRAND, BRAND_NAME, type BrandId } from "@/lib/brand";

const COLLAPSE_STORAGE_KEY = "fc-staff-sidebar-collapsed";

/** A sub-view of a nav item, listed under it while you are inside that section.
 * Deliberately not its own top-level entry: these are two views of one screen,
 * and promoting them would put a second "Statistics" in the sidebar and invite
 * exactly the "which of these do I open?" question the Operator/Orders comment
 * below exists to avoid. */
interface NavChild {
  href: string;
  label: string;
  /** Optional glyph before the label. Sub-menu entries are normally plain
   *  text — the parent's icon covers the group — so one here means "this child
   *  is a different KIND of thing from its siblings". Wait time is settings;
   *  the three next to it are content. */
  icon?: (props: IconProps) => ReactNode;
}

interface NavItem {
  href: string;
  label: string;
  icon: (props: IconProps) => React.ReactElement;
  /** Attention count, shown as a `badge-crit` pill when > 0. Carried by the
   * Control panel and Operator, which read the same gatherAttention list. */
  badgeKey?: "attention";
  /** Roles that can see this item. Omitted = every role. */
  roles?: StaffRole[];
  /** Sub-views, revealed only while this section is open. The first one should
   * be the item's own href, so the list reads as a complete set rather than as
   * "the parent, plus the other one". */
  children?: NavChild[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "OPERATIONS",
    items: [
      // The attention badge used to hang off a separate /cx desk. That desk is
      // gone; the Control panel's own attention table is now the only place
      // that queue is rendered, so the count rides here.
      { href: "/", label: "Control panel", icon: IconHome, badgeKey: "attention" },
      // ONE PLACE WORK STARTS, ONE PLACE TO LOOK THINGS UP (3 Sept 2026).
      //
      // An Operator panel used to sit between these two, rendering the same
      // gatherAttention queue as the Control panel's badge above — and Orders
      // was hidden from the sidebar entirely, on the argument that "Operator"
      // and "Orders" side by side invite the question the Operator panel
      // existed to remove: which of these do I open?
      //
      // Retiring the Operator panel dissolves that. The Control panel is where
      // the day starts; Orders is the reference list. Two entries, two plainly
      // different jobs, and no screen duplicating another.
      //
      // (The old comment also claimed the Operator panel linked here as "See
      // all orders". It never did — global search and deep links were the only
      // ways in, which is a poor way to reach the full order list.)
      //
      // NO BADGE on Orders, deliberately: an escalated order is already counted
      // in the Control panel's attention badge above, and two red pills for one
      // order read as two problems. To add one, bring back the escalated-order
      // count in app/(staff)/layout.tsx.
      { href: "/orders", label: "Orders", icon: IconReceipt },
      { href: "/payments", label: "Payments", icon: IconCreditCard, roles: ["finance", "admin"] },
      { href: "/communications", label: "Communications", icon: IconMail },
      // Two-way threads with florists, and anything the outreach assistant
      // handed over. Order-agnostic on purpose: a recruiting conversation has
      // no order behind it.
      { href: "/conversations", label: "Conversations", icon: IconChatBubble },
      // Two views of one screen, so they live under Statistics rather than as a
      // segmented control on the page itself: the sidebar is where this team
      // navigates, and a tab strip inside the page was a second navigation
      // system for one feature.
      {
        href: "/statistics",
        label: "Statistics",
        icon: IconChartBar,
        roles: ["ops", "admin"],
        children: [
          { href: "/statistics", label: "General" },
          { href: "/statistics/funnel", label: "Visual funnel" },
        ],
      },
    ],
  },
  {
    label: "PARTNERS",
    items: [
      { href: "/florists", label: "Florists", icon: IconBuildingStorefront },
      { href: "/discovery", label: "Discovery", icon: IconCompass },
      // Who is partway through a recruiting funnel. Under PARTNERS rather than
      // OPERATIONS: this is about acquiring florists, not running orders.
      { href: "/sequences", label: "Sequences", icon: IconMail },
      // The call list. Sequences answers "what is the funnel doing"; this
      // answers "who do I phone next", which is a different job for a
      // different person — hence its own item rather than a tab in there.
      { href: "/reach-out", label: "Reach Out", icon: IconPhone, roles: ["ops", "admin"] },
      { href: "/admin/tiers", label: "Trust tiers", icon: IconShieldCheck, roles: ["ops", "admin"] },
    ],
  },
  {
    label: "SYSTEM",
    items: [
      { href: "/lifecycle", label: "Order lifecycle", icon: IconFlow, roles: ["ops", "admin"] },
      // One tab, one sub-menu entry per funnel. The steps, their waits and
      // their words all live behind these three links, so the acceptance
      // window and the cut-off offset stop being things only a developer can
      // change. Same sub-menu mechanism as Statistics above, for the same
      // reason: the sidebar is where this team navigates.
      {
        href: "/flows",
        label: "Order flows",
        icon: IconFlow,
        roles: ["ops", "admin"],
        children: [
          // Wait time first: it is the shape of the funnel — how long between
          // each message — and it reads as the thing the three message screens
          // below then fill in.
          { href: "/flows/wait-time", label: "Wait time", icon: IconSettings },
          { href: "/flows/assignment", label: "Local florist assignment" },
          { href: "/flows/order-reachout", label: "“We have an order”" },
          { href: "/flows/cold", label: "Cold reach-out" },
        ],
      },
      { href: "/operations", label: "External ops", icon: IconActivity, roles: ["ops", "admin"] },
      { href: "/jobs", label: "Jobs", icon: IconClock, roles: ["ops", "admin"] },
      { href: "/messages", label: "Messages", icon: IconGlobe, roles: ["admin"] },
      // The flat per-key list. /messages covers the same copy rendered as the
      // recipient sees it; this stays for the ~450 ui.* florist-app strings,
      // which have no message to preview.
      // The florist-facing Q&A (/help + /florist/help), edited answer by answer.
      { href: "/faq", label: "Florist Q&A", icon: IconGlobe, roles: ["admin"] },
      { href: "/email-templates", label: "All copy keys", icon: IconGlobe, roles: ["admin"] },
      // Creates and deletes florists and fires real sends, so admin-only —
      // the same gate as Settings, not the general staff one.
      { href: "/testing", label: "Test stores", icon: IconCompass, roles: ["admin"] },
      { href: "/settings", label: "Settings", icon: IconSettings, roles: ["admin"] },
    ],
  },
];

// The Smart design menu (docs/design/client-brand-smart-design): the six screens
// a person needs when agents run the orders. Same routes as above under the
// client-facing names; every other page is still reachable by URL and search.
const SMART_DESIGN_NAV: NavGroup[] = [
  {
    label: "",
    items: [
      { href: "/", label: "Today", icon: IconHome, badgeKey: "attention" },
      { href: "/orders", label: "Deliveries", icon: IconReceipt },
      { href: "/conversations", label: "Inbox", icon: IconChatBubble },
      { href: "/payments", label: "Payouts", icon: IconCreditCard, roles: ["finance", "admin"] },
      { href: "/florists", label: "Partners", icon: IconBuildingStorefront },
      {
        href: "/statistics",
        label: "Reports",
        icon: IconChartBar,
        roles: ["ops", "admin"],
        children: [
          { href: "/statistics", label: "General" },
          { href: "/statistics/funnel", label: "Visual funnel" },
        ],
      },
    ],
  },
];

const NAV_BY_BRAND: Record<BrandId, NavGroup[]> = {
  facundo: NAV_GROUPS,
  "smart-design": SMART_DESIGN_NAV,
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({
  item,
  active,
  inSection = false,
  collapsed,
  badgeCount,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  /** The section is open but a CHILD carries the active treatment. The parent
   * goes to full-strength ink without the wash and the inset bar, so there is
   * exactly one highlighted row and it is the view you are looking at. */
  inSection?: boolean;
  collapsed: boolean;
  badgeCount: number;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={`flex h-10 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
        active ? "text-accent-ink" : inSection ? "text-ink hover:bg-surface-2" : "text-ink-soft hover:bg-surface-2"
      } ${collapsed ? "justify-center" : ""}`}
      style={
        active
          ? { background: "var(--tA-wash)", boxShadow: "inset 3px 0 0 var(--accent)" }
          : undefined
      }
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {!collapsed && badgeCount > 0 && (
        <span className="badge badge-crit ml-auto">{badgeCount}</span>
      )}
      {collapsed && badgeCount > 0 && (
        <span
          aria-hidden="true"
          className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--crit)" }}
        />
      )}
    </Link>
  );
}

function SidebarNav({
  collapsed,
  pathname,
  role,
  badgeCounts,
  operatorView = false,
  onNavigate,
}: {
  collapsed: boolean;
  pathname: string;
  role: StaffRole | null;
  badgeCounts: { attention: number };
  /** `app_settings.operator_view` — see OPERATOR_HIDDEN. */
  operatorView?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-2 py-4">
      {NAV_BY_BRAND[BRAND].map((group) => {
        const items = group.items.filter((item) => {
          if (item.roles && !(role && item.roles.includes(role))) return false;
          // The Smart design menu is already the short one; operator view would
          // only take Inbox out of it.
          if (operatorView && BRAND === "facundo" && OPERATOR_HIDDEN.has(item.href)) return false;
          return true;
        });
        if (items.length === 0) return null;
        return (
          <div key={group.label}>
            {!collapsed && group.label && <p className="mini-h px-2.5 pb-1.5">{group.label}</p>}
            <div className="flex flex-col gap-0.5">
              {items.map((item) => {
                const open = isActive(pathname, item.href);
                // Sub-views appear only while you are inside the section, and
                // never in the collapsed rail (36px of icon has nowhere to put
                // them). Permanently listing every sub-view would add rows to a
                // sidebar that already carries eighteen.
                const children = open && !collapsed ? item.children : undefined;
                return (
                  <div key={item.href} className="relative">
                    <NavLink
                      item={item}
                      // With children showing, the exactly-matching child owns
                      // the active treatment — otherwise two rows light up for
                      // one screen and neither reads as "you are here".
                      active={open && !children}
                      inSection={open && Boolean(children)}
                      collapsed={collapsed}
                      badgeCount={item.badgeKey ? badgeCounts[item.badgeKey] : 0}
                      onNavigate={onNavigate}
                    />
                    {children && (
                      <div className="mt-0.5 flex flex-col gap-0.5">
                        {children.map((child) => {
                          // Exact match, never a prefix: "/statistics" is a
                          // prefix of "/statistics/funnel", so a prefix test
                          // would light General on the funnel page too.
                          const childActive = pathname === child.href;
                          return (
                            <Link
                              key={child.href}
                              href={child.href}
                              onClick={onNavigate}
                              aria-current={childActive ? "page" : undefined}
                              className={`ml-[19px] flex h-8 items-center rounded-lg border-l pl-3.5 pr-2.5 text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
                                childActive
                                  ? "font-semibold text-accent-ink"
                                  : "font-medium text-ink-soft hover:bg-surface-2 hover:text-ink"
                              }`}
                              style={{ borderLeftColor: childActive ? "var(--accent)" : "var(--line)" }}
                            >
                              {child.icon && (
                                <child.icon className="mr-1.5 h-3.5 w-3.5 flex-none opacity-70" />
                              )}
                              <span className="truncate">{child.label}</span>
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/** What "Operator view" hides. Everything an operator working the queue never
 *  opens: how the funnels are worded, who is mid-recruiting, what the ingest
 *  jobs did. In code rather than in the database because it is a judgement
 *  about what the job needs, not a per-tenant preference — and because a list
 *  of hrefs in a settings row is a way to hide a link that no longer exists.
 *
 *  HIDES LINKS ONLY. Every route keeps its own role gate, so this declutters
 *  the sidebar and grants nobody anything.
 *
 *  It applies to EVERYONE, admins included — an admin who turns it on and sees
 *  no change has no way to tell whether it worked. Settings is deliberately
 *  not in the list, so the way to turn it off is always one click away. */
const OPERATOR_HIDDEN = new Set([
  "/communications",
  "/conversations",
  "/sequences",
  "/admin/tiers",
  "/lifecycle",
  "/operations",
  "/jobs",
  "/messages",
  "/email-templates",
  "/testing",
  "/faq",
]);

export default function StaffShell({
  userEmail,
  role,
  testMode,
  attentionCount,
  operatorView = false,
  children,
}: {
  userEmail: string;
  /** The signed-in staff member's permission level — narrows which sidebar
   * items render (see NAV_GROUPS' per-item `roles`). */
  role: StaffRole | null;
  testMode: boolean;
  /** Count of orders needing a human across the loop — the badge on both the
   * Control panel and Operator (see lib/cxAttention.ts). */
  attentionCount: number;
  /** `app_settings.operator_view`. Shortens the sidebar for non-admin staff. */
  operatorView?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Apply the saved theme (light/dark/system) to every `.ds` root. Re-run on
  // navigation because some pages mount their own nested `.ds` (e.g. the
  // discovery `<main className="ds page">`), which re-declares the tokens and
  // would otherwise fall back to the OS theme on client-side route changes.
  // SSR renders without data-theme (follows the OS); a brief flash on first
  // paint is the same tradeoff as the collapse-state restore below.
  useEffect(() => {
    applyTheme(getStoredTheme());
  }, [pathname]);

  // Restore the persisted collapse preference after mount (not in the
  // useState initializer) so the server-rendered markup and the first client
  // render match — avoids a hydration mismatch. This causes a one-frame
  // "expanded" flash on reload for users who collapsed it, which is an
  // acceptable tradeoff for a POC.
  useEffect(() => {
    const stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (stored === "1") setCollapsed(true);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  // Route changes should close the mobile drawer.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const badgeCounts = { attention: attentionCount };
  const sidebarWidth = collapsed ? 64 : 240;

  return (
    <div className="ds min-h-screen">
      {/* Desktop sidebar — fixed, collapsible (state persisted to localStorage). */}
      <aside
        className="fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-line bg-surface transition-[width] duration-150 lg:flex"
        style={{ width: sidebarWidth }}
      >
        {/* Brand header — full wordmark when expanded, square mark when collapsed. */}
        <div
          className={`flex h-14 shrink-0 items-center border-b border-line ${
            collapsed ? "justify-center px-2" : "px-4"
          }`}
        >
          <Link href="/" aria-label={`${BRAND_NAME[BRAND]} home`} className="flex items-center">
            {collapsed ? (
              <BrandLogo variant="mark" size={26} />
            ) : (
              <BrandLogo className="h-[22px] w-auto text-ink" />
            )}
          </Link>
        </div>
        <SidebarNav collapsed={collapsed} pathname={pathname} role={role} badgeCounts={badgeCounts} operatorView={operatorView} />
        <div className="border-t border-line p-2">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={`flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-ink-soft hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
              collapsed ? "justify-center" : ""
            }`}
          >
            <IconChevronRight
              className="h-[18px] w-[18px] shrink-0 transition-transform"
              style={{ transform: collapsed ? "rotate(0deg)" : "rotate(180deg)" }}
            />
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Mobile off-canvas drawer — mirrors the JobsPanel drawer mechanic
       * (backdrop click / Escape to close), sliding in from the left. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-[1100] bg-black/40 animate-overview-backdrop-fade lg:hidden"
          onClick={() => setMobileOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="fixed inset-y-0 left-0 flex w-64 flex-col bg-surface shadow-2xl animate-staff-sidebar-drawer-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex h-14 items-center justify-between border-b border-line px-3">
              <BrandLogo size={22} className="h-[20px] w-auto text-ink" />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation"
                className="rounded-md px-2 py-1 text-ink-faint hover:bg-surface-2 hover:text-ink-soft"
              >
                &times;
              </button>
            </div>
            <SidebarNav
              collapsed={false}
              pathname={pathname}
              role={role}
              badgeCounts={badgeCounts}
              operatorView={operatorView}
              onNavigate={() => setMobileOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Content column — offset by the desktop sidebar width. */}
      <div className={`flex min-h-screen flex-col ${collapsed ? "lg:ml-16" : "lg:ml-60"} transition-[margin] duration-150`}>
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="rounded-md p-1.5 text-ink-soft hover:bg-surface-2 lg:hidden"
          >
            <IconMenu className="h-5 w-5" />
          </button>

          <div className="min-w-0 grow-[2] basis-0 max-w-2xl">
            <GlobalSearch />
          </div>
          {/* Spacer absorbs leftover width so the cluster stays pinned right
           * while the search grows to fill most of the bar. */}
          <div className="grow" aria-hidden />

          <div className="flex shrink-0 items-center gap-2.5">
            <span className={`badge ${testMode ? "badge-warn" : "badge-accent"}`}>
              {testMode ? "TEST MODE" : "LIVE"}
            </span>
            <JobsPanel />
            <UserMenu email={userEmail} />
          </div>
        </header>

        {testMode && (
          <div
            role="status"
            className="flex h-7 shrink-0 items-center justify-center text-center font-mono text-[11px] font-semibold uppercase tracking-wide"
            style={{ background: "var(--tC-wash)", color: "var(--warn)" }}
          >
            TEST MODE — no real payments or emails are sent.
          </div>
        )}

        <main className="flex-1 bg-[var(--bg)]">{children}</main>
      </div>
    </div>
  );
}
