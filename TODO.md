# CrowdSolve Landing Page - TODO

## Blocked on Tim

- [ ] **Stripe Payment Link** - Tim needs to create a Payment Link in the Stripe dashboard for the beta cohort price. Once received:
  - Set `STRIPE_PAYMENT_URL` on Railway env vars
  - Set `STRIPE_PAYMENT_URL` in `~/.claude.json` MCP config for `crowdsolve-applications`
  - Then `approve_application` MCP tool will send payment emails automatically
- [ ] **Custom domain** (optional) - If Tim can add a CNAME for `beta.crowdsolve.eco` pointing to Railway, that gives a cleaner URL. Otherwise buy a separate domain (e.g. `joincrowdsolve.com`)

## Stripe Integration (after getting API key)

- [ ] **Stripe webhook endpoint** - `POST /api/stripe/webhook` to auto-update `payment_status` when someone pays
- [ ] **Auto-invite to Circle** - On payment confirmation, use Circle Admin API to invite the member to the community
- [ ] **Payment amount validation** - Verify the payment amount matches the expected cohort price

## Landing Page Polish

- [ ] **OG image** - Social sharing preview image for when the URL is shared on LinkedIn, Slack, etc.
- [ ] **Favicon** - Currently using default
- [ ] **Analytics** - GA4 or Plausible tag for tracking traffic
- [ ] **Founder testimonial consent** - Confirm Cody + Frank are OK with their testimonials on the page (Mel already confirmed)

## Application Pipeline Improvements

- [ ] **Custom sender domain** - Emails currently come from `tmac@agentmail.to`. Set up a custom domain (e.g. `team@crowdsolve.eco`) for professional applicant-facing emails
- [ ] **Decline email opt-in** - Currently decline emails only send with explicit `send_email=true`. Consider making this the default once the copy is finalized
- [ ] **Application export** - Add a CSV export endpoint for applications (useful for sharing with Tim)

## Infrastructure

- [ ] **Remove old `NOTIFY_EMAIL`** - Railway has both `NOTIFY_EMAIL` (old, singular) and `NOTIFY_EMAILS` (new, plural). Delete the old one in the dashboard
- [ ] **Backup strategy** - Railway volume persists across deploys but has no automated backups. Consider periodic SQLite dumps to a backup location
- [ ] **Postgres migration** - If the cohort grows past beta, migrate from SQLite to Railway Postgres for concurrent write support

## Done (2026-03-21)

- [x] Email notifications to Patrick (NOTIFY_EMAILS)
- [x] Auth middleware + admin API
- [x] PATCH /api/applications/:id (approve/decline/waitlist)
- [x] POST /api/applications/:id/send-payment (with double-send guard)
- [x] GET /api/applications/:id
- [x] MCP server with 5 tools (list, get, approve, decline, update)
- [x] Railway volume at /app/data
- [x] Smoke tests (11/11 passing)
- [x] MCP registered in ~/.claude.json
- [x] Checkbox label styling fix
