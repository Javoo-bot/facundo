"use client";

import { useState } from "react";

/**
 * Persistent indicator shown while a staff member is viewing the florist app as
 * a specific florist (read-only support view). Floats above the tab bar so it's
 * always visible without fighting the shell's fixed top nav. "Exit" clears the
 * view-as cookie and returns to the staff console.
 */
export default function ViewAsBanner({ shopName }: { shopName: string }) {
  const [busy, setBusy] = useState(false);

  const exit = async () => {
    setBusy(true);
    try {
      await fetch("/api/staff/view-as", { method: "DELETE" });
    } catch {
      /* fall through to navigation regardless */
    }
    // Hard navigation so the server re-resolves the session without the cookie.
    window.location.href = "/florists";
  };

  return (
    <div className="fc-viewas-pill" role="status" aria-live="polite">
      <span aria-hidden>👁</span>
      <span className="fc-viewas-text">
        Viewing as <b>{shopName}</b> · read-only
      </span>
      <button type="button" onClick={exit} disabled={busy} className="fc-viewas-exit">
        {busy ? "Exiting…" : "Exit"}
      </button>
      <style>{`
        .fc-viewas-pill {
          position: fixed; z-index: 200;
          left: 50%; transform: translateX(-50%);
          bottom: calc(76px + env(safe-area-inset-bottom));
          display: flex; align-items: center; gap: 8px;
          background: #7c2d12; color: #fff;
          padding: 7px 8px 7px 14px; border-radius: 999px;
          font-size: 13px; font-weight: 500; line-height: 1;
          box-shadow: 0 6px 22px rgba(0,0,0,.30);
          max-width: calc(100vw - 24px);
        }
        .fc-viewas-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fc-viewas-pill b { font-weight: 700; }
        .fc-viewas-exit {
          flex: none;
          background: rgba(255,255,255,.18); color: #fff;
          border: 0; border-radius: 999px; padding: 5px 12px;
          font-size: 12px; font-weight: 600; cursor: pointer;
        }
        .fc-viewas-exit:hover { background: rgba(255,255,255,.28); }
        .fc-viewas-exit:disabled { opacity: .6; cursor: default; }
        @media (min-width: 980px) { .fc-viewas-pill { bottom: 20px; } }
      `}</style>
    </div>
  );
}
