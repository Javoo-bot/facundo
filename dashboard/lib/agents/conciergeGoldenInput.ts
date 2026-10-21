import type { AgentInput } from "../cxAgent.ts";

export const GOLDEN_INPUT: AgentInput = {
  personaName: "Lucía",
  personaRole: "florist partner manager",
  locale: "es",
  kind: "support",
  facts: [
    "Order #FC-1001 is accepted and due on 14 October between 10:00 and 14:00.",
    "The first payout of 35.00 EUR was paid by card when you accepted.",
  ],
  helpFacts: ["The remaining 30% is released once the delivery photo is checked."],
  thread: [
    { direction: "out", body: "Thanks for accepting the order." },
    { direction: "in", body: "When do I get the rest of the money?" },
  ],
};
