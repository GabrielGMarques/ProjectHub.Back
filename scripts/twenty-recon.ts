// Recon: open Twenty in headed mode, screenshot signup + dump form fields so we
// know what selectors to drive in the provisioning script.
import { chromium } from 'playwright';
import * as path from 'path';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const outDir = path.resolve(__dirname, 'twenty-recon-out');
  await import('fs/promises').then(fs => fs.mkdir(outDir, { recursive: true }));

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(outDir, '01-landing.png'), fullPage: true });
  console.log('URL after load:', page.url());
  console.log('Title:', await page.title());

  const html = await page.content();
  await import('fs/promises').then(fs =>
    fs.writeFile(path.join(outDir, '01-landing.html'), html, 'utf-8')
  );

  // Dump every input/button/link so we can see form structure
  const inputs = await page.$$eval('input, button, a', (els: any[]) =>
    els.map((el: any) => ({
      tag: el.tagName,
      type: el.type || null,
      name: el.name || null,
      placeholder: el.placeholder || null,
      text: el.textContent?.trim().slice(0, 80) || null,
      href: el.href || null,
      ariaLabel: el.getAttribute('aria-label'),
      dataTestId: el.getAttribute('data-testid'),
    }))
  );
  console.log(JSON.stringify(inputs, null, 2));

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
