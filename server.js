const express = require('express');
const axios = require('axios').default;
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

const BASE_URL = 'https://qpublic.schneidercorp.com/Application.aspx';
const SEARCH_URL =
  BASE_URL + '?App=PauldingCountyGA&Layer=Parcels&PageType=Search';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://qpublic.schneidercorp.com/',
  'Origin':  'https://qpublic.schneidercorp.com',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Upgrade-Insecure-Requests': '1',
};

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Property lookup ───────────────────────────────────────────────────────────
app.post('/api/property-lookup', async (req, res) => {
  const { streetNumber, streetName } = req.body;
  if (!streetNumber || !streetName) {
    return res.status(400).json({ error: 'streetNumber and streetName are required' });
  }

  console.log(`[lookup] "${streetNumber} ${streetName}"`);

  try {
    // Each request gets its own cookie jar so sessions don't bleed between calls
    const jar = new CookieJar();
    const client = wrapper(axios.create({ jar, headers: HEADERS }));

    // ── 1. Load the search page (establishes session + grabs ViewState) ───────
    const searchPage = await client.get(SEARCH_URL);
    const $s = cheerio.load(searchPage.data);

    const viewState          = $s('input[name="__VIEWSTATE"]').val() || '';
    const viewStateGen       = $s('input[name="__VIEWSTATEGENERATOR"]').val() || '';
    const eventValidation    = $s('input[name="__EVENTVALIDATION"]').val() || '';

    if (!viewState) {
      console.warn('[lookup] Could not find __VIEWSTATE — page structure may have changed');
    }

    // Find the street-number and street-name input names dynamically
    // (ASP.NET WebForms generates long IDs like ctl00_ContentPlaceHolder1_...)
    const stNoName   = findInputName($s, /stno|streetno|street_no|stnum/i)   || 'stno';
    const stNameName = findInputName($s, /stname|streetname|street_name/i)   || 'stname';
    const searchBtnName = findSubmitName($s) || 'btnSearch';

    console.log(`[lookup] form fields: stNo="${stNoName}" stName="${stNameName}" btn="${searchBtnName}"`);

    // ── 2. Submit the address search ──────────────────────────────────────────
    const formData = new URLSearchParams();
    formData.append('__VIEWSTATE',          viewState);
    formData.append('__VIEWSTATEGENERATOR', viewStateGen);
    formData.append('__EVENTVALIDATION',    eventValidation);
    formData.append(stNoName,   streetNumber);
    formData.append(stNameName, streetName);
    formData.append(searchBtnName, 'Search');

    const resultsPage = await client.post(SEARCH_URL, formData.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const $r = cheerio.load(resultsPage.data);

    // ── 3. Find the first result link ─────────────────────────────────────────
    const resultHref = findFirstResultHref($r);
    if (!resultHref) {
      return res.status(404).json({ error: 'No results found for this address.' });
    }

    const detailURL = resultHref.startsWith('http')
      ? resultHref
      : 'https://qpublic.schneidercorp.com/' + resultHref.replace(/^\//, '');

    console.log(`[lookup] detail URL: ${detailURL}`);

    // ── 4. Load the property detail page ─────────────────────────────────────
    const detailPage = await client.get(detailURL);
    const $d = cheerio.load(detailPage.data);

    const ownerName = scrapeLabel($d, /owner\s*name|owner/i);
    const yearBuilt = scrapeLabel($d, /year\s*built/i);

    if (!ownerName && !yearBuilt) {
      return res
        .status(404)
        .json({ error: 'Property found but data could not be read. The page layout may have changed.' });
    }

    console.log(`[lookup] owner="${ownerName}" yearBuilt="${yearBuilt}"`);
    res.json({ ownerName: ownerName || 'N/A', yearBuilt: yearBuilt || 'N/A' });
  } catch (err) {
    console.error('[lookup] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Find an <input> whose name or id matches a regex, return its `name` attribute */
function findInputName($, regex) {
  let found = null;
  $('input[type="text"], input:not([type])').each((_, el) => {
    const name = $(el).attr('name') || '';
    const id   = $(el).attr('id')   || '';
    if (regex.test(name) || regex.test(id)) { found = name; return false; }
  });
  return found;
}

/** Find the search submit button's name */
function findSubmitName($) {
  let found = null;
  $('input[type="submit"], button[type="submit"]').each((_, el) => {
    const val  = $(el).val()       || '';
    const name = $(el).attr('name') || '';
    const id   = $(el).attr('id')  || '';
    if (/search/i.test(val) || /search/i.test(name) || /search/i.test(id)) {
      found = name; return false;
    }
  });
  return found;
}

/** Find the first property-detail link in a results table */
function findFirstResultHref($) {
  // Schneider qpublic results are in a GridView table; skip the header row
  const candidates = [
    'table[id*="Grid"] tr:nth-child(2) a',
    'table[id*="Result"] tr:nth-child(2) a',
    'table[id*="Search"] tr:nth-child(2) a',
    '.SearchResults tr:nth-child(2) a',
    'a[href*="PageType=Detail"]',
    'a[href*="ParcelID"]',
    'a[href*="PIN="]',
  ];
  for (const sel of candidates) {
    const href = $(sel).first().attr('href');
    if (href) return href;
  }
  return null;
}

/** Search every table row for a cell whose text matches labelRegex; return the next cell's text */
function scrapeLabel($, labelRegex) {
  let value = null;
  $('tr').each((_, row) => {
    const cells = $(row).find('td, th');
    cells.each((i, cell) => {
      const text = $(cell).text().trim();
      if (labelRegex.test(text) && i < cells.length - 1) {
        const candidate = $(cells[i + 1]).text().trim().replace(/\s+/g, ' ');
        if (candidate) { value = candidate; return false; }
      }
    });
    if (value) return false;
  });
  return value;
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servpro property lookup server on port ${PORT}`);
});
