// =====================================================================
// WorkBee - shared server library (database + email + sessions)
// ספרייה משותפת לכל נקודות הקצה: מסד נתונים, אימייל, וסשנים
// =====================================================================
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const SESSION_DAYS = 7;            // משך התחברות אוטומטית בימים
const ADMIN_SESSION_HOURS = 12;    // משך כניסת מנהל בשעות
const REVIEW_FALLBACK_DAYS = 7;    // פרסום ביקורת אוטומטי אם צד אחד לא אישר

let pool = null;
let schemaPromise = null;
let transporter = null;

// ---------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3
    });
  }
  return pool;
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const p = getPool();
      await p.query(`
        CREATE TABLE IF NOT EXISTS wb_users (
          email TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          phone TEXT,
          password_hash TEXT NOT NULL,
          verified BOOLEAN NOT NULL DEFAULT FALSE,
          verify_token TEXT,
          verify_sent_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await p.query(`
        CREATE TABLE IF NOT EXISTS wb_jobs (
          id BIGINT PRIMARY KEY,
          title TEXT NOT NULL,
          employer TEXT,
          employer_email TEXT,
          employer_phone TEXT,
          category TEXT,
          location TEXT,
          city TEXT,
          pay NUMERIC NOT NULL DEFAULT 0,
          rating NUMERIC NOT NULL DEFAULT 5,
          reviews_count INTEGER NOT NULL DEFAULT 0,
          badge TEXT,
          time TEXT,
          min_age INTEGER,
          descr TEXT,
          hours TEXT,
          gender TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await p.query(`
        CREATE TABLE IF NOT EXISTS wb_requests (
          id BIGINT PRIMARY KEY,
          job_id BIGINT,
          job_title TEXT,
          applicant_name TEXT,
          applicant_email TEXT,
          applicant_phone TEXT,
          employer_email TEXT,
          employer_name TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          worker_done BOOLEAN NOT NULL DEFAULT FALSE,
          employer_done BOOLEAN NOT NULL DEFAULT FALSE,
          worker_review JSONB,
          employer_review JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await p.query(`
        CREATE TABLE IF NOT EXISTS wb_messages (
          id SERIAL PRIMARY KEY,
          request_id BIGINT NOT NULL,
          sender TEXT,
          sender_email TEXT,
          body TEXT,
          ts BIGINT,
          time_label TEXT
        )`);
      await p.query(`
        CREATE TABLE IF NOT EXISTS wb_reports (
          id BIGINT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reported_name TEXT,
          reported_email TEXT,
          reporter_name TEXT,
          reporter_email TEXT,
          category TEXT,
          details TEXT,
          context TEXT,
          status TEXT NOT NULL DEFAULT 'open'
        )`);
      await p.query(`
        CREATE TABLE IF NOT EXISTS wb_blocked (
          email TEXT PRIMARY KEY
        )`);
      await p.query(`
        CREATE TABLE IF NOT EXISTS wb_sessions (
          token TEXT PRIMARY KEY,
          email TEXT,
          kind TEXT NOT NULL DEFAULT 'user',
          expires_at TIMESTAMPTZ NOT NULL
        )`);
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

function q(text, params) {
  return getPool().query(text, params);
}

// ---------------------------------------------------------------------
// Passwords (hashed with scrypt - never stored as plain text)
// ---------------------------------------------------------------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(pw, stored) {
  try {
    const parts = String(stored || '').split(':');
    if (parts.length !== 2) return false;
    const check = crypto.scryptSync(String(pw), parts[0], 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(parts[1], 'hex'), Buffer.from(check, 'hex'));
  } catch (err) {
    return false;
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------
// Email (Gmail SMTP)
// ---------------------------------------------------------------------
function getMailer() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });
  }
  return transporter;
}

function getSiteUrl() {
  return (process.env.SITE_URL || 'https://beework21.vercel.app').replace(/\/+$/, '');
}

async function sendMail(to, subject, html) {
  const t = getMailer();
  if (!t) throw new Error('mail-not-configured');
  await t.sendMail({
    from: `"WorkBee" <${process.env.GMAIL_USER}>`,
    to: to,
    subject: subject,
    html: html
  });
}

function verificationEmailHtml(name, link) {
  return `
  <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; background: #f8fafc; border-radius: 16px;">
    <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 28px; text-align: center;">
      <h2 style="color: #0f172a; margin: 0 0 8px 0;">🐝 WorkBee - אימות כתובת האימייל</h2>
      <p style="color: #64748b; font-size: 15px;">שלום ${escapeHtml(name || '')},</p>
      <p style="color: #334155; font-size: 15px; line-height: 1.6;">
        כמעט סיימת! לחץ/י על הכפתור למטה כדי לאמת שכתובת האימייל באמת שייכת לך.<br>
        רק אחרי האימות תוכל/י להתחבר לאזור האישי.
      </p>
      <a href="${link}" style="display: inline-block; background: #6366f1; color: #ffffff; text-decoration: none; font-weight: bold; padding: 14px 34px; border-radius: 12px; margin: 18px 0; font-size: 16px;">
        אימות האימייל ✅
      </a>
      <p style="color: #94a3b8; font-size: 12px; line-height: 1.6;">
        אם הכפתור לא עובד, העתק/י את הקישור הבא לדפדפן:<br>
        <span style="color: #6366f1; direction: ltr; unicode-bidi: embed;">${link}</span>
      </p>
      <p style="color: #94a3b8; font-size: 12px;">אם לא את/ה נרשמת לאתר, אפשר פשוט להתעלם מההודעה הזו.</p>
    </div>
  </div>`;
}

function reportEmailToOwnerHtml(rep) {
  const row = (label, value) =>
    `<tr><td style="padding:6px 10px; background:#f8fafc; border:1px solid #e2e8f0; font-weight:bold; white-space:nowrap;">${label}</td><td style="padding:6px 10px; border:1px solid #e2e8f0;">${escapeHtml(value || '')}</td></tr>`;
  return `
  <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 620px;">
    <h2 style="color:#0f172a;">🚩 דיווח חדש על משתמש - WorkBee</h2>
    <table style="border-collapse:collapse; width:100%; font-size:14px;">
      ${row('מזהה דיווח', String(rep.id))}
      ${row('מועד', rep.created_at ? new Date(rep.created_at).toLocaleString('he-IL') : '')}
      ${row('המדווח עליו', rep.reported_name + ' (' + (rep.reported_email || 'ללא אימייל') + ')')}
      ${row('נשלח ע"י', rep.reporter_name + ' (' + rep.reporter_email + ')')}
      ${row('סיבה', rep.category)}
      ${row('הקשר', rep.context)}
    </table>
    <h3 style="color:#0f172a;">פירוט הדיווח:</h3>
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px; white-space:pre-wrap;">${escapeHtml(rep.details || '')}</div>
    <p style="color:#64748b; font-size:13px;">ניתן לטפל בדיווח בפאנל הניהול: ${getSiteUrl()}/#admin</p>
  </div>`;
}

// ---------------------------------------------------------------------
// Cookies + sessions
// ---------------------------------------------------------------------
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  });
  return out;
}

function setCookie(res, name, value, maxAgeSec) {
  res.setHeader('Set-Cookie',
    `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`);
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie',
    `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

async function createSession(email, kind) {
  const token = crypto.randomBytes(32).toString('hex');
  const ms = kind === 'admin'
    ? ADMIN_SESSION_HOURS * 60 * 60 * 1000
    : SESSION_DAYS * 24 * 60 * 60 * 1000;
  await q(
    `INSERT INTO wb_sessions (token, email, kind, expires_at) VALUES ($1, $2, $3, NOW() + ($4 || ' milliseconds')::interval)`,
    [token, email || '', kind, String(ms)]
  );
  return token;
}

// Returns the logged-in user row (with sliding 7-day expiry) or null
async function getSessionUser(req) {
  const token = parseCookies(req).wb_session;
  if (!token) return null;
  const r = await q(
    `SELECT s.token, u.email, u.name, u.phone, u.verified, u.created_at
     FROM wb_sessions s JOIN wb_users u ON u.email = s.email
     WHERE s.token = $1 AND s.kind = 'user' AND s.expires_at > NOW()`,
    [token]
  );
  if (r.rows.length === 0) return null;
  // sliding window - every visit extends the auto-login by another 7 days
  await q(`UPDATE wb_sessions SET expires_at = NOW() + ($2 || ' milliseconds')::interval WHERE token = $1`,
    [token, String(SESSION_DAYS * 24 * 60 * 60 * 1000)]);
  return r.rows[0];
}

async function isAdminSession(req) {
  const token = parseCookies(req).wb_admin;
  if (!token) return false;
  const r = await q(
    `SELECT 1 FROM wb_sessions WHERE token = $1 AND kind = 'admin' AND expires_at > NOW()`,
    [token]
  );
  return r.rows.length > 0;
}

async function destroySession(req, res, cookieName, kind) {
  const token = parseCookies(req)[cookieName];
  if (token) {
    await q(`DELETE FROM wb_sessions WHERE token = $1 AND kind = $2`, [token, kind]);
  }
  clearCookie(res, cookieName);
}

// ---------------------------------------------------------------------
// Blocking / misc
// ---------------------------------------------------------------------
async function getBlockedEmails() {
  const r = await q(`SELECT email FROM wb_blocked`);
  return r.rows.map((x) => x.email);
}

async function isBlockedEmail(email) {
  if (!email) return false;
  const r = await q(`SELECT 1 FROM wb_blocked WHERE email = $1`, [String(email).toLowerCase()]);
  return r.rows.length > 0;
}

// Port of the client's "job end date" logic (date label + to-hour)
function getJobEndDate(job) {
  const dm = /\((\d{1,2})\/(\d{1,2})\)/.exec(job.time || '');
  const hm = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/.exec(job.hours || '');
  if (!dm || !hm) return null;

  const day = Number(dm[1]);
  const month = Number(dm[2]) - 1;
  const startH = Number(hm[1]);
  const endH = Number(hm[3]);
  const endM = Number(hm[4]);
  const now = new Date();

  let best = null;
  [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].forEach((y) => {
    const d = new Date(y, month, day, endH, endM, 0, 0);
    if (endH <= startH) d.setDate(d.getDate() + 1); // shift ending after midnight
    if (!best || Math.abs(d - now) < Math.abs(best - now)) best = d;
  });
  return best;
}

function hasWorkEnded(job) {
  const end = getJobEndDate(job);
  return end ? Date.now() >= end.getTime() : true;
}

// Reviews are published when both sides confirmed, or after the fallback
// days passed since the work ended with only one side confirming
function isReviewPublished(reqRow, job) {
  if (reqRow.worker_done && reqRow.employer_done) return true;
  if (!reqRow.worker_done && !reqRow.employer_done) return false;
  const end = getJobEndDate(job);
  return !!end && Date.now() >= end.getTime() + REVIEW_FALLBACK_DAYS * 24 * 60 * 60 * 1000;
}

function averageScore(list) {
  if (!list.length) return 0;
  return Math.round(list.reduce((sum, x) => sum + x.score, 0) / list.length * 10) / 10;
}

// ---------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------
function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function json(res, status, obj) {
  res.status(status).json(obj);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || ''));
}

module.exports = {
  SESSION_DAYS, REVIEW_FALLBACK_DAYS,
  ensureSchema, q, getPool,
  hashPassword, verifyPassword, safeEqual,
  getMailer, sendMail, verificationEmailHtml, reportEmailToOwnerHtml, getSiteUrl,
  parseCookies, setCookie, clearCookie,
  createSession, getSessionUser, isAdminSession, destroySession,
  getBlockedEmails, isBlockedEmail,
  getJobEndDate, hasWorkEnded, isReviewPublished, averageScore,
  applyCors, json, readBody, escapeHtml, isValidEmail
};
