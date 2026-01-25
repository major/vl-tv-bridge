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
  // Mark as loaded
  window.vlTvBridgeLoaded = true;
  console.log('🌉 VL-TV Bridge: Content script loaded on TradingView');

  // Track drawn shapes for cleanup
  let drawnShapeIds = [];

  /**
   * Inject the script that will have access to TradingViewApi
   */
  function injectScript() {
    // Check if already injected
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
   * Listen for messages from the extension popup/background
   */
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('📨 Content script received:', message);

    switch (message.type) {
      case 'DRAW_LEVELS':
        drawLevels(message.levels, message.options)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Async response

      case 'CLEAR_DRAWN':
        clearDrawnLevels()
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;

      case 'DRAW_NOTES':
        drawNotes(message.trades, message.options)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
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
   * Send command to injected script and wait for response
   */
  function sendToInjected(command, data = {}) {
    return new Promise((resolve, reject) => {
      const messageId = Date.now().toString(36) + Math.random().toString(36);

      const handler = (event) => {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== 'vl-tv-injected') return;
        if (event.data.messageId !== messageId) return;

        window.removeEventListener('message', handler);

        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.result);
        }
      };

      window.addEventListener('message', handler);

      // Timeout after 5 seconds
      setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(new Error('Timeout waiting for injected script response'));
      }, 5000);

      window.postMessage({
        source: 'vl-tv-content',
        messageId,
        command,
        data
      }, '*');
    });
  }

  /**
   * Check if TradingView API is ready
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
   * Get the current chart symbol
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
   * Draw trade levels on the chart
   * First clears any existing VL-prefixed shapes, then draws new ones
   * Handles both single levels (type: 'level') and zones (type: 'zone')
   */
  async function drawLevels(levels, options = {}) {
    const levelCount = levels.filter(l => l.type !== 'zone').length;
    const zoneCount = levels.filter(l => l.type === 'zone').length;
    console.log(`🎯 CONTENT: drawLevels called with ${levelCount} levels and ${zoneCount} zones`);

    // Clear existing VL lines first (keeps circles intact)
    try {
      const clearResult = await sendToInjected('CLEAR_VL_LINES');
      console.log(`🧹 Cleared ${clearResult.removed} existing VL lines`);
    } catch (err) {
      console.warn('Could not clear existing VL lines:', err);
    }

    const results = [];

    for (const item of levels) {
      try {
        let result;

        if (item.type === 'zone') {
          // Draw zone as thick line at midpoint
          result = await sendToInjected('DRAW_ZONE', {
            highPrice: item.highPrice,
            lowPrice: item.lowPrice,
            midPrice: item.midPrice,
            label: item.label,
            options: {
              linecolor: options.color || '#02A9DE',
              linewidth: 4, // Thick line for zones
              linestyle: options.style || 0
            }
          });

          if (result.shapeId) {
            drawnShapeIds.push(result.shapeId);
            results.push({
              type: 'zone',
              midPrice: item.midPrice,
              highPrice: item.highPrice,
              lowPrice: item.lowPrice,
              shapeId: result.shapeId,
              success: true
            });
          }
        } else {
          // Draw single level as normal line
          result = await sendToInjected('DRAW_LINE', {
            price: item.price,
            label: item.label || `VL ${item.price}`,
            options: {
              linecolor: options.color || '#02A9DE',
              linewidth: options.width || 2,
              linestyle: options.style || 0
            }
          });

          if (result.shapeId) {
            drawnShapeIds.push(result.shapeId);
            results.push({ type: 'level', price: item.price, shapeId: result.shapeId, success: true });
          }
        }
      } catch (err) {
        const identifier = item.type === 'zone' ? `zone at ${item.midPrice}` : `level at ${item.price}`;
        console.error(`❌ Failed to draw ${identifier}:`, err);
        results.push({
          type: item.type || 'level',
          price: item.price || item.midPrice,
          success: false,
          error: err.message
        });
      }
    }

    // Save drawn shape IDs for cleanup
    await browser.storage.local.set({ drawnShapeIds });

    return {
      success: true,
      drawn: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      zones: results.filter(r => r.type === 'zone' && r.success).length,
      levels: results.filter(r => r.type === 'level' && r.success).length,
      results
    };
  }

  async function drawNotes(trades, options = {}) {
    console.log(`📝 CONTENT: drawNotes called with ${trades.length} trades`);

    try {
      const clearResult = await sendToInjected('CLEAR_VL_NOTES');
      console.log(`🧹 Cleared ${clearResult.removed} existing VL notes`);
    } catch (err) {
      console.warn('Could not clear existing VL notes:', err);
    }

    const results = [];

    for (const trade of trades) {
      try {
        const result = await sendToInjected('DRAW_NOTE', {
          price: trade.price,
          timestamp: trade.timestamp,
          rank: trade.rank,
          darkPool: trade.darkPool,
          dollarVolume: trade.dollarVolume,
          options: options
        });

        if (result.skipped) {
          results.push({
            price: trade.price,
            rank: trade.rank,
            skipped: true,
            reason: result.reason
          });
        } else if (result.shapeId) {
          drawnShapeIds.push(result.shapeId);
          results.push({
            price: trade.price,
            timestamp: trade.timestamp,
            rank: trade.rank,
            darkPool: trade.darkPool,
            shapeId: result.shapeId,
            success: true
          });
        }
      } catch (err) {
        console.error(`❌ Failed to draw note for trade #${trade.rank}:`, err);
        results.push({
          price: trade.price,
          rank: trade.rank,
          success: false,
          error: err.message
        });
      }
    }

    await browser.storage.local.set({ drawnShapeIds });

    const successCount = results.filter(r => r.success).length;
    const skippedCount = results.filter(r => r.skipped).length;
    const dpCount = results.filter(r => r.success && r.darkPool).length;
    const litCount = successCount - dpCount;

    return {
      success: true,
      drawn: successCount,
      skipped: skippedCount,
      failed: results.filter(r => !r.success && !r.skipped).length,
      darkPoolCount: dpCount,
      litCount: litCount,
      results
    };
  }

  /**
   * Clear all VL-drawn levels from the chart
   */
  async function clearDrawnLevels() {
    const results = [];

    for (const shapeId of drawnShapeIds) {
      try {
        await sendToInjected('REMOVE_SHAPE', { shapeId });
        results.push({ shapeId, success: true });
      } catch (err) {
        results.push({ shapeId, success: false, error: err.message });
      }
    }

    drawnShapeIds = [];
    await browser.storage.local.set({ drawnShapeIds: [] });

    return {
      success: true,
      removed: results.filter(r => r.success).length,
      results
    };
  }

  /**
   * Load previously drawn shape IDs from storage
   */
  async function loadDrawnShapeIds() {
    const stored = await browser.storage.local.get('drawnShapeIds');
    drawnShapeIds = stored.drawnShapeIds || [];
  }

  // 🚀 Initialize
  loadDrawnShapeIds();
  injectScript();
}
