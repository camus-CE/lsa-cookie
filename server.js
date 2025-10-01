const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 8080;
const PROFILE_DIR = process.env.PROFILE_DIR || '/config/profile';
const PROFILE_NAME = process.env.PROFILE_NAME || 'Default';
const WAIT_UNTIL = process.env.WAIT_UNTIL || 'domcontentloaded';
const TARGET_URL = process.env.TARGET_URL || 'https://ads.google.com/localservices/accountpicker';
const COOKIE_TTL_MS = parseInt(process.env.COOKIE_TTL_MS || '3600000', 10);
const API_KEY = process.env.API_KEY || '';
const SEED_FILE = process.env.SEED_FILE || '/config/seed-cookie.txt';

let cache = { header: '', cookies: [], expires: 0 };

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

async function readSeed() { try { return await fs.readFile(SEED_FILE, 'utf8'); } catch { return ''; } }
async function writeSeed(v) {
  await fs.mkdir(path.dirname(SEED_FILE), { recursive: true });
  await fs.writeFile(SEED_FILE, v || '', 'utf8');
}

function parseCookieHeader(str) {
  return (str || '').split(/;\s*/).map(kv => {
    const i = kv.indexOf('='); if (i < 0) return null;
    const name = kv.slice(0, i).trim(); const value = kv.slice(i + 1).trim();
    if (!name) return null;
    return {
      name, value, domain: '.google.com', path: '/',
      secure: true, httpOnly: true, sameSite: 'Lax',
      expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    };
  }).filter(Boolean);
}

function buildSAPISIDHASH(cookies, origin) {
  const c = n => cookies.find(x => x.name === n)?.value;
  const sapsid = c('SAPISID') || c('__Secure-3PAPISID') || c('__Secure-1PAPISID');
  if (!sapsid) return '';
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapsid} ${origin}`).digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

async function getCookiesAndHeader(targetUrl, { force=false, useSeed=true, clear=false } = {}) {
  if (!force && cache.header && Date.now() < cache.expires) {
    return { header: cache.header, cookies: cache.cookies, fromCache: true };
  }

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', `--profile-directory=${PROFILE_NAME}`],
  });

  if (clear) {
    try { await ctx.clearCookies(); } catch {}
  }

  if (useSeed) {
    const seeded = await readSeed();
    const toSet = parseCookieHeader(seeded);
    if (toSet.length) await ctx.addCookies(toSet);
  }

  const page = await ctx.newPage();
  await page.goto(targetUrl || TARGET_URL, { waitUntil: WAIT_UNTIL });

  const cookies = await ctx.cookies();
  await ctx.close();

  const header = cookies
    .filter(c => (c.domain || '').includes('google.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  cache = { header, cookies, expires: Date.now() + COOKIE_TTL_MS };
  return { header, cookies, fromCache: false };
}

app.get('/cookie', requireKey, async (req, res) => {
  try {
    const force = ['1','true','yes'].includes(String(req.query.force || '').toLowerCase());
    const useSeed = !(['0','false','no'].includes(String(req.query.seed || '').toLowerCase()));
    const clear = ['1','true','yes'].includes(String(req.query.clear || '').toLowerCase());

    const url = req.query.url || TARGET_URL;
    const origin = req.query.origin || new URL(url).origin || 'https://ads.google.com';

    const { header, cookies, fromCache } =
      await getCookiesAndHeader(url, { force, useSeed, clear });

    const authHeader = buildSAPISIDHASH(cookies, origin);

    res.json({
      cookieHeader: header,
      authHeader,
      origin,
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
