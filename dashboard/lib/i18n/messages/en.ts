// English catalog — the always-complete fallback. Every other locale file
// falls back to whatever's missing here (see lib/i18n/index.ts::t), so this
// file is the one that must never have a hole. `{placeholder}` tokens are
// interpolated by `t()`'s `vars` argument — keep them matched with each call
// site's `vars` object.

/** A nested string catalog: leaves are translatable strings, branches are
 * plain objects. Deliberately loose (no exact key enumeration) so a partial
 * locale file (`{}`, or missing a few leaves) still type-checks — `t()` does
 * the lookup/fallback at runtime, not the compiler. */
export type MessageTree = { [key: string]: string | MessageTree };

export const en: MessageTree = {
  email: {
    shell: {
      testBanner: "TEST MODE: no real payments or emails are sent.",
      footer: "Facundo · automated message",
      // The plain voice's footer. One line, because commercial mail into
      // DE/FR needs an identifiable sender and a way out even when the
      // email is meant to read as hand-written.
      plainFooter: "Facundo · Barcelona, Spain",
      plainUnsubscribe: "Stop receiving these",
    },
    offer: {
      // Copy rewritten 2026-08-05 (the marketing lead's review pass). The subject no longer
      // carries {orderName}/{when} — both vars are still resolved and passed
      // by the send site, so an editor override can put either back without a
      // deploy; they're simply absent from the default English.
      subject: "We have a flower order in {city}. Can you send it?",
      subjectNoCity: "We have a flower order for you. Can you send it?",
      preheader: "We pay up front, by card. Tap to see the order.",
      // Opening line of the FULL variant. The short variant replaces it with
      // `short.greeting` (the only difference between the two variants since
      // the rewrite — see lib/offerEmailContent.ts).
      greeting: "Hi there,",
      intro: "Facundo is an international flower delivery service with a 20-year legacy. We're expanding our selected florist network in {city}, and your shop's excellent reviews are why we're reaching out.",
      // Used instead of `intro` when delivery_area is null (mirrors the
      // subject/subjectNoCity split above) — a full alternate sentence rather
      // than substituting a generic phrase for {city}, so every locale reads
      // grammatically instead of forcing a translated noun into a
      // language-specific preposition slot ("in"/"à"/"a"/"en") that may not fit.
      introNoCity: "Facundo is an international flower delivery service with a 20-year legacy. We're expanding our selected florist network, and your shop's excellent reviews are why we're reaching out.",
      orderLead: "We have an order for you, and more to follow. Here's how it works:",
      // The four numbered steps, SHARED by both variants. Step 1/2 deliberately
      // say "street name" then "full delivery address on accept" — that's what
      // the product actually does (ui.orderDetail.detail.addressShownOnAccept).
      // The draft's other wording promised the full address before accepting.
      flowStep1: "Click “Yes, I'll make it” below to see the bouquet, the street name, date and price.",
      flowStep2: "If you can do it, tap \u201cI can deliver this order as shown\u201d: you get the full delivery address, and we pay 70% immediately by credit card.",
      flowStep2Full: "If you can do it, tap “I can deliver this order as shown”: you get the full delivery address, and we pay you in full immediately by credit card.",
      flowStep3: "Make the bouquet, upload a quick photo, and get the remaining 30% before you deliver.",
      flowStep3Full: "Make the bouquet and upload a quick photo. No payment is waiting on it: we need it as proof of delivery, and the customer receives it.",
      flowStep4: "Confirm the delivery so we can update the customer.",
      closing: "Every step is quick and we'll walk you through it. Orders come by email or text, and there's no waiting to get paid.",
      // NOTE: the old `howItWorksTitle` + `step1..5Title/Body` keys are gone.
      // They described a five-step flow the product no longer presents that
      // way, and their only remaining reader — /florist/how-it-works — now has
      // its own page-shaped copy under `ui.howItWorks`. Any DB override stored
      // against those keys is inert.
      factPayout: "Your payout",
      factArea: "Area",
      factDeliverBy: "Deliver by",
      // ONE label, end to end: the button, the sentence in flowStep1 that tells
      // the florist what to click, and the app's own accept control. The draft
      // had two different names for the same button in the same email.
      cta: "Yes, I'll make it",
      // The deadline sentence, in two full forms rather than one sentence with
      // a glued-in fragment — same reason introNoCity is a whole alternate
      // sentence (see above). `deadlineNote` is the normal path: a real
      // florist-local wall-clock time from lib/floristTime.ts. It falls back to
      // `replyWindowNote` when we can't state one honestly — no coordinates for
      // the shop, an unknown zone, or a deadline that has already passed.
      deadlineNote: "We need your answer before {time}.",
      replyWindowNote: "We need your answer within {window}.",
      // Interpolated into `subject`/`subjectNoCity` as {when} — see
      // lib/offerEmailContent.ts::formatOfferWhen. The third branch (a
      // specific date) isn't a catalog key: it's rendered directly via
      // `toLocaleDateString(locale, ...)`, which is inherently locale-aware.
      when: {
        today: "today",
        soon: "soon", // order has no delivery_at at all — rare, keep the subject sensible anyway
      },
      // Interpolated into `replyWindowNote` as {window} — see
      // lib/offerEmailContent.ts::formatOfferReplyWindow. Plurals are
      // separate keys (no plural machinery in t()/interpolate()), chosen by
      // the same mins/hours branching the old hardcoded version used.
      replyWindow: {
        fewMinutes: "a few minutes", // <= 1 minute left, or rounding makes an exact count misleading
        minutes: "{count} minutes",
        hour: "1 hour",
        hours: "{count} hours",
        couple: "a couple of hours", // expiry missing or already past — vague but honest fallback
      },
      unsubscribeLead: "Getting too many of these?",
      unsubscribeLink: "Manage your order emails",
      helpLead: "Questions before you decide?",
      helpLink: "Read our florist Q&A",
      // Rendered again in the offer footer since 2026-09-16 (removed in the
      // 2026-08-05 review pass until there was a chat behind it; there is now).
      // See the footer comment in lib/offerEmailContent.ts for why it came back.
      supportLead: "Questions about this order?",
      // Fallback for {floristName} in short.greeting when the florist record
      // has no name — resolved in lib/offerEmailContent.ts (testable), not
      // lib/offerVars.ts, per the leak-guard fix (was a hardcoded "there").
      genericFloristName: "there",
      short: {
        // The repeat-florist variant. It reuses flowStep1..4 verbatim and only
        // swaps the framing around them: we can't tell how long it's been since
        // this florist last read the flow, so it's re-stated as a reminder
        // rather than dropped.
        greeting: "Hi {floristName}, we have a flower order for you.",
        reminder: "Quick reminder in case it's been a while: Facundo is an international flower delivery service with a 20-year legacy, and you're part of our selected florist network. Orders come by email or text, always paid up front by credit card, no waiting.",
        lead: "Here's this one:",
        closing: "Every step takes seconds and we'll walk you through it.",
        howItWorksLead: "New to this?",
        howItWorksLink: "See how it works",
      },
    },
    // Client-facing notices (assigned/on_the_way/delivered). Customers are
    // English-only for now by decision — see clientComms.ts::notifyClient,
    // which hardcodes locale "en" rather than reading these per-locale.
    client: {
      assigned: {
        subject: "Your Facundo order is being prepared",
        body: "Good news: a local florist has been assigned to your order and is preparing your bouquet now. We'll let you know the moment it's on its way.",
      },
      on_the_way: {
        subject: "Your Facundo order is on the way",
        body: "Your bouquet has left the florist and is on its way to its destination. We'll let you know the moment it's delivered.",
      },
      delivered: {
        subject: "Your Facundo order has been delivered",
        body: "Your order has been delivered. We hope it brings a smile. Thank you for choosing Facundo.",
        photoNote: "This photo link expires in 30 days.",
      },
    },
    // Issue-thread emails (lib/issueComms.ts). `resolvedSubject`/`repliedSubject`
    // are florist-facing (localized); the message `body` itself is CX's
    // free-typed reply/resolution text and is never translated.
    // Staff-sent sign-in link (lib/floristMagicEmail.ts) — CX emailing a
    // florist a one-tap way back into their account, or straight to one order.
    magicLink: {
      subject: "Your Facundo sign-in link",
      subjectOrder: "Your Facundo link to order {orderLabel}",
      preheader: "One tap to open your Facundo account.",
      headline: "Sign in to Facundo",
      body: "Tap the button below to open your Facundo account. The link keeps working for 30 days, and you can use it more than once.",
      bodyOrder: "Tap the button below to open this order in your Facundo account. The link keeps working for 30 days, and you can use it more than once.",
      cta: "Open Facundo",
      ctaOrder: "Open the order",
      ignore: "If you weren't expecting this email, you can safely ignore it.",
    },
    // "Thank you for accepting" — sent the moment a florist takes an order
    // (lib/acceptComms.ts). Its whole reason for existing is `trust`: the
    // accept used to produce a message for the customer, for Shopify and for
    // CX, and nothing at all for the person who just committed to making the
    // bouquet.
    acceptConfirm: {
      subject: "Thank you: order {orderLabel} is yours",
      preheader: "We trust you to deliver it correctly. Here's what happens next.",
      headline: "Thank you for accepting",
      // The sentence this message exists for. Deliberately says "as shown":
      // the recipe, the add-ons and the card message in the app are the
      // agreement, not a suggestion.
      trust: "Thank you for taking order {orderLabel}, {floristName}. We trust you to prepare and deliver it correctly, exactly as shown in the app. The customer is counting on you, and so are we.",
      trustNoName: "Thank you for taking order {orderLabel}. We trust you to prepare and deliver it correctly, exactly as shown in the app. The customer is counting on you, and so are we.",
      paid: "Your 70% is on its way to your Facundo card. Open the order to reveal the card and charge it.",
      paidFull: "Your payout for this order is on its way to your Facundo card, in full. Open the order to reveal the card and charge it.",
      next: "Next: make the bouquet, then upload a photo of it in the app. The remaining 30% is released before you deliver.",
      nextFull: "Next: make the bouquet, then upload a photo of it in the app. Nothing is waiting on that photo, we need it as proof of delivery and the customer receives it.",
      address: "The full delivery address and the recipient's details are in the app now that the order is yours.",
      problem: "If anything goes wrong (a missing ingredient, an address that doesn't work), report it from the order page rather than leaving it silent. We'll help.",
      cta: "Open the order",
      factOrder: "Order",
      factDeliverBy: "Deliver by",
      factPayout: "Your payout",
    },
    issue: {
      resolvedSubject: "Your issue on {orderLabel} was resolved",
      repliedSubject: "Facundo replied about {orderLabel}",
      cta: "Open order",
    },
    // ---- The cold-outreach funnel (replaces the old single `recruiting` email) ----
    //
    // Seven touches, each a DIFFERENT angle, not the same pitch reworded. The
    // funnel's rule is that a prospect who ignored one argument should meet a
    // new one, not the same paragraph in a new envelope:
    //
    //   t1  day 0        company, branded  the situation: a real person in another
    //                                      country wants flowers delivered here
    //   t2  day 3        persona, plain    scarcity: this city is short of florists
    //   t3  day 7        persona, plain    the objection: how the money actually works
    //   r1  click + 2d   persona, plain    "you looked — what stopped you?"
    //   r2  r1 + 3d      persona, plain    the graceful exit
    //   co1 cold offer lapsed, persona     "that order went to another shop"
    //   co2 co1 + 4d     persona, plain    last word on the next order
    //
    // t2 onward are signed by a named persona (outreach_personas) and default to
    // the PLAIN email voice — no logo, no card, no button. That is the point:
    // touch 1 is from a company, everything after it is from a person, and a
    // person's email does not arrive in a branded template.
    //
    // What the old copy did that this deliberately does not: open with "20-year
    // legacy and over 200,000 orders delivered" (nobody deciding whether to make
    // a bouquet cares), assert "your shop's excellent reviews" at a shop we may
    // know nothing about, or lay the offer out as a four-point numbered list,
    // which is the single strongest tell that an email was mail-merged.
    //
    // The WhatsApp claim is gone. OFFER_CHANNELS is ["email","sms","push"] —
    // promising a channel we do not have is a promise broken on day one.
    recruit: {
      t1: {
        // An invitation, not an offer. This email has NO order attached, so a
        // subject built around "flower orders in {city}" both overpromises and
        // reads almost identically to email.offer.subject, which a florist needs
        // to be able to tell apart at a glance once they're in the network.
        // Phrased as a question: it asks rather than announces, and it cannot be
        // mistaken for the real offer email.
        subject: "Would you take flower orders in {city}?",
        subjectNoCity: "Would you take flower orders from us?",
        greeting: "Hi there,",
        p1: "We're Facundo. Someone in another country wants to send flowers to a person in {city}, and we need a local florist to make and deliver them.",
        p1NoCity: "We're Facundo. Someone in another country wants to send flowers to a person in your city, and we need a local florist to make and deliver them.",
        p2: "That's the whole business. We find the customer; you make the bouquet.",
        // Branches on whether we actually HAVE a rating/review signal for this
        // shop. Claiming "your excellent reviews" at a shop we've never seen a
        // review for is a lie the recipient can check in one click.
        evidenceReviews: "Your shop came up when we looked at who's well reviewed in {city}.",
        evidenceReviewsNoCity: "Your shop came up when we looked at who's well reviewed in your area.",
        evidence: "Your shop came up while we were looking at florists in {city}.",
        evidenceNoCity: "Your shop came up while we were looking at florists in your area.",
        p3: "You'd get an email or a text when an order comes up near you, with the bouquet, the address, the date and the price. Take it or ignore it. No fee, no contract, no minimum.",
        p4: "The part most florists ask about first: we pay 70% by card the moment you accept, before you've bought a single stem. You send a photo of the finished bouquet, we check it, and the other 30% goes out, still before you deliver. Nothing to chase.",
        p5: "If that sounds workable, joining takes about a minute.",
        cta: "Join the Facundo network",
      },
      t2: {
        // Lowercase, no brand, no city-as-marketing. A subject line typed by a
        // person following up on their own email looks like this one.
        subject: "florists in {city}",
        subjectNoCity: "florists in your area",
        greeting: "Hi,",
        p1: "I sent a note a few days ago about Facundo. I'm following it up myself because {city} is one of the places we're short of florists right now.",
        p1NoCity: "I sent a note a few days ago about Facundo. I'm following it up myself because your area is one of the places we're short of florists right now.",
        p2: "When an order lands and we have nobody nearby, we either send it a long way out or we lose it. Neither is good for whoever is meant to be receiving the flowers.",
        p3: "You wouldn't be committing to anything. You'd be on the list we contact when something lands near you, and you say yes or no each time.",
        p4: "Worth a minute of your time?",
        cta: "Get on the list",
      },
      t3: {
        subject: "how the money actually works",
        greeting: "Hi,",
        p1: "Last one from me.",
        p2: "Florists who don't reply often tell me later that the terms sounded too good: paid before you deliver, no fee, no contract. Fair enough. So, plainly:",
        p3: "We charge the customer. When you accept an order we put 70% on a card you can use that same day, before you buy anything. You send a photo of the finished bouquet, we check it's right, and the remaining 30% goes out. Then you deliver.",
        p4: "We carry the risk on the customer; you carry it on the bouquet. That's why there's no fee. We've already been paid.",
        p5: "If it's not for you, no hard feelings and I'll stop writing.",
        cta: "Try one order",
      },
      r1: {
        // Fires on the FIRST click, on email and SMS together. The angle is the
        // click itself — this is the one touch that can honestly say "you looked".
        subject: "did something not add up?",
        greeting: "Hi,",
        p1: "I can see someone from your shop opened the link I sent. Thanks for taking a look.",
        p2: "You didn't finish, which usually means one of three things: the delivery area didn't look right, the payment side wasn't clear, or you simply got busy.",
        p3: "Whichever it was, reply to this and I'll answer. I read these myself.",
        cta: "Pick up where you left off",
      },
      r2: {
        subject: "closing this off",
        greeting: "Hi,",
        p1: "I'll leave it here. I don't want to keep filling your inbox.",
        p2: "If you ever want to take a Facundo order, the link below works whenever you're ready. And if you'd rather speak to a person first, reply to this and you'll get me.",
        cta: "Join whenever you're ready",
      },
      // ---- The cold-offer bridge ----
      // Sent after a REAL order we offered to a shop outside the network has
      // gone elsewhere. It is the only touch that can point at something
      // concrete that already happened, which makes it the strongest recruiting
      // email we have — and the only honest moment to admit we offered an order
      // to a shop we'd never spoken to.
      co1: {
        subject: "that {city} order went to another shop",
        subjectNoCity: "that order went to another shop",
        greeting: "Hi,",
        p1: "A few days ago we sent you a real flower order for {city}. It's gone to another florist now. These move fast, often within the hour.",
        p1NoCity: "A few days ago we sent you a real flower order. It's gone to another florist now. These move fast, often within the hour.",
        p2: "I'm writing because you're not actually in our network yet. We sent it to you anyway, because you were the closest good fit we could find. That's an odd way to introduce ourselves, so: hello.",
        p3: "If you'd like the next one, getting on the list takes about a minute. No fee, no contract. You say yes or no to each order, and we pay 70% by card before you buy a stem.",
        p4: "There'll be another order near you. There usually is.",
        cta: "Get on the list",
      },
      co2: {
        subject: "the next {city} order",
        subjectNoCity: "the next order near you",
        greeting: "Hi,",
        p1: "Following up once on the order we sent you. You're still not on the list, so the next one will go elsewhere too.",
        p2: "If that's deliberate, no problem and I'll stop. If it's just been a busy week, the link below is the whole process.",
        cta: "Get on the list",
      },
    },
// ---- Reactivation: florists who ALREADY joined ----
    //
    // A better problem than recruiting, and a different one: they said yes once.
    // Two sequences because there are two ways it went quiet, and confusing them
    // is worse than saying nothing. Telling a shop that has never delivered for
    // us "it's been a while since your last order" would be visibly wrong and
    // would tell them nobody here is paying attention.
    //
    //   ra1/ra2 — joined, never took a first order. The blocker is almost always
    //             nerves about how the money actually moves, so ra1 answers that
    //             without being asked and ra2 simply offers a person.
    //   rd1/rd2 — took orders before, then stopped. Assume a reason exists and
    //             ask, rather than pitching them something they already know.
    // ---- The spoken opening for a voice call ----
    //
    // Assembled from lib/voice/recordingPolicy.ts::noticeParts, IN ORDER, and
    // spoken before anything is captured. `ai` is always present — the voice
    // policy is proactive disclosure, and that obligation does not depend on
    // whether we are recording.
    //
    // Written to be SAID rather than read: short clauses, no stacked
    // subordinates, nothing a person has to rewind to parse. A notice nobody
    // can follow at speaking speed is not a notice.
    voiceNotice: {
      ai: "Hello, this is {name} from Facundo. I should say up front that I'm an automated assistant, not a person, and I can put you through to a colleague any time you'd like.",
      recording: "This call is recorded so a colleague can check I got things right.",
      transcript: "I keep a written note of this call so a colleague can check I got things right.",
    },
    // ---- AI disclosure ----
    // EU AI Act Art. 50 has applied since 2 August 2026 in every market this
    // funnel targets. It requires that people are INFORMED they are interacting
    // with an AI system unless that is obvious from context — and our replies
    // are signed by a named persona, which points the reader the other way and
    // so removes that exemption.
    //
    // `proactive` is appended ONCE per thread, on the first reply a model
    // writes (conversations.ai_disclosed_at). NOT on the funnel touches: those
    // are hand-written catalog copy, not an AI interacting with anyone.
    // `whenAsked` is the answer when they ask outright — guarded by
    // lib/cxAgentGuard.ts::replyDisclosesAi so it cannot be talked around.
    disclosure: {
      proactive: "Replies to this address are drafted by an automated assistant. Say the word and a colleague will pick it up.",
      whenAsked: "You're right to ask: I'm an automated assistant, not a person. Say the word and a colleague will take over.",
    },
    reactivate: {
      ra1: {
        subject: "you haven't taken a first order yet",
        greeting: "Hi,",
        p1: "You joined our florist network a little while ago and haven't taken an order yet. That's completely fine, and it's the most common place to pause.",
        p2: "If it's the money side that's holding you up, here it is once more: we pay 70% by card the moment you accept, before you buy anything. You send a photo of the finished bouquet, we check it, and the other 30% goes out before you deliver. You are never out of pocket at any point.",
        p3: "If it's something else, the delivery area, the timings, the app itself, tell me what it is and I'll sort it out.",
        p4: "The next order near you will come through the same way as the last. There is nothing to set up in advance.",
        cta: "Open your florist account",
      },
      ra2: {
        subject: "anything I can help with?",
        greeting: "Hi,",
        p1: "Following up once. You're still on our list and still get the orders, so nothing is lost either way.",
        p2: "If there's a reason you haven't taken one yet, I'd genuinely like to know, even if the answer is that it isn't for you. Reply to this and it comes straight to me.",
        cta: "Open your florist account",
      },
      rd1: {
        subject: "it's been a while, {city}",
        subjectNoCity: "it's been a while",
        greeting: "Hi,",
        p1: "You've made bouquets for us before, and it's been a while since the last one. Orders are still coming through {city}.",
        p1NoCity: "You've made bouquets for us before, and it's been a while since the last one. Orders are still coming through your area.",
        p2: "If something went wrong on one of them, I'd rather hear it than guess. If it was just a busy season, that's the usual answer and no explanation is needed.",
        p3: "Nothing has changed on our side: same terms, same 70% by card when you accept, and you still say yes or no to each one.",
        cta: "Open your florist account",
      },
      rd2: {
        subject: "should we keep sending you orders?",
        greeting: "Hi,",
        p1: "One last note, and a direct question: do you want to keep receiving orders from us?",
        p2: "If yes, you don't need to do anything, they'll keep coming. If not, say so and I'll take you off the list today, no hard feelings. Either answer is genuinely useful, and silence is the only one I can't act on.",
        cta: "Open your florist account",
      },
    },
  },
  sms: {
    // "Thank you for accepting", SMS half (lib/acceptComms.ts). Budgeted at 2
    // segments. Same GSM-7 rule as sms.offer above and for the same reason:
    // one accented character or one typographic dash doubles the bill on every
    // send. Straight apostrophes, "-" not "—", no accents in any locale.
    acceptConfirm: {
      body: "Facundo: thanks for accepting order {orderLabel}. We trust you to deliver it correctly, as shown. 70% is on its way to your card. Photo in the app releases the other 30%: {url}",
      bodyFull: "Facundo: thanks for accepting order {orderLabel}. We trust you to deliver it correctly, as shown. Your full payment is on its way to your card. Still upload the photo in the app as proof: {url}",
      optOut: "Stop texts: {url}",
    },
    offer: {
      // Rewritten 2026-08-05 to sell the 70/30 split rather than just the
      // payout figure. Budgeted at 3 segments (was 2) — a deliberate, costed
      // choice, asserted per-locale in lib/offerSmsContent.test.mjs.
      //
      // EVERY string in this section must stay GSM-7. One accented character
      // or one typographic dash flips the WHOLE message to UCS-2's 67-char
      // segments and doubles the bill — that is not a style rule, it is the
      // difference between 3 and 6 segments on every send. So: straight
      // apostrophes, "-" not "—", and no accents even in fr/es/it/de/pt.
      body: "Facundo, international flower delivery. We have a flower order for your shop in {city}. 70% paid by card when you accept, 30% before delivery. Details: {url} - {deadline}",
      bodyFull: "Facundo, international flower delivery. We have a flower order for your shop in {city}. Paid in full by card when you accept. Details: {url} - {deadline}",
      bodyNoCity: "Facundo, international flower delivery. We have a flower order for your shop. 70% paid by card when you accept, 30% before delivery. Details: {url} - {deadline}",
      bodyNoCityFull: "Facundo, international flower delivery. We have a flower order for your shop. Paid in full by card when you accept. Details: {url} - {deadline}",
      // Repeat florist: no city (they know where they are), no re-introduction.
      repeat: "Hi {floristName}, Facundo here - you're in our florist network. New flower order for you: 70% paid by card on accept, 30% before delivery. {url} - {deadline}",
      repeatFull: "Hi {floristName}, Facundo here - you're in our florist network. New flower order for you: paid in full by card on accept. {url} - {deadline}",
      // The deadline as a trailing fragment rather than two full body strings.
      // Gluing is safe HERE and not in the email: SMS copy is telegraphic in
      // every one of our languages, and doubling six bodies to carry both
      // deadline forms would be worse.
      byTime: "by {time}",
      within: "reply in {window}",
      optOut: "Stop texts: {url}",
    },
    // The SMS legs of the recruiting funnel. Only TWO touches carry a text:
    // t1 (alongside the day-0 email) and r1 (the first click). The funnel caps
    // SMS at one message for an engaged prospect on purpose — a cold text to a
    // shop that never asked to hear from us is the send most likely to be
    // remembered as spam, and the cheapest to get wrong.
    //
    // EVERY string here must stay GSM-7, same rule as sms.offer above: one
    // accent or one typographic dash flips the whole message to UCS-2's 67-char
    // segments and doubles the bill. Straight apostrophes, "-" not "—", no
    // accents in any locale. The persona's name is folded through toGsm7Safe at
    // build time, so an accented persona cannot break the budget either.
    recruit: {
      t1: {
        body: "Facundo, international flower delivery. We need a florist in {city} - we pay 70% by card when you accept, 30% before you deliver. No fee, no contract. Join in 1 min: {url}",
        bodyNoCity: "Facundo, international flower delivery. We need a florist in your area - we pay 70% by card when you accept, 30% before you deliver. No fee, no contract. Join in 1 min: {url}",
      },
      r1: {
        body: "Hi, {name} from Facundo here. You looked at our florist signup but didn't finish - anything I can answer? Finish here: {url}",
      },
      optOut: "No more texts: {url}",
    },
  },
  // Human labels for order-issue `type` values. Shared by the issue emails
  // (lib/issueComms.ts) and the issue-facing UI (FloristMessages, IssueThread)
  // via lib/i18n/issueLabels.ts::issueLabel() — the single source of truth
  // that replaced three copy-pasted inline maps.
  issueLabel: {
    missing_ingredient: "Missing ingredient",
    wrong_address: "Wrong address",
    out_of_range: "Address out of range",
    recipient_unavailable: "No one home / recipient unavailable",
    damaged_wrong_recipient: "Damaged / wrong recipient",
    other: "Issue",
  },
  ui: {
    account: {
      language: {
        title: "Language",
        en: "English",
        fr: "Français",
        es: "Español",
        it: "Italiano",
        de: "Deutsch",
        pt: "Português",
        saving: "Saving…",
        error: "Couldn't save your language. Try again.",
      },
      // Everything else on FloristAccount.tsx (Team, Change password, Install
      // app link, push-notification copy, Appearance/theme, Sign out).
      title: "Account",
      signedIn: "Signed in",
      subtitle: "Florist account",
      installLink: "Install app",
      helpLink: "Questions and Answers",
      signOut: "Log out",
      theme: {
        title: "Appearance",
        ariaLabel: "Theme",
        light: "Light",
        dark: "Dark",
        system: "System",
      },
      password: {
        title: "Change password",
        newPlaceholder: "New password",
        confirmPlaceholder: "Confirm new password",
        saving: "Saving…",
        update: "Update password",
        tooShort: "Use at least 8 characters.",
        mismatch: "Passwords don't match.",
        updated: "Password updated.",
      },
      push: {
        title: "Order notifications",
        on: "✓ Notifications on",
        enable: "Enable order notifications",
        requesting: "Requesting…",
        failed: "Failed",
        error: "Could not enable notifications.",
      },
      // No real email is sent for invites (drafts/links only, matching this
      // project's outreach convention) — "invitePlaceholder" is an example
      // address format and is deliberately left unchanged across locales.
      team: {
        title: "Team",
        owner: "Owner",
        member: "Member",
        remove: "Remove",
        removing: "Removing…",
        pendingInvites: "Pending invites",
        revoke: "Revoke",
        revoking: "Revoking…",
        inviteHeading: "Invite a teammate",
        invitePlaceholder: "teammate@shop.com",
        invite: "Invite",
        inviting: "Inviting…",
        copy: "Copy",
        inviteError: "Couldn't create the invite.",
      },
    },
    // The florist app walkthrough (/florist/guide). Written in `en` only for now;
    // t() falls back per key, so the page renders complete in every locale and
    // can be translated key-by-key later without touching the component.
    guide: {
      eyebrow: "Facundo · Florist guide",
      title: "Your orders, and getting paid",
      lede: "You make the bouquet. We find the customer, handle them, and pay you before you start. Here's the whole loop, screen by screen.",
      payTitle: "How the money works",
      leg1When: "The moment you accept",
      leg1Note: "Issued to your Facundo card before you've bought a single stem.",
      leg1NoteFull: "The whole amount, issued to your Facundo card before you have bought a single stem.",
      leg2When: "When you send the photo",
      leg2Note: "Released once we've seen the finished bouquet: still before you deliver.",
      leg2NoteFull: "No payment is waiting on it. We need it as proof the delivery happened, and the customer receives it.",
      barAlt: "70 per cent on accept plus 30 per cent on photo equals 100 per cent",
      barAltFull: "One hundred per cent of your payout, paid when you accept",
      sum: "70% + 30% = 100% of your payout, in your hands before the flowers leave your shop.",
      sumFull: "100% of your payout, in your hands before you buy a single flower.",
      stepsTitle: "An order, start to finish",
      stepsSub: "Six steps. In practice each one takes seconds.",
      step1Title: "An order comes to you",
      step1Body: "You get a text and an email. Open the app and it's waiting under Orders. Nothing is assigned to you yet: this is an offer, and it's yours to take or leave.",
      step1Extra: "There's no penalty for passing. Say no and the next order still comes.",
      step1Caption: "Orders, table view: an offer waiting for an answer",
      step2Title: "See what you'd be making",
      step2Body: "Before you decide, you see the bouquet, the recipe, how far it's going, when it has to arrive, and exactly what you'll be paid.",
      step2Extra: "You don't get the recipient's full address yet: just the area. That arrives the moment you accept.",
      step2Caption: "The offer: payout and deadline up front",
      step3Title: "Accept it, and the first payment moves",
      step3Body: "One button: “I can deliver this order as shown”. That's the whole decision.",
      step3Extra: "Your 70% is issued to your Facundo card straight away: before you've bought a single stem.",
      step3ExtraFull: "Your whole payout is issued to your Facundo card straight away: before you have bought a single stem.",
      step3Caption: "Shown in the animation below.",
      step4Title: "Now you have everything",
      step4Body: "The full delivery address, the recipient's name and phone, the card message to write out, and the recipe with quantities.",
      step4Extra: "Something wrong: a flower you can't get, an address that doesn't work? Use Report a problem on the order rather than letting it slide. We'll sort it.",
      step4Caption: "The work order, unlocked after accepting",
      step5Title: "Send a photo of the bouquet",
      step5Body: "When it's made, photograph it in the app. We check it matches what the customer ordered.",
      step5Extra: "That releases the remaining 30%: still before you deliver.",
      step5ExtraFull: "That is your proof of delivery. Your payment does not depend on it, and it was already made in full.",
      step5Caption: "This screen appears on the order once you've accepted it.",
      step6Title: "Deliver, and confirm it",
      step6Body: "Mark it delivered so we can tell the customer. That closes the order.",
      step6Extra: "It moves into History, and the money is already yours.",
      step6Caption: "History: delivered orders and what they paid",
      acceptTitle: "The one button that matters",
      acceptSub: "Accepting is a single tap: and the payment moves on that tap.",
      acceptAlt: "Accepting an order in the app: the offer screen, then the unlocked work order",
      acceptBody: "“I can deliver this order as shown” is the whole commitment. Tap it and three things happen at once: the order is yours, the full address appears, and your 70% is on its way.",
      acceptBodyFull: "I can deliver this order as shown is the whole commitment. Tap it and three things happen at once: the order is yours, the full address appears, and your entire payout is on its way.",
      declineBody: "Not right for you? “I can't accept this order” tells us in one tap so we can find someone else quickly. That's genuinely useful to us: silence is what slows an order down.",
      moneyTitle: "Where your money shows up",
      moneySub: "Two places, and they always agree.",
      balanceTitle: "Balance",
      balanceBody: "What you've earned and what's on its way. Your standing with us sits at the top.",
      historyTitle: "History",
      historyBody: "Every order you've delivered, with the date and what it paid.",
      messagesTitle: "Messages",
      messagesBody: "Anything we need to ask you, and anywhere you've reported a problem on an order.",
      signInTitle: "Signing in",
      signInSub: "However you get here, you land in the same place.",
      waysInTitle: "Three ways in",
      waysInBody: "Google, a code emailed to you, or a password. Use whichever you prefer: it's the same account either way.",
      accountTitle: "Your shop's details",
      accountBody: "Opening hours, the number we text, your delivery cutoff. Keep these right and the orders we send you will fit.",
      footer: "Questions before you take an order? Every screen has Questions and Answers in the corner, and “I have a question first” sits on the offer itself: asking never costs you the order.",
    },
    howItWorks: {
      eyebrow: "Facundo · For florists",
      title: "How an order works",
      subtitle: "Four steps, from the offer landing on your phone to the money in your account. You are paid in full before the flowers leave your shop.",
      subtitleFull: "Four steps, from the offer landing on your phone to the money in your account. You are paid in full the moment you accept.",
      // The page's own step copy. The offer email's flowStep1..4 read as
      // instructions about that email ("click below"), which is meaningless
      // here — so this page carries its own wording for the same four steps.
      stepsTitle: "The four steps",
      step1Title: "We send you the order",
      step1Body: "You see the bouquet, the street name, the delivery date and exactly what you will be paid. Accept it or ignore it: there is no obligation and no minimum.",
      step2Title: "You are paid 70% on the spot",
      step2TitleFull: "You are paid in full on the spot",
      step2Body: "The moment you accept, we share a Facundo credit card you can charge for 70% of your payout. That is before you buy a single stem.",
      step2BodyFull: "The moment you accept, we share a Facundo credit card you can charge for your whole payout. That is before you buy a single stem.",
      step3Title: "You send a photo",
      step3Body: "Make the bouquet and upload one clear photo of it. We check it against the order and release the remaining 30%, still before you deliver.",
      step3BodyFull: "Make the bouquet and upload one clear photo of it. No payment is waiting on it: we need it as proof the delivery happened, and the customer receives it.",
      step4Title: "You confirm the delivery",
      step4Body: "Tell us it arrived and we close the order with the customer. Nothing else to chase.",
      payTitle: "Paid before you deliver",
      payAccept: "when you accept",
      payAcceptFull: "when you accept, in one payment",
      payPhoto: "when your photo is approved",
      payPhotoFull: "left to wait for. Your photo is proof of delivery, not a payment gate.",
      payNothingLeft: "Nothing",
      payNote: "No 30- or 60-day terms. No monthly settlements.",
      perksTitle: "What being in the network means",
      perk1Title: "No fee, no commitment",
      perk1Body: "Nothing to pay to join, and no minimum number of orders. Take the ones that suit you.",
      perk2Title: "Orders your way",
      perk2Body: "By email or text, whichever you actually read.",
      perk3Title: "In your language",
      perk3Body: "Everything is handled online, in the language you work in.",
      perk4Title: "Local work, global customers",
      perk4Body: "Customers order from anywhere in the world; the bouquet is made and delivered by a shop like yours.",
      footer: "Questions about a specific order? Reply to the email it came in on.",
    },
    // The Q&A, rendered by components/help/HelpCenter.tsx onto BOTH /help
    // (public, linked from the emails) and /florist/help (inside the PWA).
    // Which articles exist and in what order is lib/help/content.ts; every
    // word of them is here. `a.<id>.q` / `.body` must exist for every article
    // in that module — lib/help/content.test.mjs fails the build otherwise.
    help: {
      title: "Questions & answers",
      cat: {
        app: "Using the app",
        money: "Getting paid",
        orders: "Orders & flowers",
        about: "About us & support",
      },
      // Shown only when the florist arrived from an offer (?back=…). The
      // second line matters: the whole point of the button is that reading
      // this page costs them nothing.
      backToOrder: "Back to your order",
      backNote: "Nothing has changed while you were here: you can pick up where you left off.",
      relatedLead: "Related",
      howItWorksLink: "See how an order works",
      joinTitle: "Want to receive orders?",
      joinBody: "There's no joining fee and no commitment. You take the orders that suit you and ignore the rest.",
      a: {
        "how-offers-arrive": {
          q: "How will I know when there's an order for me?",
          body: "We send the offer to your phone the moment it comes in: by email and SMS, and as a push notification if you've installed the app. Every message links straight to the order, and you don't need a password: the link signs you in.",
        },
        "accept-an-order": {
          q: "How do I accept an order?",
          body: "Open the offer and check the three things that decide it: what you'd be paid, where it's going, and when it has to arrive. Tap Accept and it's yours: the full address and the recipient's name appear straight away. If you're not sure, read these answers first and come back; the offer stays open while you do.",
          callout1: "What you'll be paid for this order",
          callout2: "The area it's going to and the delivery date",
          callout3: "Accept it, or tell us it isn't for you",
        },
        "what-do-i-make": {
          q: "Where do I see what to make?",
          body: "The order page lists every item with a photo, the recipe (which flowers and how many), anything that goes in the box alongside them, and the message for the card. Match the photo as closely as you can: it's what the customer was shown.",
        },
        "delivery-photo": {
          q: "How do I send the delivery photo?",
          body: "Open the order, tap Upload delivery photo, and take one clear picture of the finished bouquet in good light before it leaves the shop. We check it against the order and release the rest of your payment.",
          bodyFull: "Open the order, tap Upload delivery photo, and take one clear picture of the finished bouquet in good light before it leaves the shop. Your payment does not depend on it: we need it as proof the delivery happened, and the customer receives it.",
          callout1: "The whole bouquet, front on, in daylight",
          callout2: "Tap here to take or choose the photo",
        },
        "install-app": {
          q: "How do I put the app on my phone?",
          body: "Open it in your phone's browser and choose “Add to Home Screen”. It then behaves like any other app, and we can send you a push notification the moment an order for your area comes in, which is the fastest way to hear about one.",
        },
        "working-language": {
          q: "Can I use it in my own language?",
          body: "Yes. The app, our emails and our messages are all available in English, Spanish, French, Italian, German and Portuguese. Change it under Account → Language and everything we send you switches too.",
        },
        teammates: {
          q: "Can someone else in my shop use the account?",
          body: "Yes. Go to Account and send an invite link to your colleague. They get their own sign-in to the same shop and see the same orders. There's no limit and no extra cost.",
        },
        "getting-paid": {
          q: "How and when do I get paid?",
          body: "In two parts, both before the flowers are delivered. 70% of your payout releases immediately, the moment you accept the order, not after delivery. The remaining 30% releases as soon as we've approved your photo of the finished bouquet. You never wait on the customer.",
          bodyFull: "In one payment, before you have bought anything. Your whole payout releases the moment you accept the order, not after delivery and not in parts. You never wait on the customer, and you never wait on us.",
        },
        "the-card": {
          q: "How does the Facundo card work?",
          body: "Rather than wait for a transfer, we show you a Facundo card loaded with your payment, which you charge like any other card. You'll find it on the order and under Balance, and the money is there as soon as that part of the payout is released. It's the only payout method we support today. If it doesn't suit your shop, contact us and we'll see what we can do.",
        },
        "photo-not-approved": {
          q: "What if my photo isn't approved?",
          body: "We tell you why and you can upload another; the order stays yours. It's usually a photo too dark to see the flowers, or a bouquet that doesn't match what was ordered. If you think we've got it wrong, say so on the order and a person will look at it.",
        },
        "missing-flower": {
          q: "I'm out of a flower in the recipe. Can I replace it?",
          body: "Yes, within limits. You may swap a flower for another as long as it's similar in shape and colour, or the swap doesn't change the overall character of the bouquet: either way, up to 30% of the bouquet's flowers, no more. Roses can't be swapped for anything else. Tell us through “Report a problem” on the order so we can let the customer know before it arrives. If what you need goes beyond that, contact us rather than guessing.",
        },
        "wrong-address": {
          q: "The address is wrong, or nobody is there",
          body: "Use “Report a problem” on the order and pick what happened. We contact the customer, get the right details and come back to you. Don't return the bouquet or leave it with a neighbour until we've answered.",
        },
        "cant-fulfil": {
          q: "I accepted, but I can't do it after all",
          body: "Open the order and choose “Give this order back”, with the reason. It goes straight out to another florist. Do it as early as you can: the closer to the delivery date, the harder it is for anyone else to pick up. Handing an order back doesn't count against you; going quiet does.",
        },
        "decline-an-offer": {
          q: "What if I don't want an order?",
          body: "Decline it, or simply ignore it. There's no obligation, no minimum and no penalty. Telling us why takes a second and means the next ones we send suit you better.",
        },
        "delivery-timing": {
          q: "When does it have to arrive?",
          body: "The delivery date is on the offer before you accept it, and on the order afterwards. Where the customer chose a time window, that's shown too. If you can't make the date, hand the order back rather than deliver it late.",
        },
        "contact-us": {
          q: "Something's wrong and I need a person",
          body: "If it's about an order you've accepted, use “Report a problem” on that order: it reaches us with the order already attached, which is the fastest route. For anything else, write to {supportEmail}. We answer in your language.",
        },
        "who-we-are": {
          q: "Who is Facundo?",
          body: "Facundo sells flowers to people sending them to someone in another city or another country: an order placed in New York for a mother in Girona. We look after the customer, the payment and the delivery promise. The bouquet itself is made and delivered by a local shop like yours.",
        },
        "what-it-costs": {
          q: "What does it cost to be in the network?",
          body: "Nothing. No joining fee, no subscription, no minimum number of orders. What we quote you on an offer is what you're paid.",
        },
        "stop-offers": {
          q: "How do I stop receiving offers?",
          body: "Every email has an unsubscribe link at the bottom, and every SMS tells you how to opt out. You can also just tell us and we'll stop. It takes effect immediately, and you can start again whenever you like.",
        },
      },
    },
    accept: {
      // Time-of-day greeting, picked from the SHOP's local clock
      // (lib/floristGreeting.ts). `night` is deliberately not "Good night" —
      // in English that is a farewell, and this is a welcome.
      greeting: {
        morning: "Good morning",
        afternoon: "Good afternoon",
        evening: "Good evening",
        night: "Hello",
      },
      greetingNamed: "{greeting}, {name}",
      title: "We're so glad you're here.",
      subtitle:
        "Facundo sends flower orders from customers all over the world to local florists like you. You make the bouquet; we handle the customer, and we pay you before you start.",
      introCheck:
        "Below is what we already know about your shop. Check it over, tell us when you're open, and you're in. It takes about a minute.",
      updateTitle: "Update your shop's details",
      updateIntro: "Change anything that isn't right and save. Everything else stays as it is.",
      labelOwner: "Your name",
      labelName: "Shop name",
      labelAddress: "Shop address",
      addressPlaceholder: "Start typing your address…",
      addressHint: "Pick your shop from the list so we can put you on the map.",
      addressVerified: "Verified with Google Maps",
      addressSearching: "Searching…",
      addressNoResults: "No matches. You can type your address instead.",
      labelPhone: "Shop general phone",
      labelMobile: "Mobile number for receiving orders",
      mobileHelper:
        "We'll text you every time an order comes up in your area. That's it: no marketing, ever.",
      optional: "(optional)",
      countryLabel: "Country code",
      mobileInvalid: "That doesn't look like a number we can message. Check it and try again.",
      labelEmail: "Email",
      hoursTitle: "When are you open?",
      hoursWeekdays: "Monday to Friday",
      openLabel: "Open",
      closedLabel: "Closed",
      opensAtLabel: "Opening time",
      closesAtLabel: "Closing time",
      hoursExpand: "Set each day separately",
      hoursCollapse: "Back to one weekday block",
      hoursNote: "These are the usual hours. Change anything that isn't right for you.",
      hoursInvalid: "Closing time needs to be later than opening time.",
      storyTitle: "Tell us what makes your shop yours",
      storyHelper:
        "Your style, what you're known for, how long you've been on that street, the flowers you love working with. Our customers see this.",
      storyPlaceholder: "We've been on this corner since 1978, and we're known for our garden roses…",
      cutoffTitle: "Next-day delivery cutoff",
      cutoffHelper: "Orders placed before this time can be delivered the next day.",
      submit: "Join the network",
      error: "Something went wrong. Please try again.",
      alreadyTitle: "You're already in the network",
      alreadyBody: "You're already part of our network ✓. Thanks for confirming your details!",
      expiredTitle: "This link has expired",
      expiredBody: "Reach out to Facundo and we'll send you a new one.",
      invalidTitle: "Link not found",
      invalidBody: "This link isn't valid. If you think this is a mistake, contact us at partners@fc.example.com.",
      days: { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" },
      // Full names for the two rows the collapsed hours view shows on their
      // own — a lone "Sat" next to a spelled-out "Monday to Friday" reads as
      // an abbreviation the layout couldn't afford.
      daysLong: { sat: "Saturday", sun: "Sunday" },
    },
    unsubscribe: {
      notFoundTitle: "Link not found",
      notFoundBody: "This unsubscribe link isn't valid anymore.",
      previewBanner: "TEST MODE: PREVIEW",
      previewNote: "This is what a florist sees. Nothing is saved and no preferences change: a real link carries that florist’s own token.",
      title: "Manage your order emails",
      body: "Choose how you'd like to hear from us about new orders.",
      titleSms: "Manage your order texts",
      bodySms: "Choose how you'd like to hear from us about new orders by text.",
      snoozeButton: "Pause for 30 days",
      stopButton: "Stop completely",
      snoozedConfirm: "Done. We won't email you about new orders for 30 days.",
      stoppedConfirm: "Done. We won't email you about new orders anymore.",
      snoozedConfirmSms: "Done. We won't text you about new orders for 30 days.",
      stoppedConfirmSms: "Done. We won't text you about new orders anymore.",
      error: "Something went wrong. Please try again.",
    },
    shell: {
      nav: {
        orders: "Orders",
        messages: "Messages",
        history: "History",
        balance: "Balance",
        account: "Account",
        help: "Questions and Answers",
        openOffersOne: "{count} open offer",
        openOffersOther: "{count} open offers",
        unreadOne: "{count} unread",
        unreadOther: "{count} unread",
      },
      noAccount: {
        staffTitle: "This is the florist app",
        staffBody: "{email} is a Facundo staff account, not a florist. Nothing's wrong here. Head back to the staff console, or sign out to hand this device to a florist.",
        staffBackToConsole: "Back to staff console",
        signOut: "Sign out",
        title: "No florist account",
        matchBefore: "No Facundo florist matches ",
        matchAfter: ". If that's not the account you meant to use, sign out and try another. Otherwise, please contact Facundo.",
        signOutTryAnother: "Sign out and try another account",
      },
    },
    offer: {
      inbox: {
        title: "New orders",
        empty: "No orders right now.",
        layoutAriaLabel: "Inbox layout",
        viewCards: "Cards",
        viewTable: "Table",
        unscheduled: "Unscheduled",
        today: "Today",
        tomorrow: "Tomorrow",
        badgeAccepted: "Accepted",
        badgeReserved: "Reserved",
        badgeFirstToAccept: "First to accept",
        bouquetAlt: "Bouquet",
        bouquetsCount: "{count} bouquets",
        itemFallback: "Item",
        whatToMake: "What to make",
        yourPayout: "Your payout",
        waitingTitle: "Waiting for accept / decline",
        waitingSubtitle: "New offers that need your response.",
        acceptedTitle: "Accepted",
        acceptedSubtitle: "Orders you've taken on.",
        colOrder: "Order",
        colArea: "Area",
        colDist: "Dist",
        colTime: "Time",
        colOffer: "Offer",
        colPayout: "Payout",
      },
      countdown: {
        lapsedStillOpen: "Your response window has passed, but nobody has taken this order yet. You can still accept",
        respondWithin: "Respond within {label} to keep this order",
      },
      feedback: {
        success: "🎉 It’s yours! You’ve got this one. It’s in your accepted orders.",
        taken: "Aw, another florist grabbed this one first. More orders are on the way 🌷",
        networkError: "Network error. Check your connection and try again.",
        genericError: "Something went wrong. Please try again.",
      },
      cardReveal: {
        cardNumber: "Card number",
        cvv: "CVV",
        expires: "Expires",
        name: "Name",
        hide: "Hide",
        revealing: "Revealing…",
        getCard: "Get your card",
        errorGeneric: "Couldn't reveal card.",
        errorNetwork: "Network error. Try again.",
        copyButton: "Copy",
        copyCardNumber: "Copy card number",
        copyCvv: "Copy cvv",
        copyExpires: "Copy expires",
        copyName: "Copy name",
      },
      celebration: {
        ariaLabel: "You earned money",
        eyebrow: "You earned",
        addedToBalance: "added to your balance",
        cardComingSoon: "Your card will appear on your Balance once payments go live.",
        done: "Done",
      },
      payout: {
        yourPayout: "Your payout",
        whenYouAccept: "When you accept",
        whenPhotoClears: "When the delivered photo clears",
        photoRequiredNote: "A delivery photo is required to release the second part.",
        photoStillRequiredNote: "You are paid in full up front, so no payment is waiting on your photo. We still need one clear photo of the finished bouquet as proof of delivery, and the customer receives it.",
        holdNote: "On your early orders the delivery part is briefly held for a quick review before it is paid.",
      },
      // The offer page itself (components/florist/offer/**). The florist's
      // decision moment, so the copy explains rather than labels — see
      // docs/superpowers/specs/2026-08-05-florist-offer-page-design.md.
      page: {
        // Follows the time-of-day greeting, which reuses ui.accept.greeting.*.
        // "make this delivery", not "process this order" — *process* is
        // back-office language for making and delivering flowers.
        lead: "We'd like you to make this delivery.",
        factAway: "Away",
        factDeliverBy: "Deliver by",
        factYouEarn: "You earn",
        // The full address and the recipient's name are withheld until accept
        // (server-side, not just hidden here), so this is a promise the page
        // actually keeps.
        fullAddressOnAccept: "Full address as soon as you accept",
        makeTitle: "What we need you to make",
        // Shown INSTEAD of the recipe, which is absent on 77% of line items.
        // It sets the standard the florist's own delivery photo is judged
        // against later, so it earns its place rather than filling space.
        photoIsTheBrief: "Match this arrangement as closely as your stock allows. The photo is the brief.",
        alsoInclude: "Also include in the delivery",
        cardTitle: "Card message",
        cardInstruction: "Write this on the card that goes with the bouquet:",
        payTitle: "How we pay you for this order",
        // {total} is the whole payout. The claim about what it covers is
        // literal: computePayoutPrice(orderTotal, percent).
        payTotal: "{total} total, including flowers, add-ons and delivery.",
        payOnAccept: "by card, the moment you accept",
        payOnPhoto: "once your delivery photo clears",
        payOnAcceptFull: "by card, the moment you accept. The whole payout, in one payment.",
        // The commitment the florist is making, in their own words. Named the
        // same in email.offer.flowStep2, which tells them what to look for.
        acceptCta: "I can deliver this order as shown",
        declineCta: "I can't accept this order",
        questionsCta: "I have a question first",
        // The way back in after a decline, while nobody else has taken it.
        // A separate string because "I can deliver this order as shown" reads
        // oddly as the answer to a decline you already made.
        reAcceptCta: "Changed your mind? I can deliver this order",
      },
    },
    orderDetail: {
      // The one hardcoded string on the order-detail Server Component
      // (app/florist/(app)/orders/[id]/page.tsx) — resolved via t(locale, ...)
      // there, not useT(), since that file can't use context.
      notFound: "Not found.",
      detail: {
        // The in-app support thread (components/florist/OrderChat.tsx). Answers
        // are drafted by the CX agent against facts read from this order, and
        // anything it may not answer goes to a person — the copy has to make
        // both of those plain without making the florist feel fobbed off.
        chat: {
          title: "Ask about this order",
          intro: "Payments, timings, the photo: ask here and you'll get an answer straight away.",
          placeholder: "What would you like to know?",
          send: "Send",
          sending: "Sending…",
          disclosure: "Replies are written by an automated assistant. Anything it can't answer goes to a colleague.",
          escalated: "A colleague is looking at this and will reply here.",
          error: "That didn't send. Try again.",
          subtitle: "Usually replies straight away",
          close: "Close",
          quick: {
            pay: "When do I get paid?",
            photo: "Has my photo been approved?",
            due: "When is this due?",
            address: "What's the delivery address?",
            problem: "Something's wrong",
          },
        },
        backToOrders: "Orders",
        distance: "Distance",
        deliverBy: "Deliver by",
        yourPayout: "Your payout",
        forRecipient: "For {recipient}",
        // The recipient's number, post-accept only. Tapping copies it rather
        // than dialling (see RecipientPhone in FloristOrderDetail.tsx), so the
        // verb is Copy, not Call. The number renders beside these, never inside
        // them, so it stays readable if the clipboard is unavailable.
        copyRecipientPhone: "Copy",
        recipientPhoneCopied: "Copied",
        addressUnavailable: "Address unavailable",
        addressShownOnAccept: "full address shown when you accept",
        occasion: "Occasion: {occasion}",
        itemFallback: "Item",
        itemCountOne: "{count} item",
        itemCountOther: "{count} items",
        noItems: "No items on this order.",
        recipe: "Recipe",
        components: "Components",
        addons: "Add-ons",
        // What an add-on IS, resolved from its barcode (lib/lineItemKind.ts).
        kind: {
          card: "Greeting card",
          vase: "Vase",
          chocolates: "Chocolates",
          teddy: "Teddy bear",
        },
        includes: "Includes",
        greetingCard: "Greeting card",
        greetingQuote: "“{greeting}”",
        totalPayout: "Total payout",
        whyDeclining: "Why are you declining?",
        accept: "Accept",
        decline: "Decline",
        accepting: "Accepting…",
        changedMindAccept: "Changed your mind? Accept",
        payments: "Payments",
        legAccept: "On accept",
        legDelivery: "On delivery",
        underReview: "under review",
        whyGivingBack: "Why are you giving this order back?",
        cancel: "Cancel",
        giveBack: "Give this order back",
        deliveryProof: "Delivery proof",
        delivered: "Delivered",
        deliveryProofAlt: "Delivery proof",
        photoRejectedNotice: "Your last photo wasn't accepted. Please upload a new one",
        uploadDeliveryPhoto: "Upload delivery photo",
        uploadingDeliveryPhoto: "Uploading photo…",
        // Shown above the upload button (components/florist/PhotoGuide.tsx).
        // The tips deliberately mirror what the AI verification gate checks
        // (lib/photoVerify/claude.ts) — keep them in step if that changes.
        photoGuide: {
          title: "How to photograph the bouquet",
          intro: "We check this photo against the order before releasing your delivery payment. A clear one pays out faster.",
          introFull: "We send this photo to the customer as proof their flowers arrived, and we check it against the order. Your payment is already made in full; a clear photo is what closes the order cleanly.",
          tips: {
            everything: "Show everything in one shot: the whole bouquet plus every extra (vase, chocolates, wine, greeting card).",
            light: "Shoot in good light: daylight or a bright room. Avoid shooting into a window.",
            background: "Keep the background plain and fill the frame with the bouquet.",
            sharp: "Tap the screen to focus and check it's sharp before you send it.",
            fresh: "Take it at the delivery, never a catalogue picture or a photo from another order.",
          },
          samplesLabel: "Examples",
          samples: {
            good: "Everything, sharp",
            dark: "Too dark",
            blurry: "Out of focus",
            cropped: "Cut off, extras missing",
          },
        },
        photoReason: {
          not_checked: "Our automatic check couldn't read this photo, so nobody has looked at it yet. That's on us, and sending another photo usually clears it straight away.",
          no_match: "The photo doesn't look like the bouquet this order asked for.",
          incomplete: "We can see the bouquet, but some of what the order asked for isn't visible in the photo.",
          unsure: "The photo wasn't clear enough for us to confirm the bouquet.",
        },
        photoMissingHeading: "Not visible in your photo",
        photoReupload: "Send a different photo",
        photoAttemptsLeft: "{n} more photo(s) before this goes to a Facundo colleague.",
        photoHumanReview: "A Facundo colleague is looking at this now. We'll let you know as soon as it's settled.",
        deliverySubmittedTitle: "Delivery submitted, under review",
        deliverySubmittedBody: "Your 30% releases once Facundo confirms the delivery photo. We'll let you know.",
        proofReceivedPaidInFull: "Thanks. We have your proof of delivery. Your payment for this order was made in full when you accepted it, so there is nothing else to come.",
        supportAndIssues: "Support & issues",
        whatsTheProblem: "What's the problem?",
        reportAnotherProblem: "Report another problem",
        reportProblem: "Report a problem",
        noLongerAvailable: "No longer available",
        gaveBack: "You gave this back",
        declined: "Declined",
        errorReportProblem: "Couldn't report the problem",
        errorFailed: "Failed",
        errorGiveBack: "Couldn't give this order back",
        errorUploadFailed: "Upload failed",
        // Sent verbatim to the server as decline_reason (see FloristOrderDetail.tsx's
        // REASONS array) — the label here is display-only, never the value sent.
        declineReasons: {
          priceTooLow: "Price too low",
          tooBusy: "Too busy",
          outOfArea: "Out of area",
          cantSource: "Can't source",
          tooUrgent: "Too urgent",
          onHoliday: "On holiday",
        },
        releaseReasons: {
          cantFulfilInTime: "Can't fulfil in time",
          outOfStock: "Out of stock",
          emergencyCameUp: "Emergency came up",
          acceptedByMistake: "Accepted by mistake",
          other: "Other",
        },
        issueReasons: {
          missingIngredient: "Missing an ingredient",
          wrongAddress: "Wrong address",
          outOfRange: "Out of my range",
          recipientUnavailable: "No one home",
          damagedWrongRecipient: "Damaged / wrong recipient",
          somethingElse: "Something else",
        },
      },
      timeline: {
        orderProgress: "Order progress",
        offerReceived: "Offer received",
        youAccepted: "You accepted",
        preparingDelivering: "Preparing & delivering",
        delivered: "Delivered",
      },
    },
    // The florist's cross-order issue list (FloristMessages.tsx, a Server
    // Component — resolved via t(locale, ...) there, not useT()) plus the
    // per-issue conversation thread (IssueThread.tsx, a Client Component —
    // resolved via useT()'s bound t()).
    messages: {
      eyebrow: "Florist",
      heading: "Messages",
      empty: "No issues or messages. If something's wrong with an order, open it and tap “Report a problem”.",
      unreadAriaLabel: "unread",
      // Florist-addressed messages (florist_messages), as opposed to the
      // order_issues rows that make up the rest of this list. `kind` picks the
      // entry; the body renders at read time, so editing it here (or via the
      // /email-templates override editor) changes messages already sent.
      welcome: {
        // Shown as the row title in the list.
        listTitle: "Welcome to Facundo",
        badge: "Welcome",
        title: "You're in. Welcome to the Facundo network.",
        intro:
          "Thanks for setting up your shop. There's nothing else to do right now, so here's what to expect.",
        howTitle: "How an order reaches you",
        howBody:
          "When a customer orders flowers for someone in your area, we message you: a text to your mobile, and an email. You'll see the bouquet, the street, the date and exactly what you'll be paid, before you decide anything.",
        acceptTitle: "If you take it",
        acceptBody:
          "Accept and the full delivery address appears, and we pay you 70% straight away by credit card, before you buy a single stem. Send us a photo of the finished bouquet and the other 30% is released, still before you deliver.",
        acceptBodyFull:
          "Accept and the full delivery address appears, and we pay you your whole payout straight away by credit card, before you buy a single stem. Send us a photo of the finished bouquet as proof of the delivery; no payment is waiting on it, and the customer receives it.",
        declineTitle: "If you can't",
        declineBody:
          "Ignore it or decline, and it goes to another florist. No penalty, no minimum, no commitment. Take the ones that suit you.",
        nextTitle: "What happens next",
        nextBody:
          "Nothing, until an order comes up near you. We'll message you the moment one does. You can update your hours or your number any time from your account.",
        howItWorksLink: "See how it works in more detail",
      },
      resolved: "Resolved",
      open: "Open",
      orderFallback: "Order",
      thread: {
        resolved: "Resolved",
        open: "Open",
        noMessagesYet: "No messages yet.",
        roleFlorist: "Florist",
        roleCx: "Facundo CX",
        placeholderNew: "Write a message…",
        placeholderFollowUp: "Add a follow-up message…",
        send: "Send",
        errorSend: "Couldn't send.",
      },
    },
    // FloristHistory.tsx + ActivityTimeline.tsx. ActivityTimeline is shared
    // with the staff-facing communications hub (FloristCardClient.tsx, no
    // LocaleProvider in that tree) — useT() there defaults to EN, so every
    // string below must stay byte-identical to the original literal.
    history: {
      title: "History",
      empty: "No past orders yet.",
      payout: "Payout",
      accepting: "Accepting…",
      changedMindAccept: "Changed your mind? Accept",
      status: {
        declined: "Declined",
        expired: "Expired",
        reassigned: "Reassigned",
        released: "Given back",
        delivered: "Delivered",
        cancelled: "Cancelled",
      },
      timeline: {
        empty: "No activity yet. Send a reach-out, add a note, or log a meeting.",
        emailSent: "Email sent",
        emailFailed: "Email failed",
        testTag: "test → {address}",
        note: "Note",
        meeting: "Meeting",
        followUpTag: "follow-up {when}",
      },
    },
    // FloristBalance.tsx (transaction ledger) + the payment-detail Server
    // Component (app/florist/(app)/payments/[id]/page.tsx — resolved via
    // t(locale, ...) there, not useT()).
    balance: {
      title: "Balance",
      cardHelperWithCards: "Paid onto your Facundo virtual cards. Tap “Get your card” on a payment below to reveal it and charge it.",
      cardHelperNoCards: "Payouts land on a Facundo virtual card you can reveal and charge.",
      transactionsHeading: "Transactions",
      noPayouts: "Payouts start when your first order is paid.",
      legAccept: "On accept",
      legDelivery: "On delivery",
      payment: {
        backToBalance: "Balance",
        leg: "Leg",
        legAccept: "On accept",
        legDelivery: "On delivery",
        status: "Status",
        method: "Method",
        virtualCard: "Virtual card",
        order: "Order",
        viewOrder: "View order",
        yourCard: "Your card",
        revealNote: "Reveal the card details to charge your payout.",
        reversedNote: "This payout was reversed (order cancelled or refunded).",
        noCardNote: "No active card for this payout.",
        ledgerNote: "This payout is recorded and yours. The card details will appear here once card payouts are switched on.",
      },
    },
    // FloristEarnings.tsx — the standing + earnings summary above the ledger.
    earnings: {
      standing: "Standing",
      ordersDeliveredOne: "{count} order delivered",
      ordersDeliveredOther: "{count} orders delivered",
      paidOut: "Paid out",
      onTheWay: "On the way",
    },
    // app/florist/(app)/install/page.tsx. Each numbered step is split into
    // Before/Bold/After (mirroring ui.shell.noAccount.matchBefore/matchAfter)
    // so the <b> emphasis survives translation; the one truly embedded icon
    // (Share, iOS step 1) is rendered as a leading glyph on the step instead
    // of mid-sentence, since its exact word position isn't stable across
    // languages — it's aria-hidden and purely decorative either way.
    install: {
      title: "Install the app",
      subtitle: "Add Facundo to your Home Screen for order push notifications and a full-screen app.",
      doneTitle: "You’re all set",
      doneBody: "Facundo is installed on this device.",
      oneTapTitle: "This device supports one-tap install",
      opening: "Opening…",
      installButton: "Install app",
      thenOpen: "Then open Facundo from your Home Screen and allow notifications.",
      iosTitle: "On iPhone / iPad (Safari)",
      androidTitle: "On Android (Chrome) or desktop",
      pushNote: "Push notifications tell you the moment a new order lands so you never miss a first-to-accept offer.",
      ios: {
        step1Before: "Tap the ",
        step1Bold: "Share",
        step1After: " icon in Safari’s toolbar.",
        step2Before: "Scroll down and choose ",
        step2Bold: "Add to Home Screen",
        step2After: ".",
        step3Before: "Tap ",
        step3Bold: "Add",
        step3After: ", then open Facundo from your Home Screen.",
        step4Before: "Open it once and allow ",
        step4Bold: "Notifications",
        step4After: " when asked.",
        note: "Push notifications need iOS 16.4+ and the installed (Home Screen) app.",
      },
      android: {
        // ⋮ / ··· are decorative glyphs, not language content — kept literal
        // in the component rather than routed through the catalog.
        step1Before: "Open the browser menu (",
        step1Or: " or ",
        step1After: ").",
        step2Before: "Tap ",
        step2Bold1: "Install app",
        step2Mid: " / ",
        step2Bold2: "Add to Home screen",
        step2After: ".",
        step3Before: "Open it and allow ",
        step3Bold: "Notifications",
        step3After: ".",
        note: "If you don't see that option, your browser may not support install yet. The site still works normally.",
      },
    },
  },
};
