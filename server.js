const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Property lookup ───────────────────────────────────────────────────────────
app.post('/api/property-lookup', async (req, res) => {
  const { streetNumber, streetName } = req.body;

  if (!streetNumber || !streetName) {
    return res.status(400).json({ error: 'streetNumber and streetName are required' });
  }

  console.log(`[lookup] ${streetNumber} ${streetName}`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // ── 1. Navigate to search page ────────────────────────────────────────────
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx' +
        '?App=PauldingCountyGA&Layer=Parcels&PageType=Search',
      { waitUntil: 'networkidle', timeout: 30_000 }
    );

    // ── 2. Fill street number ─────────────────────────────────────────────────
    const stNoInput = await findInput(page, [
      '[id*="txtStNo"]',
      '[id*="StNo"]',
      '[name*="stno" i]',
      'input[placeholder*="number" i]',
    ]);
    if (!stNoInput) {
      // Last resort: label-based
      await page.getByLabel(/street\s*#|street\s*no|house\s*no/i).first().fill(streetNumber);
    } else {
      await stNoInput.fill(streetNumber);
    }

    // ── 3. Fill street name ───────────────────────────────────────────────────
    const stNameInput = await findInput(page, [
      '[id*="txtStName"]',
      '[id*="StName"]',
      '[name*="stname" i]',
      'input[placeholder*="street name" i]',
    ]);
    if (!stNameInput) {
      await page.getByLabel(/street\s*name/i).first().fill(streetName);
    } else {
      await stNameInput.fill(streetName);
    }

    // ── 4. Submit the search form ─────────────────────────────────────────────
    const searchBtn = await findInput(page, [
      'input[value="Search" i]',
      'button:has-text("Search")',
      '[id*="btnSearch"]',
      '[id*="cmdSearch"]',
    ]);
    if (searchBtn) {
      await searchBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForLoadState('networkidle', { timeout: 20_000 });

    // ── 5. Click the first result ─────────────────────────────────────────────
    const resultLink = await findInput(page, [
      // Schneider qpublic result tables typically have links in the second+ rows
      'table[id*="Grid"] tr:nth-child(2) a',
      'table[id*="Result"] tr:nth-child(2) a',
      'table[id*="Search"] tr:nth-child(2) a',
      '.SearchResults tr:nth-child(2) a',
      // Fallback: any detail/parcel link
      'a[href*="PageType=Detail"]',
      'a[href*="ParcelID"]',
      'a[href*="PIN="]',
    ]);

    if (!resultLink) {
      return res.status(404).json({ error: 'No results found for this address.' });
    }

    await resultLink.click();
    await page.waitForLoadState('networkidle', { timeout: 20_000 });

    // ── 6. Scrape owner name & year built ─────────────────────────────────────
    const ownerName = await scrapeFieldByLabel(page, /owner\s*name|owner/i);
    const yearBuilt = await scrapeFieldByLabel(page, /year\s*built/i);

    if (!ownerName && !yearBuilt) {
      return res.status(404).json({ error: 'Property detail found but data could not be read.' });
    }

    console.log(`[lookup] owner="${ownerName}" yearBuilt="${yearBuilt}"`);
    res.json({
      ownerName: ownerName || 'N/A',
      yearBuilt: yearBuilt || 'N/A',
    });
  } catch (err) {
    console.error('[lookup] error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Try each selector in order and return the first matching Locator, or null.
 */
async function findInput(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) return loc;
    } catch (_) {
      // selector may throw if syntax is invalid on this page — skip
    }
  }
  return null;
}

/**
 * Search every <tr> for a cell whose text matches labelRegex.
 * If found, return the trimmed text of the NEXT sibling <td>.
 * Also handles <th>/<td> label-value pairs in the same row.
 */
async function scrapeFieldByLabel(page, labelRegex) {
  // Strategy 1: rows where first cell is the label
  const rows = page.locator('tr');
  const rowCount = await rows.count();

  for (let i = 0; i < rowCount; i++) {
    const cells = rows.nth(i).locator('th, td');
    const cellCount = await cells.count();
    for (let c = 0; c < cellCount - 1; c++) {
      const labelText = (await cells.nth(c).textContent()) || '';
      if (labelRegex.test(labelText.trim())) {
        const value = (await cells.nth(c + 1).textContent()) || '';
        const cleaned = value.trim().replace(/\s+/g, ' ');
        if (cleaned) return cleaned;
      }
    }
  }

  // Strategy 2: look for a <span> or <div> that directly follows a label element
  const labelEls = page.locator(`td, th, span, div, label`);
  const labelCount = await labelEls.count();
  for (let i = 0; i < labelCount; i++) {
    const text = (await labelEls.nth(i).textContent()) || '';
    if (labelRegex.test(text.trim())) {
      // Try the immediately following sibling
      const sibling = labelEls.nth(i + 1);
      if ((await sibling.count()) > 0) {
        const val = ((await sibling.textContent()) || '').trim().replace(/\s+/g, ' ');
        if (val) return val;
      }
    }
  }

  return null;
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servpro property lookup server listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
