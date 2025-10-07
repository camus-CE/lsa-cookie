// server.js
const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '256kb' }));

/* =========================
   ENV / Defaults
========================= */
const PORT = parseInt(process.env.PORT || '8080', 10);

// Root user-data dir that lsa-login also writes into
// e.g. chrome://version -> Profile Path: /config/.config/chromium/Default
const PROFILE_DIR  = process.env.PROFILE_DIR  || '/config/.config/chromium';
const PROFILE_NAME = process.env.PROFILE_NAME || 'Default';

const API_KEY = process.env.API_KEY || '';

const TARGET_URL =
  process.env.TARGET_URL ||
  'https://ads.google.com/localservices/accountpicker';

// Playwright: 'load' | 'domcontentloaded' | 'networkidle'
const WAIT_UNTIL_RAW = String(process.env.WAIT_UNTIL || 'networkidle').toLowerCase();
const WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle'].includes(WAIT_UNTIL_RAW)
  ? WAIT_UNTIL_RAW
  : 'networkidle';

const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '20000', 10);
const COOKIE_TTL_MS  = parseInt(process.env.COOKIE_TTL_MS  || '3600000', 10); // 1h cache
const HEADLESS = String(process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';

const SEED_FILE = process.env.SEED_FILE || '/config/seed-cookie.txt';

// in-memory cache and concurrency guard
let cache = { header: '', cookies: [], expires: 0 };
let inflight = null;

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
    promise.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); }
    );
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
        expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600, // seed 1 week
      };
    })
    .filter(Boolean);
}

function buildSAPISIDHASH(cookies, origin) {
  const get = n => cookies.find(c => c.name === n)?.value;
  const sapsid = get('SAPISID') || get('__Secure-3PAPISID') || get('__Secure-1PAPISID');
  if (!sapsid) return '';
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapsid} ${origin}`).digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

function cookieHeaderFrom(cookies) {
  return cookies
    .filter(c => (c.domain || '').includes('google.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/* =========================
   Profile repair / cleanup
========================= */
async function cleanupProfileLocks(root, profileName) {
  const P = path.join(root, profileName);
  const rm  = async p => fsp.rm(p, { force: true }).catch(() => {});
  const rmr = async p => fsp.rm(p, { recursive: true, force: true }).catch(() => {});
  await rm(path.join(P, 'LOCK'));
  await rm(path.join(P, 'SingletonCookie'));
  await rm(path.join(P, 'SingletonLock'));
  await rm(path.join(P, 'SingletonSocket'));
  // transient caches
  await rmr(path.join(P, 'Crashpad'));
  await rmr(path.join(P, 'Code Cache'));
  await rmr(path.join(P, 'GPUCache'));
  await rmr(path.join(P, 'ShaderCache'));
  await rmr(path.join(P, 'Service Worker', 'CacheStorage'));
  await rmr(path.join(P, 'Service Worker', 'ScriptCache'));
  await rmr(path.join(P, 'shared_proto_db'));
}

/* =========================
   Safe launch on temp clone
========================= */
async function cloneProfileToTemp(root, profileName) {
  const srcProfile = path.join(root, profileName);
  const dstRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lsa-ud-'));
  const dstProfile = path.join(dstRoot, profileName);

  await fsp.mkdir(dstProfile, { recursive: true });
  // copy "Local State" if present
  if (await pathExists(path.join(root, 'Local State'))) {
    await fsp.cp(path.join(root, 'Local State'), path.join(dstRoot, 'Local State')).catch(() => {});
  }

  // copy a small set of DBs that mint auth quickly (keeps copies light)
  const toCopy = [
    'Cookies', 'Cookies-wal', 'Cookies-shm',
    path.join('Network', 'Cookies'), path.join('Network', 'Cookies-wal'),
    'Preferences', 'Secure Preferences', 'Login Data',
  ];
  for (const rel of toCopy) {
    const src = path.join(srcProfile, rel);
    if (await pathExists(src)) {
      const dst = path.join(dstProfile, rel);
      await fsp.mkdir(path.dirname(dst), { recursive: true }).catch(() => {});
      await fsp.cp(src, dst).catch(() => {});
    }
  }

  return {
    userDataDir: dstRoot,
    cleanup: async () => { await fsp.rm(dstRoot, { recursive: true, force: true }).catch(() => {}); },
  };
}

/* =========================
   Core: fetch cookies (robust)
========================= */
async function getCookiesAndHeaderRaw(targetUrl, { useSeed = true, clear = false } = {}) {
  // Clean up stale lock files in the *source* profile to prevent weirdness
  await cleanupProfileLocks(PROFILE_DIR, PROFILE_NAME);

  // Work on a temp clone to avoid LevelDB "LOCK"/Singleton contention
  const clone = await cloneProfileToTemp(PROFILE_DIR, PROFILE_NAME);

  const ctx = await chromium.launchPersistentContext(clone.userDataDir, {
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
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

    const url = targetUrl || TARGET_URL;
    await withDeadline(
      page.goto(url, { waitUntil: WAIT_UNTIL, timeout: NAV_TIMEOUT_MS }),
      NAV_TIMEOUT_MS + 5000
    ).catch(() => { /* swallow; we can still read context cookies */ });

    const cookies = await ctx.cookies();
    const header = cookieHeaderFrom(cookies);
    return { header, cookies };
  } finally {
    await ctx.close().catch(() => {});
    await clone.cleanup().catch(() => {});
  }
}

/* Guarantee only one real launch at a time */
async function getCookiesAndHeader(targetUrl, opts) {
  // Use cache unless force was requested upstream
  if (!opts?.force && cache.header && Date.now() < cache.expires) {
    return { header: cache.header, cookies: cache.cookies, fromCache: true };
  }

  if (!inflight) {
    inflight = getCookiesAndHeaderRaw(targetUrl, opts)
      .then(({ header, cookies }) => {
        cache = { header, cookies, expires: Date.now() + COOKIE_TTL_MS };
        return { header, cookies, fromCache: false };
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/* =========================
   Routes
========================= */
app.get('/cookie', requireKey, async (req, res) => {
  try {
    const force   = ['1','true','yes'].includes(String(req.query.force || '').toLowerCase());
    const useSeed = !(['0','false','no'].includes(String(req.query.seed || '').toLowerCase()));
    const clear   = ['1','true','yes'].includes(String(req.query.clear || '').toLowerCase());

    const url    = req.query.url || TARGET_URL;
    const origin = req.query.origin || new URL(url).origin || 'https://ads.google.com';

    const { header, cookies, fromCache } =
      await getCookiesAndHeader(url, { force, useSeed, clear });

    const names = new Set(cookies.map(c => c.name));
    const hasSID = names.has('SID') || names.has('__Secure-1PSID') || names.has('__Secure-3PSID');
    const hasSAPISID =
      names.has('SAPISID') || names.has('__Secure-1PAPISID') || names.has('__Secure-3PAPISID');

    const authHeader = buildSAPISIDHASH(cookies, origin);

    res.json({
      cookieHeader: header,
      authHeader,
      origin,
      hasSID,
      hasSAPISID,
      needLogin: !(hasSID && hasSAPISID),
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

/* Seed cookie header */
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

/* Clear seed */
app.delete('/seed', requireKey, async (_req, res) => {
  await writeSeed('');
  cache = { header: '', cookies: [], expires: 0 };
  res.json({ ok: true });
});

/* One-click profile repair (no shell needed) */
app.post('/repair', requireKey, async (_req, res) => {
  try {
    await cleanupProfileLocks(PROFILE_DIR, PROFILE_NAME);
    res.json({ ok: true, cleaned: true, profile: path.join(PROFILE_DIR, PROFILE_NAME) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/healthz', (_req, res) => res.send('ok'));
app.listen(PORT, () => console.log(`lsa-cookie on :${PORT}`));
