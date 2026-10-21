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
          .catch(err => sendResponse({ success: false, drawn: 0, failed: 0, zones: 0, levels: 0, results: [], error: err.message }));
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
   * Read stored drawing records for one chart context and category.
   * @param {string} storageKey - The scoped storage key.
   * @returns {Promise<Array>} Previously saved opaque reconciliation records.
   */
  async function readDrawingRecords(storageKey) {
    const stored = await browser.storage.local.get(storageKey);
    const records = stored?.[storageKey];
    if (records === undefined) return [];
    if (!Array.isArray(records)) throw new Error(`Invalid stored drawing records for ${storageKey}`);
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
    const records = await readDrawingRecords(storageKey);
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
    return { success: false, drawn: 0, failed, zones: 0, levels: 0, results: [], removed: 0, error };
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
   * @param {Array} levels - Background-provided levels and zones.
   * @param {Object} options - Drawing style options.
   * @param {string} expectedSymbol - Expected symbol, when provided.
   * @returns {Promise<Object>} The levels drawing response.
   */
  async function drawLevels(levels, options = {}, expectedSymbol) {
    if (!Array.isArray(levels)) return failedLevelsResponse('Levels must be an array');

    const items = levels.map(item => {
      if (item?.type === 'zone') {
        return {
          type: 'zone',
          highPrice: item.highPrice,
          lowPrice: item.lowPrice,
          midPrice: item.midPrice,
          timestamp: item.timestamp,
          label: item.label,
          levels: Array.isArray(item.levels)
            ? item.levels.map(level => ({ price: level.price, timestamp: level.timestamp }))
            : [],
          options: {
            linecolor: options.color || '#02A9DE',
            linewidth: 4,
            lineopacity: options.opacity ?? 100,
            linestyle: options.style || 0
          }
        };
      }

      return {
        type: 'level',
        price: item?.price,
        timestamp: item?.timestamp,
        label: item?.label || `VL ${item?.price}`,
        options: {
          linecolor: options.color || '#02A9DE',
          linewidth: options.width || 2,
          lineopacity: options.opacity ?? 100,
          linestyle: options.style || 0
        }
      };
    });

    try {
      const context = await getDrawingContext(expectedSymbol);
      const coreResult = await reconcileDrawings(context, 'levels', items);
      const results = mergeItemResults(items, coreResult.results);
      const successfulResults = results.filter(result => result.success === true);
      const failed = results.filter(result => result.success !== true).length;
      const drawn = successfulResults.length;
      const response = {
        success: coreResult.success && failed === 0,
        drawn,
        failed,
        zones: successfulResults.filter(result => result.type === 'zone').length,
        levels: successfulResults.filter(result => result.type === 'level').length,
        results,
        removed: coreResult.removed
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
      const response = {
        success: coreResult.success && failed === 0,
        drawn: successfulResults.length,
        skipped,
        failed,
        darkPoolCount,
        litCount: successfulResults.length - darkPoolCount,
        results,
        removed: coreResult.removed
      };
      if (coreResult.error) response.error = coreResult.error;
      return response;
    } catch (err) {
      return failedTradesResponse(err.message || 'Could not reconcile trades', items.length);
    }
  }

  /**
   * Clear levels and trades from only the active chart context.
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
    let removed = 0;
    let success = true;

    for (const kind of ['levels', 'trades']) {
      try {
        const result = await reconcileDrawings(context, kind, []);
        removed += result.removed;
        results.push(...result.results);
        if (!result.success) success = false;
        if (result.error) errors.push(result.error);
      } catch (err) {
        success = false;
        errors.push(err.message || `Could not clear ${kind}`);
      }
    }

    const response = { success, removed, results };
    if (errors.length) response.error = errors.join('; ');
    return response;
  }

  // 🚀 Initialize without loading the obsolete global shape-ID tracker.
  injectScript();
}
