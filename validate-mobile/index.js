const fetch = require('node-fetch');

// Simple in-memory cache for validated numbers (expires after 5 minutes)
const validationCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

module.exports = async ({ req, res, log, error }) => {
  // Enable CORS
  res.headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.send('', 200);
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.json({ ok: false, error: 'Method not allowed' }, 405);
  }

  let channel;
  
  try {
    const body = req.body;
    
    if (!body) {
      return res.json({ ok: false, error: 'No request body' }, 400);
    }

    // Basic validation/sanitization
    let receiver = (body.receiver || '').replace(/\D/g, '');
    if (!receiver.startsWith('0')) {
      receiver = `0${receiver}`;
    }
    channel = body.channel;
    
    // Server-side constants (not from frontend for security)
    const currency = 'GHS';
    const accountnumber = process.env.MOOLRE_ACCOUNT_NUMBER || '752100407030';
    const type = 1;

    if (!receiver || !channel || ![1, 6, 7].includes(channel)) {
      return res.json({ ok: false, error: 'Invalid input' }, 400);
    }

    const apiUser = process.env.MOOLRE_API_USER;
    const apiKey = process.env.MOOLRE_API_KEY;
    if (!apiUser || !apiKey) {
      log('Missing API credentials');
      return res.json({ ok: false, error: 'Server not configured' }, 500);
    }

    // Check cache first
    const cacheKey = `${receiver}-${channel}`;
    const cached = validationCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      log(`Returning cached validation result for: ${receiver.substring(0, 3)}****${receiver.substring(7)}`);
      return res.json({ ok: true, data: cached.data, cached: true });
    }

    // Log request details for debugging
    log(`Moolre validation request: channel=${channel}, receiver=${receiver.substring(0, 3)}****${receiver.substring(7)}, currency=${currency}, type=${type}`);

    // Create timeout - Telecel gets longer timeout since it's slower
    const baseTimeoutMs = parseInt(process.env.MOOLRE_TIMEOUT_MS || '8000');
    const timeoutMs = channel === 6 ? Math.max(baseTimeoutMs, 45000) : baseTimeoutMs;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch('https://api.moolre.com/open/transact/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-USER': apiUser,
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify({
        type,
        receiver,
        channel,
        currency,
        accountnumber,
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // Handle response
    const responseText = await resp.text();
    let data = null;
    
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      error(`Non-JSON response from Moolre API: status=${resp.status}, response=${responseText.substring(0, 200)}`);
      return res.json({ 
        ok: false, 
        error: `API returned invalid response. Status: ${resp.status}` 
      }, resp.status);
    }

    if (!resp.ok) {
      return res.json({ ok: false, error: data?.message || 'Validation failed' }, resp.status);
    }

    // Cache successful validation results
    if (data && data.status === 1) {
      validationCache.set(cacheKey, { data, timestamp: Date.now() });
    }

    return res.json({ ok: true, data });

  } catch (err) {
    error(`Validate mobile error: ${err.message}`);
    
    if (err.name === 'AbortError') {
      error('Moolre API timeout - this may indicate slow API response or network issues');
      const isTelecel = channel === 6;
      const errorMessage = isTelecel 
        ? 'Telecel validation is taking longer than expected. Please try again or use MTN/AirtelTigo for faster validation.'
        : 'Validation service is currently slow. Please try again in a moment.';
      return res.json({ 
        ok: false, 
        error: errorMessage,
        isTelecelTimeout: isTelecel
      }, 408);
    }
    
    if (err.message.includes('fetch')) {
      return res.json({ ok: false, error: 'Network error' }, 503);
    }
    
    return res.json({ ok: false, error: 'Server error' }, 500);
  }
};
