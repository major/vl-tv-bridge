/**
 * VL TradingView Bridge - Popup Script
 * One-click workflow: Detect TV symbol -> Fetch VL levels/trades -> Draw on chart
 */

/** Stage text shown while a background fetch is in progress. */
const STAGE_TEXT = {
  range: 'Reading chart date range',
  fetch: 'Fetching from VolumeLeaders',
  draw: 'Drawing on chart'
};

/** Default values for every stored setting, keyed the same way as storage. */
const DEFAULTS = {
  debugMode: false,
  levelCount: 10,
  yearRange: 5,
  lineColor: '#2962FF',
  lineThickness: 2,
  lineOpacity: 100,
  showDates: false,
  tradeCount: 5,
  tradeLitColor: '#92CBF9',
  tradeDarkPoolColor: '#F4A460',
  tradeThickness: 1,
  showOriginalTradeRank: false,
  tradeLabelPosition: 'right',
  levelAlertScope: 'off',
  tradeAlertScope: 'off'
};

/**
 * Table-driven setting descriptors. Each entry knows how to read its control(s),
 * write a stored value back into the control, and save changes to storage.
 * This replaces the old pile of near-identical change handlers.
 *
 * `color` settings also carry `swatchId` (the decorative color swatch) and `errorId`
 * (the message shown for an invalid hex code), both next to their hex text input.
 */
const SETTINGS = [
  { key: 'levelCount', group: 'levels', type: 'radio', name: 'levelCount', parse: toInt },
  { key: 'yearRange', group: 'levels', type: 'select', id: 'year-range-select', parse: toInt },
  { key: 'showDates', group: 'levels', type: 'switch', id: 'show-dates-toggle' },
  {
    key: 'lineColor', group: 'levels', type: 'color', id: 'line-color-input',
    swatchId: 'line-color-swatch', errorId: 'line-color-error', onChange: updateLinePreview
  },
  { key: 'lineThickness', group: 'levels', type: 'range', id: 'line-thickness-range', valueId: 'line-thickness-value', suffix: ' px', parse: toInt, onChange: updateLinePreview },
  { key: 'lineOpacity', group: 'levels', type: 'radio', name: 'lineOpacity', parse: toInt, onChange: updateLinePreview },
  { key: 'levelAlertScope', group: 'levels', type: 'select', id: 'level-alert-scope-select' },
  { key: 'tradeCount', group: 'trades', type: 'radio', name: 'tradeCount', parse: toInt },
  {
    key: 'tradeLitColor', group: 'trades', type: 'color', id: 'trade-lit-color-input',
    swatchId: 'trade-lit-color-swatch', errorId: 'trade-lit-color-error'
  },
  {
    key: 'tradeDarkPoolColor', group: 'trades', type: 'color', id: 'trade-dark-pool-color-input',
    swatchId: 'trade-dark-pool-color-swatch', errorId: 'trade-dark-pool-color-error'
  },
  { key: 'tradeThickness', group: 'trades', type: 'range', id: 'trade-thickness-range', valueId: 'trade-thickness-value', suffix: ' px', parse: toInt },
  { key: 'showOriginalTradeRank', group: 'trades', type: 'switch', id: 'show-original-trade-rank-toggle' },
  { key: 'tradeLabelPosition', group: 'trades', type: 'radio', name: 'tradeLabelPosition' },
  { key: 'tradeAlertScope', group: 'trades', type: 'select', id: 'trade-alert-scope-select' },
  { key: 'debugMode', group: 'more', type: 'switch', id: 'debug-toggle', onChange: sendDebugMode }
];

/** Parses an integer, falling back to NaN (caller supplies the real default). */
function toInt(value) {
  return parseInt(value, 10);
}

/** Returns the checked radio value for a given `name`, or null if none checked. */
function getRadioValue(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : null;
}

/** Checks the radio in `name` group whose value matches `value`. */
function setRadioValue(name, value) {
  const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (radio) {
    radio.checked = true;
  }
}

/**
 * Reads the current value of a setting's control(s), normalized to its stored type.
 */
function readSetting(setting) {
  switch (setting.type) {
    case 'radio': {
      const raw = getRadioValue(setting.name);
      if (raw === null) return DEFAULTS[setting.key];
      return setting.parse ? setting.parse(raw) : raw;
    }
    case 'select': {
      const el = document.getElementById(setting.id);
      const raw = setting.parse ? setting.parse(el.value) : el.value;
      return Number.isNaN(raw) ? DEFAULTS[setting.key] : raw;
    }
    case 'switch':
      return document.getElementById(setting.id).checked;
    case 'color': {
      const el = document.getElementById(setting.id);
      return normalizeHexOrDefault(el.value, DEFAULTS[setting.key]);
    }
    case 'range': {
      const el = document.getElementById(setting.id);
      const raw = setting.parse ? setting.parse(el.value) : el.value;
      return Number.isNaN(raw) ? DEFAULTS[setting.key] : raw;
    }
    default:
      return DEFAULTS[setting.key];
  }
}

/**
 * Applies a stored value to a setting's control(s), including any companion
 * display element (hex label, range value, etc).
 */
function applySetting(setting, value) {
  const resolved = value === undefined || value === null ? DEFAULTS[setting.key] : value;
  switch (setting.type) {
    case 'radio':
      setRadioValue(setting.name, resolved);
      break;
    case 'select':
      document.getElementById(setting.id).value = resolved;
      break;
    case 'switch':
      document.getElementById(setting.id).checked = Boolean(resolved);
      break;
    case 'color': {
      const normalized = normalizeHexOrDefault(resolved, DEFAULTS[setting.key]);
      document.getElementById(setting.id).value = normalized;
      showColorValue(setting, normalized);
      break;
    }
    case 'range': {
      document.getElementById(setting.id).value = resolved;
      document.getElementById(setting.valueId).textContent = `${resolved}${setting.suffix || ''}`;
      break;
    }
    default:
      break;
  }
}

/**
 * Saves a setting's current control value to storage and runs its onChange hook.
 * Color settings use it too; their input handler calls it once the hex code is valid.
 */
async function saveSetting(setting) {
  const value = readSetting(setting);
  if (setting.type === 'range') {
    document.getElementById(setting.valueId).textContent = `${value}${setting.suffix || ''}`;
  }
  await browser.storage.local.set({ [setting.key]: value });
  if (setting.onChange) {
    setting.onChange(value);
  }
}

/** Wires change/input listeners for a single setting descriptor. */
function wireSetting(setting) {
  const save = () => saveSetting(setting);
  switch (setting.type) {
    case 'radio':
      document.querySelectorAll(`input[name="${setting.name}"]`).forEach((el) => {
        el.addEventListener('change', save);
      });
      break;
    case 'select':
    case 'switch':
      document.getElementById(setting.id).addEventListener('change', save);
      break;
    case 'range':
      document.getElementById(setting.id).addEventListener('input', save);
      break;
    case 'color':
      wireColorInput(setting);
      break;
    default:
      break;
  }
}

/**
 * Wires a hex text input. A valid code applies live and saves. Invalid text is
 * flagged but never saved. On blur, the text snaps back to the last saved color.
 */
function wireColorInput(setting) {
  const input = document.getElementById(setting.id);
  input.addEventListener('input', () => {
    const hex = normalizeHexOrDefault(input.value, null);
    if (hex) {
      showColorValue(setting, hex);
      saveSetting(setting);
      return;
    }
    // Only flag the error once the text is as long as a full code, like #2962FF,
    // so the field does not turn red while the user is still typing.
    if (input.value.trim().length >= 7) {
      flagColorError(setting);
    } else {
      clearColorError(setting);
    }
  });
  input.addEventListener('blur', () => {
    const hex = normalizeHexOrDefault(input.value, input.dataset.savedHex);
    input.value = hex;
    showColorValue(setting, hex);
  });
}

/**
 * Shows a valid color in a color setting's swatch and remembers it as the last
 * saved value, so a bad edit can revert to it on blur.
 */
function showColorValue(setting, hex) {
  document.getElementById(setting.id).dataset.savedHex = hex;
  document.getElementById(setting.swatchId).style.backgroundColor = hex;
  clearColorError(setting);
}

/** Clears the invalid state and hides the error message for a color input. */
function clearColorError(setting) {
  document.getElementById(setting.id).removeAttribute('aria-invalid');
  document.getElementById(setting.errorId).classList.add('hidden');
}

/** Marks a color input as invalid and shows its error message. */
function flagColorError(setting) {
  document.getElementById(setting.id).setAttribute('aria-invalid', 'true');
  document.getElementById(setting.errorId).classList.remove('hidden');
}

/**
 * Builds a short status suffix describing alert sync results, or '' when there
 * is nothing worth reporting. `alerts` comes from a DRAW_LEVELS/DRAW_NOTES
 * response's `alerts` field: `{ created, deleted, kept, skipped, failed, error }`.
 */
function alertsNote(alerts) {
  if (!alerts) return '';
  const parts = [];
  if (alerts.created) parts.push(`${alerts.created} added`);
  if (alerts.deleted) parts.push(`${alerts.deleted} removed`);
  if (alerts.skipped) parts.push(`${alerts.skipped} skipped (already had alerts)`);
  if (alerts.failed) parts.push(`${alerts.failed} failed`);
  if (parts.length === 0) return '';
  const firstError = alerts.failed ? firstAlertError(alerts) : '';
  return ` · 🔔 ${parts.join(', ')}${firstError ? `: ${firstError}` : ''}`;
}

/** Returns the first alert error text, cut to 80 characters for the status line. */
function firstAlertError(alerts) {
  const text = (Array.isArray(alerts.errors) && alerts.errors[0]) || alerts.error || '';
  return text.slice(0, 80);
}

/** Sends the current debug mode to the background script. */
async function sendDebugMode(enabled) {
  await browser.runtime.sendMessage({ type: 'SET_DEBUG', enabled });
}

/** Updates the sample line in the Levels tab to reflect color, thickness, and opacity. */
function updateLinePreview() {
  const line = document.querySelector('#line-preview line');
  if (!line) return;
  const color = normalizeHexOrDefault(elements.lineColorInput.value, DEFAULTS.lineColor);
  const thickness = toInt(elements.lineThicknessRange.value) || DEFAULTS.lineThickness;
  const opacity = toInt(getRadioValue('lineOpacity')) || DEFAULTS.lineOpacity;
  line.style.stroke = color;
  line.style.strokeWidth = String(thickness);
  line.style.strokeOpacity = String(opacity / 100);
}

/** Resets every setting in a group (levels/trades) to its default value. */
async function resetGroup(group) {
  const updates = {};
  SETTINGS.filter((s) => s.group === group).forEach((setting) => {
    updates[setting.key] = DEFAULTS[setting.key];
    applySetting(setting, DEFAULTS[setting.key]);
  });
  await browser.storage.local.set(updates);
  if (group === 'levels') {
    updateLinePreview();
  }
}

// DOM elements
const elements = {
  version: document.getElementById('version'),
  status: document.getElementById('status'),
  statusMain: document.getElementById('status-main'),
  statusTip: document.getElementById('status-tip'),
  tvLight: document.getElementById('tv-light'),
  vlLight: document.getElementById('vl-light'),
  openVlBtn: document.getElementById('open-vl-btn'),
  chartSymbol: document.getElementById('chart-symbol'),
  fetchDrawBtn: document.getElementById('fetch-draw-btn'),
  fetchDrawHint: document.getElementById('fetch-draw-hint'),
  fetchTradesBtn: document.getElementById('fetch-trades-btn'),
  fetchTradesHint: document.getElementById('fetch-trades-hint'),
  clearChartBtn: document.getElementById('clear-chart-btn'),
  clearChartHint: document.getElementById('clear-chart-hint'),
  customize: document.getElementById('customize'),
  lineColorInput: document.getElementById('line-color-input'),
  lineThicknessRange: document.getElementById('line-thickness-range'),
  linePreview: document.getElementById('line-preview')
};

// State
let tvReady = false;
let currentSymbol = null;
let currentTabId = null;
let activeAction = null; // 'levels' | 'trades' | null while a fetch is in flight
let progressStage = null;
let progressStep = 0;
let progressTotal = 0;
let startTime = null;
let elapsedTimerId = null;
let tipTimerId = null;

/**
 * Initializes the popup: loads version/settings, checks readiness, and wires events.
 */
async function init() {
  const manifest = browser.runtime.getManifest();
  elements.version.textContent = `v${manifest.version}`;

  // Load settings first so controls and swatches show saved values right away,
  // even while the slower TradingView and VL checks are still running.
  await loadSettings();
  await restoreCustomizeState();

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tabs[0]?.id;

  await Promise.all([
    checkTradingView(tabs[0]),
    checkVlAuth()
  ]);

  setupEventListeners();
  updateButtonStates();
}

/** Loads all stored settings and applies them to their controls. */
async function loadSettings() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  SETTINGS.forEach((setting) => {
    applySetting(setting, stored[setting.key] ?? DEFAULTS[setting.key]);
  });
  updateLinePreview();
}

/** Restores whether the Customize panel was open and which tab was active. */
async function restoreCustomizeState() {
  const stored = await browser.storage.local.get(['customizeOpen', 'customizeTab']);
  elements.customize.open = Boolean(stored.customizeOpen);
  switchTab(stored.customizeTab || 'levels');
}

/**
 * Checks if the active tab is TradingView, whether the chart API is ready,
 * and reads the current chart symbol.
 */
async function checkTradingView(tab) {
  const isTradingView = tab?.url?.includes('tradingview.com');

  if (!isTradingView) {
    setLight(elements.tvLight, 'not-ready', 'Open a TradingView chart');
    showChartSymbol('Open a TradingView chart', true);
    tvReady = false;
    return;
  }

  setLight(elements.tvLight, 'checking', 'Checking chart...');

  try {
    const readyResponse = await browser.tabs.sendMessage(currentTabId, { type: 'CHECK_TV_READY' });

    if (readyResponse?.ready) {
      tvReady = true;
      setLight(elements.tvLight, 'ready', 'TradingView chart open');

      const symbolResponse = await browser.tabs.sendMessage(currentTabId, { type: 'GET_CURRENT_SYMBOL' });
      if (symbolResponse?.symbol) {
        currentSymbol = symbolResponse.symbol;
        showChartSymbol(currentSymbol, false);
      } else {
        showChartSymbol('Could not detect symbol', true);
      }
    } else {
      tvReady = false;
      setLight(elements.tvLight, 'not-ready', 'Wait for chart to load');
      showChartSymbol('Wait for chart to load', true);
    }
  } catch (err) {
    console.error('Failed to check TV status:', err);
    tvReady = false;
    setLight(elements.tvLight, 'not-ready', 'Refresh the TradingView page');
    showChartSymbol('Refresh the TradingView page', true);
  }
}

/** Shows the detected chart symbol, or a plain-language hint when unavailable. */
function showChartSymbol(text, isEmpty) {
  elements.chartSymbol.textContent = text;
  elements.chartSymbol.classList.toggle('empty', isEmpty);
}

/**
 * Checks VolumeLeaders login status and shows a login link when it is missing.
 */
async function checkVlAuth() {
  setLight(elements.vlLight, 'checking', 'Checking VL login...');
  elements.openVlBtn.classList.add('hidden');

  try {
    const response = await browser.runtime.sendMessage({ type: 'CHECK_VL_AUTH' });
    if (response?.authenticated) {
      setLight(elements.vlLight, 'ready', 'Logged in to VL');
    } else {
      setLight(elements.vlLight, 'not-ready', 'Log in to VolumeLeaders');
      elements.openVlBtn.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Failed to check VL auth:', err);
    setLight(elements.vlLight, 'not-ready', 'Log in to VolumeLeaders');
    elements.openVlBtn.classList.remove('hidden');
  }
}

/**
 * Sets the state class and accessible name of a status light. The full state
 * text becomes both the hover tooltip (`title`) and the screen-reader label
 * (`aria-label`), since the visible row only shows a dot and a short code.
 */
function setLight(light, state, text) {
  light.className = `light ${state}`;
  light.title = text;
  light.setAttribute('aria-label', text);
}

/**
 * Enables/disables action buttons based on readiness, and shows a short hint
 * under each disabled button explaining why it can't be used yet.
 */
function updateButtonStates() {
  const working = activeAction !== null;
  const canFetch = tvReady && Boolean(currentSymbol);

  elements.fetchDrawBtn.disabled = working || !canFetch;
  elements.fetchTradesBtn.disabled = working || !canFetch;
  elements.clearChartBtn.disabled = working || !tvReady;

  setHint(elements.fetchDrawHint, working ? '' : fetchHintText(canFetch));
  setHint(elements.fetchTradesHint, working ? '' : fetchHintText(canFetch));
  setHint(elements.clearChartHint, working || tvReady ? '' : 'Open a chart first');
}

/** Returns the plain-language reason a fetch button is disabled, or '' when enabled. */
function fetchHintText(canFetch) {
  if (canFetch) return '';
  if (!tvReady) return 'Open a chart first';
  return 'Waiting for a chart symbol';
}

/** Shows or hides a hint element under a button. */
function setHint(el, text) {
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

/**
 * Sets the status area's style and message. Clears any lingering tip.
 */
function setStatus(kind, text) {
  elements.status.className = `status ${kind}`;
  elements.statusMain.textContent = text;
  elements.statusTip.classList.add('hidden');
  elements.statusTip.textContent = '';
}

/** Shows the "this can take a while" tip under the status message. */
function showSlowTip() {
  elements.statusTip.textContent = 'This can take a while for busy tickers. You can close this popup. Drawing will still finish.';
  elements.statusTip.classList.remove('hidden');
}

/** Renders the live elapsed-time progress message while a fetch is in flight. */
function renderProgress() {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const stageText = progressStage || STAGE_TEXT.fetch;
  // Only show "Step X of Y" when there is more than one real step to report
  const stepText = progressTotal > 1 ? `Step ${progressStep} of ${progressTotal}: ` : '';
  elements.status.className = 'status info';
  elements.statusMain.textContent = `${stepText}${stageText}... ${elapsed}s`;
}

/**
 * Puts a button into "working" state: spinner, locked buttons, live timer,
 * and a background message listener for step progress.
 */
function startWorking(btn, action) {
  activeAction = action;
  progressStage = null;
  progressStep = 0;
  progressTotal = 0;
  startTime = Date.now();

  const label = btn.querySelector('.btn-label');
  label.dataset.originalText = label.textContent;
  label.textContent = 'Working...';
  btn.classList.add('working');
  updateButtonStates();

  renderProgress();
  elapsedTimerId = setInterval(renderProgress, 1000);
  tipTimerId = setTimeout(showSlowTip, 8000);
}

/** Ends "working" state and shows the final result message. */
function stopWorking(btn, kind, text) {
  clearInterval(elapsedTimerId);
  clearTimeout(tipTimerId);
  elapsedTimerId = null;
  tipTimerId = null;
  activeAction = null;

  const label = btn.querySelector('.btn-label');
  if (label.dataset.originalText) {
    label.textContent = label.dataset.originalText;
  }
  btn.classList.remove('working');
  setStatus(kind, text);
  updateButtonStates();
}

/** Listens for FETCH_PROGRESS messages from the background script. */
browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'FETCH_PROGRESS') return;
  if (!activeAction || message.action !== activeAction) return;
  progressStage = STAGE_TEXT[message.stage] || progressStage;
  progressStep = message.step || 0;
  progressTotal = message.totalSteps || 0;
  renderProgress();
});

/**
 * Main action: fetch VL levels for the current symbol and draw them on the chart.
 */
async function fetchAndDraw() {
  if (!currentSymbol) {
    setStatus('error', '❌ No symbol detected');
    return;
  }

  startWorking(elements.fetchDrawBtn, 'levels');

  try {
    const lineColor = normalizeHexOrDefault(elements.lineColorInput.value, DEFAULTS.lineColor);
    const lineThickness = toInt(elements.lineThicknessRange.value) || DEFAULTS.lineThickness;
    const lineOpacity = toInt(getRadioValue('lineOpacity')) || DEFAULTS.lineOpacity;

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

    if (!response?.success) {
      throw new Error(response?.error || 'VolumeLeaders session could not be verified');
    }

    if (response.levels.length === 0) {
      stopWorking(elements.fetchDrawBtn, 'warning', `No VL levels found for ${currentSymbol}`);
    } else if (response.drawResult?.success) {
      const note = alertsNote(response.drawResult.alerts);
      stopWorking(elements.fetchDrawBtn, 'success', `✅ Drew ${response.drawResult.drawn} levels for ${currentSymbol}${note}`);
    } else {
      stopWorking(elements.fetchDrawBtn, 'warning', `⚠️ Fetched ${response.count} levels but draw failed`);
    }
  } catch (err) {
    console.error('Fetch & Draw error:', err);
    stopWorking(elements.fetchDrawBtn, 'error', `❌ ${err.message}`);
  }
}

/**
 * Fetch VL large trades for the current symbol and draw them on the chart.
 */
async function fetchAndDrawTrades() {
  if (!currentSymbol) {
    setStatus('error', '❌ No symbol detected');
    return;
  }

  startWorking(elements.fetchTradesBtn, 'trades');

  try {
    const tradeCount = toInt(getRadioValue('tradeCount')) || DEFAULTS.tradeCount;
    const tradeLitColor = normalizeHexOrDefault(document.getElementById('trade-lit-color-input').value, DEFAULTS.tradeLitColor);
    const tradeDarkPoolColor = normalizeHexOrDefault(document.getElementById('trade-dark-pool-color-input').value, DEFAULTS.tradeDarkPoolColor);
    const tradeThickness = toInt(document.getElementById('trade-thickness-range').value) || DEFAULTS.tradeThickness;
    const showOriginalTradeRank = document.getElementById('show-original-trade-rank-toggle').checked;
    const tradeLabelPosition = getRadioValue('tradeLabelPosition') || DEFAULTS.tradeLabelPosition;

    const response = await browser.runtime.sendMessage({
      type: 'FETCH_VL_TRADES',
      symbol: currentSymbol,
      tabId: currentTabId,
      tradeCount,
      drawOptions: {
        tradeLitColor,
        tradeDarkPoolColor,
        tradeThickness,
        showOriginalTradeRank,
        horzLabelsAlign: tradeLabelPosition
      }
    });

    if (!response?.success) {
      throw new Error(response?.error || 'VolumeLeaders session could not be verified');
    }

    if (response.trades.length === 0) {
      stopWorking(elements.fetchTradesBtn, 'warning', `No large trades found for ${currentSymbol}`);
    } else if (response.drawResult?.success) {
      const dpCount = response.drawResult.darkPoolCount || 0;
      const litCount = response.drawResult.litCount || 0;
      const skippedCount = response.drawResult.skipped || 0;
      let statusText = `✅ Drew ${response.drawResult.drawn} trades (🔵 ${litCount} lit, 🟠 ${dpCount} dark pool)`;
      if (skippedCount > 0) {
        statusText += ` · ${skippedCount} outside range`;
      }
      statusText += alertsNote(response.drawResult.alerts);
      stopWorking(elements.fetchTradesBtn, 'success', statusText);
    } else {
      stopWorking(elements.fetchTradesBtn, 'warning', `⚠️ Fetched ${response.count} trades but draw failed`);
    }
  } catch (err) {
    console.error('Fetch trades error:', err);
    stopWorking(elements.fetchTradesBtn, 'error', `❌ ${err.message}`);
  }
}

/**
 * Clears all VL-drawn lines/trades from the chart.
 */
async function clearChart() {
  if (!tvReady) return;

  elements.clearChartBtn.disabled = true;

  try {
    const response = await browser.tabs.sendMessage(currentTabId, { type: 'CLEAR_DRAWN' });
    if (response?.success) {
      setStatus('success', `🗑️ Cleared ${response.removed} levels from chart`);
    }
  } catch (err) {
    console.error('Clear error:', err);
    setStatus('error', `❌ Clear failed: ${err.message}`);
  }

  updateButtonStates();
}

/** Opens the VolumeLeaders login page in a new tab. */
async function openVolumeLeaders() {
  await browser.tabs.create({ url: 'https://www.volumeleaders.com' });
}

/** Switches the active Customize tab and remembers the choice. */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    const isActive = tab.dataset.tab === name;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
  document.querySelectorAll('.tab-content').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `${name}-tab`);
  });
}

/** Sets up every event listener used by the popup. */
function setupEventListeners() {
  elements.fetchDrawBtn.addEventListener('click', fetchAndDraw);
  elements.fetchTradesBtn.addEventListener('click', fetchAndDrawTrades);
  elements.clearChartBtn.addEventListener('click', clearChart);
  elements.openVlBtn.addEventListener('click', openVolumeLeaders);

  SETTINGS.forEach(wireSetting);

  document.getElementById('reset-levels-btn').addEventListener('click', () => resetGroup('levels'));
  document.getElementById('reset-trades-btn').addEventListener('click', () => resetGroup('trades'));

  elements.customize.addEventListener('toggle', () => {
    browser.storage.local.set({ customizeOpen: elements.customize.open });
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
      browser.storage.local.set({ customizeTab: tab.dataset.tab });
    });
  });
}

// 🚀 Start
init();
