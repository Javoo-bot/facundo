import { describe, expect, it } from "vitest";
import {
  buildFocusedContext,
  collectInternalLinks,
  deobfuscate,
  detectEcommerceSignals,
  extractCandidateEmails,
  extractCandidatePhones,
  isSocialUrl,
  isThinPage,
  decodeCloudflareEmail,
  rankLinks,
  scoreLink,
  unwrapRedirectLink,
} from "../src/extractors";

describe("deobfuscate", () => {
  it("handles parenthesized (at)/(dot) form", () => {
    expect(deobfuscate("info (at) shop (dot) com")).toBe("info@shop.com");
  });

  it("handles bracket [at]/[dot] form", () => {
    expect(deobfuscate("info [at] shop [dot] com")).toBe("info@shop.com");
  });

  it("handles bare word ' at '/' dot ' form", () => {
    expect(deobfuscate("info at shop dot com")).toBe("info@shop.com");
  });
});

describe("extractCandidateEmails", () => {
  it("finds a plain email in raw HTML text", () => {
    const pages = { "https://example.com/": "<p>Reach us at hello@example-shop.com any time.</p>" };
    expect(extractCandidateEmails(pages)).toEqual(["hello@example-shop.com"]);
  });

  it("finds a mailto: link and strips the query string", () => {
    const pages = {
      "https://example.com/": '<a href="mailto:sales@example-shop.com?subject=Hello%20there">Email us</a>',
    };
    expect(extractCandidateEmails(pages)).toEqual(["sales@example-shop.com"]);
  });

  it("finds an email in a JSON-LD email field", () => {
    const pages = {
      "https://example.com/": `<script type="application/ld+json">${JSON.stringify({
        "@type": "Florist",
        email: "ld@example-shop.com",
      })}</script>`,
    };
    expect(extractCandidateEmails(pages)).toEqual(["ld@example-shop.com"]);
  });

  it("finds an obfuscated (at)/(dot) email in visible text", () => {
    const pages = {
      "https://example.com/": "<p>Write to info (at) example-shop (dot) com for orders.</p>",
    };
    expect(extractCandidateEmails(pages)).toEqual(["info@example-shop.com"]);
  });

  it("skips noreply, wixsite, and example.com addresses", () => {
    const pages = {
      "https://example.com/": `
        <p>noreply@example-shop.com</p>
        <p>owner@myflorist.wixsite.com</p>
        <p>fake@example.com</p>
        <p>real@genuine-shop.com</p>
      `,
    };
    expect(extractCandidateEmails(pages)).toEqual(["real@genuine-shop.com"]);
  });

  it("caps output at 10 total candidates when more than 10 unique matches exist", () => {
    const emails = Array.from({ length: 15 }, (_, i) => `person${i}@genuine-shop.com`);
    const pages = { "https://example.com/": `<p>${emails.join(" ")}</p>` };
    const result = extractCandidateEmails(pages);
    expect(result).toHaveLength(10);
    expect(result).toEqual(emails.slice(0, 10));
  });

  it("orders pass-1 (plain regex + mailto) results before pass-2 (JSON-LD + obfuscated) results when both compete for the cap", () => {
    // Pass 1: 4 unique plain-text emails.
    const pass1Emails = ["p1a@genuine-shop.com", "p1b@genuine-shop.com", "p1c@genuine-shop.com", "p1d@genuine-shop.com"];
    // Pass 2: 8 unique emails via JSON-LD (an array of entities, each with its own email).
    const pass2Emails = Array.from({ length: 8 }, (_, i) => `p2${String.fromCharCode(97 + i)}@genuine-shop.com`);
    const jsonLd = JSON.stringify(pass2Emails.map((email) => ({ "@type": "Person", email })));
    const html = `
      <p>${pass1Emails.join(" ")}</p>
      <script type="application/ld+json">${jsonLd}</script>
    `;
    const result = extractCandidateEmails({ "https://example.com/": html });
    expect(result).toHaveLength(10); // 4 (pass1) + 8 (pass2) = 12 unique, capped at 10.
    expect(result.slice(0, 4)).toEqual(pass1Emails);
    expect(result.slice(4)).toEqual(pass2Emails.slice(0, 6));
  });

  it("preserves a Unicode local part instead of truncating it", () => {
    const pages = {
      "https://example.com/": "<p>Contact: concepciónperez@correo-demo.es for more info</p>",
    };
    expect(extractCandidateEmails(pages)).toEqual(["concepciónperez@correo-demo.es"]);
  });

  it("does not swallow adjacent CJK text glued onto a real ASCII email", () => {
    // A widened-to-any-Unicode-letter class would pull "先生" (no separator) into
    // the local part — the same silent-corruption failure mode this fix targets,
    // just triggered by a different script. Extraction scope here is Latin (the
    // POC's es/fr/it/de markets), not "every Unicode letter."
    const pages = { "https://example.com/": "<p>先生contact@genuine-shop.com</p>" };
    expect(extractCandidateEmails(pages)).toEqual(["contact@genuine-shop.com"]);
  });

  it("does not swallow adjacent Cyrillic text glued onto a real ASCII email", () => {
    const pages = { "https://example.com/": "<p>Приветivan@genuine-shop.com</p>" };
    expect(extractCandidateEmails(pages)).toEqual(["ivan@genuine-shop.com"]);
  });
});

describe("extractCandidateEmails + Cloudflare", () => {
  it("finds an address that only exists in a data-cfemail attribute", () => {
    // What the page renders is "[email protected]" — the visible text holds
    // nothing, so this has to come off the raw HTML.
    const pages = {
      "https://www.chaine-fleurs.com/content/18-service-client":
        '<a href="/cdn-cgi/l/email-protection" class="__cf_email__" ' +
        'data-cfemail="b3d0dcddc7d2d0c7f3d0dbd2daddd69ed5dfd6c6c1c09dd0dcde">[email&#160;protected]</a>',
    };
    expect(extractCandidateEmails(pages)).toEqual(["contact@chaine-fleurs.com"]);
  });

  it("also reads the address out of the email-protection href", () => {
    const pages = {
      "https://x.test/":
        '<a href="/cdn-cgi/l/email-protection#b3d0dcddc7d2d0c7f3d0dbd2daddd69ed5dfd6c6c1c09dd0dcde">email</a>',
    };
    expect(extractCandidateEmails(pages)).toEqual(["contact@chaine-fleurs.com"]);
  });
});

describe("extractCandidateEmails + WordPress antispambot() entity/percent obfuscation", () => {
  // Added 2026-09-01. blumendemo.ch and flori-demo.ro spell the address out as
  // per-character HTML numeric entities (WordPress core's antispambot()), and
  // flori-demo.ro additionally percent-encodes the href target underneath that —
  // both render plainly to a human ("E-Mail: info@blumendemo.ch") and read as
  // nothing to a raw-html regex, since there's no literal "@" in the source.
  // KEEP IN STEP with test_email_regex.py.
  it("reads a numeric-entity-obfuscated address (the real blumendemo.ch/kontakt.html payload)", () => {
    const pages = {
      "https://blumendemo.ch/kontakt.html":
        '<a href="&#109;&#97;&#105;&#108;&#116;&#111;&#58;&#105;&#x6E;&#102;&#x6F;' +
        '&#64;&#x62;&#108;&#x75;&#109;&#x65;&#110;&#x64;&#101;&#x6D;&#111;&#46;&#x63;&#104;" ' +
        'class="email">&#105;&#x6E;&#102;&#x6F;&#64;&#x62;&#108;&#x75;&#109;&#x65;' +
        "&#110;&#x64;&#101;&#x6D;&#111;&#46;&#x63;&#104;</a>",
    };
    expect(extractCandidateEmails(pages)).toEqual(["info@blumendemo.ch"]);
  });

  it("reads entities layered over percent-encoding (the real flori-demo.ro/contact payload)", () => {
    const pages = {
      "https://flori-demo.ro/contact":
        '<a href="&#109;&#97;&#105;&#108;&#116;&#111;&#58;%6f%66%66%69%63%65@' +
        '%66%6c%6f%72%69%2d%64%65%6d%6f.%72%6f">' +
        "&#x6f;&#x66;&#x66;&#x69;&#x63;&#x65;&#x40;&#x66;&#x6c;" +
        "&#x6f;&#x72;&#x69;&#x2d;&#x64;&#x65;&#x6d;&#x6f;&#x2e;&#x72;&#x6f;</a>",
    };
    expect(extractCandidateEmails(pages)).toEqual(["office@flori-demo.ro"]);
  });

  it("does not corrupt a plain page whose only entities are unrelated (&amp;/&nbsp;)", () => {
    const pages = {
      "https://florshop-demo.com/": "<p>Contact us &amp; visit&nbsp;our shop. Email: hello@florshop-demo.com</p>",
    };
    expect(extractCandidateEmails(pages)).toEqual(["hello@florshop-demo.com"]);
  });
});

describe("extractCandidateEmails + retina-asset-filename false positives", () => {
  // Added 2026-09-02. perfume-demo.net's CSS holds "shadow@2x.png" (the
  // name@2x.png / name@3x.jpg convention for retina image assets), which is
  // "local@domain.tld"-shaped enough to pass EMAIL_REGEX. It never reached a
  // stored email (Claude's selection always filtered it), but it's still
  // noise in the candidate list. KEEP IN STEP with test_email_regex.py.
  it("skips a retina-asset filename that looks like local@domain.tld", () => {
    const pages = {
      "https://florshop-demo.com/":
        "<style>.icon{background:url(shadow@2x.png)}</style><p>Email: hello@florshop-demo.com</p>",
    };
    expect(extractCandidateEmails(pages)).toEqual(["hello@florshop-demo.com"]);
  });
});

describe("decodeCloudflareEmail", () => {
  // The real payload from chaine-fleurs.com/content/18-service-client, where the
  // address was plainly visible to a human and invisible to us.
  it("reverses Cloudflare's obfuscation", () => {
    expect(decodeCloudflareEmail("b3d0dcddc7d2d0c7f3d0dbd2daddd69ed5dfd6c6c1c09dd0dcde")).toBe(
      "contact@chaine-fleurs.com"
    );
  });

  it("returns null rather than mojibake for junk", () => {
    expect(decodeCloudflareEmail("00")).toBeNull();      // too short
    expect(decodeCloudflareEmail("abc")).toBeNull();     // odd length
    expect(decodeCloudflareEmail("deadbeef")).toBeNull(); // decodes, but not email-shaped
  });
});

describe("extractCandidatePhones", () => {
  it("finds a tel: href and strips the query string", () => {
    const pages = { "https://example.com/": '<a href="tel:+34972000251?foo=bar">Call</a>' };
    expect(extractCandidatePhones(pages)).toEqual(["+34972000251"]);
  });

  it("finds a phone in a JSON-LD telephone field", () => {
    const pages = {
      "https://example.com/": `<script type="application/ld+json">${JSON.stringify({
        "@type": "Florist",
        telephone: "+34 972 00 02 51",
      })}</script>`,
    };
    expect(extractCandidatePhones(pages)).toEqual(["+34 972 00 02 51"]);
  });

  it("finds a wa.me link", () => {
    const pages = { "https://example.com/": '<a href="https://wa.me/34972000251">WhatsApp us</a>' };
    expect(extractCandidatePhones(pages)).toEqual(["34972000251"]);
  });

  it("finds a generic bare-digit-run phone in text", () => {
    const pages = { "https://example.com/": "<p>Call us on 972 000 251 today.</p>" };
    expect(extractCandidatePhones(pages)).toEqual(["972 000 251"]);
  });

  it("filters out digit runs shorter than 8 or longer than 15 digits", () => {
    const pages = {
      "https://example.com/": "<p>Short: 1234567. Long: 1234567890123456. Just right: 123456789.</p>",
    };
    expect(extractCandidatePhones(pages)).toEqual(["123456789"]);
  });

  it("dedups an exact repeat", () => {
    const pages = {
      "https://example.com/": '<a href="tel:972000251">Call</a><p>Or reach 972000251 directly.</p>',
    };
    expect(extractCandidatePhones(pages)).toEqual(["972000251"]);
  });

  it("gives tel: href priority over a generic candidate for the same page", () => {
    const pages = {
      "https://example.com/": `
        <a href="tel:972000251">Call</a>
        <p>Or reach us at 972000251 or the standalone number 555555555.</p>
      `,
    };
    const result = extractCandidatePhones(pages);
    // The tel:-derived number (pass 1) lands ahead of the generic-only number (pass 4).
    expect(result[0]).toBe("972000251");
    expect(result).toContain("555555555");
    expect(result.indexOf("972000251")).toBeLessThan(result.indexOf("555555555"));
  });
});

describe("detectEcommerceSignals", () => {
  it("detects a platform signal", () => {
    const signals = detectEcommerceSignals({ "https://example.com/": "<script>window.Shopify = {}</script>" });
    expect(signals.platform).toBe("shopify");
  });

  it("detects a cart signal", () => {
    const signals = detectEcommerceSignals({ "https://example.com/": '<a href="/cart">Cart</a>' });
    expect(signals.cart_signal).toBe("/cart");
  });

  it("detects product schema case-insensitively", () => {
    const signals = detectEcommerceSignals({
      "https://example.com/": '<div itemtype="https://schema.org/Product">Roses</div>',
    });
    expect(signals.product_schema).toBe(true);
  });

  it("detects a network marker and maps it to the network name", () => {
    const signals = detectEcommerceSignals({ "https://example.com/": "<footer>Powered by Interflora</footer>" });
    expect(signals.network_marker).toBe("interflora");
  });

  it("excludes social-hosted page content from the scan", () => {
    const pages = {
      "https://instagram.com/x": "<html>shopify shopify shopify</html>",
      "https://example.com/": "<html><body>Welcome to our flower shop, no ecommerce here.</body></html>",
    };
    const signals = detectEcommerceSignals(pages);
    expect(signals.platform).toBeUndefined();
  });

  it("returns an empty object when nothing matches", () => {
    expect(detectEcommerceSignals({ "https://example.com/": "<p>Just a normal page.</p>" })).toEqual({});
  });
});

describe("isThinPage", () => {
  it("treats short/empty html as thin", () => {
    expect(isThinPage(null)).toBe(true);
    expect(isThinPage("")).toBe(true);
    expect(isThinPage("<p>hi</p>")).toBe(true);
  });

  it("treats a richer page with several links and >200 chars of text as not thin", () => {
    const paragraph = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6);
    const html = `
      <html><body>
        <p>${paragraph}</p>
        <a href="/contact">Contact</a>
        <a href="/shop">Shop</a>
        <a href="/about">About</a>
        <!-- padding to clear THIN_HTML_BYTES ${"x".repeat(1500)} -->
      </body></html>
    `;
    expect(html.length).toBeGreaterThan(2000);
    expect(isThinPage(html)).toBe(false);
  });

  it("treats a page with plenty of text but zero <a href> links as thin", () => {
    const paragraph = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6);
    const html = `
      <html><body>
        <p>${paragraph}</p>
        <!-- padding to clear THIN_HTML_BYTES ${"x".repeat(1800)} -->
      </body></html>
    `;
    expect(html.length).toBeGreaterThan(2000);
    expect(isThinPage(html)).toBe(true);
  });
});

describe("scoreLink / rankLinks", () => {
  it("scores known keyword paths and the shallow-path/root fallback", () => {
    expect(scoreLink("https://example.com/contact")).toBe(10);
    expect(scoreLink("https://example.com/mentions-legales")).toBe(9);
    expect(scoreLink("https://example.com/about")).toBe(8);
    expect(scoreLink("https://example.com/shop")).toBe(7);
    expect(scoreLink("https://example.com/x")).toBe(3);
    expect(scoreLink("https://example.com/")).toBe(0);
  });

  it("puts pages that carry an address ahead of the shop", () => {
    // Retuned 2026-08-11: cart and shop used to outrank `about`, so on a site
    // with a few info pages the crawl budget went to the checkout funnel.
    const shuffled = [
      "https://example.com/panier",
      "https://example.com/about",
      "https://example.com/shop",
      "https://example.com/contact",
      "https://example.com/impressum",
    ];
    expect(rankLinks(shuffled)).toEqual([
      "https://example.com/contact",
      "https://example.com/impressum",
      "https://example.com/about",
      "https://example.com/panier",
      "https://example.com/shop",
    ]);
  });

  // The regression this retune came from, with the site's real URLs. Every one
  // of the three pages holding an address scored 0 and lost its slot to the
  // cart, the login page and four product collections.
  it("ranks chaine-fleurs.com's service-client page above its cart and account", () => {
    const links = [
      "https://www.chaine-fleurs.com/panier",
      "https://www.chaine-fleurs.com/mon-compte",
      "https://www.chaine-fleurs.com/95-notre-collection-de-bouquets-2026",
      "https://www.chaine-fleurs.com/content/18-service-client",
      "https://www.chaine-fleurs.com/content/13-nous-connaitre",
      "https://www.chaine-fleurs.com/content/12-mentions-legales",
    ];
    expect(rankLinks(links).slice(0, 3)).toEqual([
      "https://www.chaine-fleurs.com/content/18-service-client",
      "https://www.chaine-fleurs.com/content/12-mentions-legales",
      "https://www.chaine-fleurs.com/content/13-nous-connaitre",
    ]);
  });

  it("is stable among equal-score ties, preserving input order", () => {
    const links = ["https://example.com/foo", "https://example.com/bar", "https://example.com/baz"];
    // All three are single-segment paths -> SHALLOW_PATH_BONUS, all equal score.
    expect(rankLinks(links)).toEqual(links);
  });
});

describe("isSocialUrl", () => {
  it("matches a bare social host", () => {
    expect(isSocialUrl("https://instagram.com/x")).toBe(true);
  });

  it("matches a www.-prefixed social host", () => {
    expect(isSocialUrl("https://www.facebook.com/y")).toBe(true);
  });

  it("does not match a non-social host", () => {
    expect(isSocialUrl("https://example.com")).toBe(false);
  });

  it("returns false (not throw) for a malformed URL", () => {
    expect(isSocialUrl("not a url ::: at all")).toBe(false);
  });
});

describe("collectInternalLinks", () => {
  it("keeps only the same-domain, non-asset, non-homepage link, normalized", () => {
    const html = `
      <a href="https://example.com/contact?ref=footer#top">Contact</a>
      <a href="https://other-domain.com/page">Other domain</a>
      <a href="/brochure.pdf">Brochure</a>
      <a href="https://example.com/">Home</a>
    `;
    const links = collectInternalLinks(html, "https://example.com");
    expect(links).toEqual(["https://example.com/contact"]);
  });
});

describe("unwrapRedirectLink", () => {
  it("decodes an Instagram redirect-wrapper target", () => {
    const target = "https://real-florist-site.com/page?x=1";
    const wrapped = `https://l.instagram.com/?u=${encodeURIComponent(target)}&e=abc123`;
    expect(unwrapRedirectLink(wrapped)).toBe(target);
  });

  it("returns a non-wrapper URL unchanged", () => {
    expect(unwrapRedirectLink("https://example.com/foo")).toBe("https://example.com/foo");
  });
});

describe("buildFocusedContext", () => {
  it("returns a snippet around a candidate found in visible text, shorter than the full page for a long page", () => {
    const filler = "padding text goes here. ".repeat(200); // well over 1600 chars
    const html = `<p>${filler} unique-candidate@genuine-shop.com is our email. ${filler}</p>`;
    const result = buildFocusedContext({ "https://example.com/": html }, ["unique-candidate@genuine-shop.com"]);
    expect(result).toContain("unique-candidate@genuine-shop.com");
    expect(result.length).toBeLessThan(html.length);
  });

  it("falls back to the prefix of combinedText when no candidate is found anywhere", () => {
    const html = '<p>Welcome to our shop.</p><a href="mailto:hidden@genuine-shop.com">Email</a>';
    const result = buildFocusedContext({ "https://example.com/": html }, ["hidden@genuine-shop.com"]);
    // "hidden@genuine-shop.com" only appears inside the href attribute, not in
    // getText's visible-text output, so no snippet is found for it -> fallback
    // to the head of combinedText (the page's visible text only).
    expect(result).toBe("Welcome to our shop. Email");
  });
});
