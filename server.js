const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

const SEARCH_URL =
  'https://qpublic.schneidercorp.com/Application.aspx' +
  '?App=PauldingCountyGA&Layer=Parcels&PageType=Search';

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Debug: inspect search page form ──────────────────────────────────────────
app.get('/debug/form', async (_req, res) => {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 30_000 });

    // Return all inputs and their name/id/placeholder/type
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, select, textarea')).map(el => ({
        tag:  el.tagName,
        type: el.type,
        name: el.name,
        id:   el.id,
        placeholder: el.placeholder,
        value: el.value,
      }))
    );
    res.json({ url: page.url(), inputs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ── Property lookup ───────────────────────────────────────────────────────────
app.post('/api/property-lookup', async (req, res) => {
  const { streetNumber, streetName } = req.body;
  if (!streetNumber || !streetName) {
    return res.status(400).json({ error: 'streetNumber and streetName are required' });
  }

  console.log(`[lookup] "${streetNumber} ${streetName}"`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    // Hide webdriver flag
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();

    // ── 1. Load search page ───────────────────────────────────────────────────
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 30_000 });

    // ── 2. Fill full address into the single address field ────────────────────
    const fullAddress = `${streetNumber} ${streetName}`;
    await page.fill('#ctlBodyPane_ctl01_ctl01_txtAddress', fullAddress);

    // ── 3. Submit — try button first, fall back to Enter ─────────────────────
    const searchBtn = await findInput(page, [
      '#ctlBodyPane_ctl01_ctl01_btnSearch',
      'input[id*="ctl01"][value*="Search" i]',
      'button[id*="ctl01"]:has-text("Search")',
      'input[value="Search" i]',
      'button:has-text("Search")',
    ]);
    if (searchBtn) {
      await searchBtn.click();
    } else {
      await page.locator('#ctlBodyPane_ctl01_ctl01_txtAddress').press('Enter');
    }
    await page.waitForLoadState('networkidle', { timeout: 20_000 });

    // ── 5. Click first result ─────────────────────────────────────────────────
    const resultLink = await findInput(page, [
      'table[id*="Grid"] tr:nth-child(2) a',
      'table[id*="Result"] tr:nth-child(2) a',
      'table[id*="Search"] tr:nth-child(2) a',
      '.SearchResults tr:nth-child(2) a',
      'a[href*="PageType=Detail"]',
      'a[href*="ParcelID"]',
    ]);

    if (!resultLink) {
      return res.status(404).json({ error: 'No results found for this address.' });
    }

    await resultLink.click();
    await page.waitForLoadState('networkidle', { timeout: 20_000 });

    // ── 6. Scrape owner & year built ──────────────────────────────────────────
    const ownerName = await scrapeLabel(page, /owner\s*name|owner/i);
    const yearBuilt = await scrapeLabel(page, /year\s*built/i);

    if (!ownerName && !yearBuilt) {
      return res.status(404).json({ error: 'Property found but data could not be read.' });
    }

    console.log(`[lookup] owner="${ownerName}" yearBuilt="${yearBuilt}"`);
    res.json({ ownerName: ownerName || 'N/A', yearBuilt: yearBuilt || 'N/A' });

  } catch (err) {
    console.error('[lookup] error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findInput(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) return loc;
    } catch (_) {}
  }
  return null;
}

async function scrapeLabel(page, labelRegex) {
  const rows = page.locator('tr');
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const cells = rows.nth(i).locator('td, th');
    const cellCount = await cells.count();
    for (let c = 0; c < cellCount - 1; c++) {
      const text = ((await cells.nth(c).textContent()) || '').trim();
      if (labelRegex.test(text)) {
        const val = ((await cells.nth(c + 1).textContent()) || '').trim().replace(/\s+/g, ' ');
        if (val) return val;
      }
    }
  }
  return null;
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servpro property lookup server on port ${PORT}`);
});
