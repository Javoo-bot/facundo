// Labelled customer questions: each lists the knowledge refs that correctly answer it.
import { load } from './sources.mjs';

const cond = (t) => load('conditions.json').find((d) => d.title === t).ref;
const art = (t) => load('articles.json').find((d) => d.title === t).ref;
const conv = (...topicWords) => load('distilled.json').filter((e) => topicWords.every((w) => e.topic.toLowerCase().includes(w))).map((e) => `octocom:conversation:${e.conversationId}`);

export const questions = () => [
  ['¿Puedo cancelar mi pedido? Lo hice hace una hora', [cond('Cancellations or modifications'), art('Why can\'t I cancel my order?'), art('How do I cancel my order?')]],
  ['Die Blumen sind verwelkt angekommen, bekomme ich mein Geld zurück?', [cond('Complaints and refund requests'), cond('Quality policy'), art('What quality standard can I expect from the flowers?')]],
  ['Can you deliver at a specific time? I need them by 3pm', [art('Is it possible to select delivery time?'), art('Is the time slot guaranteed?'), art('Is it possible to schedule flower delivery?')]],
  ['The tracking says delivered but my mother got nothing', [art('Order is marked as delivered, but I did not receive it')]],
  ['Is the vase included with the bouquet?', [art('Is the vase included in flower bouquets?'), cond('Products and photos')]],
  ['Il bouquet è diverso dalla foto, mancano alcuni fiori', [cond('Product substitution policy'), cond('Products and photos'), cond('Quality policy'), art('Why have I received a different additional product to the one I ordered?')]],
  ['My discount code is not working at checkout', [art('Discount code does not work'), art('How to use a discount code?')]],
  ['Can I return the teddy bear that came with the flowers?', [cond('Right of withdrawal')]],
  ['Quiero enviar flores a un hospital, ¿qué datos necesitan?', [cond('Special delivery locations')]],
  ['How much does delivery cost?', [cond('Delivery cost'), art('How much is shipping to location ABC?')]],
  ['Will you refund me because the flowers arrived one day late?', [cond('Delivery delays'), art('Can I request a refund of my order due to shipping delayts?')]],
  ['Who sent me these flowers? The card had no name', [art('Who sent me my gift?')]],
  ['Je voudrais changer l\'adresse de livraison de ma commande', [art('How do I modify the delivery address?'), art('How do I modify my order?'), cond('Cancellations or modifications')]],
  ['What is your phone number, can you call me?', [art('Contact Phone Number'), art('Can you call me?')]],
  ['Mon paiement échoue, est-ce que je peux payer avec PayPal ?', [cond('Payment methods and incident management'), art('Why is my payment failing?')]],
  ['The recipient refused the flowers, will you send them again?', [cond('Deliveries refused by the recipient')]],
  ['La floristería no entregó el pedido, quiero la devolución completa', [...conv('undelivered'), ...conv('not delivered'), ...conv('unfulfilled')]],
  ['Some flowers were swapped for others, I want compensation', [cond('Product substitution policy'), art('Why have I received a different additional product to the one I ordered?'), ...conv('substitut')]],
];
