# One confirm surface for every offer send

**Date:** 2026-08-05
**Status:** approved, ready to implement

## Why

Five buttons send an offer to a florist, and no two behave the same:

| Button | Where | Channel checkboxes | Rendered preview |
|---|---|---|---|
| **Send** | reach-out row (candidate/queued) | ✗ | ✗ |
| **Advance → send #N** | foot of the reach-out panel | ✗ | ✗ |
| **Re-send** | reach-out row (dead/lapsed offer) | ✗ | ✓ |
| **Send again** | reach-out row (live offer) | ✓ | ✗ |
| **Send / Send with changes** | offer approval (CX desk) | ✗ | editable draft, not rendered |

Two of them fire a real email to a real florist in one click with no preview at
all — including the first contact, the one message that reaches a shop which has
never heard of us. The two that do have some confirmation each have half of it.

Every one of these ends in `sendOffer`, so the inconsistency is purely in the
confirm step in front of them.

## The surface

One component, `SendOfferDialog`, opened by all five. Rendered inline in the
reach-out row rather than as a modal — that is the pattern `ResendPreview`
already uses, and the panel lives in a narrow order sidebar.

```
┌─ Send offer to Petals Girona ──────────────┐
│ Channels                                   │
│  [x] Email  · to marc@petals-demo.cat           │
│  [ ] SMS    · no phone number on file      │  ← disabled, reason inline
│  [x] Push                                  │
│                                            │
│ Preview (en · LIVE)           [ Edit text ]│
│ ┌────────────────────────────────────────┐ │
│ │ Subject: We have a flower order in …   │ │
│ │ [the real rendered email, in an iframe]│ │
│ └────────────────────────────────────────┘ │
│                    [ Cancel ]  [ Send ]    │
└────────────────────────────────────────────┘
```

- Channels default to everything available. Confirm is disabled at zero selected
  (matching today's renotify box).
- **Unavailable channels are disabled with the reason shown before sending.**
  Today that reason only appears afterwards, in the result list.
- **Edit text** appears only where the draft is editable (offer approvals). It
  swaps in the subject/body fields and re-renders the preview from what was
  typed, so CX keeps exactly the power they have now.
- The existing LIVE / TEST MODE banner, reply-window line, unsubscribe-placeholder
  note and block-reason line all carry over — they are the parts of the current
  Re-send box worth keeping.
- The "reason for re-sending" audit field stays on the re-send path only, where
  it exists today.

## Pre-flight channel availability

This is the part that must not be re-implemented. `sendOffer` and
`renotifyOffer` each derive per-channel skips with subtle, order-dependent
rules — `florist-no-sms-phone` is checked *ahead* of `no-test-phone` so test
mode mirrors live behaviour, and so on — and those two copies are already
near-duplicates of each other.

A preview that re-derives them a third time would drift, and drift on this
exact class of shared predicate is what produced today's withdrawn-offer bug.

So: extract the rules verbatim into `lib/offerChannels.ts` as a pure function
over the already-resolved offer vars, unit-test it, and call it from all three
places — `sendOffer`, `renotifyOffer`, and the preview route. One predicate,
three callers, same answer by construction.

Push is the one channel not derivable from `resolveOfferVars`: availability
means "this florist has a `push_subscriptions` row". The preview route adds a
cheap existence check for it.

## Backend

1. `GET /api/orders/reachout/preview` returns `channels: [{ channel, available,
   reason }]` alongside the existing fields. Email/SMS from the extracted
   predicate, push from the subscription check.
2. `POST /api/orders/approvals` accepts `channels`, threaded through
   `approveApproval` into `sendOffer` — which already takes them.

`send`, `resend` and `renotify` already accept `channels` and need nothing.

## Call sites

All five switch to `SendOfferDialog`. `ResendPreview` and `RenotifyBox` are
deleted — collapsing them is what stops each being half-built.

`Advance → send #N` gets the confirm step like the rest. It reaches the next
candidate, who is frequently a shop that has never heard of us, so it is the
last button that should fire unpreviewed.

## Risks

- **Tempo.** Two of these fire in one click today. Adding a step is the point,
  but it is a real change for CX sending in volume.
- **Blast radius on the send path.** Extracting the skip rules touches
  `sendOffer`, which every offer in the system goes through. Mitigated by
  extracting verbatim, unit-testing the extracted function against the current
  behaviour, and changing no rule while moving it.

## Non-goals

- No change to what actually goes out on any channel, to the CAS claim ladder,
  to `lateAccept`, or to the payout math.
- The Settings "Send test email" probe is a diagnostic, not an offer, and keeps
  its one-click behaviour.
