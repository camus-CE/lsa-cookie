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

// ===== Helpers =====
function requireKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  res.status(401).json({ error: 'unauthorized' });
}

function profileHasDb() {
  try { return fs.existsSync(path.join(PROFILE_DIR, PROFILE_NAME, 'Cookies')); }
  catch { return false; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildSAPISIDHASH(cookies, origin = 'https://ads.google.com') {
  const get = n => cookies.find(c => c.name === n)?.value;
  const sapsid = get('SAPISID') || get('__Secure-3PAPISID') || get('__Secure-1PAPISID');
  if (!sapsid) return '';
  const ts = Math.floor(Date.now()/1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapsid} ${origin}`).digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

// ---- clone profile to avoid ProcessSingleton lock ----
async function cloneProfileToTemp() {
  const srcRoot = PROFILE_DIR;
  const srcDefault = path.join(srcRoot, PROFILE_NAME);
  const dstRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lsa-prof-'));
  const dstDefault = path.join(dstRoot, PROFILE_NAME);

  // copy Local State (has os_crypt key)
  try { await fsp.copyFile(path.join(srcRoot, 'Local State'), path.join(dstRoot, 'Local State')); } catch {}

  // minimal files from Default needed to read cookies
  const mustCopy = [
    'Cookies',
    path.join('Network', 'Cookies'),
    'Preferences',
    'Login Data',
    'Secure Preferences'
  ];

  await fsp.mkdir(dstDefault, { recursive: true });
  for (const entry of mustCopy) {
    const src = path.join(srcDefault, entry);
    const dst = path.join(dstDefault, entry);
    try {
      const stat = await fsp.stat(src);
      if (stat.isDirectory()) await copyDir(src, dst);
      else {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(src, dst);
      }
    } catch {}
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

async function rmrf(p) { await fsp.rm(p, { recursive: true, force: true }); }

// Pull ALL cookies via CDP (works across domains & Puppeteer versions)
async function getAllCookies(page) {
  const client = await page.target().createCDPSession();
  const { cookies } = await client.send('Network.getAllCookies');
  return cookies || [];
}

// ---- auth cookie wait logic ----
function hasAuthCookies(list) {
  return list.some(c => c.name === 'SID' || c.name === '__Secure-1PSID' || c.name === '__Secure-3PSID');
}

async function waitForSID(page, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ck = await getAllCookies(page);
    if (hasAuthCookies(ck)) return ck;
    await sleep(500);
  }
  return await getAllCookies(page); // best effort
}

// -----------------------------------------------------------
async function fetchFreshAuth(targetUrl) {
  const { userDataDir, cleanup } = await cloneProfileToTemp();

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    executablePath: CHROME_PATH,
    userDataDir, // launch against the clone
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
    await sleep(800);

    // LSA — mint PSIDTS/SIDTS
    const url = (targetUrl || LSA_URL) + ((targetUrl || LSA_URL).includes('?') ? '&' : '?') + `t=${Date.now()}`;
    await page.goto(url, { waitUntil: WAIT_UNTIL });
    await sleep(1200);

    // Wait until GAIA session cookies (SID/PSID) are present
    let cookies = await waitForSID(page);

    // If still missing, poke GAIA once more and wait again
    if (!hasAuthCookies(cookies)) {
      const GAIA_CHECK = 'https://accounts.google.com/CheckCookie?continue=https://ads.google.com/localservicesads/';
      await page.goto(GAIA_CHECK, { waitUntil: WAIT_UNTIL });
      await sleep(800);
      cookies = await waitForSID(page, 8000);
    }

    const cookieHeader = cookies
      .filter(c => (c.domain || '').includes('google.com'))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    const origin = new URL(targetUrl || LSA_URL).origin;
    const authHeader = buildSAPISIDHASH(cookies, origin);

    const foundAuth = cookies
      .filter(c => ['SID','__Secure-1PSID','__Secure-3PSID','SAPISID','__Secure-1PAPISID','__Secure-3PAPISID'].includes(c.name))
      .map(c => c.name);

    return { cookies, cookieHeader, authHeader, origin, foundAuth };
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

    const { cookies, cookieHeader, authHeader, origin, foundAuth } = await fetchFreshAuth(url);

    cache = { cookieHeader, cookies, authHeader, expires: Date.now() + COOKIE_TTL_MS };

    res.json({ cookieHeader, authHeader, origin, foundAuth, fromCache: false, at: new Date().toISOString() });
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
