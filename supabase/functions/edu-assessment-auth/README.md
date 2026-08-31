# Assessment authentication function

This function replaces the access code embedded in `assessments.html`.

It:

- verifies the instructor-provided code on the server
- limits repeated login attempts per function instance
- returns a signed, two-hour assessment session token
- requires that token before proxying assessment reports
- removes the Google Apps Script report URL from the public page
- never returns the configured access code

## Required Supabase secrets

Set these in the Supabase project secret manager, never in GitHub or frontend code:

- `ASSESSMENT_ACCESS_CODE` — the code shared with registered families
- `ASSESSMENT_SESSION_SECRET` — a random value of at least 32 characters, different from the access code
- `ASSESSMENT_REPORT_URL` — the existing Google Apps Script report endpoint
- `ALLOWED_ORIGINS` — optional comma-separated additional origins

Deploy the function without Supabase JWT verification because the function issues and validates its own short-lived scoped token:

```sh
supabase functions deploy edu-assessment-auth --no-verify-jwt
```

## Important boundary

This removes the access code and report endpoint from the public browser source. It does not make the assessment questions or answer keys secret while they remain embedded in a public GitHub Pages HTML file. Protecting the item bank requires a later server-delivered, one-question-at-a-time assessment flow with server-side scoring.

The in-memory login limiter is defense in depth only; it resets when an Edge Function instance restarts and is not a substitute for durable rate limiting at the gateway or database.
