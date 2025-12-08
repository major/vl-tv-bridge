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
let largeTrades = new Map(); // symbol -> trades[] (for circles)
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
  // Handle direct-fetch:TICKER format (used by fetchVlLevels)
  const directFetchMatch = url.match(/^direct-fetch:([A-Z0-9]+)$/i);
  if (directFetchMatch) return directFetchMatch[1].toUpperCase();

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
      // If tabId is provided, also draw the levels on that tab
      fetchAndDraw(message.symbol, message.tabId, message.drawOptions)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // Async response

    case 'FETCH_VL_TRADES':
      // Fetch large trades from VL API for circles
      // If tabId is provided, also draw the circles on that tab
      fetchAndDrawTrades(message.symbol, message.tabId, message.tradeCount)
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

  // Get user's settings
  const settings = await browser.storage.local.get(['levelCount', 'yearRange']);
  const levelCount = String(settings.levelCount ?? 10);
  const yearRange = settings.yearRange ?? 5;

  // Check authentication first
  const auth = await checkVlAuth();
  if (!auth.authenticated) {
    throw new Error('Not logged into VolumeLeaders. Please log in at volumeleaders.com first.');
  }

  // Build the request body (DataTables format)
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const startDate = new Date(now.getFullYear() - yearRange, now.getMonth(), now.getDate())
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
    'MinDate': startDate,
    'MaxDate': today,
    'VCD': '0',
    'RelativeSize': '0',
    'TradeLevelRank': levelCount,
    'TradeLevelCount': levelCount
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
 * Fetch VL levels and optionally draw them on a tab
 * This ensures drawing happens even if the popup closes during fetch
 */
async function fetchAndDraw(symbol, tabId = null, drawOptions = {}) {
  // Step 1: Fetch the levels
  const fetchResult = await fetchVlLevels(symbol);

  if (!fetchResult.success || fetchResult.levels.length === 0) {
    return fetchResult;
  }

  // Step 2: If tabId provided, draw the levels
  if (tabId) {
    try {
      // Get clustering settings
      const settings = await browser.storage.local.get(['clusteringEnabled', 'clusterThreshold']);
      const clusteringEnabled = settings.clusteringEnabled !== false; // Default true
      const threshold = settings.clusterThreshold ?? 1.0;

      // Apply clustering if enabled
      let drawables;
      if (clusteringEnabled && threshold > 0) {
        drawables = clusterLevels(fetchResult.levels, threshold);
        console.log(`🔗 BACKGROUND: Clustered ${fetchResult.levels.length} levels into ${drawables.length} items (threshold: ${threshold}%)`);
      } else {
        drawables = fetchResult.levels.map(l => ({ type: 'level', ...l }));
      }

      // Add appropriate labels to each item
      const drawablesWithLabels = drawables.map(item => ({
        ...item,
        label: item.type === 'zone' ? formatZoneLabel(item) : formatLevelLabel(item)
      }));

      console.log(`🎨 BACKGROUND: Drawing ${drawablesWithLabels.length} items on tab ${tabId}`);

      const drawResponse = await browser.tabs.sendMessage(tabId, {
        type: 'DRAW_LEVELS',
        levels: drawablesWithLabels,
        options: {
          color: drawOptions.color || '#02A9DE',
          width: drawOptions.width || 2,
          style: drawOptions.style || 0
        }
      });

      console.log(`🎨 BACKGROUND: Draw complete:`, drawResponse);

      return {
        ...fetchResult,
        drawResult: drawResponse,
        clustered: clusteringEnabled,
        clusterCount: drawables.filter(d => d.type === 'zone').length
      };
    } catch (err) {
      console.error('❌ BACKGROUND: Failed to draw levels:', err);
      // Return fetch result even if draw fails - levels are still cached
      return {
        ...fetchResult,
        drawResult: { success: false, error: err.message }
      };
    }
  }

  return fetchResult;
}

/**
 * Fetch large trades from VolumeLeaders API (for circles)
 */
async function fetchVlTrades(ticker, tradeCount = 10) {
  if (!ticker) {
    throw new Error('No ticker symbol provided');
  }

  ticker = ticker.toUpperCase();
  console.log(`🔍 Fetching VL trades for ${ticker}...`);

  // Get user's settings for date range (same setting as trade levels)
  const settings = await browser.storage.local.get(['yearRange']);
  const yearRange = settings.yearRange ?? 5; // Default 5 years

  // Check authentication first
  const auth = await checkVlAuth();
  if (!auth.authenticated) {
    throw new Error('Not logged into VolumeLeaders. Please log in at volumeleaders.com first.');
  }

  // Build the request body (DataTables format for GetTrades)
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const startDate = new Date(now.getFullYear() - yearRange, now.getMonth(), now.getDate())
    .toISOString().split('T')[0];

  const params = new URLSearchParams({
    'draw': '1',
    'columns[0][data]': 'FullTimeString24',
    'columns[0][name]': 'FullTimeString24',
    'columns[0][searchable]': 'true',
    'columns[0][orderable]': 'false',
    'columns[0][search][value]': '',
    'columns[0][search][regex]': 'false',
    'columns[1][data]': 'Volume',
    'columns[1][name]': 'Sh',
    'columns[1][searchable]': 'true',
    'columns[1][orderable]': 'false',
    'columns[1][search][value]': '',
    'columns[1][search][regex]': 'false',
    'columns[2][data]': 'Price',
    'columns[2][name]': 'Price',
    'columns[2][searchable]': 'true',
    'columns[2][orderable]': 'false',
    'columns[2][search][value]': '',
    'columns[2][search][regex]': 'false',
    'columns[3][data]': 'Dollars',
    'columns[3][name]': '$$',
    'columns[3][searchable]': 'true',
    'columns[3][orderable]': 'false',
    'columns[3][search][value]': '',
    'columns[3][search][regex]': 'false',
    'columns[4][data]': 'DollarsMultiplier',
    'columns[4][name]': 'RS',
    'columns[4][searchable]': 'true',
    'columns[4][orderable]': 'false',
    'columns[4][search][value]': '',
    'columns[4][search][regex]': 'false',
    'columns[5][data]': 'TradeRank',
    'columns[5][name]': 'Rank',
    'columns[5][searchable]': 'true',
    'columns[5][orderable]': 'false',
    'columns[5][search][value]': '',
    'columns[5][search][regex]': 'false',
    'columns[6][data]': 'LastComparibleTradeDate',
    'columns[6][name]': 'Last Date',
    'columns[6][searchable]': 'true',
    'columns[6][orderable]': 'false',
    'columns[6][search][value]': '',
    'columns[6][search][regex]': 'false',
    'order[0][column]': '0',
    'order[0][dir]': 'DESC',
    'start': '0',
    'length': String(tradeCount),
    'search[value]': '',
    'search[regex]': 'false',
    'Tickers': ticker,
    'StartDate': startDate,
    'EndDate': today,
    'MinVolume': '0',
    'MaxVolume': '2000000000',
    'MinPrice': '0',
    'MaxPrice': '100000',
    'MinDollars': '500000',
    'MaxDollars': '300000000000',
    'Conditions': '-1',
    'VCD': '0',
    'RelativeSize': '0',
    'DarkPools': '-1',
    'Sweeps': '-1',
    'LatePrints': '-1',
    'SignaturePrints': '0',
    'TradeRank': '-1',
    'IncludePremarket': '1',
    'IncludeRTH': '1',
    'IncludeAH': '1',
    'IncludeOpening': '1',
    'IncludeClosing': '1',
    'IncludePhantom': '1',
    'IncludeOffsetting': '1',
    'SectorIndustry': '',
    'Sort': 'Dollars'
  });

  try {
    const response = await fetch('https://www.volumeleaders.com/Trades/GetTrades', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      credentials: 'include',
      body: params.toString()
    });

    console.log(`📡 VL Trades API response status: ${response.status}`);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('VolumeLeaders session expired. Please log in again.');
      }
      throw new Error(`VL API error: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    console.log(`📦 VL API returned ${json.data?.length || 0} trades`);

    if (!json.data || json.data.length === 0) {
      return {
        success: true,
        ticker,
        trades: [],
        message: `No large trades found for ${ticker}`
      };
    }

    // Parse and store the trades
    const trades = json.data.map(item => {
      // Parse .NET JSON date format: "/Date(1748563200000)/"
      const dateMatch = item.Date?.match(/\/Date\((\d+)\)\//);
      const timestamp = dateMatch ? parseInt(dateMatch[1], 10) / 1000 : null;

      return {
        ticker: item.Ticker || ticker,
        price: item.Price,
        timestamp, // Unix seconds for TradingView
        rank: item.TradeRank,
        dollars: item.Dollars,
        volume: item.Volume,
        darkPool: item.DarkPool === 1,
        fullDateTime: item.FullDateTime,
        source: `trades-fetch:${ticker}`
      };
    });

    // Store in largeTrades map
    largeTrades.set(ticker, trades);
    console.log(`✅ Stored ${trades.length} trades for ${ticker}`);

    return {
      success: true,
      ticker,
      trades,
      count: trades.length
    };

  } catch (err) {
    console.error(`❌ Failed to fetch VL trades for ${ticker}:`, err);
    throw err;
  }
}

/**
 * Fetch VL trades and optionally draw circles on a tab
 */
async function fetchAndDrawTrades(symbol, tabId = null, tradeCount = 5) {
  // Step 1: Fetch the trades
  const fetchResult = await fetchVlTrades(symbol, tradeCount);

  if (!fetchResult.success || fetchResult.trades.length === 0) {
    return fetchResult;
  }

  // Step 2: If tabId provided, draw the circles
  if (tabId) {
    try {
      console.log(`🔵 BACKGROUND: Drawing ${fetchResult.trades.length} trade circles on tab ${tabId}`);

      const drawResponse = await browser.tabs.sendMessage(tabId, {
        type: 'DRAW_CIRCLES',
        trades: fetchResult.trades
      });

      console.log(`🔵 BACKGROUND: Circle draw complete:`, drawResponse);

      return {
        ...fetchResult,
        drawResult: drawResponse
      };
    } catch (err) {
      console.error('❌ BACKGROUND: Failed to draw circles:', err);
      return {
        ...fetchResult,
        drawResult: { success: false, error: err.message }
      };
    }
  }

  return fetchResult;
}

/**
 * Format level label for TradingView line (e.g., "VL #1 $1.6B")
 */
function formatLevelLabel(level) {
  const parts = ['VL'];

  if (level.rank) {
    parts.push(`#${level.rank}`);
  }

  if (level.dollars) {
    parts.push(formatDollars(level.dollars));
  }

  return parts.join(' ');
}

/**
 * Format large dollar amounts (e.g., 1.6B, 250M)
 */
function formatDollars(amount) {
  if (amount >= 1e9) return `$${(amount / 1e9).toFixed(1)}B`;
  if (amount >= 1e6) return `$${(amount / 1e6).toFixed(0)}M`;
  if (amount >= 1e3) return `$${(amount / 1e3).toFixed(0)}K`;
  return `$${amount.toFixed(0)}`;
}

/**
 * Cluster nearby price levels into zones based on percentage threshold
 *
 * @param {Array} levels - Array of level objects with price property
 * @param {number} thresholdPercent - Clustering threshold (e.g., 1.0 for 1%)
 * @returns {Array} Array of level and zone objects
 */
function clusterLevels(levels, thresholdPercent) {
  if (!levels || levels.length === 0) return [];
  if (thresholdPercent <= 0) {
    // No clustering - mark all as single levels
    return levels.map(l => ({ type: 'level', ...l }));
  }

  // Sort by price ascending
  const sorted = [...levels].sort((a, b) => a.price - b.price);

  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const level = sorted[i];
    const clusterHigh = Math.max(...currentCluster.map(l => l.price));

    // Calculate threshold relative to cluster's high price
    const threshold = clusterHigh * (thresholdPercent / 100);

    if ((level.price - clusterHigh) <= threshold) {
      // Level is close enough - add to current cluster
      currentCluster.push(level);
    } else {
      // Level is too far - finalize current cluster, start new one
      clusters.push(finalizeCluster(currentCluster));
      currentCluster = [level];
    }
  }

  // Don't forget the last cluster
  clusters.push(finalizeCluster(currentCluster));

  return clusters;
}

/**
 * Finalize a cluster into either a single level or a zone
 */
function finalizeCluster(levels) {
  if (levels.length === 1) {
    return { type: 'level', ...levels[0] };
  }

  const prices = levels.map(l => l.price);
  const ranks = levels.map(l => l.rank).filter(Boolean).sort((a, b) => a - b);
  const totalDollars = levels.reduce((sum, l) => sum + (l.dollars || 0), 0);
  const highPrice = Math.max(...prices);
  const lowPrice = Math.min(...prices);

  return {
    type: 'zone',
    highPrice,
    lowPrice,
    midPrice: (highPrice + lowPrice) / 2,
    levels,
    aggregated: {
      rankRange: ranks.length > 0 ? [ranks[0], ranks[ranks.length - 1]] : [null, null],
      totalDollars,
      levelCount: levels.length,
      avgDollars: totalDollars / levels.length
    }
  };
}

/**
 * Format zone label for TradingView line
 * e.g., "VL #1-3 $2.9B"
 */
function formatZoneLabel(zone) {
  const { aggregated } = zone;
  const parts = ['VL'];

  // Rank range
  if (aggregated.rankRange[0] !== null) {
    if (aggregated.rankRange[0] === aggregated.rankRange[1]) {
      parts.push(`#${aggregated.rankRange[0]}`);
    } else {
      parts.push(`#${aggregated.rankRange[0]}-${aggregated.rankRange[1]}`);
    }
  }

  // Total dollar volume
  if (aggregated.totalDollars > 0) {
    parts.push(formatDollars(aggregated.totalDollars));
  }

  return parts.join(' ');
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
