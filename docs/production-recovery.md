# Production recovery runbook

Use this runbook before changing or redeploying the booking, payment, scheduling, calendar, or report-delivery backend.

Project reference currently used by the frontend: `otdyhyzghaohnhtwzkvu`

## Goal

Create a reviewable, restorable source baseline without exposing family data or credentials. The recovered baseline must include:

- every deployed Edge Function
- database schema, functions, triggers, RLS policies, and relevant extensions
- scheduler and cron jobs
- secret **names** and required configuration, never secret values
- payment-provider mode and webhook configuration
- calendar/report delivery contracts
- a dated production smoke-test record

## Safety rules

- Freeze backend deployments while recovery is underway.
- Do not make a real payment to test recovery.
- Do not paste secrets into issues, pull requests, chat, screenshots, or shell history.
- Do not commit database dumps or family/student records to this public repository.
- Store data backups in an access-controlled, encrypted location.
- Record every production read or change in a dated recovery log.

## 1. Confirm access and inventory

From a trusted workstation with the current Supabase CLI:

```sh
supabase login
supabase functions list --project-ref otdyhyzghaohnhtwzkvu
supabase secrets list --project-ref otdyhyzghaohnhtwzkvu
```

The secrets command is for inventorying names and confirming configuration presence. Do not copy values into the repository.

In the Supabase dashboard, separately inventory:

- project owner and administrators
- database plan and backup/PITR status
- deployed function names, versions, JWT settings, and last deployment times
- scheduled jobs and their authentication method
- webhook destinations
- database extensions
- authentication settings, if any
- custom domains and allowed browser origins

## 2. Recover Edge Function source

Download every deployed function into an isolated recovery branch:

```sh
supabase functions download --project-ref otdyhyzghaohnhtwzkvu
```

Supabase notes that downloaded functions may not include `import_map.json` or `deno.json`. Reconstruct and pin missing dependency configuration before treating the export as deployable.

For each function, record:

| Function | Public/JWT | Called by | Writes | External service | Retry/idempotency |
|---|---|---|---|---|---|
| `edu-availability` | To verify | Booking page | Expired holds, if implemented | None expected | To verify |
| `edu-create-package` | To verify | Booking page | Packages and slot holds | Payment provider | Required |
| `edu-capture-payment` | To verify | Payment return/webhook | Payments and sessions | Payment + calendar | Required |
| `edu-charge-second-payment` | Protected worker expected | Scheduler | Payments and sessions | Payment + calendar | Required |
| `edu-save-placement` | To verify | Placement page | Placement result | Report/email | Required |

Do not infer deployed behavior from names. Verify the downloaded source and the deployed configuration.

## 3. Back up the database

Obtain the current connection string through the Supabase dashboard and run dumps from a private working directory:

```sh
supabase db dump --db-url "$SUPABASE_DB_URL" -f roles.sql --role-only
supabase db dump --db-url "$SUPABASE_DB_URL" -f schema.sql
supabase db dump --db-url "$SUPABASE_DB_URL" -f data.sql --use-copy --data-only
```

Move data-bearing files to encrypted storage immediately. Only reviewed schema migrations belong in this repository.

Also export or record:

- `edu_packages`, `edu_sessions`, and `edu_config` definitions
- constraints and unique indexes that prevent double booking
- database functions and triggers
- RLS policies and grants
- cron/scheduler definitions
- webhook/retry tables
- enum values and status transition rules

## 4. Reconcile the live contracts

For every public endpoint, document request and response examples using synthetic data only.

Verify these invariants:

- availability failures disable booking rather than showing every slot as free
- the server accepts exactly four distinct valid weekday sessions
- pricing and discounts are calculated server-side
- slot reservation is atomic and expires safely
- a browser redirect cannot mark a payment successful
- provider callbacks are signed and idempotent
- captured amount, currency, package, and provider object IDs are cross-checked
- second payments cannot run early or more than once
- failed calendar/email delivery cannot erase or duplicate a successful payment
- PII is sent only to approved destinations
- logs do not contain secrets or unnecessary student data

## 5. Establish a non-production test path

Before any provider migration or recovered-code deployment:

1. create or identify a staging Supabase project
2. restore schema without production family/student data
3. configure only test-mode payment credentials
4. deploy recovered functions to staging
5. test availability success and outage behavior
6. test simultaneous attempts to reserve the same slot
7. test payment success, cancellation, decline, duplicate callback, delayed callback, and retry
8. test second-payment success, authentication-required, failure, and duplicate scheduler invocation
9. confirm calendar/report failures enter a visible retry state
10. compare staging behavior with the current production contracts

## 6. Production deployment gate

A production deployment requires all of the following:

- recovered source and migrations reviewed in a pull request
- Verify site CI green
- staging evidence attached to the change
- database backup completed and restore steps tested
- exact functions and migrations listed
- secret names and provider mode confirmed
- webhook destinations and signatures confirmed
- rollback owner and monitoring window assigned
- no unrelated changes bundled into the release

Deploy one bounded change at a time. Verify health, logs, booking state, and payment reconciliation before continuing.

## 7. Rollback and incident response

If booking or availability is uncertain, disable new booking first; never fail open.

If payment state is uncertain:

1. stop automated retry or second-charge jobs
2. preserve provider event IDs and application logs
3. reconcile provider records against `edu_packages` and `edu_sessions`
4. do not issue duplicate charges or refunds based only on browser reports
5. contact affected families only after the authoritative payment state is known
6. document the incident, correction, and prevention action

If a secret may have been exposed, rotate it at the provider and Supabase, invalidate dependent sessions/tokens where possible, inspect logs, and document the exposure window.

## Official references

- [Supabase CLI reference](https://supabase.com/docs/reference/cli/introduction)
- [Supabase backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Supabase Edge Function secrets](https://supabase.com/docs/guides/functions/secrets)
- [Supabase production function deployment](https://supabase.com/docs/guides/functions/deploy)
