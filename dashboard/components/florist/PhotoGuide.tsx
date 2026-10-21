"use client";
import { useId } from "react";
import { useT } from "@/components/florist/LocaleProvider";

/**
 * Shown right above the delivery-photo upload: what makes a proof photo pass,
 * plus four worked samples. The advice mirrors exactly what the AI verification
 * gate scores the photo on (lib/photoVerify/claude.ts) — every ordered item
 * visible, sharp, plainly this delivery — so following it is genuinely the
 * difference between the 30% releasing and the leg being held for CX review.
 *
 * The samples are drawn inline as SVG rather than shipped as photos: no assets
 * to host, they inherit the florist app's light/dark tokens, and they render
 * instantly on a phone with a bad connection at the doorstep — which is exactly
 * when a florist reads this.
 */

type Sample = "good" | "dark" | "blurry" | "cropped";

const SAMPLES: Sample[] = ["good", "dark", "blurry", "cropped"];
const TIPS = ["everything", "light", "background", "sharp", "fresh"] as const;

/** One bloom: petals + a contrasting centre, so it still reads as a flower
 * at the ~80px the tiles get on a phone. */
function Bloom({ x, y, r = 6, opacity = 1 }: { x: number; y: number; r?: number; opacity?: number }) {
  return (
    <g opacity={opacity}>
      {[0, 72, 144, 216, 288].map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return <circle key={deg} cx={x + Math.sin(rad) * r * 0.62} cy={y - Math.cos(rad) * r * 0.62} r={r * 0.52} fill="currentColor" />;
      })}
      <circle cx={x} cy={y} r={r * 0.3} fill="var(--surface-2)" />
    </g>
  );
}

/** A wrapped bouquet + a gift-box add-on on a surface — drawn once and re-used
 * by every sample tile, so the four only differ by what's WRONG with them. */
function Scene() {
  return (
    <g>
      {/* leaves behind the blooms */}
      <path d="M33 40 C20 36 15 27 16 20" stroke="var(--ink-faint)" strokeWidth="2.2" fill="none" strokeLinecap="round" opacity=".8" />
      <path d="M33 40 C46 36 51 27 50 20" stroke="var(--ink-faint)" strokeWidth="2.2" fill="none" strokeLinecap="round" opacity=".8" />
      {/* blooms, fanned */}
      <Bloom x={20} y={24} r={6} opacity={0.7} />
      <Bloom x={46} y={24} r={6} opacity={0.7} />
      <Bloom x={26} y={15} r={6.5} opacity={0.88} />
      <Bloom x={40} y={15} r={6.5} opacity={0.88} />
      <Bloom x={33} y={24} r={7.5} />
      {/* paper wrap over the stems */}
      <path d="M22 33 L44 33 L38 55 L28 55 Z" fill="var(--surface)" stroke="var(--ink-faint)" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M33 33 V55" stroke="var(--ink-faint)" strokeWidth="1" opacity=".7" />
      {/* add-on gift box, ribboned */}
      <rect x="50" y="40" width="17" height="15" rx="2" fill="var(--surface)" stroke="var(--ink-faint)" strokeWidth="1.4" />
      <path d="M58.5 40 V55 M50 47.5 H67" stroke="var(--ink-faint)" strokeWidth="1.4" />
      <path d="M55.5 40 C55.5 36 61.5 36 61.5 40" stroke="var(--ink-faint)" strokeWidth="1.4" fill="none" />
      {/* surface line */}
      <path d="M6 55.6 H70" stroke="var(--ink-faint)" strokeWidth="1.2" opacity=".55" />
    </g>
  );
}

function SampleTile({ kind, caption }: { kind: Sample; caption: string }) {
  const good = kind === "good";
  const blurId = `${useId()}-blur`; // filter ids must be unique document-wide
  return (
    <figure style={{ margin: 0, minWidth: 0 }}>
      <div
        style={{
          position: "relative",
          borderRadius: 9,
          overflow: "hidden",
          border: `1.5px solid ${good ? "var(--accent)" : "var(--line-strong)"}`,
          background: "var(--surface-2)",
        }}
      >
        {/* Decorative: the figcaption below is the accessible text. */}
        <svg viewBox="0 0 72 62" aria-hidden style={{ display: "block", width: "100%", height: "auto", color: "var(--accent)" }}>
          <defs>
            <filter id={blurId}><feGaussianBlur stdDeviation="1.8" /></filter>
          </defs>
          {/* `cropped` zooms in so the gift box and the top blooms fall outside
              the frame; `blurry` softens it; `dark` lays a scrim over it. */}
          <g
            filter={kind === "blurry" ? `url(#${blurId})` : undefined}
            transform={kind === "cropped" ? "translate(-14 -22) scale(1.85)" : undefined}
          >
            <Scene />
          </g>
          {kind === "dark" && <rect width="72" height="62" fill="#000" opacity=".62" />}
        </svg>
        <span
          aria-hidden
          style={{
            position: "absolute", top: 4, right: 4, width: 16, height: 16, borderRadius: 999,
            display: "grid", placeItems: "center", fontSize: 10, fontWeight: 800, lineHeight: 1,
            background: good ? "var(--accent)" : "var(--surface)",
            color: good ? "var(--surface)" : "var(--ink-faint)",
            border: good ? "none" : "1px solid var(--line-strong)",
          }}
        >
          {good ? "✓" : "✕"}
        </span>
      </div>
      <figcaption style={{ fontSize: ".68rem", lineHeight: 1.25, marginTop: 4, color: good ? "var(--accent-ink)" : "var(--ink-faint)" }}>
        {caption}
      </figcaption>
    </figure>
  );
}

/** `singlePayment`: this florist's tier paid the whole payout on accept, so the
 * default intro ("...before releasing your delivery payment. A clear one pays
 * out faster.") is untrue for them. Worse than untrue: it is the only reason
 * this card gives for bothering, so leaving it invites the inference that a
 * florist with no payment outstanding can skip the photo. The variant gives
 * them the reason that IS true — the customer sees this picture. */
export default function PhotoGuide({ singlePayment = false }: { singlePayment?: boolean }) {
  const { t } = useT();
  const k = (key: string) => t(`ui.orderDetail.detail.photoGuide.${key}`);
  return (
    // `minWidth: 0` here too — the card is itself a grid item on the order page.
    <div className="ocard" style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <div style={{ display: "grid", gap: 3 }}>
        <div className="mini-h">📸 {k("title")}</div>
        <p style={{ margin: 0, fontSize: ".8rem", color: "var(--ink-soft)", lineHeight: 1.4 }}>{k(singlePayment ? "introFull" : "intro")}</p>
      </div>

      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
        {TIPS.map((tip) => (
          <li key={tip} style={{ display: "flex", gap: 7, fontSize: ".82rem", lineHeight: 1.35, color: "var(--ink)" }}>
            <span aria-hidden style={{ color: "var(--accent)", fontWeight: 800, flexShrink: 0 }}>✓</span>
            <span>{k(`tips.${tip}`)}</span>
          </li>
        ))}
      </ul>

      {/* `minWidth: 0` at every level down to the tiles: without it a grid item
          refuses to shrink below its content, and the four tiles would widen
          the whole card past the viewport on a narrow phone. */}
      <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
        <div className="fc-recipe-h">{k("samplesLabel")}</div>
        {/* Four equal fractions rather than fixed widths + scroll: the samples
            only teach anything side by side, and a scroller would hide the
            fourth one off-screen on a 360px phone. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6, minWidth: 0 }}>
          {SAMPLES.map((s) => <SampleTile key={s} kind={s} caption={k(`samples.${s}`)} />)}
        </div>
      </div>
    </div>
  );
}
