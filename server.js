const express = require('express');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Property lookup via Zillow ────────────────────────────────────────────────
app.post('/api/property-lookup', async (req, res) => {
  const { streetAddress, city, state, zip } = req.body;
  if (!streetAddress) {
    return res.status(400).json({ error: 'streetAddress is required' });
  }

  // Build Zillow search URL
  const query = [streetAddress, city, state, zip].filter(Boolean).join(', ');
  const slug  = query.replace(/[^\w\s]/g, '').replace(/\s+/g, '-');
  const url   = `https://www.zillow.com/homes/${slug}_rb/`;
  console.log(`[lookup] ${query} → ${url}`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(3000);

    // Zillow embeds all property data in a <script id="__NEXT_DATA__"> tag
    const yearBuilt = await page.evaluate(() => {
      try {
        const el = document.getElementById('__NEXT_DATA__');
        if (!el) return null;
        const json = JSON.parse(el.textContent);

        // Walk the tree — yearBuilt can be nested a few levels deep
        const str = JSON.stringify(json);
        const match = str.match(/"yearBuilt"\s*:\s*(\d{4})/);
        return match ? match[1] : null;
      } catch (_) {
        return null;
      }
    });

    if (!yearBuilt) {
      return res.status(404).json({ error: 'Property not found on Zillow or year built unavailable.' });
    }

    console.log(`[lookup] yearBuilt=${yearBuilt}`);
    res.json({ yearBuilt });

  } catch (err) {
    console.error('[lookup] error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
