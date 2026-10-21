"use client";

import OfferHeader from "@/components/florist/offer/OfferHeader";
import OfferFacts from "@/components/florist/offer/OfferFacts";
import OfferItems from "@/components/florist/offer/OfferItems";
import OfferCardMessage from "@/components/florist/offer/OfferCardMessage";
import OfferPayout, { type PayoutSplit } from "@/components/florist/offer/OfferPayout";
import OfferCountdown from "@/components/florist/OfferCountdown";
import type { OrderLineItem } from "@/lib/types";
import type { GreetingKey } from "@/lib/floristGreeting";

/** The PRE-ACCEPT offer: everything a florist needs to say yes or no, in the
 * order they need it — who's asking, the three deciding numbers, what to make,
 * what to write on the card, and how the money arrives.
 *
 * Composition only. Every action (accept, decline and its reason funnel) stays
 * in components/florist/FloristOrderDetail.tsx and arrives through `actions`,
 * so the fetch/router/read-only logic lives in exactly one place and this tree
 * stays presentational.
 *
 * The post-accept work order — full address, timeline, photo upload, issue
 * reporting, payments — is deliberately NOT here; it remains in
 * FloristOrderDetail. See
 * docs/superpowers/specs/2026-08-05-florist-offer-page-design.md. */
export default function FloristOfferView({
  greetingKey,
  ownerName,
  orderName,
  area,
  distanceKm,
  deliveryAt,
  payout,
  items,
  greeting,
  payoutSplit,
  offerExpiresAt,
  stillAcceptableAfterExpiry,
  actions,
}: {
  greetingKey: GreetingKey | null;
  ownerName: string | null;
  orderName: string | null;
  area: string | null;
  distanceKm: number | null;
  deliveryAt: string | null;
  payout: number | null;
  items: OrderLineItem[];
  greeting: string | null;
  payoutSplit: PayoutSplit | null;
  offerExpiresAt: string | null;
  stillAcceptableAfterExpiry: boolean;
  actions: React.ReactNode;
}) {
  return (
    <>
      <OfferHeader greetingKey={greetingKey} ownerName={ownerName} orderName={orderName} />
      <OfferFacts area={area} distanceKm={distanceKm} deliveryAt={deliveryAt} payout={payout} />
      <OfferItems items={items} />
      <OfferCardMessage greeting={greeting} />
      <OfferPayout split={payoutSplit} />
      <OfferCountdown expiresAt={offerExpiresAt} />
      {actions}
    </>
  );
}
