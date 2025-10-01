const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 8080;
const PROFILE_DIR = process.env.PROFILE_DIR || '/config/profile';
const PROFILE_NAME = process.env.PROFILE_NAME || 'Default';
const WAIT_UNTIL = process.env.WAIT_UNTIL || 'domcontentloaded';
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

  const page = await ctx.newPage();
  await page.goto('https://ads.google.com/localservicesads/leads', { waitUntil: WAIT_UNTIL });
  const cookies = await ctx.cookies();
  await ctx.close();

  const header = cookies
    .filter(c => (c.domain || '').includes('google.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  cache = { header, expires: Date.now() + COOKIE_TTL_MS };
  return header;
}

app.get('/cookie', async (_req, res) => {
  try {
    const cookieHeader = await getCookieHeader();
    res.json({ cookieHeader });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// simple healthcheck
app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`lsa-cookie on :${PORT}`));
