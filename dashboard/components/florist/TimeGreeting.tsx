"use client";

import { useEffect, useState } from "react";
import { greetingKeyForHour, type GreetingKey } from "@/lib/floristGreeting";

/** Time-of-day greeting for a florist, shared by the join form
 * (app/florist/accept/[token]) and the offer page
 * (components/florist/offer/OfferHeader.tsx).
 *
 * The server resolves this from the SHOP's timezone (tz-lookup over its stored
 * coordinates) and passes the key down — that is the common case (all 14
 * onboarded shops have coordinates), it renders correctly on first paint, and
 * it costs no client work.
 *
 * `serverKey` is null only when we hold no usable coordinates. Then, and only
 * then, this falls back to the browser's clock after mount: the florist is on
 * their own device, so it's a good second-best. The fallback deliberately does
 * NOT run when the server already answered — a florist travelling would
 * otherwise be greeted by wherever they happen to be standing rather than by
 * their shop. */
export default function TimeGreeting({
  serverKey,
  greetings,
  name,
  namedTemplate,
  className,
  style,
}: {
  serverKey: GreetingKey | null;
  greetings: Record<GreetingKey, string>;
  /** Owner's name, when we have one. Never the shop name — "Good evening,
   * Flors Girona" reads like a mail-merge failure. */
  name: string | null;
  /** "{greeting}, {name}" — ordering and punctuation vary by locale. */
  namedTemplate: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [key, setKey] = useState<GreetingKey | null>(serverKey);

  useEffect(() => {
    if (serverKey) return;
    setKey(greetingKeyForHour(new Date().getHours()));
  }, [serverKey]);

  // Nothing to show until the client effect resolves. Rendering a placeholder
  // greeting and swapping it would flash the wrong words.
  if (!key) return null;

  const greeting = greetings[key];
  const text = name ? namedTemplate.replace("{greeting}", greeting).replace("{name}", name) : greeting;

  return (
    <p className={className} style={style}>
      {text}
    </p>
  );
}
