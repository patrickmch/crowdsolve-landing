const express = require('express');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const nodemailer = require('nodemailer');

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

const insertApp = db.prepare(`
  INSERT INTO applications (name, email, startup_idea, action_taken, community_contribution, commit_showing_up, commit_openness, referral_source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const getAllApps = db.prepare('SELECT * FROM applications ORDER BY created_at DESC');

// --- Email ---
function createTransport() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function stripHtml(str) {
  if (!str) return '';
  return String(str).replace(/<[^>]*>/g, '').trim().slice(0, 2000);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendNotification(data) {
  const transport = createTransport();
  if (!transport) {
    console.log('SMTP not configured, skipping email notification');
    return;
  }
  const to = process.env.NOTIFY_EMAIL || process.env.SMTP_USER;
  try {
    await transport.sendMail({
      from: process.env.SMTP_USER,
      to,
      subject: `New CrowdSolve Beta Application: ${data.name}`,
      text: [
        `${data.name} (${data.email}) just applied.`,
        '',
        `Startup idea: ${data.startup_idea || '(not provided)'}`,
        '',
        `Action taken: ${data.action_taken || '(not provided)'}`,
        '',
        `What they'd bring: ${data.community_contribution || '(not provided)'}`,
        '',
        `Heard about us: ${data.referral_source || '(not provided)'}`,
        '',
        `Commitments: ${data.commit_showing_up ? '[x]' : '[ ]'} Show up & engage  ${data.commit_openness ? '[x]' : '[ ]'} Share openly & give feedback`
      ].join('\n')
    });
    console.log(`Notification sent for ${data.email}`);
  } catch (err) {
    console.error('Email notification failed:', err.message);
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
