// Why a thread is waiting, in words a person can act on. An unexplained queue
// is the thing that makes CX ignore a queue. Import-free so the factory sweep
// (agents/factory/) can read the same words the /conversations page shows.
export const ESCALATION_REASON_LABEL: Record<string, string> = {
  intent: "Asked about money, contracts, or a person — never answered automatically",
  turn_cap: "Hit the limit on replies without a human",
  low_confidence: "The assistant wasn't confident enough",
  model_flagged: "The assistant asked for a human",
  money_claim: "The draft mentioned a figure we haven't approved",
  promise: "The draft promised something we can't guarantee",
  // Both kinds: recruiting serves shops that have not joined, support those
  // that have (lib/agentTurn.ts), and an excluded shop is never answered.
  not_eligible: "This shop is excluded, or is not the kind of shop this assistant serves",
  // Support-only: a real order is attached to this conversation, but the shop
  // hasn't finished joining yet (a cold offer, or a staff manual override,
  // accepted before the usual activation step ran). Not excluded, not the
  // wrong kind of shop — a live lead that still needs a person.
  not_joined: "This shop has a real order here but hasn't finished joining yet",
  empty_reply: "The assistant produced nothing to send",
  "agent-disabled": "The assistant is turned off in Settings",
  "agent-error": "The assistant failed — nothing was sent",
  "agent-llm-unavailable": "The AI service was unreachable — nothing was sent",
  "unmatched-sender": "We can't tell which florist this is from",
  // Support-only reasons. Each names something a person can actually go and
  // fix, rather than restating that the assistant declined.
  "no-order": "We can't tell which order this is about",
  "open-issue": "The order has an open problem report, so a person answers",
  "no-facts":"We hold nothing about this order to answer from",
  "turn-error": "The assistant crashed — nothing was sent",
  "conversation-missing": "The thread record is gone",
  "no-persona": "No active persona for this market",
  "send-failed": "The reply failed to send",
  "florist-missing": "The florist record is gone",
};
