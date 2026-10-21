"use client";

/**
 * The Settings tablist. Uses the shared `.ds .segmented` style
 * (app/design-system.css) that the florist inbox's view switcher already uses;
 * StaffShell wraps every staff route in `.ds`, so it applies here.
 */

export const SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "matching", label: "Matching" },
  { id: "offers", label: "Offers" },
  { id: "payments", label: "Payments" },
  { id: "notifications", label: "Notifications" },
  { id: "outreach", label: "Outreach" },
  { id: "integrations", label: "Integrations" },
  { id: "personas", label: "Personas" },
  { id: "access", label: "Access" },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

/** Narrow an untrusted `?tab=` value; anything unknown falls back to General. */
export function parseTab(value: string | null): SettingsTabId {
  const match = SETTINGS_TABS.find((t) => t.id === value);
  return match ? match.id : "general";
}

export default function SettingsTabs({
  active,
  onChange,
}: {
  active: SettingsTabId;
  onChange: (tab: SettingsTabId) => void;
}) {
  return (
    <div className="segmented flex-wrap" role="tablist" aria-label="Settings sections">
      {SETTINGS_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`settings-tab-${tab.id}`}
          aria-selected={active === tab.id}
          aria-controls={`settings-panel-${tab.id}`}
          className={active === tab.id ? "on" : ""}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
