"use client";

import { createContext, useContext } from "react";

/**
 * True when the florist app is being rendered inside a staff "view as florist"
 * session (read-only support view). Interactive florist controls read this to
 * disable themselves.
 *
 * This is a UX guard, NOT the security boundary — florist WRITE routes already
 * reject a staff session server-side (they authorize via currentFlorist(),
 * which is null for staff). But some client controls act on the AMBIENT browser
 * Supabase session directly (e.g. change-password, sign-out) with no server
 * route in between; in view-as that ambient session is the staff member's own,
 * so those MUST be hidden/disabled here to avoid mutating the wrong account.
 */
const ViewAsReadOnlyContext = createContext(false);

export function ViewAsProvider({ children }: { children: React.ReactNode }) {
  return <ViewAsReadOnlyContext.Provider value={true}>{children}</ViewAsReadOnlyContext.Provider>;
}

export function useViewAsReadOnly(): boolean {
  return useContext(ViewAsReadOnlyContext);
}
