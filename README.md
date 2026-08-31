# Up and Up Educational Services — Tutoring Site

Public GitHub Pages site for virtual math tutoring, placement tests, and instructor-led student assessments.

## Production status

The public frontend is live at:

https://upandupmath.github.io/upandup-tutoring/

The pages call a Supabase project for booking availability and package creation, and use separate report-delivery integrations for assessment results.

### Recovery warning

As of the August 31, 2026 repository audit, the backend code and database migrations described by the previous README were **not present on `main`**. In particular, `supabase/functions/` did not exist even though the README called it a reference copy of the deployed code.

Treat the currently deployed Supabase project as the only known copy of the production backend until its functions, schema, schedules, and configuration names have been exported and reconciled. Do not redeploy payment functions, rotate payment configuration, or accept a new payment integration based only on this repository.

Follow [the production recovery runbook](docs/production-recovery.md) before any backend or payment cutover.

## Frontend pages

- `index.html` — marketing, availability, registration, and checkout entry
- `placement.html` — public parent-consented placement assessment
- `assessments.html` — instructor-code assessment page
- `teaching.jpg` — tutor photo used by the homepage

## Verification

Pull requests and pushes to `main` run a dependency-free verifier:

```sh
node scripts/verify-site.mjs
```

It checks inline JavaScript syntax, local links, common committed credential patterns, the four-session booking cap, fail-closed availability behavior, and privacy/security invariants.

## Publishing the frontend

GitHub Pages publishes `main` from the repository root. Frontend changes should go through a pull request and pass the Verify site workflow before merge.

There is no frontend build step.

## Pricing and payment changes

Displayed prices in `index.html` and server-side prices in Supabase must match, but the server is the authority. Before changing either:

1. export the deployed functions and database schema
2. back up production data outside this public repository
3. verify the current payment provider and environment
4. test the complete flow in a non-production environment
5. reconcile successful payment, duplicate callback, decline, cancellation, and retry cases
6. use a reviewed pull request for the frontend change

Never put payment secrets, service-role keys, database connection strings, access codes, or report endpoints in GitHub Pages or committed files.

## Current work

The Stripe migration is staged separately in [draft PR #2](https://github.com/upandupmath/upandup-tutoring/pull/2). It is not deployed or approved for merge until the account and backend setup checklist is complete.
