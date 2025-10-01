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

/* =========================
   ENV / Defaults
========================= */
const PORT        = parseInt(process.env.PORT || '8080', 10);
const PROFILE_DIR = process.env.PROFILE_DIR || '/config/.config/chromium';
// preferred name; we will auto-detect if another profile actually holds cookies
const PROFILE_NAME_PREFERRED = process.env.PROFILE_NAME || 'Default';
const HEADLESS    = String(process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';
const API_KEY     = process.env.API_KEY || '';
const CHROME_PATH = process.env.CHROMIUM_PATH || '/usr/lib/chromium/chromium';

const WAIT_UNTIL = ['load','domcontentloaded','networkidle0','networkidle2']
  .includes(String(process.env.WAIT_UNTIL || 'networkidle0').toLowerCase())
  ? String(process.env.WAIT_UNTIL || 'networkidle0').toLowerCase()
  : 'networkidle0';

// IMPORTANT: LSA tokens are minted under /localservicesads/
const LSA_URL     = process.env.TARGET_URL || 'https://ads.google.com/localservices/accountpicker';
const COOKIE_TTL_MS = parseInt(process.env.COOKIE_TTL_MS || '600000', 10); // 10m

let cache = { cookieHeader: '', cookies: [], authHeader: '', expires: 0 };

/* =========================
   Small helpers
========================= */
function requireKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  res.status(401).json({ error: 'unauthorized' });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/* =========================
   Profile resolution
========================= */
function listCandidateProfiles() {
  const names = ['Default'];
  for (let i = 1; i <= 6; i++) names.push(`Profile ${i}`);
  const seen = new Set();
  // put preferred first, then common names
  return [PROFILE_NAME_PREFERRED, ...names].filter(n => !seen.has(n) && (seen.add(n), true));
}
function dirHasCookieDb(p) {
  return exists(path.join(p, 'Cookies')) ||
         exists(path.join(p, 'Cookies-wal')) ||
         exists(path.join(p, 'Network', 'Cookies')) ||
         exists(path.join(p, 'Network', 'Cookies-wal'));
}
function resolveProfileRoot() {
  for (const name of listCandidateProfiles()) {
    const full = path.join(PROFILE_DIR, name);
    if (dirHasCookieDb(full)) return { profileName: name, profilePath: full };
  }
  return { profileName: PROFILE_NAME_PREFERRED, profilePath: path.join(PROFILE_DIR, PROFILE_NAME_PREFERRED) };
}

/* =========================
   Auth header
========================= */
function buildSAPISIDHASH(cookies, origin = 'https://ads.google.com') {
  const get = n => cookies.find(c => c.name === n)?.value;
  const sapsid = get('SAPISID') || get('__Secure-3PAPISID') || get('__Secure-1PAPISID');
  if (!sapsid) return '';
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapsid} ${origin}`).digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}
function hasAuthCookies(list) {
  return list.some(c => c.name === 'SID' || c.name === '__Secure-1PSID' || c.name === '__Secure-3PSID');
}

/* =========================
   CDP cookie utils
========================= */
async function getAllCookies(page) {
  const client = await page.target().createCDPSession();
  const { cookies } = await client.send('Network.getAllCookies');
  return cookies || [];
}
async function waitForSID(page, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ck = await getAllCookies(page);
    if (hasAuthCookies(ck)) return ck;
    await sleep(500);
  }
  return await getAllCookies(page);
}

/* =========================
   Clone profile (copy Cookies + WAL/SHM)
========================= */
async function copyCookieStores(srcDir, dstDir) {
  try {
    const entries = await fsp.readdir(srcDir, { withFileTypes: true });
    await fsp.mkdir(dstDir, { recursive: true });
    const names = new Set(entries.map(e => e.name));
    for (const base of ['Cookies']) {
      for (const suf of ['', '-wal', '-shm']) {
        const name = `${base}${suf}`;
        if (!names.has(name)) continue;
        await fsp.copyFile(path.join(srcDir, name), path.join(dstDir, name));
      }
    }
  } catch {}
}
async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  await Promise.all(entries.map(async ent => {
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

async function cloneProfileToTemp() {
  const { profileName, profilePath } = resolveProfileRoot();
  const dstRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lsa-prof-'));
  const dstProfile = path.join(dstRoot, profileName);

  // Local State (os_crypt key for cookie decryption)
  try { await fsp.copyFile(path.join(PROFILE_DIR, 'Local State'), path.join(dstRoot, 'Local State')); } catch {}

  await fsp.mkdir(dstProfile, { recursive: true });

  // Copy cookie DBs from both locations
  await copyCookieStores(profilePath, dstProfile);
  await copyCookieStores(path.join(profilePath, 'Network'), path.join(dstProfile, 'Network'));

  // Best-effort extras
  for (const extra of ['Preferences', 'Login Data', 'Secure Preferences']) {
    try { await fsp.copyFile(path.join(profilePath, extra), path.join(dstProfile, extra)); } catch {}
  }

  return {
    userDataDir: dstRoot,
    profileName,
    debug: {
      pickedProfile: profileName,
      source: {
        root: profilePath,
        hasCookies: exists(path.join(profilePath, 'Cookies')),
        hasCookiesWal: exists(path.join(profilePath, 'Cookies-wal')),
        hasNetCookies: exists(path.join(profilePath, 'Network', 'Cookies')),
        hasNetCookiesWal: exists(path.join(profilePath, 'Network', 'Cookies-wal')),
      }
    },
    cleanup: async () => { try { await rmrf(dstRoot); } catch {} }
  };
}

/* =========================
   Main auth fetch
========================= */
async function fetchFreshAuth(targetUrl) {
  const cloned = await cloneProfileToTemp();

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    executablePath: CHROME_PATH,
    userDataDir: cloned.userDataDir,
    args: [
      `--profile-directory=${cloned.profileName}`,
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

    // GAIA preflight
    const GAIA_URL = 'https://accounts.google.com/ServiceLogin?service=adwords&continue=https://ads.google.com/localservices/accountpicker';
    await page.goto(GAIA_URL, { waitUntil: WAIT_UNTIL });
    await sleep(800);

    // Hit LSA (tokens minted here)
    const url = (targetUrl || LSA_URL) + ((targetUrl || LSA_URL).includes('?') ? '&' : '?') + `t=${Date.now()}`;
    await page.goto(url, { waitUntil: WAIT_UNTIL });
    await sleep(1200);

    // Wait until SID/PSID are present
    let cookies = await waitForSID(page);

    // If still missing, poke GAIA once more
    if (!hasAuthCookies(cookies)) {
      const GAIA_CHECK = 'https://accounts.google.com/CheckCookie?continue=https://ads.google.com/localservices/accountpicker';
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

    return { cookies, cookieHeader, authHeader, origin, foundAuth, debug: cloned.debug };
  } finally {
    await browser.close();
    await cloned.cleanup();
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
        authHeader: cache.authHeader,
        origin: new URL(url).origin,
        fromCache: true,
        at: new Date().toISOString()
      });
    }

    const { cookies, cookieHeader, authHeader, origin, foundAuth, debug } = await fetchFreshAuth(url);
    cache = { cookieHeader, cookies, authHeader, expires: Date.now() + COOKIE_TTL_MS };

    res.json({ cookieHeader, authHeader, origin, foundAuth, debug, fromCache: false, at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/whoami', (_req, res) => {
  const { profileName, profilePath } = resolveProfileRoot();
  res.json({
    PROFILE_DIR,
    PROFILE_NAME_PREFERRED,
    resolvedProfile: profileName,
    resolvedPath: profilePath,
    CHROME_PATH,
    WAIT_UNTIL,
    HEADLESS,
    hasCookiesDb: dirHasCookieDb(profilePath),
  });
});

app.get('/healthz', (_req, res) => res.send('ok'));

/* =========================
   Boot
========================= */
app.listen(PORT, () => console.log(`lsa-cookie listening on :${PORT}`));
