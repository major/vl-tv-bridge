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

// DOM elements
const elements = {
  status: document.getElementById('status'),
  tvStatus: document.getElementById('tv-status'),
  vlStatus: document.getElementById('vl-status'),
  chartSymbol: document.getElementById('chart-symbol'),
  fetchDrawBtn: document.getElementById('fetch-draw-btn'),
  clearChartBtn: document.getElementById('clear-chart-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  levelCount: document.getElementById('level-count'),
  levelsList: document.getElementById('levels-list'),
  drawCachedBtn: document.getElementById('draw-cached-btn'),
  clearCacheBtn: document.getElementById('clear-cache-btn'),
  symbolInput: document.getElementById('symbol-input'),
  priceInput: document.getElementById('price-input'),
  addBtn: document.getElementById('add-btn'),
  debugToggle: document.getElementById('debug-toggle'),
  levelCountSelect: document.getElementById('level-count-select'),
  yearRangeSelect: document.getElementById('year-range-select'),
  clusteringToggle: document.getElementById('clustering-toggle'),
  thresholdSelect: document.getElementById('threshold-select'),
  thresholdRow: document.getElementById('threshold-row')
};

// State
let levels = {};
let tvReady = false;
let vlReady = false;
let currentSymbol = null;
let currentTabId = null;

/**
 * Initialize popup
 */
async function init() {
  console.log('🎛️ Popup initialized');

  // Get current tab
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tabs[0]?.id;

  // Load cached levels
  await loadLevels();

  // Check statuses in parallel
  await Promise.all([
    checkTradingView(tabs[0]),
    checkVlAuth()
  ]);

  // Load settings
  const stored = await browser.storage.local.get([
    'debugMode', 'levelCount', 'yearRange', 'clusteringEnabled', 'clusterThreshold'
  ]);
  elements.debugToggle.checked = stored.debugMode || false;
  elements.levelCountSelect.value = stored.levelCount ?? 10;
  elements.yearRangeSelect.value = stored.yearRange ?? 5;
  elements.clusteringToggle.checked = stored.clusteringEnabled !== false; // Default true
  elements.thresholdSelect.value = stored.clusterThreshold ?? 1.0;
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

  elements.clearChartBtn.disabled = !tvReady;

  const hasCachedLevels = Object.values(levels).flat().length > 0;
  elements.drawCachedBtn.disabled = !tvReady || !hasCachedLevels;
}

/**
 * Load cached levels from storage
 */
async function loadLevels() {
  const stored = await browser.storage.local.get('tradeLevels');
  levels = stored.tradeLevels || {};
  renderLevels();
}

/**
 * Render cached levels list
 */
function renderLevels() {
  const symbols = Object.keys(levels);
  const totalCount = Object.values(levels).flat().length;

  elements.levelCount.textContent = totalCount;

  if (totalCount === 0) {
    elements.levelsList.innerHTML = `<div class="empty">No levels cached yet.</div>`;
    return;
  }

  let html = '';

  for (const symbol of symbols.sort()) {
    const symbolLevels = levels[symbol] || [];
    if (symbolLevels.length === 0) continue;

    html += `<div class="symbol-group">
      <div class="symbol-header">${symbol} (${symbolLevels.length})</div>`;

    const sorted = symbolLevels.sort((a, b) => {
      if (a.rank && b.rank) return a.rank - b.rank;
      return b.price - a.price;
    });

    for (const level of sorted) {
      const rankBadge = level.rank ? `<span class="rank">#${level.rank}</span>` : '';
      const dollarInfo = level.dollars ? formatDollars(level.dollars) : '';

      html += `
        <div class="level-item" data-symbol="${symbol}" data-price="${level.price}">
          ${rankBadge}
          <span class="price">$${level.price.toFixed(2)}</span>
          <span class="dollars">${dollarInfo}</span>
          <button class="remove" title="Remove">×</button>
        </div>`;
    }

    html += '</div>';
  }

  elements.levelsList.innerHTML = html;

  // Add remove handlers
  elements.levelsList.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', handleRemoveLevel);
  });
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
  elements.fetchDrawBtn.textContent = '⏳ Fetching...';
  elements.status.textContent = `Fetching levels for ${currentSymbol}...`;

  try {
    // Send fetch request with tabId - background script handles drawing
    // This ensures draw happens even if popup closes during fetch
    const response = await browser.runtime.sendMessage({
      type: 'FETCH_VL_LEVELS',
      symbol: currentSymbol,
      tabId: currentTabId,
      drawOptions: {
        color: '#02A9DE',
        width: 2,
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

    // Reload cached levels
    await loadLevels();

  } catch (err) {
    console.error('Fetch & Draw error:', err);
    elements.status.textContent = `❌ ${err.message}`;
  }

  elements.fetchDrawBtn.textContent = '🚀 Fetch & Draw VL Levels';
  elements.fetchDrawBtn.disabled = false;
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
 * Draw cached levels on chart
 */
async function drawCachedLevels() {
  if (!tvReady) return;

  const allLevels = Object.values(levels).flat();
  if (allLevels.length === 0) {
    elements.status.textContent = 'No cached levels to draw';
    return;
  }

  elements.drawCachedBtn.disabled = true;
  elements.status.textContent = 'Drawing cached levels...';

  try {
    // Filter for current symbol if we have one
    let levelsToDraw = allLevels;
    if (currentSymbol && levels[currentSymbol]) {
      levelsToDraw = levels[currentSymbol];
    }

    const levelsWithLabels = levelsToDraw.map(level => ({
      ...level,
      label: formatLevelLabel(level)
    }));

    const response = await browser.tabs.sendMessage(currentTabId, {
      type: 'DRAW_LEVELS',
      levels: levelsWithLabels,
      options: {
        color: '#02A9DE',
        width: 2,
        style: 0
      }
    });

    if (response?.success) {
      elements.status.textContent = `✅ Drew ${response.drawn} cached levels`;
    }
  } catch (err) {
    console.error('Draw cached error:', err);
    elements.status.textContent = `❌ ${err.message}`;
  }

  elements.drawCachedBtn.disabled = false;
}

/**
 * Clear cached levels
 */
async function clearCache() {
  levels = {};
  await browser.storage.local.set({ tradeLevels: {} });
  renderLevels();
  updateButtonStates();
  elements.status.textContent = '🗑️ Cache cleared';
}

/**
 * Remove a single cached level
 */
async function handleRemoveLevel(e) {
  const item = e.target.closest('.level-item');
  const symbol = item.dataset.symbol;
  const price = parseFloat(item.dataset.price);

  if (levels[symbol]) {
    levels[symbol] = levels[symbol].filter(l => l.price !== price);
    if (levels[symbol].length === 0) {
      delete levels[symbol];
    }
  }

  await browser.storage.local.set({ tradeLevels: levels });
  renderLevels();
  updateButtonStates();
}

/**
 * Add a manual level
 */
async function addManualLevel() {
  const symbol = elements.symbolInput.value.trim().toUpperCase() || currentSymbol;
  const price = parseFloat(elements.priceInput.value);

  if (!symbol || isNaN(price)) {
    elements.status.textContent = '❌ Enter symbol and price';
    return;
  }

  if (!levels[symbol]) {
    levels[symbol] = [];
  }

  if (!levels[symbol].find(l => l.price === price)) {
    levels[symbol].push({
      price,
      symbol,
      timestamp: Date.now(),
      source: 'manual'
    });
  }

  await browser.storage.local.set({ tradeLevels: levels });
  renderLevels();
  updateButtonStates();

  elements.symbolInput.value = '';
  elements.priceInput.value = '';
  elements.status.textContent = `✅ Added ${symbol} @ $${price.toFixed(2)}`;
}

/**
 * Refresh status checks
 */
async function refresh() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tabs[0]?.id;
  tvReady = false;
  vlReady = false;
  currentSymbol = null;

  await Promise.all([
    checkTradingView(tabs[0]),
    checkVlAuth()
  ]);

  updateButtonStates();
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
 * Update threshold row visibility based on clustering toggle
 */
function updateThresholdVisibility() {
  elements.thresholdRow.style.display =
    elements.clusteringToggle.checked ? 'flex' : 'none';
}

/**
 * Toggle collapsible sections
 */
function toggleSection(e) {
  const header = e.target.closest('.section-header');
  if (!header) return;

  const targetId = header.dataset.toggle;
  const content = document.getElementById(targetId);
  if (content) {
    content.classList.toggle('collapsed');
    const chevron = header.querySelector('.chevron');
    if (chevron) {
      chevron.style.transform = content.classList.contains('collapsed') ? 'rotate(-90deg)' : '';
    }
  }
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
  elements.fetchDrawBtn.addEventListener('click', fetchAndDraw);
  elements.clearChartBtn.addEventListener('click', clearChart);
  elements.refreshBtn.addEventListener('click', refresh);
  elements.drawCachedBtn.addEventListener('click', drawCachedLevels);
  elements.clearCacheBtn.addEventListener('click', clearCache);
  elements.addBtn.addEventListener('click', addManualLevel);
  elements.debugToggle.addEventListener('change', toggleDebug);
  elements.levelCountSelect.addEventListener('change', handleLevelCountChange);
  elements.yearRangeSelect.addEventListener('change', handleYearRangeChange);
  elements.clusteringToggle.addEventListener('change', handleClusteringToggle);
  elements.thresholdSelect.addEventListener('change', handleThresholdChange);

  // Collapsible sections
  document.querySelectorAll('.section-header').forEach(header => {
    header.addEventListener('click', toggleSection);
  });

  // Enter key on price input
  elements.priceInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addManualLevel();
  });
}

// 🚀 Start
init();
