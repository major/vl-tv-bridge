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
  tradeLabelPosition: 'right'
};

/**
 * Table-driven setting descriptors. Each entry knows how to read its control(s),
 * write a stored value back into the control, and save changes to storage.
 * This replaces the old pile of near-identical change handlers.
 *
 * `color` settings also carry `swatchId`/`panelId`/`label`, used to build a custom
 * in-popup color picker (see createColorPicker) instead of a native <input type="color">.
 */
const SETTINGS = [
  { key: 'levelCount', group: 'levels', type: 'radio', name: 'levelCount', parse: toInt },
  { key: 'yearRange', group: 'levels', type: 'select', id: 'year-range-select', parse: toInt },
  { key: 'showDates', group: 'levels', type: 'switch', id: 'show-dates-toggle' },
  {
    key: 'lineColor', group: 'levels', type: 'color', id: 'line-color-input', hexId: 'line-color-hex',
    swatchId: 'line-color-swatch', panelId: 'line-color-panel', label: 'level line color',
    onChange: updateLinePreview
  },
  { key: 'lineThickness', group: 'levels', type: 'range', id: 'line-thickness-range', valueId: 'line-thickness-value', suffix: ' px', parse: toInt, onChange: updateLinePreview },
  { key: 'lineOpacity', group: 'levels', type: 'radio', name: 'lineOpacity', parse: toInt, onChange: updateLinePreview },
  { key: 'tradeCount', group: 'trades', type: 'radio', name: 'tradeCount', parse: toInt },
  {
    key: 'tradeLitColor', group: 'trades', type: 'color', id: 'trade-lit-color-input', hexId: 'trade-lit-color-hex',
    swatchId: 'trade-lit-color-swatch', panelId: 'trade-lit-color-panel', label: 'lit trade color'
  },
  {
    key: 'tradeDarkPoolColor', group: 'trades', type: 'color', id: 'trade-dark-pool-color-input', hexId: 'trade-dark-pool-color-hex',
    swatchId: 'trade-dark-pool-color-swatch', panelId: 'trade-dark-pool-color-panel', label: 'dark pool trade color'
  },
  { key: 'tradeThickness', group: 'trades', type: 'range', id: 'trade-thickness-range', valueId: 'trade-thickness-value', suffix: ' px', parse: toInt },
  { key: 'showOriginalTradeRank', group: 'trades', type: 'switch', id: 'show-original-trade-rank-toggle' },
  { key: 'tradeLabelPosition', group: 'trades', type: 'radio', name: 'tradeLabelPosition' },
  { key: 'debugMode', group: 'more', type: 'switch', id: 'debug-toggle', onChange: sendDebugMode }
];

/**
 * Preset swatches shown in every color picker panel: the three stored defaults
 * plus a small TradingView-like palette, so common colors are one click away.
 */
const PRESET_COLORS = [
  '#2962FF', '#92CBF9', '#F4A460', '#F23645', '#089981', '#FF9800',
  '#FFEB3B', '#9C27B0', '#00BCD4', '#E91E63', '#4CAF50', '#3F51B5',
  '#795548', '#FFFFFF', '#000000'
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
      document.getElementById(setting.hexId).textContent = normalized;
      colorPickers[setting.id]?.setColor(normalized);
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
 * Not used for 'color' settings: those save through scheduleColorSave instead, so
 * drags can apply live without writing to storage on every pointer move.
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
      // Wired separately by setupColorPickers(); the picker calls scheduleColorSave
      // directly so drag updates can apply live without saving on every pointer move.
      break;
    default:
      break;
  }
}

/** Every live color picker instance, keyed by its setting's hidden input id. */
const colorPickers = {};

/** Pending debounced storage writes for color settings, keyed by setting.key. */
const pendingColorSaves = new Map();

/**
 * Saves a color setting's value to storage. While dragging (not `committing`),
 * writes are debounced by ~150ms so a pointer drag does not spam storage.local.
 * On commit (pointerup, Enter, Done, preset click) the write happens right away.
 */
function scheduleColorSave(setting, hex, committing) {
  const pending = pendingColorSaves.get(setting.key);
  if (pending) {
    clearTimeout(pending);
    pendingColorSaves.delete(setting.key);
  }
  if (committing) {
    browser.storage.local.set({ [setting.key]: hex });
    return;
  }
  const timer = setTimeout(() => {
    pendingColorSaves.delete(setting.key);
    browser.storage.local.set({ [setting.key]: hex });
  }, 150);
  pendingColorSaves.set(setting.key, timer);
}

/**
 * Creates a self-contained color picker UI inside `panelEl`, opened by clicking
 * `swatchEl`. This replaces native <input type="color">, which on Linux opens the
 * GTK system color dialog and steals focus from the popup, closing it before a
 * color can be picked. Everything here lives inside the popup's own DOM instead.
 *
 * `onChange(hex, { committing })` fires on every color change. `committing` is
 * false during a drag or while typing, and true when the change should be
 * treated as final (pointerup, Enter, Done, or a preset click).
 */
function createColorPicker({ swatchEl, hexLabelEl, panelEl, label, initial, onChange }) {
  let hex = normalizeHexOrDefault(initial, '#000000');
  let hsv = hexToHsv(hex);
  let isOpen = false;

  const svSquare = document.createElement('div');
  svSquare.className = 'sv-square';
  svSquare.tabIndex = 0;
  svSquare.setAttribute('role', 'slider');
  svSquare.setAttribute('aria-label', `${label} saturation and brightness`);
  svSquare.setAttribute('aria-valuemin', '0');
  svSquare.setAttribute('aria-valuemax', '100');

  const svThumb = document.createElement('div');
  svThumb.className = 'sv-thumb';
  svSquare.appendChild(svThumb);

  const hueRange = document.createElement('input');
  hueRange.type = 'range';
  hueRange.min = '0';
  hueRange.max = '359';
  hueRange.className = 'hue-range';
  hueRange.setAttribute('aria-label', `${label} hue`);

  const presetRow = document.createElement('div');
  presetRow.className = 'preset-row';
  const presetButtons = PRESET_COLORS.map((presetHex) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-swatch';
    btn.style.backgroundColor = presetHex;
    btn.dataset.hex = presetHex;
    btn.setAttribute('aria-label', `Use color ${presetHex}`);
    presetRow.appendChild(btn);
    return btn;
  });

  const hexRow = document.createElement('div');
  hexRow.className = 'hex-input-row';
  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.className = 'hex-input';
  hexInput.maxLength = 7;
  hexInput.placeholder = '#RRGGBB';
  hexInput.setAttribute('aria-label', `${label} hex value`);
  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'btn text picker-done';
  doneBtn.textContent = 'Done';
  hexRow.append(hexInput, doneBtn);

  const hexError = document.createElement('div');
  hexError.className = 'hex-error hidden';
  hexError.textContent = 'Enter 6 hex digits, like 2962FF';
  hexError.setAttribute('role', 'alert');

  panelEl.append(svSquare, hueRange, presetRow, hexRow, hexError);

  /** Shows or hides the "invalid hex" error message and marks the hex input accordingly. */
  function setHexError(show) {
    hexError.classList.toggle('hidden', !show);
    hexInput.classList.toggle('invalid', show);
  }

  /** Syncs every visual (swatch, hex label, sv thumb, hue slider, presets, hex input) to current state. */
  function renderVisuals() {
    swatchEl.style.setProperty('--swatch-color', hex);
    swatchEl.setAttribute('aria-label', `Change ${label}, current ${hex}`);
    hexLabelEl.textContent = hex;
    svSquare.style.setProperty('--hue', String(hsv.h));
    svSquare.setAttribute('aria-valuetext', `Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`);
    svThumb.style.left = `${hsv.s * 100}%`;
    svThumb.style.top = `${(1 - hsv.v) * 100}%`;
    hueRange.value = String(Math.round(hsv.h));
    presetButtons.forEach((btn) => {
      btn.classList.toggle('selected', btn.dataset.hex === hex);
    });
    if (document.activeElement !== hexInput) {
      hexInput.value = hex;
    }
    setHexError(false);
  }

  /** Recomputes the hex from the current HSV state, updates visuals, and notifies the caller. */
  function commitHsv(committing) {
    hex = hsvToHex(hsv.h, hsv.s, hsv.v);
    renderVisuals();
    onChange(hex, { committing });
  }

  /** Reads a pointer position within the sv square and updates saturation/value. */
  function setFromPoint(clientX, clientY, committing) {
    const rect = svSquare.getBoundingClientRect();
    const s = rect.width === 0 ? hsv.s : clamp((clientX - rect.left) / rect.width, 0, 1);
    const v = rect.height === 0 ? hsv.v : clamp(1 - (clientY - rect.top) / rect.height, 0, 1);
    hsv = { ...hsv, s, v };
    commitHsv(committing);
  }

  svSquare.addEventListener('pointerdown', (event) => {
    svSquare.setPointerCapture(event.pointerId);
    setFromPoint(event.clientX, event.clientY, false);
  });
  svSquare.addEventListener('pointermove', (event) => {
    if (event.buttons !== 1) return;
    setFromPoint(event.clientX, event.clientY, false);
  });
  svSquare.addEventListener('pointerup', (event) => {
    setFromPoint(event.clientX, event.clientY, true);
  });
  svSquare.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    let handled = true;
    if (event.key === 'ArrowLeft') hsv = { ...hsv, s: clamp(hsv.s - step, 0, 1) };
    else if (event.key === 'ArrowRight') hsv = { ...hsv, s: clamp(hsv.s + step, 0, 1) };
    else if (event.key === 'ArrowUp') hsv = { ...hsv, v: clamp(hsv.v + step, 0, 1) };
    else if (event.key === 'ArrowDown') hsv = { ...hsv, v: clamp(hsv.v - step, 0, 1) };
    else handled = false;
    if (handled) {
      event.preventDefault();
      commitHsv(true);
    }
  });

  hueRange.addEventListener('input', () => {
    hsv = { ...hsv, h: toInt(hueRange.value) };
    commitHsv(false);
  });
  hueRange.addEventListener('change', () => {
    hsv = { ...hsv, h: toInt(hueRange.value) };
    commitHsv(true);
  });

  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      hsv = hexToHsv(btn.dataset.hex);
      commitHsv(true);
    });
  });

  /** Validates and applies the hex input's current text, showing an error instead of saving if invalid. */
  function applyHexInput(committing) {
    const raw = hexInput.value.trim();
    if (raw === '') return;
    const candidate = normalizeHexOrDefault(raw, '');
    if (!candidate) {
      setHexError(true);
      return;
    }
    hsv = hexToHsv(candidate);
    commitHsv(committing);
  }

  hexInput.addEventListener('input', () => applyHexInput(false));
  hexInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyHexInput(true);
    }
  });
  doneBtn.addEventListener('click', () => {
    if (hexInput.value.trim() !== '') {
      applyHexInput(true);
    }
    close();
  });

  panelEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      swatchEl.focus();
    }
  });

  /** Opens this picker's panel, closing any other open picker first. */
  function open() {
    Object.values(colorPickers).forEach((other) => {
      if (other !== picker && other.isOpen()) other.close();
    });
    panelEl.classList.remove('hidden');
    swatchEl.setAttribute('aria-expanded', 'true');
    isOpen = true;
    renderVisuals();
  }

  /** Closes this picker's panel. */
  function close() {
    panelEl.classList.add('hidden');
    swatchEl.setAttribute('aria-expanded', 'false');
    isOpen = false;
  }

  swatchEl.addEventListener('click', () => {
    if (isOpen) {
      close();
      swatchEl.focus();
    } else {
      open();
    }
  });

  const picker = {
    /** Updates the picker to show `newHex` without firing onChange (used when loading/resetting settings). */
    setColor(newHex) {
      hex = normalizeHexOrDefault(newHex, hex);
      hsv = hexToHsv(hex);
      renderVisuals();
    },
    getColor: () => hex,
    isOpen: () => isOpen,
    close
  };

  renderVisuals();
  return picker;
}

/** Closes any open color picker panel when a click lands outside every swatch/panel. */
document.addEventListener('click', (event) => {
  Object.entries(colorPickers).forEach(([, picker]) => {
    if (!picker.isOpen()) return;
    if (picker.panelEl?.contains(event.target) || picker.swatchEl?.contains(event.target)) return;
    picker.close();
  });
});

/**
 * Builds one custom color picker per 'color' setting in SETTINGS, replacing the
 * native color inputs. Must run before loadSettings() so applySetting can sync
 * each picker's visuals to the stored value.
 */
function setupColorPickers() {
  SETTINGS.filter((setting) => setting.type === 'color').forEach((setting) => {
    const swatchEl = document.getElementById(setting.swatchId);
    const hexLabelEl = document.getElementById(setting.hexId);
    const panelEl = document.getElementById(setting.panelId);
    const hiddenInput = document.getElementById(setting.id);

    const picker = createColorPicker({
      swatchEl,
      hexLabelEl,
      panelEl,
      label: setting.label,
      initial: hiddenInput.value,
      onChange: (hex, meta) => {
        hiddenInput.value = hex;
        if (setting.onChange) setting.onChange(hex);
        scheduleColorSave(setting, hex, meta.committing);
      }
    });
    picker.swatchEl = swatchEl;
    picker.panelEl = panelEl;
    colorPickers[setting.id] = picker;
  });
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
  tvStatus: document.getElementById('tv-status'),
  vlStatus: document.getElementById('vl-status'),
  vlLoginHint: document.getElementById('vl-login-hint'),
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

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tabs[0]?.id;

  await Promise.all([
    checkTradingView(tabs[0]),
    checkVlAuth()
  ]);

  setupColorPickers();
  await loadSettings();
  await restoreCustomizeState();
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
    setCheckRow(elements.tvStatus, 'not-ready', 'Open a TradingView chart');
    showChartSymbol('Open a TradingView chart', true);
    tvReady = false;
    return;
  }

  setCheckRow(elements.tvStatus, 'checking', 'Checking chart...');

  try {
    const readyResponse = await browser.tabs.sendMessage(currentTabId, { type: 'CHECK_TV_READY' });

    if (readyResponse?.ready) {
      tvReady = true;
      setCheckRow(elements.tvStatus, 'ready', 'TradingView chart open');

      const symbolResponse = await browser.tabs.sendMessage(currentTabId, { type: 'GET_CURRENT_SYMBOL' });
      if (symbolResponse?.symbol) {
        currentSymbol = symbolResponse.symbol;
        showChartSymbol(currentSymbol, false);
      } else {
        showChartSymbol('Could not detect symbol', true);
      }
    } else {
      tvReady = false;
      setCheckRow(elements.tvStatus, 'not-ready', 'Wait for chart to load');
      showChartSymbol('Wait for chart to load', true);
    }
  } catch (err) {
    console.error('Failed to check TV status:', err);
    tvReady = false;
    setCheckRow(elements.tvStatus, 'not-ready', 'Refresh the TradingView page');
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
  setCheckRow(elements.vlStatus, 'checking', 'Checking VL login...');
  elements.vlLoginHint.classList.add('hidden');

  try {
    const response = await browser.runtime.sendMessage({ type: 'CHECK_VL_AUTH' });
    if (response?.authenticated) {
      setCheckRow(elements.vlStatus, 'ready', 'Logged in to VL');
    } else {
      setCheckRow(elements.vlStatus, 'unverified', 'Log in to VolumeLeaders');
      elements.vlLoginHint.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Failed to check VL auth:', err);
    setCheckRow(elements.vlStatus, 'unverified', 'Log in to VolumeLeaders');
    elements.vlLoginHint.classList.remove('hidden');
  }
}

/** Sets the state class and text of a setup checklist row. */
function setCheckRow(row, state, text) {
  row.className = `check-row ${state}`;
  row.querySelector('.text').textContent = text;
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
      stopWorking(elements.fetchDrawBtn, 'success', `✅ Drew ${response.drawResult.drawn} levels for ${currentSymbol}`);
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
