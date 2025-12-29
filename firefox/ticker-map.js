/**
 * VL TradingView Bridge - Ticker Symbol Translation
 *
 * Handles bidirectional translation between TradingView and VolumeLeaders ticker formats.
 *
 * Examples:
 *   TradingView: BRK.B, BRK.A (dot-separated share classes)
 *   VolumeLeaders: BRKB, BRKA (concatenated)
 */

// Static mappings for known exceptions (TV format -> VL format)
// Add any tickers that don't follow standard patterns here
const TV_TO_VL_MAP = {
  // Share class tickers (most common case)
  // These follow the pattern X.Y -> XY, handled by the generic rule below
  // Add any true exceptions here:
  // 'EXAMPLE.TV': 'EXAMPLEVL',
};

// Reverse map (VL format -> TV format)
const VL_TO_TV_MAP = {
  // Share class tickers that need dots restored
  'BRKA': 'BRK.A',
  'BRKB': 'BRK.B',
  // Add other known share class tickers as discovered:
  // 'GOOGL': 'GOOGL',  // No change needed (Class A has no suffix)
};

// Country/exchange suffixes to strip (TradingView-specific)
const COUNTRY_SUFFIXES = ['.US', '.UK', '.DE', '.FR', '.JP', '.HK', '.AU', '.CA'];

/**
 * Translate TradingView ticker to VolumeLeaders format
 * @param {string} tvTicker - TradingView format ticker (e.g., "BRK.B", "AAPL.US")
 * @returns {string} - VolumeLeaders format ticker (e.g., "BRKB", "AAPL")
 */
function tvToVl(tvTicker) {
  if (!tvTicker) return null;

  let ticker = tvTicker.toUpperCase().trim();

  // Remove exchange prefix (NASDAQ:AAPL -> AAPL)
  if (ticker.includes(':')) {
    ticker = ticker.split(':').pop();
  }

  // Check static map first
  if (TV_TO_VL_MAP[ticker]) {
    return TV_TO_VL_MAP[ticker];
  }

  // Strip country suffixes (.US, .UK, etc.)
  for (const suffix of COUNTRY_SUFFIXES) {
    if (ticker.endsWith(suffix)) {
      ticker = ticker.slice(0, -suffix.length);
      break;
    }
  }

  // Handle share class notation: X.Y -> XY (e.g., BRK.B -> BRKB)
  // Only applies to single-letter suffixes (share classes)
  const dotMatch = ticker.match(/^([A-Z]+)\.([A-Z])$/);
  if (dotMatch) {
    ticker = dotMatch[1] + dotMatch[2];
  }

  return ticker;
}

/**
 * Translate VolumeLeaders ticker to TradingView format
 * @param {string} vlTicker - VolumeLeaders format ticker (e.g., "BRKB")
 * @returns {string} - TradingView format ticker (e.g., "BRK.B")
 */
function vlToTv(vlTicker) {
  if (!vlTicker) return null;

  const ticker = vlTicker.toUpperCase().trim();

  // Check static map first (covers known share class tickers)
  if (VL_TO_TV_MAP[ticker]) {
    return VL_TO_TV_MAP[ticker];
  }

  // No transformation needed for most tickers
  return ticker;
}

/**
 * Check if a ticker appears to be a share class variant
 * @param {string} ticker - Any format ticker
 * @returns {boolean}
 */
function isShareClass(ticker) {
  if (!ticker) return false;
  const upper = ticker.toUpperCase();
  // TV format: X.Y where Y is single letter
  // VL format: ends with A or B after 2+ letter base
  return /^[A-Z]+\.[A-Z]$/.test(upper) || VL_TO_TV_MAP[upper] !== undefined;
}

// Export as global object for use in background.js
// (Firefox MV2 background scripts share global scope when loaded via manifest)
var tickerMap = { tvToVl, vlToTv, isShareClass };
