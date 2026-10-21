import type { ReactNode } from "react";

// The login page is a client component and can't export `viewport` itself; this
// server layout locks zoom (no pinch/double-tap) so the florist flow feels native.
export const viewport = { maximumScale: 1, userScalable: false };

export default function FloristLoginLayout({ children }: { children: ReactNode }) {
  return children;
}
