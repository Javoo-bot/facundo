"use client";

import Link from "next/link";
import { signOut } from "@/lib/auth";
import { useT } from "@/components/florist/LocaleProvider";

/**
 * Dead-end replacement for the florist layout's `!map` branch. Two audiences
 * land here for different reasons and need different ways out:
 *
 * - Staff (allow-listed) who opened the florist PWA in another tab — nothing
 *   is wrong, they just want back to the console they were already signed
 *   into, or to sign out and let a florist use this browser.
 * - A real florist whose auth email doesn't match any `florists.email` row —
 *   they need to see WHICH account they're on (the actual diagnostic) and a
 *   way to sign out and try a different one, since this page renders outside
 *   FloristShell and has no nav to escape through otherwise.
 */
export default function NoFloristAccount({ email, isStaff }: { email: string; isStaff: boolean }) {
  const { t } = useT();
  return (
    <main
      className="ds page fc-readable"
      style={{ display: "flex", minHeight: "100dvh", alignItems: "center", justifyContent: "center" }}
    >
      <div className="card" style={{ maxWidth: 420, width: "100%", padding: "28px 24px", display: "grid", gap: 14, textAlign: "center" }}>
        {isStaff ? (
          <>
            <h1 style={{ fontSize: "1.3rem" }}>{t("ui.shell.noAccount.staffTitle")}</h1>
            <p style={{ color: "var(--ink-soft)", fontSize: ".92rem", margin: 0 }}>
              {t("ui.shell.noAccount.staffBody", { email })}
            </p>
            <div style={{ display: "grid", gap: 10, marginTop: 6 }}>
              <Link href="/" className="btn btn-solid" style={{ justifyContent: "center", minHeight: 44 }}>
                {t("ui.shell.noAccount.staffBackToConsole")}
              </Link>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => signOut()}
                style={{ justifyContent: "center", minHeight: 44 }}
              >
                {t("ui.shell.noAccount.signOut")}
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: "1.3rem" }}>{t("ui.shell.noAccount.title")}</h1>
            <p style={{ color: "var(--ink-soft)", fontSize: ".92rem", margin: 0 }}>
              {t("ui.shell.noAccount.matchBefore")}
              <strong style={{ color: "var(--ink)" }}>{email}</strong>
              {t("ui.shell.noAccount.matchAfter")}
            </p>
            <button
              type="button"
              className="btn btn-solid"
              onClick={() => signOut("/florist/login")}
              style={{ justifyContent: "center", minHeight: 44, marginTop: 6 }}
            >
              {t("ui.shell.noAccount.signOutTryAnother")}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
