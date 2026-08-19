# Pricing (same words as the site)

The live cards are on [conarium.dev](https://conarium.dev/#pricing). This file
exists so the public repository does not drift from the site the way `docs.html`
did. A card line that cannot be delivered does not go on the card.

| Tier | Price | Button |
|---|---|---|
| Community | Free | Get started free → GitHub |
| **Pro** | **$20/month** or **$200/year — save $40** | Get started → `#cta` while checkout is closed; `/buy?plan=pro&period=monthly\|yearly` once it opens |
| Business | $100/month | **Join the waitlist** → `#cta` — **does not take payment** |
| Enterprise | Custom | Contact us → `#cta` |

## Pro (priced, checkout closed)

- **Checkout is closed.** `/buy` and both card buttons redirect to `#cta`, and
  `/api/checkout/live` reports `{"live":false}`. The price below is published,
  not payable. When the payment path goes live this section says `sold` and the
  Button column above drops its first clause.
- Hosted countersignature: someone other than you signs the chain head. Shipped in the package since 0.2.16; the VERAX-operated endpoint is not open to customers yet.
- Fair use — 60 submissions per minute.
- No monthly quota.
- **One period, not a subscription.** It does not renew by itself — when the period ends, access ends and you can buy it again. 14-day no-questions refund; after that, no partial refunds.
- VAT added where applicable.

## Business (waitlist)

Three items remain marked **In the contract, not shipped yet**:

- reconciliation on a schedule, against your database's own counters
- an alert when coverage breaks
- a signed period report, generated on your side

Do not remove those marks. The waitlist form (`#cta`) is Business / Enterprise /
Design Partner. It is not Pro checkout.

## `#cta`

The footer form writes an email to the waitlist. Pro checkout does not use it —
but while checkout is closed, the Pro buttons and `/buy` land there, which is
the one case in which a Pro reader reaches this form.
