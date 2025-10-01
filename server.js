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
const PROFILE_NAME_PREFERRED = process.env.PROFILE_NAME || 'Default'; // we'll auto-detect anyway
const HEADLESS    = String(process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';
const API_KEY     = process.env.API_KEY || '';
const CHROME_PATH = process.env.CHROMIUM_PATH || '/usr/lib/chromium/chromium';

// Default to 'domcontentloaded' (more robust than networkidle on LSA)
const WAIT_UNTIL = ['load','domcontentloaded','networkidle0','networkidle2']
  .includes(String(process.env.WAIT_UNTIL || 'domcontentloaded').toLowerCase())
  ? String(process.env.WAIT_UNTIL || 'domcontentloaded').toLowerCase()
  : 'domcontentloaded';

// Soft navigation timeout (ms) so timeouts don't stall the whole flow
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '12000', 10);

// LSA tokens are minted under /localservicesads/
const LSA_URL     = process.env.TARGET_URL || 'https://ads.google.com/localservicesads/';
const COOKIE_TTL_MS = parseInt(process.env.COOKIE_TTL_MS || '600000', 10); // 10m cache

let cache = { cookieHeader: '', cookies: [], authHeader: '', expires: 0 };

/* =========================
   Helpers
========================= */
function requireKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  res.status(401).json({ error: 'unauthorized' });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

// Soft navigation that never throws; we’ll still poll cookies afterward
async function gotoSoft(page, url, waitUntil = WAIT_UNTIL, timeout = NAV_TIMEOUT_MS) {
  try {
    await page.goto(url, { waitUntil, timeout });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.name || String(e) };
  }
}

/* =========================
   Profile candidates
========================= */
function listCandidateProfiles() {
  const names = ['Default'];
  for (let i = 1; i <= 8; i++) names.push(`Profile ${i}`);
  const seen = new Set();
  return [PROFILE_NAME_PREFERRED, ...names].filter(n => !seen.has(n) && (seen.add(n), true));
}
function dirHasCookieDb(p) {
  return exists(path.join(p, 'Cookies')) ||
         exists(path.join(p, 'Cookies-wal')) ||
         exists(path.join(p, 'Network', 'Cookies')) ||
         exists(path.join(p, 'Network', 'Cookies-wal'));
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
   CDP cookies + wait
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
  return await getAllCookies(page); // best-effort
}

/* =========================
   Clone profile (Cookies + WAL/SHM)
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
async function rmrf(p) { await fsp.rm(p, { recursive: true, force: true }); }

async function cloneNamedProfileToTemp(profileName) {
  const profilePath = path.join(PROFILE_DIR, profileName);
  const dstRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lsa-prof-'));
  const dstProfile = path.join(dstRoot, profileName);

  // Local State carries the os_crypt key
  try { await fsp.copyFile(path.join(PROFILE_DIR, 'Local State'), path.join(dstRoot, 'Local State')); } catch {}
  await fsp.mkdir(dstProfile, { recursive: true });

  // Copy cookie DBs from both locations
  if (exists(profilePath)) {
    await copyCookieStores(profilePath, dstProfile);
    await copyCookieStores(path.join(profilePath, 'Network'), path.join(dstProfile, 'Network'));
  }

  // Best-effort extras
  for (const extra of ['Preferences', 'Login Data', 'Secure Preferences']) {
    try { await fsp.copyFile(path.join(profilePath, extra), path.join(dstProfile, extra)); } catch {}
  }

  return {
    userDataDir: dstRoot,
    profileName,
    source: {
      root: profilePath,
      hasCookies: exists(path.join(profilePath, 'Cookies')),
      hasCookiesWal: exists(path.join(profilePath, 'Cookies-wal')),
      hasNetCookies: exists(path.join(profilePath, 'Network', 'Cookies')),
      hasNetCookiesWal: exists(path.join(profilePath, 'Network', 'Cookies-wal')),
    },
    cleanup: async () => { try { await rmrf(dstRoot); } catch {} }
  };
}

/* =========================
   Single attempt on a given profile
========================= */
async function tryProfileOnce(profileName, targetUrl) {
  const cloned = await cloneNamedProfileToTemp(profileName);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    executablePath: CHROME_PATH,
    userDataDir: cloned.userDataDir,
    args: [
      `--profile-directory=${profileName}`,
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

    // GAIA preflight through the LSA flow
    const GAIA_URL = 'https://accounts.google.com/ServiceLogin?service=adwords&continue=https://ads.google.com/localservicesads/';
    await gotoSoft(page, GAIA_URL, WAIT_UNTIL, NAV_TIMEOUT_MS);
    await sleep(600);

    // build a sequence of "touch" URLs; try caller's URL first
    const base = (targetUrl || LSA_URL);
    const touchUrls = [
      base,
      'https://ads.google.com/localservicesads/leads',
      'https://ads.google.com/localservicesads/accountpicker',
      // deep lead link (strong minting signal):
      'https://ads.google.com/localservices/lead?cid=1711176863&bid=2543314145&pid=9999999999&mcid=9121518467&euid=5170738981&lid=4823432947&hl=en&gl=US',
    ];

    let cookies = [];
    for (const u of touchUrls) {
      const urlWithBust = u + (u.includes('?') ? '&' : '?') + `t=${Date.now()}`;
      await gotoSoft(page, urlWithBust, WAIT_UNTIL, NAV_TIMEOUTMS); // typo fixed below
      await sleep(600);
      cookies = await waitForSID(page, 5000);
      if (hasAuthCookies(cookies)) break;
    }

    // still nothing? GAIA check + one last base hit
    if (!hasAuthCookies(cookies)) {
      const GAIA_CHECK = 'https://accounts.google.com/CheckCookie?continue=https://ads.google.com/localservicesads/';
      await gotoSoft(page, GAIA_CHECK, WAIT_UNTIL, NAV_TIMEOUT_MS);
      await sleep(500);
      const urlWithBust = base + (base.includes('?') ? '&' : '?') + `t=${Date.now()}`;
      await gotoSoft(page, urlWithBust, WAIT_UNTIL, NAV_TIMEOUT_MS);
      await sleep(600);
      cookies = await waitForSID(page, 6000);
    }

    const foundAuth = cookies
      .filter(c => ['SID','__Secure-1PSID','__Secure-3PSID','SAPISID','__Secure-1PAPISID','__Secure-3PAPISID'].includes(c.name))
      .map(c => c.name);

    const cookieHeader = cookies
      .filter(c => (c.domain || '').includes('google.com'))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    const origin = new URL(base).origin;
    const authHeader = buildSAPISIDHASH(cookies, origin);

    return {
      ok: Boolean(foundAuth.length || authHeader),
      cookies, cookieHeader, authHeader, origin, foundAuth,
      debug: {
        pickedProfile: profileName,
        source: cloned.source,
        sampleCookieNames: cookies.slice(0, 12).map(c => c.name)
      },
      _cleanup: cloned.cleanup
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      debug: { pickedProfile: profileName, source: cloned.source },
      _cleanup: cloned.cleanup
    };
  } finally {
    await browser.close();
  }
}

/* =========================
   Try multiple profiles until auth is found
========================= */
async function fetchFreshAuth(targetUrl, forcedProfile) {
  const tried = [];
  const candidates = forcedProfile ? [forcedProfile] : listCandidateProfiles();

  for (const candidate of candidates) {
    const attempt = await tryProfileOnce(candidate, targetUrl);
    tried.push({ profile: candidate, ok: attempt.ok, error: attempt.error, debug: attempt.debug });
    try { await attempt._cleanup(); } catch {}

    if (attempt.ok) {
      return {
        cookies: attempt.cookies,
        cookieHeader: attempt.cookieHeader,
        authHeader: attempt.authHeader,
        origin: attempt.origin,
        foundAuth: attempt.foundAuth,
        debug: { pickedProfile: candidate, tried }
      };
    }
  }

  // none worked
  return {
    cookies: [],
    cookieHeader: '',
    authHeader: '',
    origin: new URL(targetUrl || LSA_URL).origin,
    foundAuth: [],
    debug: { pickedProfile: candidates[candidates.length - 1], tried }
  };
}

/* =========================
   Routes
========================= */
app.get('/cookie', requireKey, async (req, res) => {
  try {
    const force   = ['1','true','yes'].includes(String(req.query.force || '').toLowerCase());
    const url     = req.query.url || LSA_URL;
    const profile = typeof req.query.profile === 'string' && req.query.profile.trim() ? req.query.profile.trim() : undefined;
    const verbose = ['1','true','yes'].includes(String(req.query.verbose || '').toLowerCase());

    if (!force && cache.cookieHeader && Date.now() < cache.expires && !profile) {
      return res.json({
        cookieHeader: cache.cookieHeader,
        authHeader:   cache.authHeader,
        origin:       new URL(url).origin,
        fromCache:    true,
        at:           new Date().toISOString()
      });
    }

    const { cookies, cookieHeader, authHeader, origin, foundAuth, debug } =
      await fetchFreshAuth(url, profile);

    cache = { cookieHeader, cookies, authHeader, expires: Date.now() + COOKIE_TTL_MS };

    res.json({
      cookieHeader,
      authHeader,
      origin,
      foundAuth,
      debug: verbose ? debug : { pickedProfile: debug.pickedProfile },
      fromCache: false,
      at: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/whoami', (_req, res) => {
  let resolvedProfile = PROFILE_NAME_PREFERRED;
  let resolvedPath = path.join(PROFILE_DIR, PROFILE_NAME_PREFERRED);
  for (const name of listCandidateProfiles()) {
    const full = path.join(PROFILE_DIR, name);
    if (dirHasCookieDb(full)) { resolvedProfile = name; resolvedPath = full; break; }
  }
  res.json({
    PROFILE_DIR,
    PROFILE_NAME_PREFERRED,
    resolvedProfile,
    resolvedPath,
    CHROME_PATH,
    WAIT_UNTIL,
    HEADLESS,
    hasCookiesDb: dirHasCookieDb(resolvedPath),
  });
});

app.get('/healthz', (_req, res) => res.send('ok'));

/* =========================
   Boot
========================= */
app.listen(PORT, () => console.log(`lsa-cookie listening on :${PORT}`));
