/**
 * VL TradingView Bridge - Background Script
 *
 * Intercepts VolumeLeaders.com API responses to capture trade level data,
 * stores them, and makes them available to TradingView content scripts.
 */

// 🔧 Configuration
const VL_API_PATTERNS = [
  '*://*.volumeleaders.com/TradeLevels/*',
  '*://volumeleaders.com/TradeLevels/*',
  '*://*.volumeleaders.com/api/*',
  '*://volumeleaders.com/api/*'
];

// 📦 State
let tradeLevels = new Map(); // symbol -> levels[]
let debugMode = true; // Log all intercepted requests initially

/**
 * Initialize extension
 */
async function init() {
  console.log('🚀 VL-TV Bridge: Background script loaded');

  // Load saved levels from storage
  const stored = await browser.storage.local.get('tradeLevels');
  if (stored.tradeLevels) {
    tradeLevels = new Map(Object.entries(stored.tradeLevels));
    console.log('📂 Loaded saved levels:', tradeLevels);
  }

  // Set up API interception
  setupInterception();

  // Listen for messages from content scripts
  browser.runtime.onMessage.addListener(handleMessage);
}

/**
 * Set up webRequest interception for VL API
 */
function setupInterception() {
  browser.webRequest.onBeforeRequest.addListener(
    interceptRequest,
    { urls: VL_API_PATTERNS },
    ['blocking']
  );

  console.log('🎯 Intercepting:', VL_API_PATTERNS);
}

/**
 * Intercept and process VL API responses
 */
function interceptRequest(details) {
  // Only intercept GET requests for API data
  if (details.method !== 'GET') return {};

  const filter = browser.webRequest.filterResponseData(details.requestId);
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();

  let responseData = '';

  filter.ondata = (event) => {
    const chunk = decoder.decode(event.data, { stream: true });
    responseData += chunk;
    filter.write(event.data); // Pass through unchanged
  };

  filter.onstop = () => {
    // Flush remaining data
    responseData += decoder.decode();
    filter.close();

    // Process the complete response
    processApiResponse(details.url, responseData);
  };

  filter.onerror = () => {
    console.error('❌ Filter error for:', details.url);
  };

  return {};
}

/**
 * Process intercepted API response - discover structure and extract levels
 */
function processApiResponse(url, data) {
  if (debugMode) {
    console.log('📡 VL API (intercepted):', url);
  }

  try {
    const json = JSON.parse(data);

    if (debugMode) {
      console.log('📦 Response structure:', summarizeObject(json));
    }

    // VL TradeLevels API returns { data: [...] }
    if (json.data && Array.isArray(json.data) && json.data.length > 0) {
      // Check if it looks like VL trade level data
      const firstItem = json.data[0];
      if (firstItem.Ticker && firstItem.Price !== undefined) {
        console.log('🎯 Intercepted VL TradeLevels:', json.data.length, 'items');
        extractLevels(url, json.data);
        return; // Don't process further
      }
    }

    // For other API responses, just log in debug mode
    if (debugMode) {
      console.log('📄 Non-TradeLevels response, ignoring');
    }

  } catch (e) {
    // Not JSON, ignore
    if (debugMode && data.length < 1000) {
      console.log('📄 Non-JSON response:', data.substring(0, 200));
    }
  }
}

/**
 * Recursively search for price/level data in response
 */
function findPriceLevels(obj, url, path = '') {
  if (!obj || typeof obj !== 'object') return;

  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();

    // Check if this key suggests price data
    if (keyLower.includes('level') || keyLower.includes('price') || keyLower.includes('trade')) {
      if (Array.isArray(value) && value.length > 0) {
        console.log(`🔍 Found ${key} at ${path}.${key}:`, value.length, 'items');
        if (typeof value[0] === 'object') {
          console.log('📋 Sample:', JSON.stringify(value[0], null, 2));
        }
      } else if (typeof value === 'number') {
        console.log(`💰 Found price ${path}.${key}:`, value);
      }
    }

    // Recurse into objects/arrays
    if (typeof value === 'object' && value !== null) {
      findPriceLevels(value, url, `${path}.${key}`);
    }
  }
}

/**
 * Extract and store trade levels from VolumeLeaders API response
 *
 * VL API structure:
 * {
 *   "data": [{
 *     "Ticker": "CRDO",
 *     "Price": 150.9,
 *     "Dollars": 1629675136.36,
 *     "Volume": 10803273,
 *     "Trades": 60,
 *     "TradeLevelRank": 1,
 *     "Dates": "2025-09-24 - 2025-11-25",
 *     ...
 *   }]
 * }
 */
function extractLevels(url, items) {
  // Try to determine symbol from URL or item data
  const urlSymbol = extractSymbolFromUrl(url);

  for (const item of items) {
    // VL uses "Ticker" (capitalized), fallback to other common names
    const symbol = (item.Ticker || item.ticker || item.symbol || urlSymbol || 'UNKNOWN').toUpperCase();

    // VL uses "Price" (capitalized)
    const price = item.Price || item.price || item.level || item.tradeLevel;

    if (price && typeof price === 'number') {
      if (!tradeLevels.has(symbol)) {
        tradeLevels.set(symbol, []);
      }

      const level = {
        price,
        symbol,
        // VL-specific enrichment
        rank: item.TradeLevelRank || item.rank,
        dollars: item.Dollars || item.dollars,
        volume: item.Volume || item.volume,
        trades: item.Trades || item.trades,
        dates: item.Dates || item.dates,
        // General
        timestamp: Date.now(),
        source: url
      };

      // Avoid duplicates (same symbol + price)
      const existing = tradeLevels.get(symbol);
      if (!existing.find(l => l.price === price)) {
        existing.push(level);
        console.log(`✅ Added level: ${symbol} @ $${price.toFixed(2)} (rank #${level.rank || '?'})`);
      }
    }
  }

  const totalLevels = Array.from(tradeLevels.values()).flat().length;
  console.log(`📊 Total levels captured: ${totalLevels}`);

  // Persist to storage
  saveLevels();
}

/**
 * Try to extract symbol from API URL
 */
function extractSymbolFromUrl(url) {
  // Common patterns: /api/levels/AAPL, /api?symbol=AAPL, etc.
  const patterns = [
    /\/([A-Z]{1,5})(?:\/|\?|$)/,
    /symbol=([A-Z]{1,5})/i,
    /ticker=([A-Z]{1,5})/i
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1].toUpperCase();
  }

  return null;
}

/**
 * Save levels to storage
 */
async function saveLevels() {
  const obj = Object.fromEntries(tradeLevels);
  await browser.storage.local.set({ tradeLevels: obj });
}

/**
 * Handle messages from content scripts and popup
 */
function handleMessage(message, sender, sendResponse) {
  console.log('📨 Message received:', message);

  switch (message.type) {
    case 'GET_LEVELS':
      // Return levels for a specific symbol or all
      const symbol = message.symbol?.toUpperCase();
      if (symbol) {
        sendResponse({ levels: tradeLevels.get(symbol) || [] });
      } else {
        sendResponse({ levels: Object.fromEntries(tradeLevels) });
      }
      break;

    case 'FETCH_VL_LEVELS':
      // Fetch levels directly from VL API for a specific symbol
      fetchVlLevels(message.symbol)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // Async response

    case 'CLEAR_LEVELS':
      if (message.symbol) {
        tradeLevels.delete(message.symbol.toUpperCase());
      } else {
        tradeLevels.clear();
      }
      saveLevels();
      sendResponse({ success: true });
      break;

    case 'SET_DEBUG':
      debugMode = message.enabled;
      console.log('🔧 Debug mode:', debugMode);
      sendResponse({ success: true });
      break;

    case 'GET_STATUS':
      sendResponse({
        levelCount: Array.from(tradeLevels.values()).flat().length,
        symbols: Array.from(tradeLevels.keys()),
        debugMode
      });
      break;

    case 'CHECK_VL_AUTH':
      // Check if user is logged into VolumeLeaders
      checkVlAuth()
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ authenticated: false, error: err.message }));
      return true;

    default:
      console.log('❓ Unknown message type:', message.type);
  }

  return true; // Keep channel open for async response
}

/**
 * Check if user is authenticated to VolumeLeaders
 */
async function checkVlAuth() {
  try {
    const cookies = await browser.cookies.getAll({ domain: 'volumeleaders.com' });
    const authCookie = cookies.find(c => c.name === '.ASPXAUTH');

    console.log('🍪 VL cookies found:', cookies.length);
    console.log('🔐 Auth cookie present:', !!authCookie);

    return {
      authenticated: !!authCookie,
      cookieCount: cookies.length
    };
  } catch (err) {
    console.error('❌ Error checking VL auth:', err);
    return { authenticated: false, error: err.message };
  }
}

/**
 * Fetch trade levels directly from VolumeLeaders API
 */
async function fetchVlLevels(ticker) {
  if (!ticker) {
    throw new Error('No ticker symbol provided');
  }

  ticker = ticker.toUpperCase();
  console.log(`🔍 Fetching VL levels for ${ticker}...`);

  // Check authentication first
  const auth = await checkVlAuth();
  if (!auth.authenticated) {
    throw new Error('Not logged into VolumeLeaders. Please log in at volumeleaders.com first.');
  }

  // Build the request body (DataTables format)
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const fiveYearsAgo = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate())
    .toISOString().split('T')[0];
  const params = new URLSearchParams({
    'draw': '1',
    'columns[0][data]': 'Price',
    'columns[0][name]': 'Price',
    'columns[0][searchable]': 'true',
    'columns[0][orderable]': 'true',
    'columns[0][search][value]': '',
    'columns[0][search][regex]': 'false',
    'columns[1][data]': 'Dollars',
    'columns[1][name]': '$$',
    'columns[1][searchable]': 'true',
    'columns[1][orderable]': 'true',
    'columns[1][search][value]': '',
    'columns[1][search][regex]': 'false',
    'columns[2][data]': 'Volume',
    'columns[2][name]': 'Shares',
    'columns[2][searchable]': 'true',
    'columns[2][orderable]': 'true',
    'columns[2][search][value]': '',
    'columns[2][search][regex]': 'false',
    'columns[3][data]': 'Trades',
    'columns[3][name]': 'Trades',
    'columns[3][searchable]': 'true',
    'columns[3][orderable]': 'true',
    'columns[3][search][value]': '',
    'columns[3][search][regex]': 'false',
    'columns[4][data]': 'RelativeSize',
    'columns[4][name]': 'RS',
    'columns[4][searchable]': 'true',
    'columns[4][orderable]': 'true',
    'columns[4][search][value]': '',
    'columns[4][search][regex]': 'false',
    'columns[5][data]': 'CumulativeDistribution',
    'columns[5][name]': 'PCT',
    'columns[5][searchable]': 'true',
    'columns[5][orderable]': 'true',
    'columns[5][search][value]': '',
    'columns[5][search][regex]': 'false',
    'columns[6][data]': 'TradeLevelRank',
    'columns[6][name]': 'Level Rank',
    'columns[6][searchable]': 'true',
    'columns[6][orderable]': 'true',
    'columns[6][search][value]': '',
    'columns[6][search][regex]': 'false',
    'columns[7][data]': 'Level Date Range',
    'columns[7][name]': 'Level Date Range',
    'columns[7][searchable]': 'true',
    'columns[7][orderable]': 'false',
    'columns[7][search][value]': '',
    'columns[7][search][regex]': 'false',
    'order[0][column]': '1',
    'order[0][dir]': 'DESC',
    'start': '0',
    'length': '-1',
    'search[value]': '',
    'search[regex]': 'false',
    'Ticker': ticker,
    'MinVolume': '0',
    'MaxVolume': '2000000000',
    'MinPrice': '0',
    'MaxPrice': '100000',
    'MinDollars': '500000',
    'MaxDollars': '300000000000',
    'MinDate': fiveYearsAgo,
    'MaxDate': today,
    'VCD': '0',
    'RelativeSize': '0',
    'TradeLevelRank': '5',
    'TradeLevelCount': '5'
  });

  try {
    const response = await fetch('https://www.volumeleaders.com/TradeLevels/GetTradeLevels', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      credentials: 'include', // Include cookies
      body: params.toString()
    });

    console.log(`📡 VL API response status: ${response.status}`);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('VolumeLeaders session expired. Please log in again.');
      }
      throw new Error(`VL API error: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    console.log(`📦 VL API returned ${json.data?.length || 0} levels`);

    if (!json.data || json.data.length === 0) {
      return {
        success: true,
        ticker,
        levels: [],
        message: `No trade levels found for ${ticker}`
      };
    }

    // Clear existing levels for this ticker before adding new ones
    tradeLevels.delete(ticker);

    // Process and store the levels
    extractLevels(`direct-fetch:${ticker}`, json.data);

    // Return the levels for immediate use
    const levels = tradeLevels.get(ticker) || [];

    return {
      success: true,
      ticker,
      levels,
      count: levels.length
    };

  } catch (err) {
    console.error(`❌ Failed to fetch VL levels for ${ticker}:`, err);
    throw err;
  }
}

/**
 * Summarize object structure for debugging
 */
function summarizeObject(obj, depth = 0) {
  if (depth > 2) return '...';

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return `Array(${obj.length}) [${summarizeObject(obj[0], depth + 1)}]`;
  }

  if (typeof obj === 'object' && obj !== null) {
    const keys = Object.keys(obj).slice(0, 5);
    const summary = keys.map(k => `${k}: ${typeof obj[k]}`).join(', ');
    const more = Object.keys(obj).length > 5 ? ', ...' : '';
    return `{${summary}${more}}`;
  }

  return typeof obj;
}

// 🚀 Start
init();
