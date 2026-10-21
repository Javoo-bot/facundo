"""Florist networks, franchises, chains and directories.

WHY THIS EXISTS
---------------
`enrich_florist` scrapes a shop's contact email from its `website_url`. That is
correct when the URL is the shop's own site. For a large minority of shops it
isn't: the "website" on the Maps listing is the shop's *profile page* on a
network, franchise or trade-association site. Scraping that page finds the head
office's address, and we store it as the shop's own.

Measured on the live DB, 2026-08-06: 207 of 984 email-having florists (21%) held
an address shared with at least one other florist. The worst cases:

    contact@reseau-demo.fr                      32 shops   (florist network)
    service.consommateurs@franchisefleurs-demo.com 22 shops   (franchise)
    zentrale@blumennetz-demo.at                     9 shops   (chain)
    au.bouquet.demo@wanadoo.fr           4 shops   (trade association —
                                                        an address belonging to
                                                        one unrelated member)

The consequence is not merely a wasted email. One order for Issy-les-Moulineaux
sent four separate offers to contact@reseau-demo.fr, each naming a different Paris
shop; the four shops that could actually have delivered never heard about it.

Note the contrast with phone numbers: those come from the Maps listing, are
per-shop, and were correct in every case observed. It is specifically the
scraped email that is unreliable, which is why the fix suppresses the email leg
rather than the florist.

WHAT THIS MODULE DOES
---------------------
Two mechanisms, deliberately separate:

  * A REGISTRY (the `florist_networks` table, seeded from SEED_NETWORKS below).
    Authoritative and human-curatable. Ingest looks a domain up here and links
    the florist, so the offer path knows the stored email isn't the shop's.

  * DISCOVERY (`discover_network_candidates`). Networks we haven't seen before
    announce themselves in the data: one domain hosting many distinct
    storefronts. This proposes them; a human confirms the kind.

The pure functions here take plain dicts and are unit-tested directly
(test_networks.py) — same convention as relevance.py and phones.py.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from urllib.parse import urlparse

# Public-suffix handling without a full PSL dependency.
#
# The rule: under a two-letter country TLD, a generic second level (com, co,
# net, org, …) is part of the SUFFIX, not the registrable name — 'com.ar',
# 'co.uk', 'com.au'. Getting this wrong is not cosmetic: an early version
# collapsed every Argentine shop to the domain 'com.ar' and duly proposed it as
# a 46-shop network.
#
# Derived rather than enumerated because the enumeration is exactly what went
# wrong — a hand-written list silently omits whichever country you ingest next.
_GENERIC_SECOND_LEVELS = frozenset(
    {
        "com", "co", "net", "org", "edu", "gov", "mil", "int", "biz", "info",
        "ac", "or", "ne", "gob", "gouv", "govt", "asso", "nom", "web", "tm",
        "ltd", "plc", "me", "priv", "firm", "gen", "ind",
    }
)

# Two-part suffixes that don't fit the rule above (a non-generic second level,
# or a TLD longer than two letters). Extend as they turn up.
_EXTRA_TWO_PART_SUFFIXES = frozenset({"nom.es", "org.uk", "sch.uk", "co.com"})


def _has_two_part_suffix(labels: list[str]) -> bool:
    """Do the last TWO labels form a public suffix (so the name is three deep)?"""
    if len(labels) < 3:
        return False
    tld, second = labels[-1], labels[-2]
    if len(tld) == 2 and second in _GENERIC_SECOND_LEVELS:
        return True
    return f"{second}.{tld}" in _EXTRA_TWO_PART_SUFFIXES


def registrable_domain(url_or_host: str | None) -> str | None:
    """The registrable ('eTLD+1') domain of a URL or bare hostname, lowercased.

    >>> registrable_domain("https://www.reseau-demo.fr/trouvez-votre-fleuriste/x/?a=1")
    'reseau-demo.fr'
    >>> registrable_domain("shop.blumennetz-demo.co.uk")
    'blumennetz-demo.co.uk'

    Returns None for anything without a usable host, so callers can treat
    "no website" and "unparseable website" identically.
    """
    if not url_or_host:
        return None
    raw = url_or_host.strip()
    if not raw:
        return None
    # urlparse only populates netloc when a scheme is present; a bare hostname
    # lands in `path` instead. Normalise by adding a scheme when there is none.
    if "//" not in raw:
        raw = "https://" + raw
    host = urlparse(raw).netloc.lower()
    if "@" in host:  # strip any userinfo
        host = host.rsplit("@", 1)[1]
    host = host.split(":", 1)[0].strip().removeprefix("www.").rstrip(".")
    if not host or "." not in host:
        return None
    labels = host.split(".")
    if _has_two_part_suffix(labels):
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def email_domain(email: str | None) -> str | None:
    """The registrable domain of an email address, or None."""
    if not email or "@" not in email:
        return None
    return registrable_domain(email.rsplit("@", 1)[1])


@dataclass(frozen=True)
class SeedNetwork:
    """A network we have already identified and classified by hand."""

    name: str
    domain: str
    # 'network'   — shared brand, INDEPENDENT member shops (Reseau Demo).
    # 'franchise' — one brand, franchised outlets (Franchise Fleurs Demo).
    # 'chain'     — one company, its own outlets (Jardinerie Demo, Blumen Netz Demo).
    # 'directory' — a listing or trade-association site that is nobody's shop.
    #               An email scraped here is not merely the wrong CONTACT for
    #               the shop, it belongs to an unrelated third party.
    kind: str
    contact_email: str | None = None
    notes: str | None = None


# Seeded from the 2026-08-06 audit of the live data — every domain here was
# confirmed by reading the shops that pointed at it. Extend by hand; the
# discovery pass below proposes candidates but never classifies them as
# 'directory', because that judgement needs a human to look at the site.
SEED_NETWORKS: tuple[SeedNetwork, ...] = (
    SeedNetwork(
        name="Reseau Demo",
        domain="reseau-demo.fr",
        kind="network",
        contact_email="contact@reseau-demo.fr",
        notes="Independent French florists listed at /trouvez-votre-fleuriste/<shop>. 32 shops shared this address.",
    ),
    SeedNetwork(
        name="Franchise Fleurs Demo",
        domain="franchisefleurs-demo.com",
        kind="franchise",
        contact_email="service.consommateurs@franchisefleurs-demo.com",
        notes="Franchised outlets at /fleuriste/<region>/<shop>. 22 shops shared the consumer-service address.",
    ),
    SeedNetwork(
        name="Jardinerie Demo",
        domain="jardinerie-demo.com",
        kind="chain",
        contact_email="service.clients@jardinerie-demo.com",
        notes="Garden-centre chain; florist counters listed at /stores/<city>.",
    ),
    SeedNetwork(
        name="Artisans Fleuristes Demo",
        domain="artisansfleuristes-demo.com",
        kind="directory",
        notes=(
            "Trade association, not a shop. Four unrelated florists were all given "
            "au.bouquet.demo@wanadoo.fr — one member's personal address."
        ),
    ),
    SeedNetwork(
        name="Carré Fleurs Demo",
        domain="carrefleurs-demo.com",
        kind="franchise",
        contact_email="contact@carrefleurs-demo.fr",
        notes="Outlets listed at /nos-magasins/<n>-<city>.html.",
    ),
    SeedNetwork(
        name="Chaine Fleurs",
        domain="chaine-fleurs.com",
        kind="network",
        notes="Per-shop addresses (paris15-lecourbe@) — listed so the domain is recognised, addresses look shop-specific.",
    ),
    SeedNetwork(
        name="Blumen Netz Demo",
        domain="blumennetz-demo.at",
        kind="chain",
        contact_email="zentrale@blumennetz-demo.at",
        notes="Austrian chain; 9 outlets shared the Zentrale address.",
    ),
    SeedNetwork(
        name="Blumen Demo Wien",
        domain="blumen-demo-wien.at",
        kind="chain",
        contact_email="office@blumen-demo-wien.at",
        notes="Austrian chain; 3 outlets shared one office address.",
    ),
    SeedNetwork(
        name="City Flowers",
        domain="cityflowers-demo.ro",
        kind="chain",
        contact_email="office@cityflowers-demo.ro",
        notes="Romanian chain; 3 outlets shared one office address.",
    ),
    SeedNetwork(
        name="Fleuriste Demo",
        domain="fleuriste-demo.paris",
        kind="chain",
        contact_email="contact@fleuriste-demo.paris",
        notes="Three Paris shops under one brand and one address.",
    ),
    SeedNetwork(
        name="Floria",
        domain="floria-demo.ro",
        kind="chain",
        contact_email="comenzi@floria-demo.ro",
        notes="Romanian online florist with physical outlets.",
    ),
    SeedNetwork(
        name="Flower Market Demo",
        domain="flowermarket-demo.com",
        kind="chain",
        notes="Per-shop addresses (ruedubac@); the Paris address hard-bounced on 2026-08-06.",
    ),
)


def seed_by_domain() -> dict[str, SeedNetwork]:
    """The seed registry keyed by registrable domain."""
    return {n.domain: n for n in SEED_NETWORKS}


def match_network(website_url: str | None, registry: dict[str, SeedNetwork | str]) -> str | None:
    """The registry key for `website_url`'s domain, or None.

    `registry` maps a registrable domain to anything the caller wants back
    (a SeedNetwork during seeding, a network_id uuid during ingest) — this
    returns the DOMAIN that matched, so the caller can look the value up
    itself and keep this function free of DB types.
    """
    domain = registrable_domain(website_url)
    if domain and domain in registry:
        return domain
    return None


@dataclass(frozen=True)
class NetworkCandidate:
    """A domain the data suggests is a network, pending human confirmation."""

    domain: str
    shop_count: int
    distinct_names: int
    # The address most of its shops share, when there is one — this is what
    # makes a candidate actionable rather than merely interesting.
    shared_email: str | None
    shared_email_count: int
    # 'franchise' when one brand name dominates the domain's shops, else
    # 'network'. Never 'chain' or 'directory': telling a chain from a franchise,
    # or a network from a directory, needs somebody to look at the site. The
    # caller records this as a PROPOSAL for review.
    proposed_kind: str
    suggested_name: str


def discover_network_candidates(
    florists: list[dict],
    *,
    min_shops: int = 3,
) -> list[NetworkCandidate]:
    """Propose networks from the shape of the data.

    A network announces itself as one domain hosting many distinct storefronts.
    `florists` is a list of dicts with at least `name`, `website_url`, `email`
    and `place_id`; anything else is ignored, so this can be fed straight from a
    Supabase select or from a test fixture.

    Ordered by shop count, descending — the most damaging first.
    """
    by_domain: dict[str, list[dict]] = {}
    for f in florists:
        domain = registrable_domain(f.get("website_url"))
        if not domain:
            continue
        by_domain.setdefault(domain, []).append(f)

    candidates: list[NetworkCandidate] = []
    for domain, shops in by_domain.items():
        # Distinct STOREFRONTS, not rows: the same shop legitimately appears
        # once per city whose ingest radius covered it (florists is upserted on
        # (city_id, place_id)), and counting those as separate shops would make
        # every duplicated single-shop site look like a network.
        place_ids = {f.get("place_id") for f in shops if f.get("place_id")}
        if len(place_ids) < min_shops:
            continue

        emails = Counter(
            (f.get("email") or "").strip().lower() for f in shops if (f.get("email") or "").strip()
        )
        shared_email, shared_email_count = (emails.most_common(1)[0] if emails else (None, 0))
        if shared_email_count < 2:
            # Many shops on one domain but no shared address — a platform that
            # gives each shop its own mailbox (see Chaine Fleurs). Worth knowing
            # about, but it is not producing wrong recipients, so don't propose
            # suppressing anyone's email over it.
            shared_email, shared_email_count = None, 0

        names = [(f.get("name") or "").strip() for f in shops if (f.get("name") or "").strip()]
        distinct_names = len({n.casefold() for n in names})
        dominant_name, dominant_count = (Counter(n.casefold() for n in names).most_common(1)[0] if names else ("", 0))
        one_brand = bool(names) and dominant_count >= max(2, len(names) // 2)

        candidates.append(
            NetworkCandidate(
                domain=domain,
                shop_count=len(place_ids),
                distinct_names=distinct_names,
                shared_email=shared_email,
                shared_email_count=shared_email_count,
                proposed_kind="franchise" if one_brand else "network",
                # The dominant shop name for a single-brand domain reads better
                # than the bare domain ('Franchise Fleurs Demo' vs 'franchisefleurs-demo.com');
                # for a mixed-brand domain the domain IS the network's identity.
                suggested_name=(
                    next((n for n in names if n.casefold() == dominant_name), domain) if one_brand else domain
                ),
            )
        )

    candidates.sort(key=lambda c: (-c.shop_count, c.domain))
    return candidates


def shared_email_counts(florists: list[dict]) -> dict[str, int]:
    """How many florist rows hold each (lowercased, trimmed) address.

    Feeds `florists.email_shared_count`. Blank addresses are excluded — an
    absent address shares nothing.
    """
    counts: Counter[str] = Counter()
    for f in florists:
        email = (f.get("email") or "").strip().lower()
        if email:
            counts[email] += 1
    return dict(counts)
