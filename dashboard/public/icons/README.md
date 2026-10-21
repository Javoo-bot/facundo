# Florist PWA app icons

`manifest.webmanifest` references two PNG icons, now present in the repo:

- `icon-192.png` — 192×192, the home-screen / notification icon.
- `icon-512.png` — 512×512, `purpose: "any maskable"`.

Both are the Facundo mark — the white two-arrow exchange glyph from
`components/BrandLogo.tsx` — on a full-bleed `#1F4FE0` tile, with the glyph kept
inside the maskable safe zone (~56% centre). The browser-tab favicon
(`app/icon.png`) is the same mark as a rounded tile; the apple-touch icon
(`app/apple-icon.png`) is full-bleed because iOS rounds the corners itself. The
full wordmark (mark + "Facundo") lives in `public/brand/facundo-logo.svg`.

To regenerate after a logo change, re-render the mark at each size (with `sharp`
from the SVG in `public/brand/`, or any rasteriser).
