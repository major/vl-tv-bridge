/**
 * VL TradingView Bridge - Content Script (runs on TradingView.com)
 *
 * Bridges communication between the extension popup/background
 * and the injected script that has access to TradingViewApi.
 */

// Only run in top frame (TradingView uses iframes)
if (window !== window.top) {
  // Skip iframes
} else if (window.vlTvBridgeLoaded) {
  console.log('🌉 VL-TV Bridge: Already loaded, skipping duplicate');
} else {
  window.vlTvBridgeLoaded = true;
  console.log('🌉 VL-TV Bridge: Content script loaded on TradingView');

  const DRAWING_STORAGE_PREFIX = 'vlDrawings:';
  const ALERT_STORAGE_PREFIX = 'vlAlerts:';
  const ALERT_SCOPES = ['off', 'top1', 'top3', 'all'];
  const ALERT_COUNT_KEYS = ['created', 'deleted', 'kept', 'skipped', 'failed'];
  const COUNTRY_SUFFIXES = ['.US', '.UK', '.DE', '.FR', '.JP', '.HK', '.AU', '.CA'];
  let drawingQueue = Promise.resolve();

  /**
   * Inject the script that will have access to TradingViewApi.
   */
  function injectScript() {
    if (document.getElementById('vl-tv-injected')) {
      console.log('💉 Injected script already present');
      return;
    }

    const script = document.createElement('script');
    script.id = 'vl-tv-injected';
    script.src = browser.runtime.getURL('injected.js');
    script.onload = () => {
      console.log('💉 Injected script loaded');
      script.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  /**
   * Add a chart drawing operation to the serialized runtime queue.
   * @param {Function} operation - The async drawing operation to run.
   * @returns {Promise<*>} The operation result.
   */
  function queueDrawingOperation(operation) {
    const queuedOperation = drawingQueue.then(operation);
    drawingQueue = queuedOperation.catch(() => {});
    return queuedOperation;
  }

  /**
   * Listen for messages from the extension popup/background.
   */
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('📨 Content script received:', message);

    switch (message.type) {
      case 'DRAW_LEVELS':
        queueDrawingOperation(() => drawLevels(message.levels, message.options, message.symbol))
          .then(sendResponse)
          .catch(err => sendResponse({ success: false, drawn: 0, failed: 0, levels: 0, results: [], error: err.message }));
        return true;

      case 'CLEAR_DRAWN':
        queueDrawingOperation(clearDrawnLevels)
          .then(sendResponse)
          .catch(err => sendResponse({ success: false, removed: 0, results: [], error: err.message }));
        return true;

      case 'DRAW_NOTES':
        queueDrawingOperation(() => drawNotes(message.trades, message.options, message.symbol))
          .then(sendResponse)
          .catch(err => sendResponse({ success: false, drawn: 0, skipped: 0, failed: 0, darkPoolCount: 0, litCount: 0, results: [], error: err.message }));
        return true;

      case 'CHECK_TV_READY':
        checkTradingViewReady()
          .then(ready => sendResponse({ ready }))
          .catch(() => sendResponse({ ready: false }));
        return true;

      case 'GET_CURRENT_SYMBOL':
        getCurrentSymbol()
          .then(symbol => sendResponse({ symbol }))
          .catch(() => sendResponse({ symbol: null }));
        return true;

      case 'GET_VISIBLE_RANGE':
        sendToInjected('GET_VISIBLE_RANGE')
          .then(range => sendResponse({ range }))
          .catch(() => sendResponse({ range: null }));
        return true;
    }
  });

  /**
   * Send a command to the injected script and wait for its response.
   * @param {string} command - The injected-script command.
   * @param {Object} data - Command data.
   * @param {number} timeoutMs - Maximum wait time in milliseconds.
   * @returns {Promise<*>} The injected-script result.
   */
  function sendToInjected(command, data = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const messageId = Date.now().toString(36) + Math.random().toString(36);
      let timeoutId;

      const handler = event => {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== 'vl-tv-injected') return;
        if (event.data.messageId !== messageId) return;

        clearTimeout(timeoutId);
        window.removeEventListener('message', handler);

        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.result);
        }
      };

      window.addEventListener('message', handler);
      timeoutId = setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(new Error('Timeout waiting for injected script response'));
      }, timeoutMs);

      window.postMessage({
        source: 'vl-tv-content',
        messageId,
        command,
        data
      }, '*');
    });
  }

  /**
   * Check whether the TradingView API is ready.
   * @returns {Promise<boolean>} True when the chart API is ready.
   */
  async function checkTradingViewReady() {
    try {
      const result = await sendToInjected('CHECK_READY');
      return result.ready;
    } catch {
      return false;
    }
  }

  /**
   * Get the current chart symbol.
   * @returns {Promise<string|null>} The current symbol, or null if unavailable.
   */
  async function getCurrentSymbol() {
    try {
      const result = await sendToInjected('GET_SYMBOL');
      return result.symbol;
    } catch {
      return null;
    }
  }

  /**
   * Normalize a TradingView symbol for comparison.
   * @param {string} symbol - The symbol from a message or chart context.
   * @returns {string|null} The normalized ticker, or null for invalid input.
   */
  function normalizeSymbol(symbol) {
    if (typeof symbol !== 'string' || !symbol.trim()) return null;

    let ticker = symbol.trim().toUpperCase().split(':').pop();
    for (const suffix of COUNTRY_SUFFIXES) {
      if (ticker.endsWith(suffix)) {
        ticker = ticker.slice(0, -suffix.length);
        break;
      }
    }
    return ticker || null;
  }

  /**
   * Get the active drawing context and validate an optional expected symbol.
   * @param {string} expectedSymbol - Expected TradingView symbol, when supplied.
   * @returns {Promise<Object>} The validated context returned by the injected script.
   */
  async function getDrawingContext(expectedSymbol) {
    const context = await sendToInjected('GET_DRAWING_CONTEXT');
    if (!context || typeof context.key !== 'string' || !context.key || typeof context.symbol !== 'string') {
      throw new Error('Invalid TradingView drawing context');
    }

    if (expectedSymbol !== undefined && expectedSymbol !== null) {
      const expected = normalizeSymbol(expectedSymbol);
      const actual = normalizeSymbol(context.symbol);
      if (!expected || !actual || expected !== actual) {
        throw new Error(`Chart symbol mismatch: expected ${expectedSymbol}, found ${context.symbol}`);
      }
    }

    return context;
  }

  /**
   * Build the storage key for one chart context and drawing category.
   * @param {Object} context - A validated chart context.
   * @param {string} kind - The drawing category, either levels or trades.
   * @returns {string} The scoped storage key.
   */
  function getDrawingStorageKey(context, kind) {
    return `${DRAWING_STORAGE_PREFIX}${context.key}:${kind}`;
  }

  /**
   * Read stored records (drawings or alerts) for one storage key.
   * @param {string} storageKey - The scoped storage key.
   * @returns {Promise<Array>} Previously saved opaque records, or an empty array.
   */
  async function readStoredRecords(storageKey) {
    const stored = await browser.storage.local.get(storageKey);
    const records = stored?.[storageKey];
    if (records === undefined) return [];
    if (!Array.isArray(records)) throw new Error(`Invalid stored records for ${storageKey}`);
    return records;
  }

  /**
   * Convert the core reconciliation response into a validated result.
   * @param {*} result - The injected script response.
   * @returns {Object} A validated response or a descriptive error.
   */
  function validateReconciliationResult(result, expectedResultCount) {
    if (!result || typeof result !== 'object' || typeof result.success !== 'boolean' ||
        !Array.isArray(result.results) || result.results.length !== expectedResultCount || !Array.isArray(result.records)) {
      throw new Error('Invalid drawing reconciliation response');
    }

    if (result.results.some(itemResult => !itemResult || typeof itemResult !== 'object' ||
        (typeof itemResult.success !== 'boolean' && itemResult.skipped !== true))) {
      throw new Error('Invalid per-item drawing reconciliation result');
    }

    const removed = Array.isArray(result.removed) ? result.removed.length : result.removed;
    if (!Number.isFinite(removed) || removed < 0) {
      throw new Error('Invalid removed count in drawing reconciliation response');
    }

    return { ...result, removed };
  }

  /**
   * Reconcile drawings for one scope and persist the core's returned records.
   * @param {Object} context - The validated active chart context.
   * @param {string} kind - The drawing category.
   * @param {Array} items - Normalized drawing items.
   * @returns {Promise<Object>} The reconciliation result and storage outcome.
   */
  async function reconcileDrawings(context, kind, items) {
    const storageKey = getDrawingStorageKey(context, kind);
    const records = await readStoredRecords(storageKey);
    const coreResponse = await sendToInjected('RECONCILE_DRAWINGS', {
      kind,
      items,
      records,
      context
    }, 30000);
    const result = validateReconciliationResult(coreResponse, items.length);

    try {
      await browser.storage.local.set({ [storageKey]: result.records });
    } catch (err) {
      return { ...result, success: false, error: err.message || 'Could not save drawing records' };
    }

    return result;
  }

  /**
   * Coerce a stored alert scope setting into a known value.
   * @param {*} value - The stored scope setting.
   * @returns {string} One of off, top1, top3, or all. Unknown values mean off.
   */
  function normalizeAlertScope(value) {
    return ALERT_SCOPES.includes(value) ? value : 'off';
  }

  /** How many of the best-ranked drawn items each limited scope keeps. */
  const ALERT_SCOPE_LIMITS = { top1: 1, top3: 3 };

  /**
   * Pick the successfully drawn items that should have alerts for one scope.
   * Limited scopes keep the best-ranked drawn items by position, not by rank value.
   * VL level ranks are all-time ranks, so a short lookback can draw #2, #5, #7;
   * "top3" then means those three, not only all-time #1 to #3.
   * Items without an integer rank only qualify for the all scope.
   * @param {Array} results - Merged per-item drawing results.
   * @param {string} scope - The alert scope setting.
   * @returns {Array<{shapeId: string, price: number}>} Desired alert targets.
   */
  function selectAlertTargets(results, scope) {
    const normalizedScope = normalizeAlertScope(scope);
    if (normalizedScope === 'off') return [];

    let drawn = results.filter(result => result.success === true);
    if (normalizedScope !== 'all') {
      drawn = drawn
        .filter(result => Number.isInteger(result.rank))
        .sort((left, right) => left.rank - right.rank)
        .slice(0, ALERT_SCOPE_LIMITS[normalizedScope]);
    }
    return drawn.map(result => ({ shapeId: result.shapeId, price: result.price }));
  }

  /**
   * Build the storage key for one chart context and alert kind.
   * @param {Object} context - A validated chart context.
   * @param {string} kind - The drawing category, either levels or trades.
   * @returns {string} The scoped alert storage key.
   */
  function getAlertStorageKey(context, kind) {
    return `${ALERT_STORAGE_PREFIX}${context.key}:${kind}`;
  }

  /**
   * Read the alert scope setting for one drawing category.
   * @param {string} kind - The drawing category, either levels or trades.
   * @returns {Promise<string>} The normalized alert scope.
   */
  async function readAlertScope(kind) {
    const scopeKey = kind === 'levels' ? 'levelAlertScope' : 'tradeAlertScope';
    const stored = await browser.storage.local.get(scopeKey);
    return normalizeAlertScope(stored?.[scopeKey]);
  }

  /**
   * Convert the injected SYNC_ALERTS response into the public alert summary.
   * @param {Object} syncResult - A non-null object returned by the injected script.
   * @returns {Object} Alert counts, with error and the first errors when the sync reported failures.
   */
  function summarizeAlertResult(syncResult) {
    const summary = {};
    for (const key of ALERT_COUNT_KEYS) {
      summary[key] = Number.isFinite(syncResult[key]) ? syncResult[key] : 0;
    }
    if (syncResult.success === true) return summary;

    const errors = Array.isArray(syncResult.errors) ? syncResult.errors.filter(Boolean) : [];
    return { ...summary, error: errors.join('; ') || 'Alert sync failed', errors: errors.slice(0, 3) };
  }

  /**
   * Sync TradingView alerts for one drawing category with the drawings just reconciled.
   * Never throws: failures are reported in the returned summary only.
   * Skips the bridge call when alerts are off and nothing is stored.
   * @param {Object} context - The validated active chart context.
   * @param {string} kind - The drawing category, either levels or trades.
   * @param {Array} results - Merged per-item drawing results. Pass [] to delete all tracked alerts.
   * @returns {Promise<Object>} Alert counts, plus error when the sync failed.
   */
  async function syncAlerts(context, kind, results) {
    const zeroCounts = Object.fromEntries(ALERT_COUNT_KEYS.map(key => [key, 0]));
    try {
      const scope = await readAlertScope(kind);
      const storageKey = getAlertStorageKey(context, kind);
      const records = await readStoredRecords(storageKey);
      if (scope === 'off' && records.length === 0) return zeroCounts;

      const syncResult = await sendToInjected('SYNC_ALERTS', {
        kind,
        context: { key: context.key },
        desired: selectAlertTargets(results, scope),
        records
      }, 30000);
      if (!syncResult || typeof syncResult !== 'object') throw new Error('Invalid alert sync response');
      if (!syncResult.success || syncResult.failed > 0 || syncResult.skipped > 0) console.warn('🔔 VL alert sync', syncResult);

      if (Array.isArray(syncResult.records)) {
        await browser.storage.local.set({ [storageKey]: syncResult.records });
      }
      return summarizeAlertResult(syncResult);
    } catch (err) {
      return { ...zeroCounts, error: err.message || 'Could not sync alerts' };
    }
  }

  /**
   * Add several alert summaries into one, joining any error messages.
   * @param {Array<Object>} summaries - Alert summaries from syncAlerts.
   * @returns {Object} The combined alert summary.
   */
  function combineAlertSummaries(summaries) {
    const combined = Object.fromEntries(ALERT_COUNT_KEYS.map(key => [key, 0]));
    const errors = [];
    const details = [];
    for (const summary of summaries) {
      for (const key of ALERT_COUNT_KEYS) combined[key] += summary[key];
      if (summary.error) errors.push(summary.error);
      if (Array.isArray(summary.errors)) details.push(...summary.errors);
    }
    return errors.length ? { ...combined, error: errors.join('; '), errors: details.slice(0, 3) } : combined;
  }

  /**
   * Convert core item results into the original response shape with source metadata.
   * @param {Array} items - The submitted normalized items.
   * @param {Array} coreResults - The core's per-item results.
   * @returns {Array} Results aligned to submitted items.
   */
  function mergeItemResults(items, coreResults) {
    return items.map((item, index) => {
      const coreResult = coreResults[index];
      if (!coreResult || typeof coreResult !== 'object') {
        return { ...item, success: false, error: 'Missing drawing result' };
      }
      return {
        ...item,
        ...coreResult,
        ...(Object.hasOwn(item, 'darkPool') ? { darkPool: item.darkPool } : {})
      };
    });
  }

  /**
   * Create a failed level response for errors before usable core results exist.
   * @param {string} error - The failure message.
   * @returns {Object} The levels response contract with zero counts.
   */
  function failedLevelsResponse(error, failed = 0) {
    return { success: false, drawn: 0, failed, levels: 0, results: [], removed: 0, error };
  }

  /**
   * Create a failed trades response for errors before usable core results exist.
   * @param {string} error - The failure message.
   * @returns {Object} The trades response contract with zero counts.
   */
  function failedTradesResponse(error, failed = 0) {
    return { success: false, drawn: 0, skipped: 0, failed, darkPoolCount: 0, litCount: 0, results: [], removed: 0, error };
  }

  /**
   * Draw or reconcile trade levels in one scoped batch.
   * @param {Array} levels - Background-provided levels.
   * @param {Object} options - Drawing style options.
   * @param {string} expectedSymbol - Expected symbol, when provided.
   * @returns {Promise<Object>} The levels drawing response.
   */
  async function drawLevels(levels, options = {}, expectedSymbol) {
    if (!Array.isArray(levels)) return failedLevelsResponse('Levels must be an array');

    const items = levels.map(item => ({
      type: 'level',
      price: item?.price,
      timestamp: item?.timestamp,
      rank: item?.rank,
      label: item?.label || `VL ${item?.price}`,
      options: {
        linecolor: options.color || '#02A9DE',
        linewidth: options.width || 2,
        lineopacity: options.opacity ?? 100,
        linestyle: options.style || 0
      }
    }));

    try {
      const context = await getDrawingContext(expectedSymbol);
      const coreResult = await reconcileDrawings(context, 'levels', items);
      const results = mergeItemResults(items, coreResult.results);
      const successfulResults = results.filter(result => result.success === true);
      const failed = results.filter(result => result.success !== true).length;
      const drawn = successfulResults.length;
      const alerts = await syncAlerts(context, 'levels', results);
      const response = {
        success: coreResult.success && failed === 0,
        drawn,
        failed,
        levels: successfulResults.filter(result => result.type === 'level').length,
        results,
        removed: coreResult.removed,
        alerts
      };
      if (coreResult.error) response.error = coreResult.error;
      return response;
    } catch (err) {
      return failedLevelsResponse(err.message || 'Could not reconcile levels', items.length);
    }
  }

  /**
   * Draw or reconcile trade markers in one scoped batch.
   * @param {Array} trades - Background-provided trades.
   * @param {Object} options - Trade drawing style options.
   * @param {string} expectedSymbol - Expected symbol, when provided.
   * @returns {Promise<Object>} The trades drawing response.
   */
  async function drawNotes(trades, options = {}, expectedSymbol) {
    if (!Array.isArray(trades)) return failedTradesResponse('Trades must be an array');

    const items = trades.map(trade => ({
      price: trade.price,
      timestamp: trade.timestamp,
      rank: trade.rank,
      originalRank: trade.originalRank,
      darkPool: trade.darkPool,
      sweep: trade.sweep,
      dollarVolume: trade.dollarVolume ?? trade.dollars,
      options
    }));

    try {
      const context = await getDrawingContext(expectedSymbol);
      const coreResult = await reconcileDrawings(context, 'trades', items);
      const results = mergeItemResults(items, coreResult.results);
      const successfulResults = results.filter(result => result.success === true);
      const skipped = results.filter(result => result.skipped === true).length;
      const failed = results.filter(result => result.success !== true && result.skipped !== true).length;
      const darkPoolCount = successfulResults.filter(result => result.darkPool).length;
      const alerts = await syncAlerts(context, 'trades', results);
      const response = {
        success: coreResult.success && failed === 0,
        drawn: successfulResults.length,
        skipped,
        failed,
        darkPoolCount,
        litCount: successfulResults.length - darkPoolCount,
        results,
        removed: coreResult.removed,
        alerts
      };
      if (coreResult.error) response.error = coreResult.error;
      return response;
    } catch (err) {
      return failedTradesResponse(err.message || 'Could not reconcile trades', items.length);
    }
  }

  /**
   * Clear levels and trades from only the active chart context.
   * Each cleared category also deletes its tracked alerts; alert failures
   * are reported in alerts and never change success.
   * @returns {Promise<Object>} The aggregate clear response.
   */
  async function clearDrawnLevels() {
    let context;
    try {
      context = await getDrawingContext();
    } catch (err) {
      return { success: false, removed: 0, results: [], error: err.message || 'Could not get chart context' };
    }

    const results = [];
    const errors = [];
    const alertSummaries = [];
    let removed = 0;
    let success = true;

    for (const kind of ['levels', 'trades']) {
      try {
        const result = await reconcileDrawings(context, kind, []);
        removed += result.removed;
        results.push(...result.results);
        if (!result.success) success = false;
        if (result.error) errors.push(result.error);
        alertSummaries.push(await syncAlerts(context, kind, []));
      } catch (err) {
        success = false;
        errors.push(err.message || `Could not clear ${kind}`);
      }
    }

    const response = { success, removed, results, alerts: combineAlertSummaries(alertSummaries) };
    if (errors.length) response.error = errors.join('; ');
    return response;
  }

  // 🚀 Initialize without loading the obsolete global shape-ID tracker.
  injectScript();
}
