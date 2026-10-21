"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut } from "@/lib/auth";
import { enablePush } from "@/lib/pushClient";
import { createBrowserClient } from "@/lib/supabase";
import { applyTheme, getStoredTheme, type ThemeMode } from "@/lib/theme";
import { LOCALES, type Locale } from "@/lib/i18n";
import { useT } from "@/components/florist/LocaleProvider";
import { useViewAsReadOnly } from "@/components/florist/ViewAsContext";

const field: React.CSSProperties = { height: 42, padding: "0 12px", width: "100%", fontSize: ".9rem" };

/** Up to two uppercase initials from an email's local part, e.g.
 * "jane.doe@x.com" -> "JD". Falls back to "?" for an empty/garbled address. */
function initialsFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[.\-_+]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return (letters || "?").toUpperCase();
}

const THEME_OPTIONS: ThemeMode[] = ["light", "dark", "system"];

/** Light / Dark / System theme picker. Defaults to System (follows the OS).
 * Applies to every `.ds` root and persists via lib/theme. */
function ThemeControl() {
  const { t } = useT();
  const [theme, setTheme] = useState<ThemeMode>("system");
  // Reflect the stored choice after mount (SSR-safe — server can't read localStorage).
  useEffect(() => { setTheme(getStoredTheme()); }, []);
  function choose(mode: ThemeMode) {
    applyTheme(mode);
    setTheme(mode);
  }
  return (
    <div style={{ padding: "12px 16px", display: "grid", gap: 8 }}>
      <span style={{ fontSize: ".92rem", color: "var(--ink)" }}>{t("ui.account.theme.title")}</span>
      <div className="segmented" role="group" aria-label={t("ui.account.theme.ariaLabel")} style={{ width: "100%" }}>
        {THEME_OPTIONS.map((mode) => (
          <button
            key={mode}
            type="button"
            className={theme === mode ? "on" : ""}
            aria-pressed={theme === mode}
            onClick={() => choose(mode)}
            style={{ flex: 1 }}
          >
            {t(`ui.account.theme.${mode}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Language picker — one locale per florist ACCOUNT (florists.locale), not per
 * team member. Posts to /api/florist/locale, then reloads so the server
 * layout re-resolves locale and every translated string updates. */
function LanguageControl() {
  const { locale, t } = useT();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: Locale) {
    if (next === locale) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/florist/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      });
      if (!res.ok) { setError(t("ui.account.language.error")); return; }
      window.location.reload(); // full reload: server layout must re-resolve locale
    } catch {
      setError(t("ui.account.language.error"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: "12px 16px", display: "grid", gap: 8 }}>
      <span style={{ fontSize: ".92rem", color: "var(--ink)" }}>{t("ui.account.language.title")}</span>
      <div className="segmented" role="group" aria-label={t("ui.account.language.title")} style={{ width: "100%", flexWrap: "wrap" }}>
        {LOCALES.map((l) => (
          <button
            key={l}
            type="button"
            className={locale === l ? "on" : ""}
            aria-pressed={locale === l}
            onClick={() => choose(l)}
            disabled={saving}
            style={{ flex: 1 }}
          >
            {t(`ui.account.language.${l}`)}
          </button>
        ))}
      </div>
      {saving && <span style={{ fontSize: ".8rem", color: "var(--ink-faint)" }}>{t("ui.account.language.saving")}</span>}
      {error && <span style={{ fontSize: ".8rem", color: "var(--crit)" }}>{error}</span>}
    </div>
  );
}

/** Inline password change for the signed-in florist — expands in place and
 * calls Supabase updateUser, so there's no navigation away from Account. */
function ChangePassword() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setMsg(null);
    if (pw.length < 8) { setMsg({ ok: false, text: t("ui.account.password.tooShort") }); return; }
    if (pw !== pw2) { setMsg({ ok: false, text: t("ui.account.password.mismatch") }); return; }
    setBusy(true);
    const { error } = await createBrowserClient().auth.updateUser({ password: pw });
    setBusy(false);
    if (error) { setMsg({ ok: false, text: error.message }); return; }
    setPw(""); setPw2("");
    setMsg({ ok: true, text: t("ui.account.password.updated") });
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen((o) => !o); setMsg(null); }}
        style={{ ...row, width: "100%", border: "none", background: "transparent", cursor: "pointer", textAlign: "left" }}
      >
        <span>{t("ui.account.password.title")}</span>
        <span aria-hidden style={{ color: "var(--ink-faint)", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>{"›"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 14px", display: "grid", gap: 8 }}>
          <input type="password" placeholder={t("ui.account.password.newPlaceholder")} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" style={field} />
          <input type="password" placeholder={t("ui.account.password.confirmPlaceholder")} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" style={field} />
          <button type="button" className="btn btn-solid" onClick={save} disabled={busy || !pw || !pw2} style={{ minHeight: 44, justifySelf: "start" }}>
            {busy ? t("ui.account.password.saving") : t("ui.account.password.update")}
          </button>
          {msg && <span style={{ fontSize: ".8rem", color: msg.ok ? "var(--accent)" : "var(--crit)" }}>{msg.text}</span>}
        </div>
      )}
    </div>
  );
}

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  height: 48,
  padding: "0 16px",
  fontSize: ".92rem",
  color: "var(--ink)",
};

/** Team management — visible to both roles, invite/revoke/remove controls only
 * for the owner. No real email is sent for invites (matches this project's
 * "drafts generated, not sent" outreach convention) — the owner copies the
 * returned link and shares it however they like. */
function TeamSection({
  role,
  team,
  pendingInvites,
  readOnly,
}: {
  role: "owner" | "member";
  team: { email: string; role: string; created_at: string }[];
  pendingInvites: { id: string; email: string; created_at: string; expires_at: string }[];
  readOnly: boolean;
}) {
  const { t } = useT();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const router = useRouter();

  async function sendInvite() {
    setInviting(true);
    setMsg(null);
    setInviteLink(null);
    try {
      const res = await fetch("/api/florist/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ ok: false, text: json.error ?? t("ui.account.team.inviteError") }); return; }
      setInviteLink(json.inviteUrl);
      setInviteEmail("");
      router.refresh();
    } finally {
      setInviting(false);
    }
  }

  async function revokeInvite(inviteId: string) {
    setBusyAction(inviteId);
    try {
      await fetch("/api/florist/invite/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteId }),
      });
      router.refresh();
    } finally {
      setBusyAction(null);
    }
  }

  async function removeTeammate(email: string) {
    setBusyAction(email);
    try {
      await fetch("/api/florist/team/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      router.refresh();
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="card" style={{ marginTop: 14, padding: 16, display: "grid", gap: 12 }}>
      <div style={{ fontWeight: 700, fontSize: ".92rem" }}>{t("ui.account.team.title")}</div>
      <div style={{ display: "grid", gap: 6 }}>
        {team.map((member) => (
          <div key={member.email} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: ".88rem" }}>
            <span>{member.email} <span style={{ color: "var(--ink-faint)", fontSize: ".78rem" }}>· {member.role === "owner" ? t("ui.account.team.owner") : t("ui.account.team.member")}</span></span>
            {role === "owner" && !readOnly && member.role !== "owner" && (
              <button type="button" onClick={() => removeTeammate(member.email)} disabled={busyAction === member.email} className="btn btn-ghost" style={{ color: "var(--crit)", height: 32, padding: "0 10px" }}>
                {busyAction === member.email ? t("ui.account.team.removing") : t("ui.account.team.remove")}
              </button>
            )}
          </div>
        ))}
      </div>

      {role === "owner" && (
        <>
          {pendingInvites.length > 0 && (
            <div style={{ display: "grid", gap: 6, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
              <span style={{ fontSize: ".8rem", color: "var(--ink-faint)" }}>{t("ui.account.team.pendingInvites")}</span>
              {pendingInvites.map((inv) => (
                <div key={inv.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: ".85rem" }}>
                  <span>{inv.email}</span>
                  {!readOnly && (
                    <button type="button" onClick={() => revokeInvite(inv.id)} disabled={busyAction === inv.id} className="btn btn-ghost" style={{ color: "var(--crit)", height: 32, padding: "0 10px" }}>
                      {busyAction === inv.id ? t("ui.account.team.revoking") : t("ui.account.team.revoke")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {!readOnly && (
          <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            <span style={{ fontSize: ".8rem", color: "var(--ink-faint)" }}>{t("ui.account.team.inviteHeading")}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="email" placeholder={t("ui.account.team.invitePlaceholder")} value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} style={field} />
              <button type="button" className="btn btn-solid" onClick={sendInvite} disabled={inviting || !inviteEmail.trim()} style={{ minHeight: 42, flexShrink: 0 }}>
                {inviting ? t("ui.account.team.inviting") : t("ui.account.team.invite")}
              </button>
            </div>
            {inviteLink && (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input readOnly value={inviteLink} style={{ ...field, fontSize: ".78rem" }} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(inviteLink)} style={{ minHeight: 42, flexShrink: 0 }}>
                  {t("ui.account.team.copy")}
                </button>
              </div>
            )}
            {msg && <span style={{ fontSize: ".8rem", color: msg.ok ? "var(--accent)" : "var(--crit)" }}>{msg.text}</span>}
          </div>
          )}
        </>
      )}
    </div>
  );
}

type PushState = "unsupported" | "off" | "requesting" | "on" | "error";

export default function FloristAccount({
  email,
  role,
  team,
  pendingInvites,
}: {
  email: string;
  role: "owner" | "member";
  team: { email: string; role: string; created_at: string }[];
  pendingInvites: { id: string; email: string; created_at: string; expires_at: string }[];
}) {
  const { t } = useT();
  const readOnly = useViewAsReadOnly();
  const [pushState, setPushState] = useState<PushState>("off");
  const [pushError, setPushError] = useState<string | null>(null);

  // Browser-only APIs (Notification, navigator) — guard behind mount so this
  // never runs during SSR of this client component.
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushState("unsupported");
      return;
    }
    setPushState(Notification.permission === "granted" ? "on" : "off");
  }, []);

  const handleEnablePush = async () => {
    setPushState("requesting");
    setPushError(null);
    const result = await enablePush();
    if (result.ok) {
      setPushState("on");
    } else {
      setPushState("error");
      setPushError(result.error ?? t("ui.account.push.error"));
    }
  };

  return (
    <main className="ds page fc-readable">
      <h1>{t("ui.account.title")}</h1>

      <div className="card" style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
        <div
          aria-hidden
          style={{
            width: 48,
            height: 48,
            borderRadius: "50%",
            background: "var(--accent)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            fontSize: "1rem",
            flexShrink: 0,
          }}
        >
          {initialsFromEmail(email || "?")}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={email}>
            {email || t("ui.account.signedIn")}
          </div>
          <div style={{ color: "var(--ink-faint)", fontSize: ".78rem" }}>{t("ui.account.subtitle")}</div>
        </div>
      </div>

      <TeamSection role={role} team={team} pendingInvites={pendingInvites} readOnly={readOnly} />

      <div className="card" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
        {!readOnly && (
          <>
            <ChangePassword />
            <div style={{ borderTop: "1px solid var(--line)" }} />
          </>
        )}
        <Link href="/florist/install" style={row}>
          <span>{t("ui.account.installLink")}</span>
          <span aria-hidden style={{ color: "var(--ink-faint)" }}>{"›"}</span>
        </Link>
        <div style={{ borderTop: "1px solid var(--line)" }} />
        {/* The header's "?" is the fast route; this is for the florist who
            goes looking for settings-shaped things by name. Same page. */}
        <Link href="/florist/help" style={row}>
          <span>{t("ui.account.helpLink")}</span>
          <span aria-hidden style={{ color: "var(--ink-faint)" }}>{"›"}</span>
        </Link>
        {!readOnly && pushState !== "unsupported" && (
          <>
            <div style={{ borderTop: "1px solid var(--line)" }} />
            {pushState === "on" ? (
              <div style={row}>
                <span>{t("ui.account.push.title")}</span>
                <span style={{ color: "var(--accent)", fontWeight: 600 }}>{t("ui.account.push.on")}</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleEnablePush}
                disabled={pushState === "requesting"}
                style={{
                  ...row,
                  width: "100%",
                  border: "none",
                  background: "transparent",
                  cursor: pushState === "requesting" ? "default" : "pointer",
                  textAlign: "left",
                }}
              >
                <span>{t("ui.account.push.enable")}</span>
                <span style={{ color: pushState === "error" ? "var(--crit)" : "var(--ink-faint)", fontSize: ".82rem" }}>
                  {pushState === "requesting" ? t("ui.account.push.requesting") : pushState === "error" ? (pushError ?? t("ui.account.push.failed")) : "›"}
                </span>
              </button>
            )}
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
        <ThemeControl />
      </div>

      {!readOnly && (
        <div className="card" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
          <LanguageControl />
        </div>
      )}

      {/* Sign-out and password change act on the AMBIENT browser session — in a
          staff view-as session that's the staff member's own login, not the
          florist's, so they're hidden. Use the "Exit" pill to leave view-as. */}
      {!readOnly && (
        <div className="card" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
          <button
            type="button"
            onClick={() => signOut("/florist/login")}
            style={{
              ...row,
              width: "100%",
              border: "none",
              background: "transparent",
              color: "var(--crit)",
              fontWeight: 600,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            {t("ui.account.signOut")}
          </button>
        </div>
      )}
    </main>
  );
}
