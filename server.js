// server.js
const express = require('express');
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '128kb' }));

// ===== ENV =====
const PORT         = parseInt(process.env.PORT || '8080', 10);
const PROFILE_DIR  = process.env.PROFILE_DIR  || '/config/.config/chromium';
const PROFILE_NAME = process.env.PROFILE_NAME || 'Default';
const HEADLESS     = String(process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';
const API_KEY      = process.env.API_KEY || '';
const CHROME_PATH  = process.env.CHROMIUM_PATH || '/usr/lib/chromium/chromium';

const WAIT_UNTIL = ['load','domcontentloaded','networkidle0','networkidle2']
  .includes(String(process.env.WAIT_UNTIL||'networkidle0').toLowerCase())
  ? String(process.env.WAIT_UNTIL||'networkidle0').toLowerCase()
  : 'networkidle0';

const LSA_URL       = process.env.TARGET_URL || 'https://ads.google.com/localservicesads/';
const COOKIE_TTL_MS = parseInt(process.env.COOKIE_TTL_MS || '600000', 10); // 10m

let cache = { cookieHeader: '', cookies: [], authHeader: '', expires: 0 };

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  res.status(401).json({ error: 'unauthorized' });
}

function profileHasDb() {
  try {
    return fs.existsSync(path.join(PROFILE_DIR, PROFILE_NAME, 'Cookies'));
  } catch { return false; }
}

function buildSAPISIDHASH(cookies, origin = 'https://ads.google.com') {
  const get = n => cookies.find(c => c.name === n)?.value;
  const sapsid = get('SAPISID') || get('__Secure-3PAPISID') || get('__Secure-1PAPISID');
  if (!sapsid) return '';
  const ts = Math.floor(Date.now()/1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapsid} ${origin}`).digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

async function fetchFreshAuth(targetUrl) {
  const userDataDir = path.join(PROFILE_DIR); // points to folder that contains "Default"
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    executablePath: CHROME_PATH,
    userDataDir,
    args: [
      `--profile-directory=${PROFILE_NAME}`, // "Default"
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--password-store=basic',
      '--use-mock-keychain'
    ]
  });

  try {
    const page = await browser.newPage();

    // 1) GAIA preflight — load account session cookies
    const GAIA_URL = 'https://accounts.google.com/ServiceLogin?service=adwords&continue=https://ads.google.com/localservicesads/';
    await page.goto(GAIA_URL, { waitUntil: WAIT_UNTIL });
    await page.waitForTimeout(800);

    // 2) Hit LSA so PSIDTS/SIDTS are minted
    const url = (targetUrl || LSA_URL) + ((targetUrl || LSA_URL).includes('?') ? '&' : '?') + `t=${Date.now()}`;
    await page.goto(url, { waitUntil: WAIT_UNTIL });
    await page.waitForTimeout(1200);

    // 3) Pull cookies from all relevant scopes
    const cookies = (await page.cookies(
      'https://accounts.google.com',
      'https://ads.google.com',
      'https://myaccount.google.com'
    ));

    const cookieHeader = cookies
      .filter(c => (c.domain || '').includes('google.com'))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    const origin = new URL(targetUrl || LSA_URL).origin;
    const authHeader = buildSAPISIDHASH(cookies, origin);

    return { cookies, cookieHeader, authHeader, origin };
  } finally {
    await browser.close();
  }
}

// ===== Routes =====
app.get('/cookie', requireKey, async (req, res) => {
  try {
    const force = ['1','true','yes'].includes(String(req.query.force||'').toLowerCase());
    const url   = req.query.url || LSA_URL;

    if (!force && cache.cookieHeader && Date.now() < cache.expires) {
      return res.json({
        cookieHeader: cache.cookieHeader,
        authHeader: cache.authHeader,
        origin: new URL(url).origin,
        fromCache: true,
        at: new Date().toISOString()
      });
    }

    const { cookies, cookieHeader, authHeader, origin } = await fetchFreshAuth(url);

    cache = { cookieHeader, cookies, authHeader, expires: Date.now() + COOKIE_TTL_MS };

    res.json({ cookieHeader, authHeader, origin, fromCache: false, at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/whoami', (_req, res) => {
  res.json({
    PROFILE_DIR,
    PROFILE_NAME,
    CHROME_PATH,
    WAIT_UNTIL,
    HEADLESS,
    hasCookiesDb: profileHasDb()
  });
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`lsa-cookie listening on :${PORT}`));
