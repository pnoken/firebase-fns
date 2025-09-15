module.exports = async (context) => {
  const { req, res, log, error } = context;
  
  // Set CORS headers for all responses
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400'
  };
  
  try {
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return res.send('', 200, corsHeaders);
    }

    // Only allow POST requests
    if (req.method !== 'POST') {
      return res.json({ ok: false, error: 'Method not allowed' }, 405, corsHeaders);
    }

    log('Processing POST request');
    
    const body = req.body;
    log('Request body:', JSON.stringify(body));
    
    if (!body) {
      return res.json({ ok: false, error: 'No request body' }, 400, corsHeaders);
    }

    // Basic validation/sanitization
    let receiver = (body.receiver || '').replace(/\D/g, '');
    if (!receiver.startsWith('0')) {
      receiver = `0${receiver}`;
    }
    const channel = body.channel;
    
    log(`Processing: receiver=${receiver}, channel=${channel}`);

    if (!receiver || !channel || ![1, 6, 7].includes(channel)) {
      return res.json({ ok: false, error: 'Invalid input' }, 400, corsHeaders);
    }

    // Server-side constants (not from frontend for security)
    const currency = 'GHS';
    const accountnumber = process.env.MOOLRE_ACCOUNT_NUMBER || '752100407030';
    const type = 1;

    const apiUser = process.env.MOOLRE_API_USER;
    const apiKey = process.env.MOOLRE_API_KEY;
    
    log(`API credentials: user=${!!apiUser}, key=${!!apiKey}`);
    
    if (!apiUser || !apiKey) {
      log('Missing API credentials');
      return res.json({ ok: false, error: 'Server not configured' }, 500, corsHeaders);
    }

    log('Making request to Moolre API');
    
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

    log(`Moolre API response: status=${resp.status}`);

    // Handle response
    const responseText = await resp.text();
    let data = null;
    
    try {
      data = JSON.parse(responseText);
      log('Parsed response:', JSON.stringify(data));
    } catch (parseError) {
      log('Non-JSON response:', responseText.substring(0, 200));
      return res.json({ 
        ok: false, 
        error: `API returned invalid response. Status: ${resp.status}` 
      }, resp.status, corsHeaders);
    }

    if (!resp.ok) {
      return res.json({ ok: false, error: data?.message || 'Validation failed' }, resp.status, corsHeaders);
    }

    log('Returning successful response');
    return res.json({ ok: true, data }, 200, corsHeaders);

  } catch (err) {
    error(`Function error: ${err.message}`);
    
    if (err.name === 'AbortError') {
      error('Moolre API timeout');
      const isTelecel = req.body?.channel === 6;
      const errorMessage = isTelecel 
        ? 'Telecel validation is taking longer than expected. Please try again or use MTN/AirtelTigo for faster validation.'
        : 'Validation service is currently slow. Please try again in a moment.';
      return res.json({ 
        ok: false, 
        error: errorMessage,
        isTelecelTimeout: isTelecel
      }, 408, corsHeaders);
    }
    
    if (err.message.includes('fetch')) {
      return res.json({ ok: false, error: 'Network error' }, 503, corsHeaders);
    }
    
    return res.json({ ok: false, error: 'Server error' }, 500, corsHeaders);
  }
};