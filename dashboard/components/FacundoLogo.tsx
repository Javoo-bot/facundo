import * as React from "react";

/**
 * Facundo wordmark: the blue exchange-arrows tile (same mark as the Smart design
 * face in BrandLogo.tsx) followed by the name. The name inherits `currentColor`
 * so it follows the theme's --ink token; the tile stays #1F4FE0 in light and
 * dark. Give it a height (className or style); the width scales with the
 * 4.25:1 aspect ratio.
 */
export default function FacundoLogo({
  title = "Facundo",
  className,
  ...props
}: React.SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    <svg
      viewBox="0 0 136 32"
      role="img"
      aria-label={title}
      className={className}
      {...props}
    >
      <rect width="32" height="32" rx="8" fill="#1F4FE0" />
      <path
        d="M3 5.5H11M11 5.5L8.5 3M13 10.5H5M5 10.5L7.5 13"
        transform="translate(6 6) scale(1.25)"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x="43"
        y="23.5"
        fill="currentColor"
        fontFamily="inherit"
        fontSize="22"
        fontWeight="600"
        letterSpacing="-0.2"
      >
        Facundo
      </text>
    </svg>
  );
}
