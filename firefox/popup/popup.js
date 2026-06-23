/**
 * VL TradingView Bridge - Popup Script
 * One-click workflow: Detect TV symbol → Fetch VL levels → Draw on chart
 */

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

// DOM elements
const elements = {
  version: document.getElementById('version'),
  status: document.getElementById('status'),
  tvStatus: document.getElementById('tv-status'),
  vlStatus: document.getElementById('vl-status'),
  chartSymbol: document.getElementById('chart-symbol'),
  fetchDrawBtn: document.getElementById('fetch-draw-btn'),
  fetchTradesBtn: document.getElementById('fetch-trades-btn'),
  clearChartBtn: document.getElementById('clear-chart-btn'),



  debugToggle: document.getElementById('debug-toggle'),
  levelCountSelect: document.getElementById('level-count-select'),
  tradeCountSelect: document.getElementById('trade-count-select'),
  tradeLitColorInput: document.getElementById('trade-lit-color-input'),
  tradeDarkPoolColorInput: document.getElementById('trade-dark-pool-color-input'),
  tradeThicknessSelect: document.getElementById('trade-thickness-select'),
  showOriginalTradeRankToggle: document.getElementById('show-original-trade-rank-toggle'),
  yearRangeSelect: document.getElementById('year-range-select'),
  clusteringToggle: document.getElementById('clustering-toggle'),
  thresholdSelect: document.getElementById('threshold-select'),
  thresholdRow: document.getElementById('threshold-row'),
  lineColorInput: document.getElementById('line-color-input'),
  lineThicknessSelect: document.getElementById('line-thickness-select'),
  lineOpacitySelect: document.getElementById('line-opacity-select'),
  showDatesToggle: document.getElementById('show-dates-toggle')
};

// State

let tvReady = false;
let vlReady = false;
let currentSymbol = null;
let currentTabId = null;

/**
 * Initialize popup
 */
async function init() {
  console.log('🎛️ Popup initialized');

  // Display version from manifest
  const manifest = browser.runtime.getManifest();
  elements.version.textContent = `v${manifest.version}`;

  // Get current tab
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tabs[0]?.id;

  // Check statuses in parallel
  await Promise.all([
    checkTradingView(tabs[0]),
    checkVlAuth()
  ]);

  // Load settings
  const stored = await browser.storage.local.get([
    'debugMode', 'levelCount', 'tradeCount', 'yearRange', 'clusteringEnabled', 'clusterThreshold',
    'lineColor', 'lineThickness', 'lineOpacity', 'showDates', 'tradeLitColor', 'tradeDarkPoolColor', 'tradeThickness',
    'showOriginalTradeRank'
  ]);
  elements.debugToggle.checked = stored.debugMode || false;
  elements.levelCountSelect.value = stored.levelCount ?? 10;
  elements.tradeCountSelect.value = stored.tradeCount ?? 5;
  elements.tradeLitColorInput.value = stored.tradeLitColor ?? '#2962FF';
  elements.tradeDarkPoolColorInput.value = stored.tradeDarkPoolColor ?? '#FF9800';
  elements.tradeThicknessSelect.value = stored.tradeThickness ?? 2;
  elements.showOriginalTradeRankToggle.checked = stored.showOriginalTradeRank || false;
  elements.yearRangeSelect.value = stored.yearRange ?? 5;
  elements.clusteringToggle.checked = stored.clusteringEnabled !== false; // Default true
  elements.thresholdSelect.value = stored.clusterThreshold ?? 1.0;
  elements.lineColorInput.value = stored.lineColor ?? '#2962FF';
  elements.lineThicknessSelect.value = stored.lineThickness ?? 2;
  elements.lineOpacitySelect.value = stored.lineOpacity ?? 100;
  elements.showDatesToggle.checked = stored.showDates || false; // Default false
  updateThresholdVisibility();

  // Set up event listeners
  setupEventListeners();

  // Update button states
  updateButtonStates();
}

/**
 * Check if current tab is TradingView and get symbol
 */
async function checkTradingView(tab) {
  const isTradingView = tab?.url?.includes('tradingview.com');

  if (!isTradingView) {
    setTvStatus('not-ready', 'Not on TradingView');
    elements.chartSymbol.textContent = 'Open a TradingView chart';
    elements.chartSymbol.classList.add('empty');
    return;
  }

  setTvStatus('checking', 'Checking chart...');

  try {
    // Check if TV API is ready
    const readyResponse = await browser.tabs.sendMessage(currentTabId, {
      type: 'CHECK_TV_READY'
    });

    if (readyResponse?.ready) {
      tvReady = true;
      setTvStatus('ready', 'TradingView ready');

      // Get the current symbol
      const symbolResponse = await browser.tabs.sendMessage(currentTabId, {
        type: 'GET_CURRENT_SYMBOL'
      });

      if (symbolResponse?.symbol) {
        currentSymbol = symbolResponse.symbol;
        elements.chartSymbol.textContent = currentSymbol;
        elements.chartSymbol.classList.remove('empty');
      } else {
        elements.chartSymbol.textContent = 'Could not detect symbol';
        elements.chartSymbol.classList.add('empty');
      }
    } else {
      setTvStatus('not-ready', 'Chart not loaded yet');
      elements.chartSymbol.textContent = 'Wait for chart to load';
      elements.chartSymbol.classList.add('empty');
    }
  } catch (err) {
    console.error('Failed to check TV status:', err);
    setTvStatus('not-ready', 'Extension not loaded');
    elements.chartSymbol.textContent = 'Refresh the TradingView page';
    elements.chartSymbol.classList.add('empty');
  }
}

/**
 * Check VolumeLeaders authentication
 */
async function checkVlAuth() {
  setVlStatus('checking', 'Checking VL login...');

  try {
    const response = await browser.runtime.sendMessage({ type: 'CHECK_VL_AUTH' });

    if (response?.authenticated) {
      vlReady = true;
      setVlStatus('ready', 'VolumeLeaders logged in');
    } else {
      vlReady = false;
      setVlStatus('not-ready', 'Not logged into VL');
    }
  } catch (err) {
    console.error('Failed to check VL auth:', err);
    vlReady = false;
    setVlStatus('not-ready', 'VL auth check failed');
  }
}

/**
 * Set TradingView status indicator
 */
function setTvStatus(state, text) {
  elements.tvStatus.className = `tv-status ${state}`;
  elements.tvStatus.querySelector('.text').textContent = text;
}

/**
 * Set VolumeLeaders status indicator
 */
function setVlStatus(state, text) {
  elements.vlStatus.className = `vl-status ${state}`;
  elements.vlStatus.querySelector('.text').textContent = text;
}

/**
 * Update button states based on current status
 */
function updateButtonStates() {
  const canFetchDraw = tvReady && vlReady && currentSymbol;
  elements.fetchDrawBtn.disabled = !canFetchDraw;
  elements.fetchTradesBtn.disabled = !canFetchDraw;

  elements.clearChartBtn.disabled = !tvReady;

}



/**
 * Main action: Fetch VL levels and draw on chart
 */
async function fetchAndDraw() {
  if (!currentSymbol) {
    elements.status.textContent = '❌ No symbol detected';
    return;
  }

  elements.fetchDrawBtn.disabled = true;
  elements.fetchDrawBtn.disabled = true;
  elements.status.textContent = `Fetching levels for ${currentSymbol}...`;

  try {
    let lineColor = elements.lineColorInput?.value?.trim().toUpperCase() || '#2962FF';
    if (!/^#[0-9A-F]{6}$/.test(lineColor)) {
      lineColor = '#2962FF';
    }
    const lineThickness = parseInt(elements.lineThicknessSelect?.value, 10) || 2;
    const lineOpacity = parseInt(elements.lineOpacitySelect?.value, 10) || 100;

    const response = await browser.runtime.sendMessage({
      type: 'FETCH_VL_LEVELS',
      symbol: currentSymbol,
      tabId: currentTabId,
      drawOptions: {
        color: lineColor,
        width: lineThickness,
        opacity: lineOpacity,
        style: 0
      }
    });

    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch levels');
    }

    if (response.levels.length === 0) {
      elements.status.textContent = `No VL levels found for ${currentSymbol}`;
    } else if (response.drawResult?.success) {
      elements.status.textContent = `✅ Drew ${response.drawResult.drawn} levels for ${currentSymbol}`;
    } else {
      elements.status.textContent = `⚠️ Fetched ${response.count} levels but draw failed`;
    }

  } catch (err) {
    console.error('Fetch & Draw error:', err);
    elements.status.textContent = `❌ ${err.message}`;
  }

  
  elements.fetchDrawBtn.disabled = false;
  updateButtonStates();
}

/**
 * Fetch VL large trades and draw circles on chart
 */
async function fetchAndDrawTrades() {
  if (!currentSymbol) {
    elements.status.textContent = '❌ No symbol detected';
    return;
  }

  elements.fetchTradesBtn.disabled = true;
  elements.fetchTradesBtn.disabled = true;
  elements.status.textContent = `Fetching large trades for ${currentSymbol}...`;

  try {
    const tradeCount = parseInt(elements.tradeCountSelect?.value, 10) || 5;
    const tradeLitColor = normalizeColorForDraw(elements.tradeLitColorInput?.value, '#2962FF');
    const tradeDarkPoolColor = normalizeColorForDraw(elements.tradeDarkPoolColorInput?.value, '#FF9800');
    const tradeThickness = parseInt(elements.tradeThicknessSelect?.value, 10) || 2;
    const showOriginalTradeRank = elements.showOriginalTradeRankToggle?.checked || false;

    // Send fetch request with tabId - background script handles drawing
    const response = await browser.runtime.sendMessage({
      type: 'FETCH_VL_TRADES',
      symbol: currentSymbol,
      tabId: currentTabId,
      tradeCount: tradeCount,
      drawOptions: {
        tradeLitColor,
        tradeDarkPoolColor,
        tradeThickness,
        showOriginalTradeRank
      }
    });

    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch trades');
    }

    if (response.trades.length === 0) {
      elements.status.textContent = `No large trades found for ${currentSymbol}`;
    } else if (response.drawResult?.success) {
      const dpCount = response.drawResult.darkPoolCount || 0;
      const litCount = response.drawResult.litCount || 0;
      const skippedCount = response.drawResult.skipped || 0;
      let statusText = `✅ Drew ${response.drawResult.drawn} trades (🔵 ${litCount} lit, 🟠 ${dpCount} dark pool)`;
      if (skippedCount > 0) {
        statusText += ` · ${skippedCount} outside range`;
      }
      elements.status.textContent = statusText;
    } else {
      elements.status.textContent = `⚠️ Fetched ${response.count} trades but draw failed`;
    }

  } catch (err) {
    console.error('Fetch trades error:', err);
    elements.status.textContent = `❌ ${err.message}`;
  }

  
  elements.fetchTradesBtn.disabled = false;
  updateButtonStates();
}

/**
 * Clear all VL lines from chart
 */
async function clearChart() {
  if (!tvReady) return;

  try {
    const response = await browser.tabs.sendMessage(currentTabId, {
      type: 'CLEAR_DRAWN'
    });

    if (response?.success) {
      elements.status.textContent = `🗑️ Cleared ${response.removed} levels from chart`;
    }
  } catch (err) {
    console.error('Clear error:', err);
    elements.status.textContent = `❌ Clear failed: ${err.message}`;
  }
}



/**
 * Toggle debug mode
 */
async function toggleDebug() {
  const enabled = elements.debugToggle.checked;
  await browser.storage.local.set({ debugMode: enabled });
  await browser.runtime.sendMessage({ type: 'SET_DEBUG', enabled });
}

/**
 * Handle level count selection change
 */
async function handleLevelCountChange() {
  const levelCount = parseInt(elements.levelCountSelect.value, 10);
  await browser.storage.local.set({ levelCount });
  console.log('⚙️ Level count set to:', levelCount);
}

/**
 * Handle trade count selection change
 */
async function handleTradeCountChange() {
  const tradeCount = parseInt(elements.tradeCountSelect.value, 10);
  await browser.storage.local.set({ tradeCount });
  console.log('⚙️ Trade count set to:', tradeCount);
}

function normalizeColorForDraw(value, fallback) {
  let color = value?.trim().toUpperCase() || fallback;
  if (color && !color.startsWith('#')) {
    color = '#' + color;
  }

  return /^#[0-9A-F]{6}$/.test(color) ? color : fallback;
}

async function handleTradeLitColorChange() {
  let color = elements.tradeLitColorInput.value.trim().toUpperCase();

  if (color && !color.startsWith('#')) {
    color = '#' + color;
    elements.tradeLitColorInput.value = color;
  }

  if (!/^#[0-9A-F]{6}$/.test(color)) {
    return;
  }

  await browser.storage.local.set({ tradeLitColor: color });
  console.log('🎨 Lit trade color set to:', color);
}

async function handleTradeDarkPoolColorChange() {
  let color = elements.tradeDarkPoolColorInput.value.trim().toUpperCase();

  if (color && !color.startsWith('#')) {
    color = '#' + color;
    elements.tradeDarkPoolColorInput.value = color;
  }

  if (!/^#[0-9A-F]{6}$/.test(color)) {
    return;
  }

  await browser.storage.local.set({ tradeDarkPoolColor: color });
  console.log('🎨 Dark pool trade color set to:', color);
}

async function handleTradeThicknessChange() {
  const thickness = parseInt(elements.tradeThicknessSelect.value, 10);
  await browser.storage.local.set({ tradeThickness: thickness });
  console.log('⚙️ Trade thickness set to:', thickness);
}

async function handleShowOriginalTradeRankToggle() {
  const enabled = elements.showOriginalTradeRankToggle.checked;
  await browser.storage.local.set({ showOriginalTradeRank: enabled });
  console.log('⚙️ Show original trade rank enabled:', enabled);
}

/**
 * Handle year range selection change
 */
async function handleYearRangeChange() {
  const yearRange = parseInt(elements.yearRangeSelect.value, 10);
  await browser.storage.local.set({ yearRange });
  console.log('⚙️ Year range set to:', yearRange);
}

/**
 * Handle clustering toggle change
 */
async function handleClusteringToggle() {
  const enabled = elements.clusteringToggle.checked;
  await browser.storage.local.set({ clusteringEnabled: enabled });
  updateThresholdVisibility();
  console.log('⚙️ Clustering enabled:', enabled);
}

/**
 * Handle cluster threshold selection change
 */
async function handleThresholdChange() {
  const threshold = parseFloat(elements.thresholdSelect.value);
  await browser.storage.local.set({ clusterThreshold: threshold });
  console.log('⚙️ Cluster threshold set to:', threshold + '%');
}

/**
 * Handle line color change
 */
async function handleLineColorChange() {
  let color = elements.lineColorInput.value.trim().toUpperCase();

  // Add # if missing
  if (color && !color.startsWith('#')) {
    color = '#' + color;
    elements.lineColorInput.value = color;
  }

  // Validate hex color format
  if (!/^#[0-9A-F]{6}$/.test(color)) {
    return; // Invalid, don't save
  }

  await browser.storage.local.set({ lineColor: color });
  console.log('🎨 Line color set to:', color);
}

/**
 * Handle line thickness selection change
 */
async function handleLineThicknessChange() {
  const thickness = parseInt(elements.lineThicknessSelect.value, 10);
  await browser.storage.local.set({ lineThickness: thickness });
  console.log('⚙️ Line thickness set to:', thickness);
}

async function handleLineOpacityChange() {
  const opacity = parseInt(elements.lineOpacitySelect.value, 10);
  await browser.storage.local.set({ lineOpacity: opacity });
  console.log('⚙️ Line opacity set to:', opacity + '%');
}

/**
 * Handle show dates toggle change
 */
async function handleShowDatesToggle() {
  const enabled = elements.showDatesToggle.checked;
  await browser.storage.local.set({ showDates: enabled });
  console.log('⚙️ Show dates enabled:', enabled);
}

/**
 * Update threshold row visibility based on clustering toggle
 */
function updateThresholdVisibility() {
  elements.thresholdRow.style.display =
    elements.clusteringToggle.checked ? 'flex' : 'none';
}



/**
 * Set up event listeners
 */
function setupEventListeners() {
  elements.fetchDrawBtn.addEventListener('click', fetchAndDraw);
  elements.fetchTradesBtn.addEventListener('click', fetchAndDrawTrades);
  elements.clearChartBtn.addEventListener('click', clearChart);



  elements.debugToggle.addEventListener('change', toggleDebug);
  elements.levelCountSelect.addEventListener('change', handleLevelCountChange);
  elements.tradeCountSelect.addEventListener('change', handleTradeCountChange);
  elements.yearRangeSelect.addEventListener('change', handleYearRangeChange);
  elements.clusteringToggle.addEventListener('change', handleClusteringToggle);
  elements.thresholdSelect.addEventListener('change', handleThresholdChange);
  elements.lineColorInput.addEventListener('input', handleLineColorChange);
  elements.lineThicknessSelect.addEventListener('change', handleLineThicknessChange);
  elements.lineOpacitySelect.addEventListener('change', handleLineOpacityChange);
  elements.showDatesToggle.addEventListener('change', handleShowDatesToggle);
  elements.tradeLitColorInput.addEventListener('input', handleTradeLitColorChange);
  elements.tradeDarkPoolColorInput.addEventListener('input', handleTradeDarkPoolColorChange);
  elements.tradeThicknessSelect.addEventListener('change', handleTradeThicknessChange);
  elements.showOriginalTradeRankToggle.addEventListener('change', handleShowOriginalTradeRankToggle);

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${tab.dataset.tab}-tab`).classList.add('active');
    });
  });




}

// 🚀 Start
init();
