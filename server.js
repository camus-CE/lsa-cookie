const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 8080;
const PROFILE_DIR = process.env.PROFILE_DIR || '/config/profile';
const PROFILE_NAME = process.env.PROFILE_NAME || 'Default';
const WAIT_UNTIL = process.env.WAIT_UNTIL || 'domcontentloaded';
const TARGET_URL = process.env.TARGET_URL || 'https://ads.google.com/localservices/accountpicker';
const COOKIE_TTL_MS = parseInt(process.env.COOKIE_TTL_MS || '3600000', 10); // 1h cache
const API_KEY = process.env.API_KEY || ''; // set this in Sliplane for protection
const SEED_FILE = process.env.SEED_FILE || '/config/seed-cookie.txt';

let cache = { header: '', expires: 0 };

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

async function readSeed() {
  try { return await fs.readFile(SEED_FILE, 'utf8'); } catch { return ''; }
}
async function writeSeed(v) {
  await fs.mkdir(path.dirname(SEED_FILE), { recursive: true });
  await fs.writeFile(SEED_FILE, v || '', 'utf8');
}

function parseCookieHeader(str) {
  // Convert "a=b; c=d; SID=..." into Playwright cookie objects for .google.com
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
        // Give seeded cookies a week horizon; Google may override them anyway.
        expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      };
    })
    .filter(Boolean);
}

async function getCookieHeader(targetUrl) {
  if (cache.header && Date.now() < cache.expires) return cache.header;

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', `--profile-directory=${PROFILE_NAME}`],
  });

  // If user seeded a cookie, pre-load it before navigation.
  const seeded = await readSeed();
  if (seeded) {
    const toSet = parseCookieHeader(seeded);
    if (toSet.length) await ctx.addCookies(toSet);
  }

  const page = await ctx.newPage();
  const url = targetUrl || TARGET_URL;
  await page.goto(url, { waitUntil: WAIT_UNTIL });

  const cookies = await ctx.cookies();
  await ctx.close();

  const header = cookies
    .filter(c => (c.domain || '').includes('google.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  cache = { header, expires: Date.now() + COOKIE_TTL_MS };
  return header;
}

app.get('/cookie', requireKey, async (req, res) => {
  try {
    const url = req.query.url || TARGET_URL;
    const cookieHeader = await getCookieHeader(url);
    res.json({ cookieHeader });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Seed / replace the cookie header the service will use.
app.post('/seed', requireKey, async (req, res) => {
  try {
    const { cookieHeader } = req.body || {};
    if (!cookieHeader || typeof cookieHeader !== 'string') {
      return res.status(400).json({ error: 'cookieHeader string required' });
    }
    await writeSeed(cookieHeader);
    cache = { header: '', expires: 0 }; // bust cache
    res.json({ ok: true, bytes: cookieHeader.length });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Clear seed
app.delete('/seed', requireKey, async (_req, res) => {
  await writeSeed('');
  cache = { header: '', expires: 0 };
  res.json({ ok: true });
});

// health
app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`lsa-cookie on :${PORT}`));
