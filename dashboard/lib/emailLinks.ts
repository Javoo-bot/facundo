// Absolute base URLs for links embedded in outbound EMAILS.
//
// Web-push deep links stay RELATIVE (`/florist/orders/…`, `/orders/…`) — the service
// worker resolves them against whichever host the PWA was installed from — so
// they are deliberately NOT built from these constants.
//
// The two production hosts are gated (see lib/hostRouting.ts + middleware.ts):
// florist.fc.example.net serves ONLY the florist PWA, bo.fc.example.net serves
// ONLY the staff backoffice. A staff link (`/orders/…`, `/payments`) 404s on the
// florist host and a `/florist/…` link 404s on the backoffice host — so ONE
// base URL cannot serve both audiences. Choose by the link's audience:
//
//   FLORIST_BASE    — /florist/… links, plus host-agnostic assets that resolve
//                     on either host: the email logo (/brand/…, excluded from
//                     the host middleware) and the signed customer proof photo
//                     (/api/…, never partitioned by host).
//   BACKOFFICE_BASE — staff links: /orders/…, /payments
//
// Both are env-overridable per environment: staging/preview/local point BOTH at
// the single un-split host that serves everything (e.g.
// APP_BASE_URL=https://facundo-staging.example.org and the same for
// BACKOFFICE_BASE_URL). The defaults are the production hosts, derived from the
// same FLORIST_HOST/BACKOFFICE_HOST constants the host router uses so they can't
// drift out of sync.
import { FLORIST_HOST, BACKOFFICE_HOST } from "./hostRouting.ts";

const strip = (u: string): string => u.replace(/\/+$/, "");

/** Florist-facing + host-agnostic (logo, customer proof) email links. */
export const FLORIST_BASE = strip(process.env.APP_BASE_URL || `https://${FLORIST_HOST}`);

/** Staff-backoffice email links (/orders/…, /payments). */
export const BACKOFFICE_BASE = strip(process.env.BACKOFFICE_BASE_URL || `https://${BACKOFFICE_HOST}`);
