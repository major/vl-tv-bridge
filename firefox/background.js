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

const VL_TRADES_TIMEOUT_MS = 60000;
const VL_MARKET_TIME_ZONE = 'America/New_York';

let debugMode = true;
let xsrfToken = null;
let xsrfTokenExpiry = 0;

function getTimeZoneOffsetMs(timestampMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(timestampMs));

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );

  const zonedTimestampMs = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second
  );

  return zonedTimestampMs - timestampMs;
}

function parseVlFullDateTime(fullDateTime) {
  if (!fullDateTime) return null;

  const match = fullDateTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match.map(Number);
  const localTimestampMs = Date.UTC(year, month - 1, day, hour, minute, second);

  let timestampMs = localTimestampMs;
  for (let i = 0; i < 2; i += 1) {
    timestampMs = localTimestampMs - getTimeZoneOffsetMs(timestampMs, VL_MARKET_TIME_ZONE);
  }

  return timestampMs / 1000;
}

/**
 * Initialize extension
 */
async function init() {
  console.log('🚀 VL-TV Bridge: Background script loaded');
  setupInterception();
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
  const urlSymbol = extractSymbolFromUrl(url);
  let count = 0;

  for (const item of items) {
    const symbol = (item.Ticker || item.ticker || item.symbol || urlSymbol || 'UNKNOWN').toUpperCase();
    const price = item.Price || item.price || item.level || item.tradeLevel;

    if (price && typeof price === 'number') {
      count++;
      if (debugMode) {
        console.log(`📊 Level: ${symbol} @ $${price.toFixed(2)} (rank #${item.TradeLevelRank || '?'})`);
      }
    }
  }

  console.log(`📊 Intercepted ${count} levels from VL API`);
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
 * Handle messages from content scripts and popup
 */
function handleMessage(message, sender, sendResponse) {
  console.log('📨 Message received:', message);

  switch (message.type) {
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
      fetchAndDrawTrades(message.symbol, message.tabId, message.tradeCount, message.drawOptions)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // Async response

    case 'SET_DEBUG':
      debugMode = message.enabled;
      console.log('🔧 Debug mode:', debugMode);
      sendResponse({ success: true });
      break;

    case 'GET_STATUS':
      sendResponse({ debugMode });
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
 * Fetch XSRF token from VolumeLeaders page
 * ASP.NET anti-forgery requires this token in X-XSRF-TOKEN header
 */
async function getXsrfToken(forceRefresh = false) {
  const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

  if (!forceRefresh && xsrfToken && Date.now() < xsrfTokenExpiry) {
    console.log('🔑 Using cached XSRF token');
    return xsrfToken;
  }

  console.log('🔑 Fetching fresh XSRF token from VL...');

  try {
    const response = await fetch('https://www.volumeleaders.com/TradeLevels?Ticker=SPY', {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch VL page: ${response.status}`);
    }

    if (response.url.includes('/Login')) {
      throw new Error('Please log in to VolumeLeaders.com first, then try again');
    }

    const html = await response.text();

    if (html.includes('Welcome Back') && html.includes('Login')) {
      throw new Error('Please log in to VolumeLeaders.com first, then try again');
    }

    // Extract token from hidden input: <input name="__RequestVerificationToken" ... value="TOKEN" />
    const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    if (!tokenMatch) {
      throw new Error('Please log in to VolumeLeaders.com first, then try again');
    }

    xsrfToken = tokenMatch[1];
    xsrfTokenExpiry = Date.now() + TOKEN_TTL_MS;

    console.log('🔑 Got fresh XSRF token:', xsrfToken.substring(0, 20) + '...');
    return xsrfToken;

  } catch (err) {
    console.error('❌ Failed to get XSRF token:', err);
    throw err;
  }
}

/**
 * Fetch trade levels directly from VolumeLeaders API
 */
async function fetchVlLevels(ticker, now = new Date()) {
  if (!ticker) {
    throw new Error('No ticker symbol provided');
  }

  // Translate TV ticker format to VL format (e.g., BRK.B -> BRKB)
  const originalTicker = ticker;
  ticker = tickerMap.tvToVl(ticker);
  if (ticker !== originalTicker.toUpperCase()) {
    console.log(`🔄 Translated ticker: ${originalTicker} -> ${ticker}`);
  }
  console.log(`🔍 Fetching VL levels for ${ticker}...`);

  // Get user's settings
  const settings = await browser.storage.local.get(['levelCount', 'tradeCount', 'yearRange']);
  const levelCount = String(settings.levelCount ?? 10);
  const tradeCount = String(settings.tradeCount ?? 5);
  const yearRange = settings.yearRange ?? 5;

  // Check authentication first
  const auth = await checkVlAuth();
  if (!auth.authenticated) {
    throw new Error('Not logged into VolumeLeaders. Please log in at volumeleaders.com first.');
  }

  // Get XSRF token for anti-forgery validation
  const token = await getXsrfToken();

  // Build the request body (DataTables format)
  now = now || new Date();
  const today = now.toISOString().split('T')[0];
  const startDate = new Date(now.getFullYear() - yearRange, now.getMonth(), now.getDate())
    .toISOString().split('T')[0];
  const chartUrl = buildChart0Url(ticker, startDate, today, levelCount, tradeCount);
  const params = new URLSearchParams({
    'draw': '2',
    'columns[0][data]': 'Price',
    'columns[0][name]': 'Price',
    'columns[0][searchable]': 'true',
    'columns[0][orderable]': 'false',
    'columns[0][search][value]': '',
    'columns[0][search][regex]': 'false',
    'columns[1][data]': 'Dollars',
    'columns[1][name]': '$$',
    'columns[1][searchable]': 'true',
    'columns[1][orderable]': 'false',
    'columns[1][search][value]': '',
    'columns[1][search][regex]': 'false',
    'columns[2][data]': 'Volume',
    'columns[2][name]': 'Sh',
    'columns[2][searchable]': 'true',
    'columns[2][orderable]': 'false',
    'columns[2][search][value]': '',
    'columns[2][search][regex]': 'false',
    'columns[3][data]': 'Trades',
    'columns[3][name]': 'Trades',
    'columns[3][searchable]': 'true',
    'columns[3][orderable]': 'false',
    'columns[3][search][value]': '',
    'columns[3][search][regex]': 'false',
    'columns[4][data]': 'RelativeSize',
    'columns[4][name]': 'RS',
    'columns[4][searchable]': 'true',
    'columns[4][orderable]': 'false',
    'columns[4][search][value]': '',
    'columns[4][search][regex]': 'false',
    'columns[5][data]': 'CumulativeDistribution',
    'columns[5][name]': 'PCT',
    'columns[5][searchable]': 'true',
    'columns[5][orderable]': 'false',
    'columns[5][search][value]': '',
    'columns[5][search][regex]': 'false',
    'columns[6][data]': 'TradeLevelRank',
    'columns[6][name]': 'Rank',
    'columns[6][searchable]': 'true',
    'columns[6][orderable]': 'false',
    'columns[6][search][value]': '',
    'columns[6][search][regex]': 'false',
    'columns[7][data]': 'Dates',
    'columns[7][name]': 'Dates',
    'columns[7][searchable]': 'true',
    'columns[7][orderable]': 'false',
    'columns[7][search][value]': '',
    'columns[7][search][regex]': 'false',
    'start': '0',
    'length': '-1',
    'search[value]': '',
    'search[regex]': 'false',
    'StartDate': startDate,
    'EndDate': today,
    'Ticker': ticker,
    'Levels': levelCount
  });

  try {
    const response = await fetch('https://www.volumeleaders.com/Chart0/GetTradeLevels', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Origin': 'https://www.volumeleaders.com',
        'Referer': chartUrl,
        'X-XSRF-TOKEN': token,
        'X-Requested-With': 'XMLHttpRequest'
      },
      credentials: 'include',
      referrer: chartUrl,
      body: params.toString()
    });

    console.log(`📡 VL API response status: ${response.status}`);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('VolumeLeaders session expired. Please log in again.');
      }
      if (response.status === 400) {
        // Token might be stale - invalidate and let caller retry
        xsrfToken = null;
        xsrfTokenExpiry = 0;
        throw new Error('XSRF token rejected - please try again');
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

    const levels = json.data.map(item => ({
      price: item.Price || item.price,
      symbol: (item.Ticker || ticker).toUpperCase(),
      rank: item.TradeLevelRank || item.rank,
      dollars: item.Dollars || item.dollars,
      volume: item.Volume || item.volume,
      trades: item.Trades || item.trades,
      dates: item.Dates || item.dates
    })).filter(l => l.price && typeof l.price === 'number');

    console.log(`📊 Fetched ${levels.length} levels for ${ticker}`);

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
      // Get clustering and display settings
      const settings = await browser.storage.local.get(['clusteringEnabled', 'clusterThreshold', 'showDates']);
      const clusteringEnabled = settings.clusteringEnabled !== false; // Default true
      const threshold = settings.clusterThreshold ?? 1.0;
      const showDates = settings.showDates || false; // Default false

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
        label: item.type === 'zone' ? formatZoneLabel(item, showDates) : formatLevelLabel(item, showDates)
      }));

      console.log(`🎨 BACKGROUND: Drawing ${drawablesWithLabels.length} items on tab ${tabId}`);

      const drawResponse = await browser.tabs.sendMessage(tabId, {
        type: 'DRAW_LEVELS',
        levels: drawablesWithLabels,
        options: {
          color: drawOptions.color || '#02A9DE',
          width: drawOptions.width || 2,
          opacity: drawOptions.opacity ?? 100,
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
async function fetchVlTrades(ticker, tradeCount = 10, visibleRange = null, now = new Date()) {
  if (!ticker) {
    throw new Error('No ticker symbol provided');
  }

  const originalTicker = ticker;
  ticker = tickerMap.tvToVl(ticker);
  if (ticker !== originalTicker.toUpperCase()) {
    console.log(`🔄 Translated ticker: ${originalTicker} -> ${ticker}`);
  }
  console.log(`🔍 Fetching VL trades for ${ticker}...`);

  const auth = await checkVlAuth();
  if (!auth.authenticated) {
    throw new Error('Not logged into VolumeLeaders. Please log in at volumeleaders.com first.');
  }

  const token = await getXsrfToken();

  let yearRange = 5;
  if (!visibleRange || !visibleRange.from || !visibleRange.to) {
    const settings = await browser.storage.local.get(['yearRange']);
    yearRange = settings.yearRange ?? 5;
  }

  const { startDate, endDate } = getTradeDateRange(visibleRange, yearRange, now);
  if (visibleRange && visibleRange.from && visibleRange.to) {
    console.log(`📅 Using chart visible range: ${startDate} to ${endDate}`);
  } else {
    console.log(`📅 Using default range (${yearRange}yr): ${startDate} to ${endDate}`);
  }

  const chartUrl = buildChart0Url(ticker, startDate, endDate, tradeCount);

  // ponytail: use GetAllPriceVolumeTradeData instead of GetTrades —
  // GetTrades returns wrong DarkPool flags on wide date ranges,
  // GetAllPriceVolumeTradeData array[1] always has correct DarkPoolTrade.
  const requestBody = {
    StartDateKey: dateKey(startDate),
    EndDateKey: dateKey(endDate),
    Ticker: ticker,
    VolumeProfile: 0,
    Levels: tradeCount,
    MinVolume: 0,
    MaxVolume: 2000000000,
    MinDollars: 500000,
    MaxDollars: 30000000000,
    DarkPools: -1,
    Sweeps: -1,
    LatePrints: -1,
    SignaturePrints: -1,
    TradeCount: tradeCount,
    MinPrice: 0,
    MaxPrice: 100000,
    VCD: 0,
    TradeRank: -1,
    TradeRankSnapshot: -1,
    IncludePremarket: 1,
    IncludeRTH: 1,
    IncludeAH: 1,
    IncludeOpening: 1,
    IncludeClosing: 1,
    IncludePhantom: 1,
    IncludeOffsetting: 1
  };

  console.log('📤 VL Trades request:', {
    ticker,
    startDate,
    endDate,
    tradeCount,
    requestUrl: 'https://www.volumeleaders.com/Chart0/GetAllPriceVolumeTradeData',
    referer: chartUrl
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VL_TRADES_TIMEOUT_MS);

  try {
    const response = await fetch('https://www.volumeleaders.com/Chart0/GetAllPriceVolumeTradeData', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Origin': 'https://www.volumeleaders.com',
        'Referer': chartUrl,
        'X-XSRF-TOKEN': token,
        'X-Requested-With': 'XMLHttpRequest'
      },
      credentials: 'include',
      referrer: chartUrl,
      signal: controller.signal,
      body: JSON.stringify(requestBody)
    });
    clearTimeout(timeoutId);

    console.log(`📡 VL Trades API response status: ${response.status}`);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('VolumeLeaders session expired. Please log in again.');
      }
      if (response.status === 400) {
        xsrfToken = null;
        xsrfTokenExpiry = 0;
        throw new Error('XSRF token rejected - please try again');
      }
      throw new Error(`VL API error: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    // Response is an array of arrays; index 1 = individual trades with accurate flags
    const tradeData = Array.isArray(json) && json.length > 1 ? json[1] : [];
    console.log(`📦 VL API returned ${tradeData.length} trades`);

    if (tradeData.length === 0) {
      return {
        success: true,
        ticker,
        trades: [],
        message: `No large trades found for ${ticker}`
      };
    }

    // Parse and store the trades
    const trades = tradeData.map(item => {
      // Parse .NET JSON date format: "/Date(1748563200000)/"
      const fullDateTimestamp = parseVlFullDateTime(item.FullDateTime);
      const dateMatch = item.Date?.match(/\/Date\((\d+)\)\//);
      const timestamp = Number.isFinite(fullDateTimestamp)
        ? fullDateTimestamp
        : (dateMatch ? parseInt(dateMatch[1], 10) / 1000 : null);

      return {
        ticker: item.Ticker || ticker,
        price: item.Price,
        timestamp, // Unix seconds for TradingView
        rank: item.TradeRank,
        originalRank: item.TradeRankSnapshot,
        dollars: item.Dollars,
        dollarVolume: item.Dollars,
        volume: item.Volume,
        darkPool: isVlFlagEnabled(item.DarkPoolTrade),
        sweep: isVlFlagEnabled(item.Sweep),
        fullDateTime: item.FullDateTime,
        source: `trades-fetch:${ticker}`
      };
    });

    console.log(`📊 Fetched ${trades.length} trades for ${ticker}`);

    return {
      success: true,
      ticker,
      trades,
      count: trades.length
    };

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      const timeoutSeconds = VL_TRADES_TIMEOUT_MS / 1000;
      console.error(`❌ VL Trades API timed out after ${timeoutSeconds} seconds`);
      throw new Error(`VolumeLeaders trades request timed out after ${timeoutSeconds} seconds`);
    }

    console.error(`❌ Failed to fetch VL trades for ${ticker}:`, err);
    throw err;
  }
}

function isVlFlagEnabled(value) {
  return value === 1 || value === true || value === '1' || value === 'true' || value === 'True';
}

function getTradeDateRange(visibleRange = null, yearRange = 5, now = new Date()) {
  const today = now.toISOString().split('T')[0];

  if (visibleRange && visibleRange.from && visibleRange.to) {
    const startDate = new Date(visibleRange.from * 1000).toISOString().split('T')[0];
    const visibleEndDate = new Date(visibleRange.to * 1000).toISOString().split('T')[0];

    return {
      startDate,
      endDate: visibleEndDate > today ? today : visibleEndDate
    };
  }

  const startDate = new Date(now.getFullYear() - yearRange, now.getMonth(), now.getDate())
    .toISOString().split('T')[0];

  return { startDate, endDate: today };
}

function dateKey(dateString) {
  return dateString.replaceAll('-', '');
}

function buildChart0Url(ticker, startDate, endDate, levels, tradeCount = levels) {
  const query = new URLSearchParams({
    'StartDate': startDate,
    'EndDate': endDate,
    'Ticker': ticker,
    'MinVolume': '0',
    'MaxVolume': '2000000000',
    'MinDollars': '500000',
    'MaxDollars': '30000000000',
    'MinPrice': '0',
    'MaxPrice': '100000',
    'DarkPools': '-1',
    'Sweeps': '-1',
    'LatePrints': '-1',
    'SignaturePrints': '-1',
    'VolumeProfile': '0',
    'Levels': String(levels),
    'TradeCount': String(tradeCount),
    'VCD': '0',
    'TradeRank': '-1',
    'TradeRankSnapshot': '-1',
    'IncludePremarket': '1',
    'IncludeRTH': '1',
    'IncludeAH': '1',
    'IncludeOpening': '1',
    'IncludeClosing': '1',
    'IncludePhantom': '1',
    'IncludeOffsetting': '1'
  });

  return `https://www.volumeleaders.com/Chart0?${query.toString()}`;
}

async function fetchAndDrawTrades(symbol, tabId = null, tradeCount = 5, drawOptions = {}) {
  let visibleRange = null;

  if (tabId) {
    try {
      const rangeResponse = await browser.tabs.sendMessage(tabId, { type: 'GET_VISIBLE_RANGE' });
      visibleRange = rangeResponse?.range;
      if (visibleRange) {
        console.log(`📅 BACKGROUND: Chart visible range: ${new Date(visibleRange.from * 1000).toISOString().split('T')[0]} to ${new Date(visibleRange.to * 1000).toISOString().split('T')[0]}`);
      }
    } catch (err) {
      console.warn('⚠️ Could not get visible range, using default date range');
    }
  }

  const fetchResult = await fetchVlTrades(symbol, tradeCount, visibleRange);

  if (!fetchResult.success || fetchResult.trades.length === 0) {
    return fetchResult;
  }

  if (tabId) {
    try {
      console.log(`📝 BACKGROUND: Drawing ${fetchResult.trades.length} trade notes on tab ${tabId}`);

      const drawResponse = await browser.tabs.sendMessage(tabId, {
        type: 'DRAW_NOTES',
        trades: fetchResult.trades,
        options: drawOptions || {}
      });

      console.log(`📝 BACKGROUND: Note draw complete:`, drawResponse);

      return {
        ...fetchResult,
        drawResult: drawResponse
      };
    } catch (err) {
      console.error('❌ BACKGROUND: Failed to draw notes:', err);
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
 * When showDates is true, includes start date (e.g., "VL #1 $1.6B 2025-09-24")
 */
function formatLevelLabel(level, showDates = false) {
  const parts = ['VL'];

  if (level.rank) {
    parts.push(`#${level.rank}`);
  }

  if (level.dollars) {
    parts.push(formatDollars(level.dollars));
  }

  let label = parts.join(' ');

  // Add start date if enabled and available
  if (showDates && level.dates) {
    // Extract just the start date from "YYYY-MM-DD - YYYY-MM-DD"
    const startDate = level.dates.split(' - ')[0];
    label += ` ${startDate}`;
  }

  return label;
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
 * e.g., "VL #7, 9, 10 $2.9B"
 * When showDates is true, includes aggregated date range from all levels
 */
function formatZoneLabel(zone, showDates = false) {
  const { aggregated, levels } = zone;
  const parts = ['VL'];

  // List actual ranks from levels (comma-delimited)
  if (levels && levels.length > 0) {
    const ranks = levels.map(l => l.rank).filter(Boolean).sort((a, b) => a - b);
    if (ranks.length > 0) {
      parts.push(`#${ranks.join(',')}`);
    }
  }

  // Total dollar volume
  if (aggregated.totalDollars > 0) {
    parts.push(formatDollars(aggregated.totalDollars));
  }

  let label = parts.join(' ');

  // Add earliest start date if enabled
  if (showDates && levels && levels.length > 0) {
    // Find the earliest start date across all levels in the zone
    const startDates = [];
    for (const level of levels) {
      if (level.dates) {
        const startDate = level.dates.split(' - ')[0];
        if (startDate) {
          startDates.push(startDate);
        }
      }
    }
    if (startDates.length > 0) {
      startDates.sort();
      label += ` ${startDates[0]}`;
    }
  }

  return label;
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
