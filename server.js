// server.js
const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '128kb' }));

/* =========================
   ENV / Defaults
========================= */
const PORT         = parseInt(process.env.PORT || '8080', 10);
const PROFILE_NAME = process.env.PROFILE_NAME || 'Default';
const HEADLESS     = String(process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';
const API_KEY      = process.env.API_KEY || '';

const WAIT_UNTIL = (() => {
  const v = String(process.env.WAIT_UNTIL || 'networkidle').toLowerCase();
  return ['load', 'domcontentloaded', 'networkidle', 'commit'].includes(v) ? v : 'networkidle';
})();

// Hit LSA so Google mints PSIDTS/SIDTS
const LSA_URL        = process.env.TARGET_URL || 'https://ads.google.com/localservicesads/';
// Short cache so rotating tokens stay fresh (default 10 minutes)
const COOKIE_TTL_MS  = parseInt(process.env.COOKIE_TTL_MS || '600000', 10);

/* =========================
   Small in-memory cache
========================= */
let cache = { cookieHeader: '', cookies: [], authHeader: '', expires: 0 };

/* =========================
   Helpers
========================= */
function requireKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Prefer the actual linuxserver/chromium profile path (per chrome://version)
const PROFILE_CANDIDATES = [
  '/config/.config/chromium',
  '/config/chromium',
  '/config',
];

function dirHasProfile(p) {
  try {
    const hasDefault = fs.existsSync(path.join(p, 'Default'));
    const hasCookies = fs.existsSync(path.join(p, 'Default', 'Cookies'));
    return hasDefault && hasCookies;
  } catch { return false; }
}

function findUserDataDir() {
  const forced = process.env.PROFILE_DIR;
  if (forced && dirHasProfile(forced)) return forced;
  for (const cand of PROFILE_CANDIDATES) if (dirHasProfile(cand)) return cand;
  return forced || PROFILE_CANDIDATES[0]; // may be empty if misconfigured
}

function buildSAPISIDHASH(cookies, origin = 'https://ads.google.com') {
  const get = n => cookies.find(c => c.name === n)?.value;
  const sapsid = get('SAPISID') || get('__Secure-3PAPISID') || get('__Secure-1PAPISID');
  if (!sapsid) return '';
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapsid} ${origin}`).digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

async function waitForRotatingTokens(ctx, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ck = await ctx.cookies();
    const hasSID   = ck.some(c => c.name === 'SID' || c.name === '__Secure-1PSID' || c.name === '__Secure-3PSID');
    const hasPSIDT = ck.some(c => c.name === '__Secure-1PSIDTS') && ck.some(c => c.name === '__Secure-3PSIDTS');
    if (hasSID && hasPSIDT) return ck;
    await new Promise(r => setTimeout(r, 350));
  }
  return await ctx.cookies(); // best-effort
}

async function fetchFreshAuth(targetUrl) {
  const USER_DATA_DIR  = findUserDataDir();
  const executablePath = process.env.CHROMIUM_PATH || undefined; // optional: force same binary as lsa-login

  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--password-store=basic',
      '--use-mock-keychain',
      `--profile-directory=${PROFILE_NAME}`,
    ],
  });

  try {
    const page = await ctx.newPage();

    // 1) Touch GAIA so SID/PSID/PAPISID load into memory
    const GAIA_URL = 'https://accounts.google.com/ServiceLogin?service=adwords&continue=https://ads.google.com/localservicesads/';
    await page.goto(GAIA_URL, { waitUntil: WAIT_UNTIL });
    await page.waitForTimeout(800);

    // 2) Hit LSA root to mint PSIDTS/SIDTS in the same context
    const url = (targetUrl || LSA_URL) + ((targetUrl || LSA_URL).includes('?') ? '&' : '?') + `t=${Date.now()}`;
    await page.goto(url, { waitUntil: WAIT_UNTIL });
    await page.waitForTimeout(1200);

    // 3) Pull cookies across domains (accounts + ads + myaccount)
    let cookies = await ctx.cookies(
      'https://accounts.google.com',
      'https://ads.google.com',
      'https://myaccount.google.com'
    );

    // 4) Ensure rotating tokens exist (best-effort wait)
    if (!cookies.some(c => c.name === '__Secure-1PSIDTS') || !cookies.some(c => c.name === '__Secure-3PSIDTS')) {
      cookies = await waitForRotatingTokens(ctx, 8000);
    }

    const cookieHeader = cookies
      .filter(c => (c.domain || '').includes('google.com'))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    const origin = new URL(targetUrl || LSA_URL).origin;
    const authHeader = buildSAPISIDHASH(cookies, origin);

    return { cookies, cookieHeader, authHeader, origin };
  } finally {
    await ctx.close();
  }
}

/* =========================
   Routes
========================= */

app.get('/cookie', requireKey, async (req, res) => {
  try {
    const force = ['1','true','yes'].includes(String(req.query.force || '').toLowerCase());
    const url   = req.query.url || LSA_URL;

    if (!force && cache.cookieHeader && Date.now() < cache.expires) {
      return res.json({
        cookieHeader: cache.cookieHeader,
        authHeader:   cache.authHeader,
        origin:       new URL(url).origin,
        fromCache:    true,
        at:           new Date().toISOString(),
      });
    }

    const { cookies, cookieHeader, authHeader, origin } = await fetchFreshAuth(url);

    cache = {
      cookieHeader,
      cookies,
      authHeader,
      expires: Date.now() + COOKIE_TTL_MS,
    };

    res.json({
      cookieHeader,
      authHeader,
      origin,
      fromCache: false,
      at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Sanity check
app.get('/whoami', (_req, res) => {
  const USER_DATA_DIR = findUserDataDir();
  const cookiesDb = path.join(USER_DATA_DIR, PROFILE_NAME, 'Cookies');
  res.json({
    USER_DATA_DIR,
    PROFILE_NAME,
    WAIT_UNTIL,
    HEADLESS,
    hasCookiesDb: fs.existsSync(cookiesDb),
  });
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`lsa-cookie listening on :${PORT}`));
