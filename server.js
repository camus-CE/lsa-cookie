const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 8080;

const PROFILE_DIR = process.env.PROFILE_DIR || '/config/profile';
const PROFILE_NAME = process.env.PROFILE_NAME || 'Default';

// guard against typos
const validWaits = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);
const DEFAULT_WAIT = 'domcontentloaded';
const envWait = (process.env.WAIT_UNTIL || DEFAULT_WAIT).toLowerCase();
const WAIT_UNTIL = validWaits.has(envWait) ? envWait : DEFAULT_WAIT;

// make the target configurable; default to account picker
const TARGET_URL =
  process.env.TARGET_URL || 'https://ads.google.com/localservices/accountpicker';

const COOKIE_TTL_MS = parseInt(process.env.COOKIE_TTL_MS || '3600000', 10); // 1h

let cache = { header: '', expires: 0 };

async function getCookieHeader() {
  if (cache.header && Date.now() < cache.expires) return cache.header;

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--profile-directory=${PROFILE_NAME}`,
    ],
  });

  try {
    const page = await ctx.newPage();
    await page.goto(TARGET_URL, { waitUntil: WAIT_UNTIL });

    // collect cookies after navigation (covers accounts.google.com redirects)
    const cookies = await ctx.cookies();

    const header = cookies
      .filter(c => (c.domain || '').includes('google.com'))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    cache = { header, expires: Date.now() + COOKIE_TTL_MS };
    return header;
  } finally {
    await ctx.close();
  }
}

app.get('/cookie', async (_req, res) => {
  try {
    const cookieHeader = await getCookieHeader();
    res.json({ cookieHeader });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`lsa-cookie on :${PORT}`));
