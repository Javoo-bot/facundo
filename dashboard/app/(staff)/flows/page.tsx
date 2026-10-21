import { redirect } from "next/navigation";
import { FLOWS } from "@/lib/flows/catalog";

export const dynamic = "force-dynamic";

// /flows has no page of its own — the sidebar's sub-menu is the index, and a
// landing page listing the same three links the sidebar already shows would be
// a second navigation system for one feature (the same reasoning that put
// Statistics' two views in the sidebar rather than in a tab strip).
export default function FlowsIndex() {
  redirect(`/flows/${FLOWS[0].slug}`);
}
