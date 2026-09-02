# Up And Up Educational Services — Virtual Math Tutoring

Live at **[upandupmath.github.io/upandup-tutoring](https://upandupmath.github.io/upandup-tutoring/)**

## What this is

A booking and tutoring platform for virtual math tutoring, grades 6–10. Parents book 4-session packages, pay through PayPal, and receive Google Calendar invites with Meet links for each session.

## Pages

| Page | Purpose |
|---|---|
| `index.html` | Main site — about, pricing, FAQ, policies, booking form |
| `placement.html` | Free 30-question placement test (6 grade levels, 5 questions each) |
| `assessments.html` | Teacher-facing student assessment tool |
| `confirmed.html` | Post-booking confirmation with dates, Meet links, billing schedule |
| `privacy.html` | COPPA-aligned privacy policy |

## Backend

Supabase edge functions handle booking, payments, email, and calendar integration. The private backend repository contains the deployed source and database schema.

### Key systems
- **Booking:** 4-session packages, exactly $65/session, billed $130 at a time
- **Payments:** PayPal with vault for automatic second installment, plus invoice option for Zelle/Cash App
- **Calendar:** Google Calendar events with Meet links auto-generated on session confirmation
- **Email:** Tutoring-branded transactional emails (confirmation, invoice, receipt, cancellation)
- **Availability:** Syncs with personal Google Calendar and blocks DCPS 2026-27 school-off days
- **Safety nets:** Payment reconciler (5 min), abandoned checkout sweep (15 min), non-payment enforcement (daily)

### Edge functions
`edu-create-package` · `edu-capture-payment` · `edu-charge-installments` · `edu-availability` · `edu-booking-status` · `edu-notify-email` · `edu-save-placement` · `edu-create-calendar` · `edu-sync-calendar` · `edu-reconcile-payments` · `edu-check-assessment`

### Cron jobs (pg_cron)
| Job | Schedule | Purpose |
|---|---|---|
| `edu-charge-installments-daily` | `0 12 * * *` | Charges due installments |
| `edu-reconcile-payments` | `*/5 * * * *` | Catches PayPal payments missed by browser |
| `edu-expire-abandoned-bookings` | `*/15 * * * *` | Releases slots from abandoned checkouts |
| `edu-enforce-nonpayment` | `30 12 * * *` | Cancels packages with missed payments |
| `edu-sync-calendar-hourly` | `15 * * * *` | Syncs personal calendar conflicts |

## Development

The public repository hosts the GitHub Pages frontend. Backend source lives in a separate private repository. Branch protection requires pull requests for `main`.

## Contact

Brother Truth · [240.542.8647](tel:2405428647) · [theuauchessclub@gmail.com](mailto:theuauchessclub@gmail.com)
