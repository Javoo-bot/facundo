import type { CSSProperties } from "react";
import FacundoLogo from "@/components/FacundoLogo";
import { BRAND, BRAND_NAME } from "@/lib/brand";

function SmartDesignMark({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        // Fixed, not a token: the mark also renders outside `.ds` (sign-in).
        background: "#1F4FE0",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 16 16" fill="none">
        <path
          d="M3 5.5H11M11 5.5L8.5 3M13 10.5H5M5 10.5L7.5 13"
          stroke="#fff"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** The current brand's logo. `mark` is the square icon for tight spots (the
 *  collapsed sidebar); `full` is mark + name. Height comes from `size` for
 *  Smart design and from className/style for the Facundo wordmark. */
export default function BrandLogo({
  variant = "full",
  size = 24,
  className,
  style,
}: {
  variant?: "full" | "mark";
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  if (BRAND === "facundo") {
    if (variant === "mark") {
      // eslint-disable-next-line @next/next/no-img-element -- small static brand mark; next/image adds no benefit here
      return <img src="/brand/facundo-mark.png" alt="Facundo" width={size} height={size} className="rounded" />;
    }
    return <FacundoLogo className={className} style={style} />;
  }
  if (variant === "mark") return <SmartDesignMark size={size} />;
  return (
    <span
      role="img"
      aria-label={BRAND_NAME[BRAND]}
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.4), ...style }}
    >
      <SmartDesignMark size={size} />
      <span style={{ fontWeight: 600, fontSize: Math.round(size * 0.68), letterSpacing: "-0.01em", color: "var(--ink)", whiteSpace: "nowrap" }}>
        {BRAND_NAME[BRAND]}
      </span>
    </span>
  );
}
