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
                   ├──▶ AgentMail (from: tmac@agentmail.to) → tmac@agentmail.to (Terry)
                   └──▶ AgentMail (from: tmac@agentmail.to) → patrick@crowdsolve.eco (Patrick)

Patrick (Claude Code) ──MCP──▶ crowdsolve-applications MCP Server
                                        │ (server-to-server HTTP, no CORS needed)
                                        ▼
                                  Railway Express API
                                        │
                                        ├──▶ PATCH status (approve/decline)
                                        └──▶ AgentMail (from: tmac@agentmail.to) → Applicant

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

Extract a reusable `sendEmail(to, subject, text)` helper from the existing inline fetch call. The sender is always the AgentMail inbox (`tmac@agentmail.to`) — only the `to` field varies per recipient. AgentMail's send API relays to external addresses via outbound SMTP.

```javascript
// In server.cjs — extracted helper
async function sendEmail(to, subject, text) {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) { console.log('AGENTMAIL_API_KEY not set, skipping email'); return; }

  // URL path = sender inbox. "to" field = recipient (can be external).
  const res = await fetch(
    `${AGENTMAIL_API}/inboxes/${encodeURIComponent(AGENTMAIL_INBOX)}/messages/send`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, text })
    }
  );
  if (!res.ok) console.error(`Email to ${to} failed:`, res.status, await res.text());
}

const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);

async function sendNotification(data) {
  const subject = `New CrowdSolve Beta Application: ${data.name}`;
  const text = formatNotificationBody(data);

  // Terry (existing)
  sendEmail(AGENTMAIL_INBOX, subject, text);

  // Direct notifications to additional recipients (fire-and-forget, no await)
  for (const email of NOTIFY_EMAILS) {
    sendEmail(email, subject, text);
  }
}
```

**Note**: All email sends are fire-and-forget (no `await`). This matches the existing pattern and prevents email failures from blocking HTTP responses. `DatabaseSync` is synchronous and blocks the event loop during writes, so keeping email sends non-blocking avoids compounding latency.

### Known Limitation: Sender Address
All emails are sent from `tmac@agentmail.to`. Applicant-facing emails (approval/decline) will show this as the sender. If a custom sender like `team@crowdsolve.eco` is needed, AgentMail would need a custom domain configuration or a separate SMTP service would be required. For MVP, the AgentMail address is acceptable — replies will land in the AgentMail inbox which Terry monitors.

## Section 2: Express API — Approval Endpoints

### Auth Middleware

Extract the existing inline auth check into a reusable middleware. Apply to all admin endpoints (`GET /api/applications`, `PATCH /api/applications/:id`, `POST /api/applications/:id/send-payment`).

```javascript
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || !authHeader || authHeader !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
```

### New Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `GET /api/applications` | GET | Bearer ADMIN_KEY | List applications (existing, updated with `?status=` filter) |
| `PATCH /api/applications/:id` | PATCH | Bearer ADMIN_KEY | Update status, notes, and/or payment_status |
| `POST /api/applications/:id/send-payment` | POST | Bearer ADMIN_KEY | Send payment link email to applicant |

### GET /api/applications (updated)

Add optional `?status=<value>` query parameter for server-side filtering:
```sql
-- Without filter
SELECT * FROM applications ORDER BY created_at DESC
-- With filter
SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC
```

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

Update SQL explicitly sets `updated_at`:
```sql
UPDATE applications
SET status = COALESCE(?, status),
    notes = COALESCE(?, notes),
    payment_status = COALESCE(?, payment_status),
    updated_at = datetime('now')
WHERE id = ?
```

On status change to `approved` with query param `?send_payment=true`:
- Automatically triggers the payment link email to the applicant

**Error handling**:
- 404 if application ID does not exist
- 400 if `status` or `payment_status` value is not in the valid set
- 400 if `send_payment=true` but `STRIPE_PAYMENT_URL` is not configured

### POST /api/applications/:id/send-payment

Sends (or re-sends) the payment link email to the applicant. Updates `payment_status` to `sent`.

**Guards**:
- 404 if application ID does not exist
- 400 if `STRIPE_PAYMENT_URL` env var is not set
- If `payment_status` is already `sent` or `paid`, returns a warning response (`{ warning: "Payment link already sent", payment_status: "sent" }`) unless `?force=true` is passed. Prevents accidental double-sends.

### Schema Migration

```sql
ALTER TABLE applications ADD COLUMN updated_at TEXT;
ALTER TABLE applications ADD COLUMN payment_status TEXT DEFAULT 'pending';
```

Migration runs at server startup (idempotent — wraps each ALTER in a try/catch that ignores "duplicate column" errors).

## Section 3: MCP Server — crowdsolve-applications

A lightweight stdio-based MCP server that wraps the Railway admin API. Lives at `~/.claude/mcp-servers/crowdsolve-applications/`.

### File Structure
```
~/.claude/mcp-servers/crowdsolve-applications/
├── package.json          # deps: @modelcontextprotocol/sdk
├── tsconfig.json         # target: ES2022, module: Node16
└── src/
    └── index.ts
```

### Build & Run

Compile with `tsc` to `dist/`. The MCP registration runs `node dist/index.js`. Alternatively, install `tsx` as a dev dep and use `tsx src/index.ts` as the command — avoids a build step during development.

### Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_applications` | `status?` (string) | List all applications. Optional filter by status. Returns id, name, email, status, payment_status, created_at. |
| `get_application` | `id` (number) | Get full details for one application by ID. |
| `approve_application` | `id` (number), `send_payment?` (boolean, default true), `notes?` (string) | Set status=approved. If send_payment=true, emails applicant the Stripe Payment Link. |
| `decline_application` | `id` (number), `send_email?` (boolean, default false), `notes?` (string) | Set status=declined. Optionally sends a polite decline email. |
| `update_application` | `id` (number), `notes?` (string), `payment_status?` (string), `status?` (string) | Update notes, payment_status, or status (including waitlisted) on an application. |

### Error Handling

All tools return structured error messages:
- **Application not found**: `"No application found with ID {id}"` (maps from Express 404)
- **Missing payment URL**: `"STRIPE_PAYMENT_URL is not configured. Set it before sending payment links."` (maps from Express 400)
- **Payment already sent**: `"Payment link already sent (status: sent). Use force=true to resend."` (maps from Express warning)
- **Network errors**: `"Failed to reach Railway API at {url}: {error message}"`
- **Auth errors**: `"Authentication failed. Check CROWDSOLVE_ADMIN_KEY."`

All Express API error responses are passed through with context so Claude Code gets actionable messages.

### Configuration

Environment variables (set in Claude Code MCP config):
- `CROWDSOLVE_API_URL` — Railway base URL (e.g. `https://crowdsolve-landing-production.up.railway.app`)
- `CROWDSOLVE_ADMIN_KEY` — Same Bearer token as the Express ADMIN_KEY
- `STRIPE_PAYMENT_URL` — Stripe Payment Link URL (passed through to Express on approve)

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

### Note on CORS

Admin API endpoints are server-to-server only (MCP server on turtle → Railway Express). No CORS headers needed. Browser-based admin access is out of scope.

## Section 4: Applicant Emails

### First Name Extraction

Templates use `{firstName}`. Extract via: `firstName = name.split(' ')[0] || name`. Single-name applicants or empty splits fall back to the full `name` field.

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

**Sender address**: Emails are sent from `tmac@agentmail.to` (see Section 1 known limitation). Replies go to the AgentMail inbox.

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

### Known Limitation: DatabaseSync

The server uses `node:sqlite`'s `DatabaseSync` which blocks the event loop during writes. For a beta cohort with single-digit daily writes, this is a non-issue. If traffic scales significantly, consider migrating to an async SQLite driver (like `better-sqlite3` with worker threads) or Postgres.

## Section 7: crowdsolve.eco/beta URL

Separate from code work — Circle admin panel setup:
1. Log into Circle admin → Website → Pages
2. Create a new page with slug `beta`
3. Add a custom HTML/embed block with full-width iframe:
   ```html
   <iframe src="https://crowdsolve-landing-production.up.railway.app"
           style="border:0; width:100%; height:100vh;">
   </iframe>
   ```
4. Set page access to Public
5. Result: `crowdsolve.eco/beta` loads the Railway landing page

**Important**: Test the iframe embed in a Circle test/draft page first. Circle's HTML blocks may sanitize iframe attributes. If the iframe is stripped, fall back to a JavaScript redirect approach:
```html
<script>window.location.href = "https://crowdsolve-landing-production.up.railway.app";</script>
```
The redirect changes the URL in the browser bar to the Railway domain.

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
| 8 | Payment email contains valid Stripe Payment Link and correct firstName | Check email content after approval |
| 9 | Decline email sends only when explicitly requested | Decline without send_email, verify no email sent |
| 10 | `payment_status` field updates correctly via MCP | Update to 'paid', verify in DB |
| 11 | SQLite DB persists across Railway deployments | Deploy a no-op change to Railway. Use `list_applications` MCP tool to confirm previously submitted test applications still appear. |
| 12 | `crowdsolve.eco/beta` loads the landing page | Visit URL in browser, verify form is functional |
| 13 | Application form still works end-to-end | Submit application via the form, verify DB + notifications |
| 14 | Double-send guard works on payment endpoint | Call send-payment twice, verify warning on second call |
| 15 | Auth rejects invalid/missing ADMIN_KEY on all admin endpoints | Call PATCH and POST without auth, verify 401 |
| 16 | MCP tools return actionable error messages | Approve non-existent ID, verify clear error message |

## Out of Scope

- Stripe API integration (needs API key from Tim)
- Stripe webhook for auto-payment-status updates
- Auto-invite to Circle on payment
- Admin web UI (MCP tools replace this)
- Applicant-facing status tracking / portal
- Automated AI evaluation of applications (exists separately on turtle cron)
- Custom sender email domain for applicant-facing emails
- Rate limiting on admin endpoints (auth-gated, low traffic)

## Dependencies

- Railway dashboard access (for Volume setup)
- Circle admin access (for /beta page setup)
- `STRIPE_PAYMENT_URL` from Tim (can deploy without it, payment emails just won't send until configured)
- `ADMIN_KEY` env var on Railway (already exists or needs to be set)
- AgentMail API key (already configured on Railway)
- `@modelcontextprotocol/sdk` npm package (for MCP server)
