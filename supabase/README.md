# Supabase backend recovery baseline

This folder restores a reviewable source baseline for the booking endpoints named by the live frontend and root README.

Important: the original deployed Edge Function source was not present in Git history. Treat this as a recovered candidate, not proof of the exact code currently running in Supabase. Do not deploy it until the migration and environment variables have been compared with the live project.

## Included in this recovery chunk

- edu-availability: fail-closed availability backed by reservation expiry.
- edu-create-package: exact four-session validation, atomic slot reservation, server-side pricing, and PayPal order creation.
- edu-capture-payment: idempotent capture, server-side order/amount/currency verification, durable confirmation, and retryable calendar-sync state.
- An additive schema baseline with unique live-slot enforcement and service-role-only RPCs.

## Required environment variables

- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- PAYPAL_CLIENT_ID
- PAYPAL_CLIENT_SECRET
- PAYPAL_BASE_URL: use only https://api-m.sandbox.paypal.com or https://api-m.paypal.com
- ALLOWED_ORIGINS: comma-separated browser origins; the GitHub Pages origin is included by default
- CALENDAR_WEBHOOK_URL
- CALENDAR_WEBHOOK_SECRET

Never put secret values in this repository or browser code.

## Reconciliation checklist before deployment

1. Export the live edu_packages, edu_sessions, and edu_config schemas.
2. Compare every existing column type and constraint with the migration.
3. Back up the live tables.
4. Run the migration in a staging Supabase project first.
5. Configure sandbox PayPal credentials and the allowed site origin.
6. Test duplicate-slot races, canceled checkout, repeated capture, wrong order IDs, wrong amounts, calendar failure, and reservation expiry.
7. Confirm PayPal vault eligibility. A delayed vault can require the VAULT.PAYMENT-TOKEN.CREATED webhook.
8. Add and test the second-payment worker only after the vault/webhook path is proven.

## Deliberately not reconstructed yet

- edu-charge-second-payment
- edu-save-placement
- PayPal vault webhooks
- Calendar retry worker

Those pieces depend on the exact live schema, PayPal account eligibility, and current Google Apps Script contract. Guessing them could create real billing or data-loss risk.
