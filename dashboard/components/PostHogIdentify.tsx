"use client";

import { useEffect } from "react";
import { identifyUser, type Identity } from "@/lib/analytics";

/**
 * Renders nothing; exists purely to run identifyUser() in the browser with the
 * identity the server layout already has.
 *
 * Kept separate from StaffShell / FloristShell on purpose: those are
 * presentational nav chrome and don't currently receive `user.id` at all, so
 * identifying inside them would mean widening their props for a concern they
 * don't own. This component follows the codebase's server-fetches → props →
 * client-component convention, and can be deleted without touching the shells.
 */
export default function PostHogIdentify(identity: Identity) {
  const { distinctId, email, surface, floristId } = identity;

  useEffect(() => {
    identifyUser({ distinctId, email, surface, floristId });
  }, [distinctId, email, surface, floristId]);

  return null;
}
