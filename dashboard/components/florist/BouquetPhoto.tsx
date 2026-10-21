"use client";

import { useState } from "react";

/**
 * Bouquet product photo with a graceful fallback — used for both the inbox
 * hero image and the small "what to make" line-item thumbs. Renders a
 * neutral placeholder box (never a broken `<img>`) when `src` is null/empty,
 * or if the CDN image itself fails to load at runtime.
 */
export default function BouquetPhoto({
  src,
  alt,
  style,
}: {
  src: string | null | undefined;
  alt: string;
  style?: React.CSSProperties;
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        role="img"
        aria-label={alt}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--surface-2)",
          color: "var(--ink-faint)",
          ...style,
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ width: "36%", height: "36%" }}
        >
          <rect x="3" y="4.5" width="18" height="15" rx="2" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <path d="M3 16l5-4.5 4 3.5 3.5-3 5.5 5" />
        </svg>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- external CDN photo, not a local/optimizable asset
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      style={{ objectFit: "cover", display: "block", ...style }}
    />
  );
}
