"use client";

import { useEffect } from "react";
import { identifyUser } from "@/lib/analytics";
import { distinctIdFor } from "@/lib/reachout/events";

/**
 * Renders nothing; joins the two halves of the recruiting funnel in PostHog.
 *
 * ---- Why this is load-bearing
 *
 * A prospect florist is not a logged-in user. The server events
 * (recruit_email_sent / _opened / _clicked) key on `florist:<id>`, because
 * server-side that is the only identity there is. In the browser they arrive
 * from the email as an ANONYMOUS visitor with a PostHog device id.
 *
 * Without this call PostHog holds two funnels that never meet — sent → opened →
 * clicked under one id, and landed → joined under another — and cannot answer
 * the only question worth asking, which is what fraction of the shops we mailed
 * actually turn up. Calling identify() with the same string stitches the
 * anonymous pageviews that led here onto the florist, retroactively.
 *
 * Mounted on `/florist/accept/<token>`, which is the first page a prospect can
 * reach where we know WHO they are: the token in the URL is the identity, and
 * it was minted for exactly one florist.
 *
 * Distinct from components/PostHogIdentify.tsx, which identifies STAFF and
 * signed-in florists by their Supabase auth id. A prospect has no auth user
 * yet — that is precisely the state this covers.
 */
export default function ProspectIdentify({ floristId }: { floristId: string }) {
  useEffect(() => {
    // Empty email deliberately. We hold one, but it is a business address we
    // SCRAPED rather than something this person gave us, and writing it onto a
    // PostHog person who has not signed up is not a trade worth making. The
    // florist_id alone joins the funnel, which is the whole purpose here.
    identifyUser({ distinctId: distinctIdFor(floristId), email: "", surface: "florist", floristId });
  }, [floristId]);

  return null;
}
