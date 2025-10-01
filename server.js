// server.js
const express = require('express');
const { chromium } = require('playwright'); // <- Playwright
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const app = express();
app.use(express.json({ limit: '256kb' }));

/* =========================
   ENV / Defaults
========================= */
const PORT = parseInt(process.env.PORT || '8080', 10);

// This is the *user data dir root* that both lsa-login and lsa-cookie share
// e.g. chrome://version shows Profile Path: /config/.config/chromium/Default
const PROFILE_DIR = process.env.PROFILE_DIR || '/config/.config/chromium';
const PROFILE_NAME = process.env.PROFILE_NAME || 'Default';

const API_KEY = process.env.API_KEY || '';
const TARGET_URL =
  process.env.TARGET_URL ||
  'https://ads.google.com/localservices/accountpicker';

// Playwright accepts 'load' | 'domcontentloaded' | 'networkidle'
const WAIT_UNTIL_RAW =
  (process.env.WAIT_UNTIL || 'networkidle').toLowerCase();
const WAIT_UNTIL =
  ['load', 'domcontentloaded', 'networkidle'].includes(WAIT_UNTIL_RAW)
    ? WAIT_UNTIL_RAW
    : 'networkidle';

const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '20000', 10);
const COOKIE_TTL_MS = parseInt(process.env.COOKIE_TTL_MS || '3600000', 10); // 1h cache
const HEADLESS =
  String(process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';

const SEED_FILE = process.env.SEED_FILE || '/config/seed-cookie.txt';

// in-memory cache
let cache = { header: '', cookies: [], expires: 0 };

/* =========================
   Helpers
========================= */
function requireKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('deadline')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function readSeed() {
  try { return await fsp.readFile(SEED_FILE, 'utf8'); } catch { return ''; }
}
async function writeSeed(v) {
  await fsp.mkdir(path.dirname(SEED_FILE), { recursive: true });
  await fsp.writeFile(SEED_FILE, v || '', 'utf8');
}

function parseCookieHeader(str) {
  // Turn "a=b; c=d; SID=..." into Playwright cookie objects
  return (str || '')
    .split(/;\s*/)
    .map(kv => {
      const i = kv.indexOf('=');
      if (i < 0) return null;
      const name = kv.slice(0, i).trim();
      const value = kv.slice(i + 1).trim();
      if (!name) return null;
      return {
        name,
        value,
        domain: '.google.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        // give seeded cookies a week, GAIA may overwrite anyway
        expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      };
    })
    .filter(Boolean);
}

function buildSAPISIDHASH(cookies, origin) {
  const get = n => cookies.find(c => c.name === n)?.value;
  const sapsid = get('SAPISID') || get('__Secure-3PAPISID') || get('__Secure-1PAPISID');
  if (!sapsid) return '';
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto
    .createHash('sha1')
    .update(`${ts} ${sapsid} ${origin}`)
    .digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

function cookieHeaderFrom(cookies) {
  return cookies
    .filter(c => (c.domain || '').includes('google.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

/* =========================
   Cookie fetch (Playwright)
========================= */
async function getCookiesAndHeader(targetUrl, { force=false, useSeed=true, clear=false } = {}) {
  if (!force && cache.header && Date.now() < cache.expires) {
    return { header: cache.header, cookies: cache.cookies, fromCache: true };
  }

  // Playwright persistent context: points to the *user data dir root*
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--profile-directory=${PROFILE_NAME}`,
      '--password-store=basic',
      '--use-mock-keychain',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    if (clear) {
      try { await ctx.clearCookies(); } catch {}
    }

    if (useSeed) {
      const seeded = await readSeed();
      const toSet = parseCookieHeader(seeded);
      if (toSet.length) await ctx.addCookies(toSet);
    }

    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    // Navigate to the target URL (accountpicker is best to mint auth cookies)
    const url = targetUrl || TARGET_URL;
    await withDeadline(
      page.goto(url, { waitUntil: WAIT_UNTIL, timeout: NAV_TIMEOUT_MS }),
      NAV_TIMEOUT_MS + 5000
    ).catch(() => { /* swallow; we will still collect cookies */ });

    // Collect cookies from the whole context (not just the page)
    const cookies = await ctx.cookies();
    const header = cookieHeaderFrom(cookies);

    cache = { header, cookies, expires: Date.now() + COOKIE_TTL_MS };
    return { header, cookies, fromCache: false };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* =========================
   Routes
========================= */
app.get('/cookie', requireKey, async (req, res) => {
  try {
    const force = ['1','true','yes'].includes(String(req.query.force || '').toLowerCase());
    const useSeed = !(['0','false','no'].includes(String(req.query.seed || '').toLowerCase()));
    const clear = ['1','true','yes'].includes(String(req.query.clear || '').toLowerCase());

    const url = req.query.url || TARGET_URL;
    const origin = req.query.origin || new URL(url).origin || 'https://ads.google.com';

    const { header, cookies, fromCache } = await getCookiesAndHeader(url, { force, useSeed, clear });

    // Build auth header and simple login diagnostics
    const names = new Set(cookies.map(c => c.name));
    const hasSID = names.has('SID') || names.has('__Secure-1PSID') || names.has('__Secure-3PSID');
    const hasSAPISID =
      names.has('SAPISID') || names.has('__Secure-1PAPISID') || names.has('__Secure-3PAPISID');
    const needLogin = !(hasSID && hasSAPISID);

    const authHeader = buildSAPISIDHASH(cookies, origin);

    res.json({
      cookieHeader: header,
      authHeader,
      origin,
      hasSID,
      hasSAPISID,
      needLogin,
      forced: force,
      usedSeed: useSeed,
      cleared: clear,
      fromCache,
      at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post('/seed', requireKey, async (req, res) => {
  try {
    const { cookieHeader } = req.body || {};
    if (!cookieHeader || typeof cookieHeader !== 'string') {
      return res.status(400).json({ error: 'cookieHeader string required' });
    }
    await writeSeed(cookieHeader);
    cache = { header: '', cookies: [], expires: 0 };
    res.json({ ok: true, bytes: cookieHeader.length });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.delete('/seed', requireKey, async (_req, res) => {
  await writeSeed('');
  cache = { header: '', cookies: [], expires: 0 };
  res.json({ ok: true });
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`lsa-cookie on :${PORT}`));
