"use client";

import { useEffect } from "react";

/**
 * Makes a "Related" link jump to its answer in place, instead of reloading the
 * page onto it.
 *
 * WHY THIS EXISTS. The page's tabs and accordion are uncontrolled DOM state (a
 * radio group and `<details open>`, both rendered by the server). A Next
 * client-side navigation re-renders around that state without re-applying it:
 * `defaultChecked` is only read when an input mounts, so following a related
 * link to another category left the old tab selected, the target answer inside
 * a `display: none` panel, and the browser scrolling to something invisible.
 * "Clicking it does nothing", plus a jump.
 *
 * So the links are plain `<a href>` again — a real navigation, which the server
 * renders correctly with the right tab and the right answer open. This
 * component then upgrades that to an in-page move: select the tab, open the
 * answer, scroll to it smoothly, and rewrite the URL so the link is still
 * shareable and Back still works.
 *
 * Progressive enhancement in the strict sense: with JS off, or before this
 * hydrates, every link still works — just as a page load. The rest of the Q&A
 * remains zero-JS.
 */
export default function HelpJump({
  /** Pixels of fixed chrome to leave above the target. The florist PWA has a
   * fixed header; the public page has nothing. */
  scrollOffset = 16,
}: {
  scrollOffset?: number;
}) {
  useEffect(() => {
    // Delegated: answers are opened and closed constantly, and a listener per
    // link would have to be rebound each time.
    function onClick(event: MouseEvent) {
      // Let the browser handle anything that isn't a plain left click — a
      // middle click or cmd-click means "open in a new tab", and the href is
      // real, so that keeps working.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as HTMLElement | null)?.closest?.("a[data-help-target]");
      if (!(link instanceof HTMLAnchorElement)) return;

      const id = link.dataset.helpTarget;
      const category = link.dataset.helpCat;
      if (!id) return;
      const target = document.getElementById(id);
      if (!(target instanceof HTMLDetailsElement)) return; // stale link: let it navigate

      event.preventDefault();

      // Switch tabs first: the answer lives in a hidden panel until we do, and
      // an element with no box cannot be scrolled to.
      if (category) {
        const radio = document.getElementById(`fc-cat-${category}`);
        if (radio instanceof HTMLInputElement) radio.checked = true;
      }
      // `<details name>` closes the others for us.
      target.open = true;

      const top = target.getBoundingClientRect().top + window.scrollY - scrollOffset;
      window.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });

      // Keep the address bar honest, without adding a history entry per hop —
      // Back should leave the Q&A, not walk back through every answer read.
      history.replaceState(null, "", link.href);
      // Move focus so a keyboard or screen-reader user lands on the answer too,
      // not just the viewport. `summary` is focusable by default.
      target.querySelector("summary")?.focus({ preventScroll: true });
    }

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [scrollOffset]);

  return null;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
