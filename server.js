const express = require('express');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.RENTCAST_API_KEY;

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Property lookup via Rentcast ──────────────────────────────────────────────
app.post('/api/property-lookup', async (req, res) => {
  const { streetAddress, city, state, zip } = req.body;
  if (!streetAddress) {
    return res.status(400).json({ error: 'streetAddress is required' });
  }
  if (!API_KEY) {
    return res.status(500).json({ error: 'RENTCAST_API_KEY environment variable not set' });
  }

  console.log(`[lookup] ${streetAddress}, ${city}, ${state} ${zip}`);

  try {
    const { data } = await axios.get('https://api.rentcast.io/v1/properties', {
      headers: { 'X-Api-Key': API_KEY },
      params:  { address: streetAddress, city, state, zipCode: zip },
      timeout: 15_000,
    });

    const yearBuilt = data.yearBuilt ?? data[0]?.yearBuilt;

    if (!yearBuilt) {
      return res.status(404).json({ error: 'Property not found or year built unavailable.' });
    }

    console.log(`[lookup] yearBuilt=${yearBuilt}`);
    res.json({ yearBuilt: String(yearBuilt) });

  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.message || err.message;
    console.error(`[lookup] error ${status}:`, message);

    if (status === 404) {
      return res.status(404).json({ error: 'Property not found.' });
    }
    res.status(500).json({ error: message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
