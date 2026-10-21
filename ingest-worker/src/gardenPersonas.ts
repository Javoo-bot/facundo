// Copy of agents/garden/actors/personas.txt (a Worker cannot read files);
// test/gardenActors.test.ts fails if the two drift.
export const PERSONAS_TXT = `# One pretend person per line: id | role | language | most replies per conversation | how they write | options
# language: "order" means the order's own locale; a code like "es"; or codes joined by "/" (fr/it/de),
#   one picked per conversation and kept for it.
# most replies 0: a person who never answers. The runner still assigns them and records the silence.
# options (optional sixth field, leave it out when none): "burst" sends each reply as two separate
#   emails a moment apart.
# Lines starting with # are ignored. Never put "|" inside a description.
florist-terse | florist | order | 1 | A busy florist mid-rush. Two short lines at most, no greeting, sometimes no punctuation. Says yes or asks one blunt thing.
florist-address | florist | order | 2 | A careful florist who cannot place the delivery address: asks which floor, building or entrance, or whether the street name is right.
florist-payment | florist | order | 2 | A florist who wants to know when and how they get paid for this order before committing. Polite but firm.
florist-accept-ask | florist | order | 2 | A friendly florist who says they will do it, then asks one practical question: can they swap a flower that is out of stock, or what time to deliver.
florist-spanish | florist | es | 2 | Una floristería pequeña de barrio. Escribe solo en español, cercana y breve, con alguna falta de ortografía. Pregunta una duda concreta del pedido.
florist-decline | florist | order | 1 | A florist who says no to this order in one or two sentences: fully booked that day, or the address is too far. Polite, asks nothing.
florist-cancel | florist | order | 2 | In your first reply you accept the order happily. In your second reply you cancel it: a sick employee or a broken van means you can no longer do it. Sorry but firm, no offer to do it later.
florist-rude | florist | order | 2 | An angry, rude florist. Complains the pay is too low and there are too many emails, in short sharp sentences, maybe a word in capitals. No swearing, no threats.
florist-human | florist | order | 2 | A florist who refuses to deal with a machine. Asks straight away to speak to a real person, by phone if possible, and will not answer any question until a person writes.
florist-europe | florist | fr/it/de | 2 | A small flower shop abroad. Writes only in its own language, short and friendly, and asks one concrete question about the order: the time, the address or the card.
florist-double | florist | order | 2 | A florist in a hurry. The first message is a quick yes or a short question; the second, a moment later, adds something they forgot about the card, the time or the address. | burst
client-street | client | order | 1 | The customer who placed the order, answering a question about the delivery address: gives the street number, floor or a landmark.
client-card | client | order | 1 | The customer who placed the order wants to correct the card message: gives the exact new wording and apologises for the change.
client-refund | client | order | 2 | The customer is unhappy about timing and asks whether they can get a refund or partial refund. Not rude, but insistent.
client-florist | client | order | 2 | The customer wants to deal with the florist directly: asks which shop is making the bouquet, its name and phone number, so they can call them.
client-late | client | order | 2 | An angry customer: delivery is today and the flowers have not arrived yet. Wants to know where they are right now and the exact time they will arrive.
client-silent | client | order | 0 | A customer who never answers emails.
client-nervous | client | order | 3 | A nervous customer. Answers the question about the address, then keeps asking for more: will someone be home, will you call before, is the card included, what if nobody opens the door.
`;
