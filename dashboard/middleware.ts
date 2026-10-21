import { NextResponse, type NextRequest } from "next/server";
import { decideHostRoute } from "@/lib/hostRouting";

// Host-based surface split: florist.fc.example.net serves ONLY the florist PWA,
// bo.fc.example.net serves ONLY the staff backoffice. Every other hostname
// (facundo*.example.org, *.workers.dev, localhost) is untouched and keeps
// serving both. All the logic lives in lib/hostRouting.ts so it's unit-testable;
// this file is the thin adapter.
//
// The 404 is returned directly rather than rewritten to Next's not-found page:
// a rewrite would depend on framework-internal paths, and this boundary is
// reached only by someone on the wrong hostname, where a plain response is fine.

export function middleware(request: NextRequest) {
  // Read the Host header rather than nextUrl.hostname: under OpenNext/Workers
  // nextUrl is reconstructed and does not reliably carry the original host.
  const host = request.headers.get("host") ?? request.nextUrl.hostname;
  const decision = decideHostRoute(host, request.nextUrl.pathname);

  if (decision.kind === "redirect") {
    // Absolute URL is required — Next rejects a relative Location in middleware
    // ("Invalid URL"). Build it from nextUrl (for the scheme) but override the
    // host with the header value, so a reconstructed nextUrl host under
    // OpenNext/Workers can't bounce the browser to the wrong hostname.
    const url = request.nextUrl.clone();
    if (host) url.host = host;
    url.pathname = decision.to;
    return NextResponse.redirect(url);
  }

  if (decision.kind === "not-found") {
    return new NextResponse(
      "<!doctype html><meta charset=utf-8><title>Not found</title>" +
        "<body style=\"font:16px system-ui;padding:3rem;max-width:32rem;margin:auto\">" +
        "<h1 style=\"font-size:1.25rem\">Not found</h1>" +
        "<p>This page isn't served on this address.</p></body>",
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  // Next gives a Server Component no way to read the current pathname, and
  // app/florist/(app)/layout.tsx needs it to build `?next=` when it bounces an
  // unauthenticated florist to sign-in — otherwise the deep link the florist
  // arrived on (an order, from an email) is silently thrown away and they land
  // on the home screen. Forwarding it as a request header is the standard
  // workaround.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Skip static assets outright — they're host-agnostic and this saves an
  // invocation per file. `/api` is matched (cheap) but always passes; see
  // lib/hostRouting.ts for why API routes are not partitioned by host.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/|brand/|.*\\.(?:png|jpg|jpeg|svg|ico|webmanifest)$).*)"],
};
