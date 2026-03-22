# Application Pipeline v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email notifications to Patrick, approval/decline endpoints, payment link flow, and an MCP server to manage applications from Claude Code.

**Architecture:** Express server on Railway gets new PATCH/POST endpoints for application management + email sending via AgentMail. A separate MCP server on turtle wraps these endpoints as Claude Code tools. No Stripe API — just a configurable Payment Link URL.

**Tech Stack:** Node.js 22, Express 4, SQLite (node:sqlite DatabaseSync), AgentMail API, @modelcontextprotocol/sdk (TypeScript), tsx

**Spec:** `docs/superpowers/specs/2026-03-21-application-pipeline-v2-design.md`

---

## File Structure

### Express Server (modify existing)
- **`server.cjs`** — All server changes go here. Add: schema migration, sendEmail helper, NOTIFY_EMAILS, requireAdmin middleware, PATCH endpoint, send-payment endpoint, email templates, status filter on GET.

### MCP Server (new project)
- **`~/.claude/mcp-servers/crowdsolve-applications/package.json`** — Dependencies: `@modelcontextprotocol/sdk`
- **`~/.claude/mcp-servers/crowdsolve-applications/tsconfig.json`** — ES2022, Node16 module resolution
- **`~/.claude/mcp-servers/crowdsolve-applications/src/index.ts`** — MCP server with 5 tools wrapping Railway admin API

### Testing
- **`test-server.cjs`** — Smoke tests for all API endpoints (run against local server)

---

## Task 1: Schema Migration + Prepared Statements

**Files:**
- Modify: `server.cjs:18-43` (database setup section)

- [ ] **Step 1: Add idempotent column migrations after table creation**

In `server.cjs`, add these lines after the `CREATE TABLE IF NOT EXISTS` block (after line 36):

```javascript
// --- Schema migrations (idempotent) ---
try { db.exec('ALTER TABLE applications ADD COLUMN updated_at TEXT'); } catch (e) {
  if (!e.message.includes('duplicate column')) throw e;
}
try { db.exec("ALTER TABLE applications ADD COLUMN payment_status TEXT DEFAULT 'pending'"); } catch (e) {
  if (!e.message.includes('duplicate column')) throw e;
}
// Backfill existing rows that have NULL payment_status
db.exec("UPDATE applications SET payment_status = 'pending' WHERE payment_status IS NULL");
```

- [ ] **Step 2: Add new prepared statements**

After the existing `getAllApps` prepared statement (line 43), add:

```javascript
const getAppsByStatus = db.prepare('SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC');
const getAppById = db.prepare('SELECT * FROM applications WHERE id = ?');
const updateApp = db.prepare(`
  UPDATE applications
  SET status = COALESCE(?, status),
      notes = COALESCE(?, notes),
      payment_status = COALESCE(?, payment_status),
      updated_at = datetime('now')
  WHERE id = ?
`);
const updatePaymentStatus = db.prepare(`
  UPDATE applications SET payment_status = ?, updated_at = datetime('now') WHERE id = ?
`);
```

- [ ] **Step 3: Verify server starts without errors**

Run: `cd /Users/tmac/projects/crowdsolve/crowdsolve-landing && node server.cjs`
Expected: `CrowdSolve running on port 3000` with no migration errors.
Stop the server after verifying.

- [ ] **Step 4: Commit**

```
git add server.cjs
git commit -m "feat: add schema migration for updated_at and payment_status columns"
```

---

## Task 2: Extract sendEmail Helper + NOTIFY_EMAILS

**Files:**
- Modify: `server.cjs:45-102` (notification section)

- [ ] **Step 1: Replace the entire notification section with the refactored version**

Replace everything from `// --- Notification (AgentMail) ---` (line 45) through the end of the `sendNotification` function (line 102) with:

```javascript
// --- Email (AgentMail) ---
const AGENTMAIL_API = 'https://api.agentmail.to/v0';
const AGENTMAIL_INBOX = process.env.AGENTMAIL_INBOX || 'tmac@agentmail.to';
// NOTIFY_EMAILS: comma-separated additional recipients for application notifications.
// AGENTMAIL_INBOX (Terry) always receives. NOTIFY_EMAILS adds Patrick, etc.
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);

async function sendEmail(to, subject, text) {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) { console.log('AGENTMAIL_API_KEY not set, skipping email to', to); return; }

  try {
    // URL path = sender inbox. "to" field = recipient (can be external address).
    const res = await fetch(
      `${AGENTMAIL_API}/inboxes/${encodeURIComponent(AGENTMAIL_INBOX)}/messages/send`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, text })
      }
    );
    if (res.ok) {
      console.log(`Email sent to ${to}: ${subject}`);
    } else {
      console.error(`Email to ${to} failed:`, res.status, await res.text());
    }
  } catch (err) {
    console.error(`Email to ${to} failed:`, err.message);
  }
}

function formatNotificationBody(data) {
  return [
    `${data.name} (${data.email}) just applied for the CrowdSolve Beta.`,
    '',
    `Startup idea: ${data.startup_idea || '(not provided)'}`,
    '',
    `Action taken: ${data.action_taken || '(not provided)'}`,
    '',
    `What they'd bring: ${data.community_contribution || '(not provided)'}`,
    '',
    `Heard about us: ${data.referral_source || '(not provided)'}`,
    '',
    `Commitments: ${data.commit_showing_up ? '[x]' : '[ ]'} Show up & engage  ${data.commit_openness ? '[x]' : '[ ]'} Share openly & give feedback`,
  ].join('\n');
}

function sendNotification(data) {
  const subject = `New CrowdSolve Beta Application: ${data.name}`;
  const text = formatNotificationBody(data);

  // Terry (always)
  sendEmail(AGENTMAIL_INBOX, subject, text);

  // Additional recipients (fire-and-forget)
  for (const email of NOTIFY_EMAILS) {
    sendEmail(email, subject, text);
  }
}
```

- [ ] **Step 2: Verify server starts and existing apply endpoint still works**

Run: `node server.cjs`

Then test with curl:
```
curl -s -X POST http://localhost:3000/api/apply \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test User","email":"test-notify@example.com","startup_idea":"Test","action_taken":"Test","community_contribution":"Test","commit_showing_up":true,"commit_openness":true}'
```
Expected: `{"success":true,"message":"Application received"}` (or duplicate error if email exists)

Stop the server after verifying.

- [ ] **Step 3: Commit**

```
git add server.cjs
git commit -m "refactor: extract sendEmail helper, add NOTIFY_EMAILS support"
```

---

## Task 3: Auth Middleware + Status Filter on GET

**Files:**
- Modify: `server.cjs:104-152` (API routes section)

- [ ] **Step 1: Add requireAdmin middleware before the API routes**

Insert right after `// --- API Routes ---` (line 104), before `app.post('/api/apply', ...)`:

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

- [ ] **Step 2: Update GET /api/applications to use middleware + status filter**

Replace the existing `app.get('/api/applications', ...)` handler (lines 144-152) with:

```javascript
app.get('/api/applications', requireAdmin, (req, res) => {
  const { status } = req.query;
  const validStatuses = ['new', 'approved', 'declined', 'waitlisted'];

  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  const applications = status ? getAppsByStatus.all(status) : getAllApps.all();
  res.json({ count: applications.length, applications });
});

app.get('/api/applications/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  const record = getAppById.get(id);
  if (!record) return res.status(404).json({ error: `No application found with ID ${id}` });

  res.json(record);
});
```

- [ ] **Step 3: Verify auth rejection, status filter, and single-app GET**

Run: `ADMIN_KEY=testkey123 node server.cjs`

Test auth rejection (expect 401):
```
curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/applications
```

Test auth success (expect 200 with JSON):
```
curl -s http://localhost:3000/api/applications -H 'Authorization: Bearer testkey123'
```

Test status filter (expect filtered results):
```
curl -s 'http://localhost:3000/api/applications?status=new' -H 'Authorization: Bearer testkey123'
```

Stop the server after verifying.

- [ ] **Step 4: Commit**

```
git add server.cjs
git commit -m "feat: add requireAdmin middleware and status filter on GET /api/applications"
```

---

## Task 4: PATCH /api/applications/:id + Email Templates

**Files:**
- Modify: `server.cjs` (add email templates + new route after GET /api/applications)

- [ ] **Step 1: Add email template functions**

Add these after the `sendNotification` function, before the `// --- API Routes ---` comment:

```javascript
// --- Applicant Email Templates ---

function sendApprovalEmail(to, firstName, paymentUrl) {
  const subject = "You're in - next steps for CrowdSolve Beta";
  const text = `Hey ${firstName},

Your application to the CrowdSolve Beta cohort has been accepted.

To confirm your spot, complete payment here: ${paymentUrl}

The cohort kicks off April 13 and runs 10 weeks. Once payment is confirmed, you'll get an invite to the Circle community where everything happens.

Questions? Reply to this email.

— The CrowdSolve Team`;

  sendEmail(to, subject, text);
}

function sendDeclineEmail(to, firstName) {
  const subject = 'CrowdSolve Beta - Update on your application';
  const text = `Hey ${firstName},

Thanks for applying to the CrowdSolve Beta. We had a lot of strong applications for this cohort and unfortunately we're not able to offer you a spot this time.

We'll keep your application on file and reach out if a spot opens up or when we launch the next cohort.

— The CrowdSolve Team`;

  sendEmail(to, subject, text);
}
```

- [ ] **Step 2: Add the PATCH endpoint**

Add after the `app.get('/api/applications', ...)` route:

```javascript
const VALID_STATUSES = ['new', 'approved', 'declined', 'waitlisted'];
const VALID_PAYMENT_STATUSES = ['pending', 'sent', 'paid', 'failed'];

app.patch('/api/applications/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  const record = getAppById.get(id);
  if (!record) return res.status(404).json({ error: `No application found with ID ${id}` });

  const { status, notes, payment_status } = req.body;

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  if (payment_status && !VALID_PAYMENT_STATUSES.includes(payment_status)) {
    return res.status(400).json({ error: `Invalid payment_status. Must be one of: ${VALID_PAYMENT_STATUSES.join(', ')}` });
  }

  const sanitizedNotes = notes ? stripHtml(notes) : null;
  updateApp.run(status || null, sanitizedNotes, payment_status || null, id);

  const updated = getAppById.get(id);

  // Auto-send payment email if approving with ?send_payment=true
  if (status === 'approved' && req.query.send_payment === 'true') {
    const paymentUrl = process.env.STRIPE_PAYMENT_URL;
    if (!paymentUrl) {
      return res.status(400).json({ error: 'Approved but STRIPE_PAYMENT_URL not configured - payment email not sent', application: updated });
    }
    const firstName = updated.name.split(' ')[0] || updated.name;
    sendApprovalEmail(updated.email, firstName, paymentUrl);
    updatePaymentStatus.run('sent', id);
    const final = getAppById.get(id);
    return res.json(final);
  }

  // Auto-send decline email if declining with ?send_decline=true
  if (status === 'declined' && req.query.send_decline === 'true') {
    const firstName = updated.name.split(' ')[0] || updated.name;
    sendDeclineEmail(updated.email, firstName);
  }

  res.json(updated);
});
```

- [ ] **Step 3: Verify PATCH endpoint**

Run: `ADMIN_KEY=testkey123 node server.cjs`

Insert a test application:
```
curl -s -X POST http://localhost:3000/api/apply \
  -H 'Content-Type: application/json' \
  -d '{"name":"Patch Test","email":"patch-test@example.com","startup_idea":"Testing","action_taken":"Testing","community_contribution":"Testing","commit_showing_up":true,"commit_openness":true}'
```

Get the ID and test PATCH:
```
curl -s http://localhost:3000/api/applications -H 'Authorization: Bearer testkey123'
```

Test approve (use the ID from above):
```
curl -s -X PATCH http://localhost:3000/api/applications/1 \
  -H 'Authorization: Bearer testkey123' \
  -H 'Content-Type: application/json' \
  -d '{"status":"approved","notes":"Great application"}'
```
Expected: JSON with `status: "approved"`, `notes: "Great application"`, `updated_at` populated.

Test 404:
```
curl -s -X PATCH http://localhost:3000/api/applications/99999 \
  -H 'Authorization: Bearer testkey123' \
  -H 'Content-Type: application/json' \
  -d '{"status":"approved"}'
```
Expected: `{"error":"No application found with ID 99999"}` with 404 status.

Test invalid status:
```
curl -s -X PATCH http://localhost:3000/api/applications/1 \
  -H 'Authorization: Bearer testkey123' \
  -H 'Content-Type: application/json' \
  -d '{"status":"invalid"}'
```
Expected: 400 with error message.

Stop the server after verifying.

- [ ] **Step 4: Commit**

```
git add server.cjs
git commit -m "feat: add PATCH /api/applications/:id with approval/decline email support"
```

---

## Task 5: POST /api/applications/:id/send-payment

**Files:**
- Modify: `server.cjs` (add new route after PATCH)

- [ ] **Step 1: Add the send-payment endpoint**

Add after the PATCH endpoint:

```javascript
app.post('/api/applications/:id/send-payment', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  const record = getAppById.get(id);
  if (!record) return res.status(404).json({ error: `No application found with ID ${id}` });

  const paymentUrl = process.env.STRIPE_PAYMENT_URL;
  if (!paymentUrl) {
    return res.status(400).json({ error: 'STRIPE_PAYMENT_URL is not configured. Set it before sending payment links.' });
  }

  // Double-send guard
  if ((record.payment_status === 'sent' || app.payment_status === 'paid') && req.query.force !== 'true') {
    return res.json({
      warning: `Payment link already sent (status: ${app.payment_status}). Use ?force=true to resend.`,
      payment_status: app.payment_status
    });
  }

  const firstName = record.name.split(' ')[0] || app.name;
  sendApprovalEmail(record.email, firstName, paymentUrl);
  updatePaymentStatus.run('sent', id);

  const updated = getAppById.get(id);
  res.json(updated);
});
```

- [ ] **Step 2: Verify send-payment endpoint**

Run: `ADMIN_KEY=testkey123 STRIPE_PAYMENT_URL=https://buy.stripe.com/test node server.cjs`

Test send-payment (use a valid application ID):
```
curl -s -X POST http://localhost:3000/api/applications/1/send-payment \
  -H 'Authorization: Bearer testkey123'
```
Expected: JSON with `payment_status: "sent"`.

Test double-send guard:
```
curl -s -X POST http://localhost:3000/api/applications/1/send-payment \
  -H 'Authorization: Bearer testkey123'
```
Expected: JSON with `warning` about already sent.

Test force resend:
```
curl -s -X POST 'http://localhost:3000/api/applications/1/send-payment?force=true' \
  -H 'Authorization: Bearer testkey123'
```
Expected: JSON with `payment_status: "sent"` and no warning.

Stop the server after verifying.

- [ ] **Step 3: Commit**

```
git add server.cjs
git commit -m "feat: add POST /api/applications/:id/send-payment with double-send guard"
```

---

## Task 6: MCP Server — Scaffold

**Files:**
- Create: `~/.claude/mcp-servers/crowdsolve-applications/package.json`
- Create: `~/.claude/mcp-servers/crowdsolve-applications/tsconfig.json`
- Create: `~/.claude/mcp-servers/crowdsolve-applications/src/index.ts`

- [ ] **Step 1: Create the directory structure**

```
mkdir -p ~/.claude/mcp-servers/crowdsolve-applications/src
```

- [ ] **Step 2: Create package.json**

Write to `~/.claude/mcp-servers/crowdsolve-applications/package.json`:

```json
{
  "name": "crowdsolve-applications-mcp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "tsx": "^4.21.0",
    "typescript": "~5.8.2"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

Write to `~/.claude/mcp-servers/crowdsolve-applications/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create the MCP server skeleton with API client helper**

Write to `~/.claude/mcp-servers/crowdsolve-applications/src/index.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.CROWDSOLVE_API_URL;
const ADMIN_KEY = process.env.CROWDSOLVE_ADMIN_KEY;

if (!API_URL) throw new Error("CROWDSOLVE_API_URL is required");
if (!ADMIN_KEY) throw new Error("CROWDSOLVE_ADMIN_KEY is required");

async function apiCall(path: string, options: RequestInit = {}): Promise<any> {
  const url = `${API_URL}${path}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${ADMIN_KEY}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    const body = await res.json();

    if (res.status === 401) {
      throw new Error("Authentication failed. Check CROWDSOLVE_ADMIN_KEY.");
    }
    if (!res.ok) {
      throw new Error(body.error || body.warning || `API returned ${res.status}`);
    }
    return body;
  } catch (err: any) {
    if (err.cause?.code === 'ECONNREFUSED' || err.cause?.code === 'ENOTFOUND') {
      throw new Error(`Failed to reach Railway API at ${url}: ${err.message}`);
    }
    throw err;
  }
}

const server = new McpServer({
  name: "crowdsolve-applications",
  version: "1.0.0",
});

// Tools will be added in Tasks 7 and 8

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CrowdSolve Applications MCP server running");
}

main().catch(console.error);
```

- [ ] **Step 5: Create .gitignore**

Write to `~/.claude/mcp-servers/crowdsolve-applications/.gitignore`:

```
node_modules/
dist/
```

- [ ] **Step 6: Install dependencies and verify build**

```
cd ~/.claude/mcp-servers/crowdsolve-applications && npm install
npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 7: Initialize git repo and commit**

The MCP server lives outside the landing page repo at `~/.claude/mcp-servers/`. It needs its own git repo:

```
cd ~/.claude/mcp-servers/crowdsolve-applications
git init
git add -A
git commit -m "feat: scaffold crowdsolve-applications MCP server"
```

---

## Task 7: MCP Tools — list_applications + get_application

**Files:**
- Modify: `~/.claude/mcp-servers/crowdsolve-applications/src/index.ts`

- [ ] **Step 1: Add list_applications tool**

Replace the `// Tools will be added in Tasks 7 and 8` comment with:

```typescript
server.tool(
  "list_applications",
  "List all CrowdSolve beta applications. Optionally filter by status (new, approved, declined, waitlisted).",
  { status: z.string().optional().describe("Filter by status: new, approved, declined, waitlisted") },
  async ({ status }) => {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const data = await apiCall(`/api/applications${query}`);
    const summary = data.applications.map((a: any) =>
      `#${a.id} | ${a.name} <${a.email}> | status: ${a.status} | payment: ${a.payment_status || 'pending'} | applied: ${a.created_at}`
    ).join('\n');
    return {
      content: [{
        type: "text" as const,
        text: `${data.count} application(s)${status ? ` (status: ${status})` : ''}:\n\n${summary || '(none)'}`,
      }],
    };
  }
);
```

- [ ] **Step 2: Add get_application tool**

```typescript
server.tool(
  "get_application",
  "Get full details for a single CrowdSolve beta application by ID.",
  { id: z.number().describe("Application ID") },
  async ({ id }) => {
    const app = await apiCall(`/api/applications/${id}`);
    const details = Object.entries(app)
      .map(([k, v]) => `${k}: ${v ?? '(null)'}`)
      .join('\n');
    return {
      content: [{ type: "text" as const, text: details }],
    };
  }
);
```

- [ ] **Step 3: Verify build**

```
cd ~/.claude/mcp-servers/crowdsolve-applications && npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 4: Commit**

```
cd ~/.claude/mcp-servers/crowdsolve-applications
git add -A
git commit -m "feat: add list_applications and get_application MCP tools"
```

---

## Task 8: MCP Tools — approve, decline, update

**Files:**
- Modify: `~/.claude/mcp-servers/crowdsolve-applications/src/index.ts`

- [ ] **Step 1: Add approve_application tool**

```typescript
server.tool(
  "approve_application",
  "Approve a CrowdSolve beta application. Sends payment link email to applicant by default.",
  {
    id: z.number().describe("Application ID"),
    send_payment: z.boolean().default(true).describe("Send payment link email (default: true)"),
    notes: z.string().optional().describe("Internal notes"),
  },
  async ({ id, send_payment, notes }) => {
    const body: Record<string, unknown> = { status: 'approved' };
    if (notes) body.notes = notes;

    const query = send_payment ? '?send_payment=true' : '';
    const result = await apiCall(`/api/applications/${id}${query}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    const warning = result.warning ? `\n\nWarning: ${result.warning}` : '';
    const paymentNote = send_payment && !result.warning
      ? `\nPayment link email sent to ${result.email}.`
      : '';

    return {
      content: [{
        type: "text" as const,
        text: `Application #${id} (${result.name}) approved.${paymentNote}${warning}`,
      }],
    };
  }
);
```

- [ ] **Step 2: Add decline_application tool**

```typescript
server.tool(
  "decline_application",
  "Decline a CrowdSolve beta application. Optionally sends a polite decline email.",
  {
    id: z.number().describe("Application ID"),
    send_email: z.boolean().default(false).describe("Send decline email to applicant (default: false)"),
    notes: z.string().optional().describe("Internal notes"),
  },
  async ({ id, send_email, notes }) => {
    const body: Record<string, unknown> = { status: 'declined' };
    if (notes) body.notes = notes;

    const query = send_email ? '?send_decline=true' : '';
    const result = await apiCall(`/api/applications/${id}${query}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    const emailNote = send_email ? `\nDecline email sent to ${result.email}.` : '';

    return {
      content: [{
        type: "text" as const,
        text: `Application #${id} (${result.name}) declined.${emailNote}`,
      }],
    };
  }
);
```

- [ ] **Step 3: Add update_application tool**

```typescript
server.tool(
  "update_application",
  "Update notes, payment_status, or status on an application. NOTE: Setting status to 'approved' via this tool does NOT send a payment email. Use approve_application for the standard approve-and-notify flow.",
  {
    id: z.number().describe("Application ID"),
    notes: z.string().optional().describe("Internal notes"),
    payment_status: z.string().optional().describe("Payment status: pending, sent, paid, failed"),
    status: z.string().optional().describe("Application status: new, approved, declined, waitlisted"),
  },
  async ({ id, notes, payment_status, status }) => {
    const body: Record<string, unknown> = {};
    if (notes) body.notes = notes;
    if (payment_status) body.payment_status = payment_status;
    if (status) body.status = status;

    if (Object.keys(body).length === 0) {
      return { content: [{ type: "text" as const, text: "No fields to update. Provide notes, payment_status, or status." }] };
    }

    const result = await apiCall(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    return {
      content: [{
        type: "text" as const,
        text: `Application #${id} updated:\n  status: ${result.status}\n  payment_status: ${result.payment_status}\n  notes: ${result.notes || '(none)'}`,
      }],
    };
  }
);
```

- [ ] **Step 4: Verify build**

```
cd ~/.claude/mcp-servers/crowdsolve-applications && npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 5: Build for distribution**

```
cd ~/.claude/mcp-servers/crowdsolve-applications && npx tsc
```
Expected: `dist/index.js` created.

- [ ] **Step 6: Commit**

```
cd ~/.claude/mcp-servers/crowdsolve-applications
git add -A
git commit -m "feat: add approve, decline, and update application MCP tools"
```

---

## Task 9: MCP Server Registration

**Files:**
- Modify: `~/.claude.json` (add to top-level mcpServers object)

- [ ] **Step 1: Add the MCP server to Claude Code config**

In `~/.claude.json`, add the following entry to the existing top-level `mcpServers` object (alongside `google_workspace_mcp`, `context-db`, etc.):

```json
"crowdsolve-applications": {
  "type": "stdio",
  "command": "node",
  "args": ["/Users/tmac/.claude/mcp-servers/crowdsolve-applications/dist/index.js"],
  "env": {
    "CROWDSOLVE_API_URL": "https://crowdsolve-landing-production.up.railway.app",
    "CROWDSOLVE_ADMIN_KEY": "",
    "STRIPE_PAYMENT_URL": ""
  }
}
```

**IMPORTANT**: The `CROWDSOLVE_ADMIN_KEY` value needs to match the `ADMIN_KEY` env var set on Railway. The `STRIPE_PAYMENT_URL` is left blank until Tim creates the Stripe Payment Link. Set these values by editing the file directly — do not commit secrets.

- [ ] **Step 2: Verify MCP server starts**

Test that the server process starts without crashing:

```
CROWDSOLVE_API_URL=http://localhost:3000 CROWDSOLVE_ADMIN_KEY=testkey123 node ~/.claude/mcp-servers/crowdsolve-applications/dist/index.js
```
Expected: stderr shows "CrowdSolve Applications MCP server running", then hangs waiting for stdio input. Ctrl+C to exit.

- [ ] **Step 3: Commit MCP server**

```
cd ~/.claude/mcp-servers/crowdsolve-applications
git add -A
git commit -m "feat: complete MCP server build"
```

---

## Task 10: End-to-End Smoke Tests

**Files:**
- Create: `/Users/tmac/projects/crowdsolve/crowdsolve-landing/test-server.cjs`

- [ ] **Step 1: Write a smoke test script**

Write to `/Users/tmac/projects/crowdsolve/crowdsolve-landing/test-server.cjs`:

```javascript
// Smoke test for the application pipeline API.
// Usage: ADMIN_KEY=testkey123 node server.cjs & sleep 1 && node test-server.cjs; kill %1
const BASE = 'http://localhost:3000';
const AUTH = { 'Authorization': 'Bearer testkey123', 'Content-Type': 'application/json' };
let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL: ${name} — ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) { if (!condition) throw new Error(msg); }

(async () => {
  console.log('Running smoke tests...\n');

  const testEmail = `smoke-${Date.now()}@test.com`;

  // 1. Submit application
  await test('POST /api/apply — submit application', async () => {
    const res = await fetch(`${BASE}/api/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Smoke Test', email: testEmail,
        startup_idea: 'Testing', action_taken: 'Testing',
        community_contribution: 'Testing',
        commit_showing_up: true, commit_openness: true,
      }),
    });
    const data = await res.json();
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(data.success === true, 'Expected success: true');
  });

  // 2. Auth rejection
  await test('GET /api/applications — rejects without auth', async () => {
    const res = await fetch(`${BASE}/api/applications`);
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  // 3. List applications
  let appId;
  await test('GET /api/applications — returns list with auth', async () => {
    const res = await fetch(`${BASE}/api/applications`, { headers: AUTH });
    const data = await res.json();
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(typeof data.count === 'number', 'Expected count');
    const app = data.applications.find(a => a.email === testEmail);
    assert(app, 'Test application not found');
    appId = app.id;
  });

  // 4. Status filter
  await test('GET /api/applications?status=new — filters', async () => {
    const res = await fetch(`${BASE}/api/applications?status=new`, { headers: AUTH });
    const data = await res.json();
    assert(data.applications.every(a => a.status === 'new'), 'Not all status=new');
  });

  // 5. Approve
  await test('PATCH — approve application', async () => {
    const res = await fetch(`${BASE}/api/applications/${appId}`, {
      method: 'PATCH', headers: AUTH,
      body: JSON.stringify({ status: 'approved', notes: 'Smoke test approval' }),
    });
    const data = await res.json();
    assert(data.status === 'approved', `Expected approved, got ${data.status}`);
    assert(data.notes === 'Smoke test approval', 'Notes not set');
    assert(data.updated_at, 'updated_at not set');
  });

  // 6. 404 on non-existent
  await test('PATCH — 404 for non-existent ID', async () => {
    const res = await fetch(`${BASE}/api/applications/99999`, {
      method: 'PATCH', headers: AUTH,
      body: JSON.stringify({ status: 'approved' }),
    });
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  // 7. Invalid status
  await test('PATCH — 400 for invalid status', async () => {
    const res = await fetch(`${BASE}/api/applications/${appId}`, {
      method: 'PATCH', headers: AUTH,
      body: JSON.stringify({ status: 'invalid' }),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  // 8. Send-payment without STRIPE_PAYMENT_URL
  await test('POST /send-payment — 400 without STRIPE_PAYMENT_URL', async () => {
    const res = await fetch(`${BASE}/api/applications/${appId}/send-payment`, {
      method: 'POST', headers: AUTH,
    });
    const data = await res.json();
    // 400 if STRIPE_PAYMENT_URL not set, otherwise success
    assert(res.status === 400 || data.payment_status, 'Unexpected response');
  });

  // 9. Decline
  await test('PATCH — decline application', async () => {
    const res = await fetch(`${BASE}/api/applications/${appId}`, {
      method: 'PATCH', headers: AUTH,
      body: JSON.stringify({ status: 'declined' }),
    });
    const data = await res.json();
    assert(data.status === 'declined', `Expected declined, got ${data.status}`);
  });

  // 10. Update payment_status
  await test('PATCH — update payment_status', async () => {
    const res = await fetch(`${BASE}/api/applications/${appId}`, {
      method: 'PATCH', headers: AUTH,
      body: JSON.stringify({ payment_status: 'paid' }),
    });
    const data = await res.json();
    assert(data.payment_status === 'paid', `Expected paid, got ${data.payment_status}`);
  });

  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  process.exit(failed > 0 ? 1 : 0);
})();
```

- [ ] **Step 2: Run the smoke tests**

```
cd /Users/tmac/projects/crowdsolve/crowdsolve-landing
rm -f data/applications.db data/applications.db-wal data/applications.db-shm
ADMIN_KEY=testkey123 node server.cjs &
sleep 1
node test-server.cjs
kill %1 2>/dev/null
```

Expected: All 10 tests pass.

- [ ] **Step 3: Commit**

```
cd /Users/tmac/projects/crowdsolve/crowdsolve-landing
git add test-server.cjs server.cjs
git commit -m "feat: complete application pipeline v2 with smoke tests"
```

---

## Task 11: Manual Steps Checklist

These are not code tasks but must be completed for the pipeline to work end-to-end.

- [ ] **Step 1: Set env vars on Railway**

In Railway dashboard, crowdsolve-landing service, Variables:
- Add `ADMIN_KEY` = (generate: `openssl rand -hex 32`)
- Add `NOTIFY_EMAILS` = `patrick@crowdsolve.eco`
- Verify `AGENTMAIL_API_KEY` is already set

- [ ] **Step 2: Set ADMIN_KEY in MCP server config**

Edit `~/.claude.json` and set `CROWDSOLVE_ADMIN_KEY` in the `crowdsolve-applications` MCP server config to the same value as Railway's `ADMIN_KEY`.

- [ ] **Step 3: Add Railway Volume**

Railway dashboard, crowdsolve-landing, Settings, Volumes, Add Volume:
- Mount path: `/app/data`

- [ ] **Step 4: Deploy to Railway**

Push the code changes to trigger deployment:
```
cd /Users/tmac/projects/crowdsolve/crowdsolve-landing
git push origin main
```

- [ ] **Step 5: Verify MCP tools work against production**

Restart Claude Code to pick up the new MCP server. Then test:
- Use `list_applications` tool
- Use `get_application` with a known ID

- [ ] **Step 6: Ask Tim for Stripe Payment Link URL**

Tim creates a Stripe Payment Link in the dashboard for the beta cohort price. Once received:
- Set `STRIPE_PAYMENT_URL` on Railway env vars
- Set `STRIPE_PAYMENT_URL` in `~/.claude.json` MCP config for `crowdsolve-applications`

- [ ] **Step 7: Set up crowdsolve.eco/beta in Circle**

Log into Circle admin, Website, Pages:
1. Create page with slug `beta`
2. Add iframe embed (test in draft first):
   ```html
   <iframe src="https://crowdsolve-landing-production.up.railway.app"
           style="border:0; width:100%; height:100vh;"></iframe>
   ```
3. If Circle sanitizes the iframe, fall back to JS redirect:
   ```html
   <script>window.location.href = "https://crowdsolve-landing-production.up.railway.app";</script>
   ```
4. Publish when verified

---

## Task Summary

| Task | Description | Depends On |
|------|-------------|------------|
| 1 | Schema migration + prepared statements | — |
| 2 | Extract sendEmail + NOTIFY_EMAILS | 1 |
| 3 | Auth middleware + GET status filter | 1 |
| 4 | PATCH endpoint + email templates | 2, 3 |
| 5 | Send-payment endpoint | 4 |
| 6 | MCP server scaffold | — (parallel with 1-5) |
| 7 | MCP tools: list + get | 6 |
| 8 | MCP tools: approve + decline + update | 7 |
| 9 | MCP server registration | 8 |
| 10 | End-to-end smoke tests | 5, 9 |
| 11 | Manual steps (Railway, Circle, Stripe) | 10 |

Tasks 1-5 (Express server) and 6-9 (MCP server) can be worked in parallel by separate agents.
