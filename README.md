# Up and Up Educational Services — Tutoring Booking Site

Static GitHub Pages frontend with a Supabase Edge Function backend for four-session virtual math tutoring packages.

## Current status

The public site is live. This branch converts the versioned payment design from PayPal to Stripe, but it does not deploy or activate Stripe by itself. No real charge can occur from repository changes alone.

## Stripe booking design

1. A parent selects exactly four available weekday sessions.
2. The backend atomically holds those slots and calculates pricing from edu_config.
3. Stripe-hosted Checkout collects payment for sessions 1 and 2 and saves the authorized card for the remaining package payment.
4. A signed Stripe webhook—not the browser redirect—verifies the payment amount, currency, Checkout Session, and PaymentIntent.
5. Sessions 1 and 2 are confirmed. Sessions 3 and 4 remain blocked for that family.
6. Within three days before session 3, the protected worker charges the authorized second payment once.
7. Calendar/Meet synchronization is recorded separately so a calendar failure cannot undo or duplicate a successful payment.

See supabase/README.md for the reconciliation and deployment checklist.

## Manual Stripe setup required

The account owner must complete these financial-account steps:

- Create or connect a Stripe account and complete Stripe's business verification.
- Add STRIPE_SECRET_KEY to Supabase secrets.
- Create the webhook endpoint and add STRIPE_WEBHOOK_SECRET.
- Add CRON_SECRET and schedule the second-payment function after test-mode QA.
- Switch from test credentials to live credentials only after a complete test booking.

Secret keys must never be added to index.html, GitHub Pages, commits, screenshots, or chat messages.

## Pricing

Pricing remains server-side in edu_config:

    update edu_config set value = '65' where key = 'price_per_session';
    update edu_config set value = 'FAMILY15' where key = 'discount_code';
    update edu_config set value = '60' where key = 'discount_price_per_session';

Keep the display constants in index.html aligned with the database values.

## Publishing the frontend

GitHub Pages publishes main from the repository root at:

https://upandupmath.github.io/upandup-tutoring/
