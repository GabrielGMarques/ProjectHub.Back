// Provision a Twenty workspace (signup as admin) and generate an API key.
// Prints the API key to stdout on success. Idempotent — if the email already
// exists, falls through to sign-in.
//
// Used as the basis for the production per-company provisioning service
// (see backend/src/services/twenty.service.ts).
import { chromium, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';

const BASE_URL = process.env.TWENTY_BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.TWENTY_EMAIL || 'admin@projectshub.local';
const PASSWORD = process.env.TWENTY_PASSWORD || 'ProjectsHub!2026';
const KEY_NAME = process.env.TWENTY_KEY_NAME || `projectshub-${Date.now()}`;
const HEADLESS = process.env.HEADLESS !== '0';
const OUT_DIR = path.resolve(__dirname, 'twenty-recon-out');

async function shot(page: Page, name: string) {
  try {
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false, timeout: 10000, animations: 'disabled' });
  } catch (e: any) {
    console.log(`[shot:${name}] screenshot failed: ${e.message}`);
  }
}

async function dumpInteractives(page: Page, label: string) {
  const items = await page.$$eval('button, a, input, [role="button"]', (els: any[]) =>
    els.map((el: any) => ({
      tag: el.tagName,
      type: el.type || null,
      text: (el.textContent || '').trim().slice(0, 80) || null,
      placeholder: el.placeholder || null,
      href: el.href || null,
      ariaLabel: el.getAttribute('aria-label'),
      dataTestId: el.getAttribute('data-testid'),
      visible: !!(el.offsetParent),
      disabled: el.disabled === true,
    })).filter(x => x.visible)
  );
  console.log(`[dump:${label}]`, JSON.stringify(items, null, 2));
}

/** Click the auth-modal submit button and wait until the modal is gone OR an error appears. */
async function submitAuthStep(page: Page, step: string): Promise<void> {
  const before = await page.locator('text=Welcome to your workspace').count();
  await page.locator('form button[type="submit"]:not([disabled])').first().click();
  // Wait up to 15s for state transition
  const result = await Promise.race([
    page.locator('text=Welcome to your workspace').waitFor({ state: 'hidden', timeout: 15000 })
      .then(() => 'modal-gone'),
    page.locator('[role="alert"], .error, [data-testid*="error"]').first()
      .waitFor({ state: 'visible', timeout: 15000 }).then(() => 'error'),
    page.waitForURL(u => !/welcome/i.test(u.toString()) && !/sign[-_]?(up|in)/i.test(u.toString()), { timeout: 15000 })
      .then(() => 'url-change'),
  ]).catch(() => 'timeout');
  console.log(`[${step}] submit result: ${result}, modal-before=${before}, url=${page.url()}`);
  if (result === 'timeout' || result === 'error') {
    const err = await page.locator('[role="alert"], .error').allTextContents().catch(() => []);
    console.error(`[${step}] auth submit did not advance. Errors on page:`, err);
    throw new Error(`auth step "${step}" stalled`);
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 1. Land on / — auth modal should appear
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /continue with email/i }).waitFor({ state: 'visible', timeout: 30_000 });
  await shot(page, '40-landing');
  await page.getByRole('button', { name: /continue with email/i }).click();
  await page.waitForTimeout(1500);
  await shot(page, '41-email-step');
  await dumpInteractives(page, '41-email-step');

  // 2. Email step — try multiple selectors
  const emailLoc = page.locator('input[type="email"], input[name="email"], input[autocomplete="email"], input[placeholder*="mail" i]').first();
  await emailLoc.waitFor({ state: 'visible', timeout: 10_000 });
  await emailLoc.fill(EMAIL);
  await shot(page, '41b-email-filled');
  await page.locator('form button[type="submit"]:not([disabled]), button:has-text("Continue"):not([disabled]), button:has-text("Next"):not([disabled])').first().click();
  await page.waitForTimeout(1500);
  await shot(page, '42-password-step');
  await page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 10_000 });

  // 3. Password step → submit. Modal should vanish.
  await page.locator('input[type="password"]').fill(PASSWORD);
  await shot(page, '43-password-filled');
  await submitAuthStep(page, 'password');
  await shot(page, '44-after-password');

  // 4. Onboarding wizard — click any "Continue / Skip / Continue without sync" until we leave the wizard.
  for (let i = 0; i < 12; i++) {
    const url = page.url();
    if (!/welcome|create|invite|onboard|sync\/|settings\/sync/i.test(url) && !/^https?:\/\/app\./i.test(url)) {
      console.log(`[onboard] reached app at ${url}`);
      break;
    }
    // Prefer "Continue without sync" / "Skip" over "Continue" (which advances vs skips)
    let btn = page.locator('a:has-text("Continue without sync"), button:has-text("Continue without sync"), button:has-text("Skip"), a:has-text("Skip")').first();
    if (await btn.count() === 0) {
      btn = page.locator('form button[type="submit"]:not([disabled]), button:has-text("Continue"):not([disabled]), button:has-text("Next"):not([disabled]), button:has-text("Finish"):not([disabled])').first();
    }
    if (await btn.count() === 0) {
      console.log('[onboard] no advance button visible — checking inputs');
      // Wizard may need text input (workspace name, first name, etc.). Fill any visible empty text input with a placeholder.
      const inputs = page.locator('input[type="text"]:visible, input:not([type]):visible');
      const n = await inputs.count();
      for (let j = 0; j < n; j++) {
        const inp = inputs.nth(j);
        if (await inp.inputValue() === '') {
          const ph = (await inp.getAttribute('placeholder')) || '';
          const val = /workspace|company|organization/i.test(ph) ? 'ProjectsHub'
            : /first/i.test(ph) ? 'Admin'
            : /last/i.test(ph) ? 'ProjectsHub'
            : 'ProjectsHub';
          await inp.fill(val);
        }
      }
      // try once more for a button now that inputs are filled
      const btn2 = page.locator('button[type="submit"]:not([disabled]), button:not([disabled])').first();
      if (await btn2.count() === 0) {
        console.log('[onboard] still no button — bailing out of onboarding loop');
        break;
      }
      await btn2.click({ timeout: 3000 }).catch(() => null);
    } else {
      await btn.click({ timeout: 3000 }).catch(() => null);
    }
    await page.waitForTimeout(1500);
    await shot(page, `45-onboard-${i}`);
  }

  // 5. Capture current workspace origin (Twenty uses <workspace>.localhost subdomains)
  const currentOrigin = new URL(page.url()).origin;
  console.log(`[origin] workspace origin = ${currentOrigin}`);

  // Open Settings → APIs & Webhooks
  // Note: bare /settings redirects back to main app; need a real sub-page first.
  await page.goto(`${currentOrigin}/settings/profile`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await shot(page, '49-settings');
  await dumpInteractives(page, 'settings-sidebar');
  const apiLink = page.locator('a:has-text("APIs"), a:has-text("Webhooks"), a:has-text("API"), [href*="settings/integrations"], [href*="settings/developers"], [href*="api-keys"], [href*="apis-and-webhooks"]').first();
  await apiLink.click({ timeout: 15_000 });
  await page.waitForTimeout(2500);
  await shot(page, '50-api-keys-page');
  await dumpInteractives(page, 'api-keys-page');

  // The page may have rendered before the click landed us on api-webhooks. Force-navigate.
  await page.goto(`${currentOrigin}/settings/api-webhooks`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await shot(page, '50b-api-webhooks');

  // Click "Create API key" — must be exact to avoid matching "New" badges in sidebar
  const createBtn = page.locator('button:has-text("Create API key"), a:has-text("Create API key")').first();
  await createBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await createBtn.click();
  await page.waitForTimeout(2500);
  await shot(page, '51-create-key-form');
  await dumpInteractives(page, 'create-key-form');

  // Fill name (placeholder is "E.g. backoffice integration") + save
  const nameInput = page.locator('input[placeholder*="integration" i], input[placeholder*="E.g." i], input[type="text"]').first();
  await nameInput.waitFor({ state: 'visible', timeout: 10_000 });
  await nameInput.fill(KEY_NAME);
  await page.waitForTimeout(500);
  await shot(page, '51b-name-filled');
  const saveBtn = page.locator('button:has-text("Save"):not([disabled]), button:has-text("Create"):not([disabled]), button:has-text("Generate"):not([disabled]), button[type="submit"]:not([disabled])').first();
  if (await saveBtn.count() > 0) {
    await saveBtn.click();
    await page.waitForTimeout(2500);
    await shot(page, '52-key-displayed');
  }

  // Find the JWT/API-key on the page
  await dumpInteractives(page, 'key-displayed');
  const key = await page.evaluate(() => {
    const re = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;
    const text = (globalThis as any).document.body.innerText as string;
    const m = text.match(re);
    if (m) return m[0];
    const inputs = Array.from((globalThis as any).document.querySelectorAll('input,textarea')) as any[];
    for (const i of inputs) {
      if (i.value && re.test(i.value)) return i.value.match(re)[0];
    }
    return null;
  });
  if (!key) {
    console.error('[twenty] could not find API key on page. Check 52-key-displayed.png');
    await browser.close();
    process.exit(2);
  }
  console.log(`\n==== API KEY ====\nTWENTY_API_KEY=${key}\n=================\n`);
  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
