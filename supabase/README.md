# Stripe/Supabase backend recovery baseline

This folder restores a reviewable source baseline and converts the booking design from PayPal to Stripe Checkout.

The original deployed Edge Function source was not present in Git history. Treat this as a recovered candidate, not proof of the exact code currently running in Supabase. The repository change does not activate Stripe or alter the currently deployed Supabase functions.

## Flow

1. edu-create-package atomically reserves exactly four slots and creates a hosted Stripe Checkout Session for sessions 1 and 2.
2. Checkout saves the card for the explicitly disclosed second off-session payment.
3. stripe-webhook verifies Stripe's signature and is the only path that marks payment complete.
4. Sessions 1 and 2 become confirmed. Sessions 3 and 4 remain blocked as pending_payment.
5. edu-charge-second-payment charges the saved card within three days before session 3.
6. edu-checkout-status lets the browser show durable webhook-confirmed status without trusting URL parameters.

## Required Supabase secrets

- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- STRIPE_API_VERSION (optional; pin after sandbox verification)
- CRON_SECRET
- ALLOWED_ORIGINS
- CALENDAR_WEBHOOK_URL
- CALENDAR_WEBHOOK_SECRET

Never put secret values or a Stripe secret key in GitHub Pages or this repository.

## Manual account step that cannot be automated

The owner must create or connect the Stripe account, complete business verification, and provide test/live secret keys and the webhook signing secret through Supabase's secret manager. Financial-account authorization cannot be performed by the repository code.

## Before deployment

1. Export and back up the live edu_packages, edu_sessions, and edu_config schemas.
2. Compare every live column and type with the migration.
3. Test the migration and functions in a staging Supabase project.
4. Use Stripe test mode for success, decline, duplicate webhook, expired Checkout, and off-session authentication-required cases.
5. Create a Stripe webhook for checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.expired, payment_intent.succeeded, and payment_intent.payment_failed.
6. Schedule edu-charge-second-payment only after the first-payment webhook and saved-card flow pass.
7. Confirm the customer-facing terms and authorization language.

## Still requires reconciliation

- edu-save-placement
- Current Google Apps Script payload
- Calendar retry worker
- Failure-alert delivery
