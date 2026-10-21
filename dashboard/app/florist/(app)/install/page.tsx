"use client";

import { useEffect, useState } from "react";
import { Apple, Bell, Check, Monitor, Share, Smartphone } from "lucide-react";
import { useT } from "@/components/florist/LocaleProvider";

/** The `beforeinstallprompt` event isn't in lib.dom.d.ts yet. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ reports as "MacIntel" with touch support
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

/** A numbered instruction step — accent circle badge + text. */
function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: "color-mix(in srgb, var(--accent) 14%, transparent)",
          color: "var(--accent)",
          display: "grid",
          placeItems: "center",
          font: "700 .74rem/1 var(--mono)",
        }}
      >
        {n}
      </span>
      <span style={{ paddingTop: 2, lineHeight: 1.45 }}>{children}</span>
    </li>
  );
}

export default function FloristInstallPage() {
  const { t } = useT();
  const [mounted, setMounted] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setMounted(true);
    setInstalled(isStandalone());
    setIos(isIOS());

    function onBeforeInstall(e: Event) {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setInstalled(true);
      setDeferredPrompt(null);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function handleInstall() {
    if (!deferredPrompt) return;
    setInstalling(true);
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") setDismissed(true);
    } finally {
      setInstalling(false);
      setDeferredPrompt(null);
    }
  }

  return (
    <main className="ds page" style={{ maxWidth: 440, margin: "0 auto" }}>
      {/* App-icon hero — reads as an installable app at a glance. */}
      <div style={{ textAlign: "center", display: "grid", justifyItems: "center", gap: 14, marginBottom: 22 }}>
        <div
          aria-hidden
          style={{
            width: 72,
            height: 72,
            borderRadius: 18,
            background: "var(--accent)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            boxShadow: "0 8px 24px color-mix(in srgb, var(--accent) 35%, transparent)",
          }}
        >
          <Smartphone size={34} aria-hidden="true" />
        </div>
        <div>
          <h1 style={{ margin: 0 }}>{t("ui.install.title")}</h1>
          <p style={{ color: "var(--ink-soft)", margin: "6px 0 0", fontSize: ".9rem" }}>
            {t("ui.install.subtitle")}
          </p>
        </div>
      </div>

      {!mounted ? (
        <div className="card" style={{ marginTop: 16, display: "grid", gap: 8 }}>
          <div className="skeleton" style={{ height: 18, width: "70%" }} />
          <div className="skeleton" style={{ height: 14, width: "90%" }} />
          <div className="skeleton" style={{ height: 14, width: "60%" }} />
        </div>
      ) : installed || dismissed ? (
        <div
          className="card"
          style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12, borderColor: "var(--accent)" }}
        >
          <span
            aria-hidden
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: "var(--accent)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Check size={22} />
          </span>
          <div>
            <b>{t("ui.install.doneTitle")}</b>
            <p style={{ margin: "2px 0 0", color: "var(--ink-soft)", fontSize: ".85rem" }}>
              {t("ui.install.doneBody")}
            </p>
          </div>
        </div>
      ) : deferredPrompt ? (
        <div className="card" style={{ marginTop: 16, display: "grid", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Monitor size={20} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />
            <div className="mini-h">{t("ui.install.oneTapTitle")}</div>
          </div>
          <button
            type="button"
            className="btn btn-solid"
            disabled={installing}
            onClick={handleInstall}
            style={{ justifyContent: "center", width: "100%", padding: "12px 14px", fontSize: ".95rem" }}
          >
            <Smartphone size={18} aria-hidden="true" /> {installing ? t("ui.install.opening") : t("ui.install.installButton")}
          </button>
          <p style={{ margin: 0, fontSize: ".8rem", color: "var(--ink-faint)" }}>
            {t("ui.install.thenOpen")}
          </p>
        </div>
      ) : ios ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Apple size={20} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />
            <div className="mini-h">{t("ui.install.iosTitle")}</div>
          </div>
          <ol style={{ margin: "14px 0 0", padding: 0, listStyle: "none", color: "var(--ink)", fontSize: ".9rem", display: "grid", gap: 14 }}>
            <Step n={1}>
              <Share size={15} style={{ display: "inline", verticalAlign: "-2px", margin: "0 4px 0 0", color: "var(--accent)" }} aria-hidden="true" />
              {t("ui.install.ios.step1Before")}<b>{t("ui.install.ios.step1Bold")}</b>{t("ui.install.ios.step1After")}
            </Step>
            <Step n={2}>{t("ui.install.ios.step2Before")}<b>{t("ui.install.ios.step2Bold")}</b>{t("ui.install.ios.step2After")}</Step>
            <Step n={3}>{t("ui.install.ios.step3Before")}<b>{t("ui.install.ios.step3Bold")}</b>{t("ui.install.ios.step3After")}</Step>
            <Step n={4}>{t("ui.install.ios.step4Before")}<b>{t("ui.install.ios.step4Bold")}</b>{t("ui.install.ios.step4After")}</Step>
          </ol>
          <p style={{ marginTop: 14, fontSize: ".8rem", color: "var(--ink-faint)" }}>
            {t("ui.install.ios.note")}
          </p>
        </div>
      ) : (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Smartphone size={20} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />
            <div className="mini-h">{t("ui.install.androidTitle")}</div>
          </div>
          <ol style={{ margin: "14px 0 0", padding: 0, listStyle: "none", color: "var(--ink)", fontSize: ".9rem", display: "grid", gap: 14 }}>
            <Step n={1}>{t("ui.install.android.step1Before")}<b>⋮</b>{t("ui.install.android.step1Or")}<b>···</b>{t("ui.install.android.step1After")}</Step>
            <Step n={2}>{t("ui.install.android.step2Before")}<b>{t("ui.install.android.step2Bold1")}</b>{t("ui.install.android.step2Mid")}<b>{t("ui.install.android.step2Bold2")}</b>{t("ui.install.android.step2After")}</Step>
            <Step n={3}>{t("ui.install.android.step3Before")}<b>{t("ui.install.android.step3Bold")}</b>{t("ui.install.android.step3After")}</Step>
          </ol>
          <p style={{ marginTop: 12, fontSize: ".8rem", color: "var(--ink-faint)" }}>
            {t("ui.install.android.note")}
          </p>
        </div>
      )}

      <div className="ocard" style={{ marginTop: 14, display: "flex", alignItems: "flex-start", gap: 10 }}>
        <Bell size={18} style={{ color: "var(--ink-faint)", flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
        <p style={{ margin: 0, fontSize: ".8rem", color: "var(--ink-soft)" }}>
          {t("ui.install.pushNote")}
        </p>
      </div>
    </main>
  );
}
