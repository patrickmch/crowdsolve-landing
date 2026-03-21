# CrowdSolve Application Pipeline v2

**Date**: 2026-03-21
**Status**: Approved
**Goal**: Complete the application-to-payment pipeline so Patrick can receive, review, approve, and collect payment from beta cohort applicants — all manageable from Claude Code via MCP.

## Context

The CrowdSolve Beta cohort launches April 13, 2026 (10 weeks). A Vite/React landing page with an Express backend is deployed on Railway at `crowdsolve-landing-production.up.railway.app`. Applications are stored in SQLite and notifications go to AgentMail (Terry/OpenClaw). Patrick needs direct visibility into applications and the ability to approve/decline with payment collection.

## Architecture

```
Applicant ──▶ Landing Page (Railway)
                   │
                   ▼
             Express API ──▶ SQLite (Railway Volume at /app/data)
                   │
                   ├──▶ AgentMail → tmac@agentmail.to (Terry)
                   └──▶ AgentMail → patrick@crowdsolve.eco (Patrick)

Patrick (Claude Code) ──MCP──▶ crowdsolve-applications MCP Server
                                        │
                                        ▼
                                  Railway Express API
                                        │
                                        ├──▶ PATCH status (approve/decline)
                                        └──▶ AgentMail → Applicant (payment link / decline)

crowdsolve.eco/beta ──iframe──▶ Railway Landing Page
```

## Section 1: Email Notifications

### Current State
Application submissions trigger a single AgentMail notification to `tmac@agentmail.to` (Terry/OpenClaw). A cron job on turtle evaluates applications and forwards to Patrick via Telegram. This chain is fragile — if Terry's infra flakes, Patrick misses applications.

### Changes
- Add `NOTIFY_EMAILS` environment variable to Railway (comma-separated, e.g. `patrick@crowdsolve.eco`)
- Modify `sendNotification()` in `server.cjs` to send one email per address in `NOTIFY_EMAILS` via AgentMail, in addition to the existing Terry notification
- Same email content: applicant name, email, startup idea, action taken, contribution, commitments, referral source

### Implementation Detail
```javascript
// In server.cjs
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || '')
  .split(',')
  .map(e => e.trim())
  .filter(Boolean);

async function sendNotification(data) {
  // Existing AgentMail notification to Terry (unchanged)
  await sendToAgentMail(AGENTMAIL_INBOX, data);

  // Direct notifications to additional recipients
  for (const email of NOTIFY_EMAILS) {
    await sendToAgentMail(email, data);
  }
}
```

AgentMail's send API supports arbitrary `to` addresses — no additional service needed.

## Section 2: Express API — Approval Endpoints

### New Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `PATCH /api/applications/:id` | PATCH | Bearer ADMIN_KEY | Update status and/or notes |
| `POST /api/applications/:id/send-payment` | POST | Bearer ADMIN_KEY | Send payment link email to applicant |

### PATCH /api/applications/:id

Request body (all fields optional):
```json
{
  "status": "approved",
  "notes": "Strong application, clear idea",
  "payment_status": "paid"
}
```

Valid `status` values: `new`, `approved`, `declined`, `waitlisted`
Valid `payment_status` values: `pending`, `sent`, `paid`, `failed`

On status change to `approved` with query param `?send_payment=true`:
- Automatically triggers the payment link email to the applicant

### POST /api/applications/:id/send-payment

Sends (or re-sends) the payment link email to the applicant. Requires `STRIPE_PAYMENT_URL` env var to be set. Updates `payment_status` to `sent`.

### Schema Migration

```sql
ALTER TABLE applications ADD COLUMN updated_at TEXT;
ALTER TABLE applications ADD COLUMN payment_status TEXT DEFAULT 'pending';
```

Migration runs at server startup (idempotent — checks if columns exist first).

## Section 3: MCP Server — crowdsolve-applications

A lightweight stdio-based MCP server that wraps the Railway admin API. Lives at `~/.claude/mcp-servers/crowdsolve-applications/`.

### File Structure
```
~/.claude/mcp-servers/crowdsolve-applications/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

### Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_applications` | `status?` (string) | List all applications. Optional filter by status. Returns id, name, email, status, payment_status, created_at. |
| `get_application` | `id` (number) | Get full details for one application by ID. |
| `approve_application` | `id` (number), `send_payment?` (boolean, default true), `notes?` (string) | Set status=approved. If send_payment=true, emails applicant the Stripe Payment Link. |
| `decline_application` | `id` (number), `send_email?` (boolean, default false), `notes?` (string) | Set status=declined. Optionally sends a polite decline email. |
| `update_application` | `id` (number), `notes?` (string), `payment_status?` (string) | Update notes or payment_status on an application. |

### Configuration

Environment variables (set in Claude Code MCP config):
- `CROWDSOLVE_API_URL` — Railway base URL (e.g. `https://crowdsolve-landing-production.up.railway.app`)
- `CROWDSOLVE_ADMIN_KEY` — Same Bearer token as the Express ADMIN_KEY
- `STRIPE_PAYMENT_URL` — Stripe Payment Link URL (passed through to Express)

### Registration

In Claude Code settings (`~/.claude/settings.json` or project settings):
```json
{
  "mcpServers": {
    "crowdsolve-applications": {
      "command": "node",
      "args": ["/Users/tmac/.claude/mcp-servers/crowdsolve-applications/dist/index.js"],
      "env": {
        "CROWDSOLVE_API_URL": "https://crowdsolve-landing-production.up.railway.app",
        "CROWDSOLVE_ADMIN_KEY": "...",
        "STRIPE_PAYMENT_URL": "..."
      }
    }
  }
}
```

## Section 4: Applicant Emails

### Approval Email (with payment link)

**Subject**: You're in — next steps for CrowdSolve Beta

```
Hey {firstName},

Your application to the CrowdSolve Beta cohort has been accepted.

To confirm your spot, complete payment here: {STRIPE_PAYMENT_URL}

The cohort kicks off April 13 and runs 10 weeks. Once payment is confirmed,
you'll get an invite to the Circle community where everything happens.

Questions? Reply to this email.

— The CrowdSolve Team
```

### Decline Email (optional, only sent if explicitly requested)

**Subject**: CrowdSolve Beta — Update on your application

```
Hey {firstName},

Thanks for applying to the CrowdSolve Beta. We had a lot of strong
applications for this cohort and unfortunately we're not able to offer
you a spot this time.

We'll keep your application on file and reach out if a spot opens up
or when we launch the next cohort.

— The CrowdSolve Team
```

Both templates live as string constants in `server.cjs`. All outgoing email content goes through humanizer before deployment.

## Section 5: Stripe Integration (Placeholder)

No Stripe API integration for MVP. Manual flow:

1. Tim creates a Stripe Payment Link in the Stripe dashboard (fixed price for beta cohort)
2. URL is set as `STRIPE_PAYMENT_URL` env var on Railway and in MCP server config
3. Approved applicants receive the link via email (Section 4)
4. Patrick monitors Stripe dashboard or gets Stripe email notifications for payments
5. Patrick updates `payment_status` to `paid` via MCP `update_application` tool
6. Patrick manually invites paid members to Circle community

### Future (requires Stripe API key from Tim)
- `POST /api/stripe/webhook` endpoint to auto-update `payment_status` on successful payment
- Auto-invite to Circle community via Circle Admin API on payment confirmation
- Payment amount validation

## Section 6: Railway Volume for SQLite Persistence

One-time manual setup in Railway dashboard:
- Navigate to the crowdsolve-landing service → Settings → Volumes
- Add volume with mount path: `/app/data`
- This ensures `data/applications.db` persists across deployments

No code changes needed. The server already writes to `data/applications.db` which maps to `/app/data/applications.db` in the container.

## Section 7: crowdsolve.eco/beta URL

Separate from code work — Circle admin panel setup:
1. Log into Circle admin → Website → Pages
2. Create a new page with slug `beta`
3. Add a custom HTML/embed block with full-width iframe:
   ```html
   <iframe src="https://crowdsolve-landing-production.up.railway.app"
           style="border:0; width:100%; height:100vh;"
           allow="forms">
   </iframe>
   ```
4. Set page access to Public
5. Result: `crowdsolve.eco/beta` loads the Railway landing page

Alternative: If Circle supports custom JS in page blocks, a redirect script (`window.location.href = "..."`) would avoid iframe quirks but changes the URL in the browser bar.

## Eval Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| 1 | Patrick receives application notification emails at patrick@crowdsolve.eco | Submit test application, check inbox |
| 2 | Terry still receives notifications at tmac@agentmail.to | Submit test application, verify AgentMail |
| 3 | MCP `list_applications` returns applications from Railway | Run tool in Claude Code, see list |
| 4 | MCP `list_applications` filters by status | Filter by 'new', verify only new apps returned |
| 5 | MCP `get_application` returns full application details | Get app by ID, verify all fields present |
| 6 | MCP `approve_application` sets status=approved and sends payment email | Approve test app, check status + email |
| 7 | MCP `decline_application` sets status=declined | Decline test app, verify status change |
| 8 | Payment email contains valid Stripe Payment Link | Check email content after approval |
| 9 | Decline email sends only when explicitly requested | Decline without send_email, verify no email sent |
| 10 | `payment_status` field updates correctly via MCP | Update to 'paid', verify in DB |
| 11 | SQLite DB persists across Railway deployments | Deploy new version, verify existing data survives |
| 12 | `crowdsolve.eco/beta` loads the landing page | Visit URL in browser |
| 13 | Application form still works end-to-end | Submit application via the form, verify DB + notifications |

## Out of Scope

- Stripe API integration (needs API key from Tim)
- Stripe webhook for auto-payment-status updates
- Auto-invite to Circle on payment
- Admin web UI (MCP tools replace this)
- Applicant-facing status tracking / portal
- Automated AI evaluation of applications (exists separately on turtle cron)

## Dependencies

- Railway dashboard access (for Volume setup)
- Circle admin access (for /beta page setup)
- `STRIPE_PAYMENT_URL` from Tim (can deploy without it, payment emails just won't send until configured)
- `ADMIN_KEY` env var on Railway (already exists or needs to be set)
- AgentMail API key (already configured on Railway)
