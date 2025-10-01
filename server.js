// server.js
const express = require('express');
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

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

// ---- NEW: clone profile to avoid ProcessSingleton lock ----
async function cloneProfileToTemp() {
  const srcRoot = PROFILE_DIR;
  const srcDefault = path.join(srcRoot, PROFILE_NAME);
  const dstRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lsa-prof-')); // e.g., /tmp/lsa-prof-abc123
  const dstDefault = path.join(dstRoot, PROFILE_NAME);

  // copy Local State (has os_crypt key)
  try {
    await fsp.copyFile(path.join(srcRoot, 'Local State'), path.join(dstRoot, 'Local State'));
  } catch { /* best effort */ }

  // minimal files from Default needed to read cookies
  const mustCopy = [
    'Cookies',                // cookie DB
    'Network',                // sometimes cookies live under Network/Cookies (new schema)
    'Preferences',            // not strictly required but cheap
    'Login Data',             // rarely needed, safe to copy
    'Secure Preferences'      // contains some profile flags
  ];

  await fsp.mkdir(dstDefault, { recursive: true });
  for (const entry of mustCopy) {
    const src = path.join(srcDefault, entry);
    const dst = path.join(dstDefault, entry);
    try {
      const stat = await fsp.stat(src);
      if (stat.isDirectory()) {
        await copyDir(src, dst);
      } else {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(src, dst);
      }
    } catch { /* skip missing files */ }
  }

  return { userDataDir: dstRoot, cleanup: async () => { try { await rmrf(dstRoot); } catch {} } };
}

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  await Promise.all(entries.map(async (ent) => {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) return copyDir(s, d);
    if (ent.isFile()) {
      await fsp.mkdir(path.dirname(d), { recursive: true });
      return fsp.copyFile(s, d);
    }
  }));
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

// -----------------------------------------------------------

async function fetchFreshAuth(targetUrl) {
  // 1) Clone the live profile so we don't collide with lsa-login
  const { userDataDir, cleanup } = await cloneProfileToTemp();

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    executablePath: CHROME_PATH,
    userDataDir, // ← launch against the clone
    args: [
      `--profile-directory=${PROFILE_NAME}`, // "Default" inside the clone
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--password-store=basic',
      '--use-mock-keychain',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  try {
    const page = await browser.newPage();

    // GAIA preflight — load account session cookies
    const GAIA_URL = 'https://accounts.google.com/ServiceLogin?service=adwords&continue=https://ads.google.com/localservicesads/';
    await page.goto(GAIA_URL, { waitUntil: WAIT_UNTIL });
    await page.waitForTimeout(800);

    // Hit LSA so PSIDTS/SIDTS are minted
    const url = (targetUrl || LSA_URL) + ((targetUrl || LSA_URL).includes('?') ? '&' : '?') + `t=${Date.now()}`;
    await page.goto(url, { waitUntil: WAIT_UNTIL });
    await page.waitForTimeout(1200);

    // Pull cookies from all relevant scopes
    const cookies = await page.cookies(
      'https://accounts.google.com',
      'https://ads.google.com',
      'https://myaccount.google.com'
    );

    const cookieHeader = cookies
      .filter(c => (c.domain || '').includes('google.com'))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    const origin = new URL(targetUrl || LSA_URL).origin;
    const authHeader = buildSAPISIDHASH(cookies, origin);

    return { cookies, cookieHeader, authHeader, origin };
  } finally {
    await browser.close();
    await cleanup(); // remove temp clone
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
