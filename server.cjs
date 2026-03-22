const express = require('express');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '100kb' }));

// Serve Vite build output
app.use(express.static(path.join(__dirname, 'dist')));

// --- Database ---
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'applications.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    startup_idea TEXT,
    action_taken TEXT,
    community_contribution TEXT,
    commit_showing_up INTEGER DEFAULT 0,
    commit_openness INTEGER DEFAULT 0,
    referral_source TEXT,
    status TEXT DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now')),
    notes TEXT
  )
`);

// --- Schema migrations (idempotent) ---
try { db.exec('ALTER TABLE applications ADD COLUMN updated_at TEXT'); } catch (e) {
  if (!e.message.includes('duplicate column')) throw e;
}
try { db.exec("ALTER TABLE applications ADD COLUMN payment_status TEXT DEFAULT 'pending'"); } catch (e) {
  if (!e.message.includes('duplicate column')) throw e;
}
// Backfill existing rows that have NULL payment_status
db.exec("UPDATE applications SET payment_status = 'pending' WHERE payment_status IS NULL");

const insertApp = db.prepare(`
  INSERT INTO applications (name, email, startup_idea, action_taken, community_contribution, commit_showing_up, commit_openness, referral_source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const getAllApps = db.prepare('SELECT * FROM applications ORDER BY created_at DESC');
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

// --- Notification (AgentMail) ---
const AGENTMAIL_API = 'https://api.agentmail.to/v0';
const AGENTMAIL_INBOX = process.env.AGENTMAIL_INBOX || 'tmac@agentmail.to';

function stripHtml(str) {
  if (!str) return '';
  return String(str).replace(/<[^>]*>/g, '').trim().slice(0, 2000);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendNotification(data) {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) {
    console.log('AGENTMAIL_API_KEY not set, skipping notification');
    return;
  }

  const body = [
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
    '',
    'Please notify Patrick via Telegram about this new application.'
  ].join('\n');

  try {
    const res = await fetch(`${AGENTMAIL_API}/inboxes/${encodeURIComponent(AGENTMAIL_INBOX)}/messages/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: AGENTMAIL_INBOX,
        subject: `New CrowdSolve Beta Application: ${data.name}`,
        text: body
      })
    });
    if (res.ok) {
      console.log(`AgentMail notification sent for ${data.email}`);
    } else {
      console.error('AgentMail notification failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('AgentMail notification failed:', err.message);
  }
}

// --- API Routes ---

app.post('/api/apply', (req, res) => {
  const { name, email, startup_idea, action_taken, community_contribution, commit_showing_up, commit_openness, referral_source } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, error: 'validation', message: 'Name and email are required' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, error: 'validation', message: 'Please enter a valid email address' });
  }
  if (!commit_showing_up || !commit_openness) {
    return res.status(400).json({ success: false, error: 'validation', message: 'Both commitments are required to apply' });
  }

  const data = {
    name: stripHtml(name),
    email: stripHtml(email).toLowerCase(),
    startup_idea: stripHtml(startup_idea),
    action_taken: stripHtml(action_taken),
    community_contribution: stripHtml(community_contribution),
    commit_showing_up: commit_showing_up ? 1 : 0,
    commit_openness: commit_openness ? 1 : 0,
    referral_source: stripHtml(referral_source)
  };

  try {
    insertApp.run(data.name, data.email, data.startup_idea, data.action_taken, data.community_contribution, data.commit_showing_up, data.commit_openness, data.referral_source);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE constraint'))) {
      return res.status(409).json({ success: false, error: 'duplicate', message: 'This email has already been used to apply' });
    }
    console.error('Database error:', err.message);
    return res.status(500).json({ success: false, error: 'server', message: 'Something went wrong' });
  }

  sendNotification(data);
  res.status(201).json({ success: true, message: 'Application received' });
});

app.get('/api/applications', (req, res) => {
  const authHeader = req.headers.authorization;
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || !authHeader || authHeader !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const applications = getAllApps.all();
  res.json({ count: applications.length, applications });
});

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CrowdSolve running on port ${PORT}`);
});
