// server.js (lsa-cookie)
const { chromium } = require('playwright');

const USER_DATA_DIR = process.env.PROFILE_DIR || '/config/.config/chromium';
const PROFILE_NAME  = process.env.PROFILE_NAME || 'Default';
const TARGET_URL    = process.env.TARGET_URL || 'https://ads.google.com/localservicesads/';
const WAIT_UNTIL    = process.env.WAIT_UNTIL || 'networkidle';

const launch = async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    args: [
      `--profile-directory=${PROFILE_NAME}`,
      '--password-store=basic',
      '--use-mock-keychain',
    ],
  });

  const page = await ctx.newPage();
  await page.goto(TARGET_URL, { waitUntil: WAIT_UNTIL });

  // visiting LSA ensures SIDTS/PSIDTS refresh
  await page.waitForTimeout(1500);

  const cookies = await ctx.cookies(); // full set from .google.com / accounts.google.com
  // ... filter/serialize as needed
  return { ctx, cookies };
};
