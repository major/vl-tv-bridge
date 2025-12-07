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
   */
  async function drawLevels(levels, options = {}) {
    console.log(`🎯 CONTENT: drawLevels called with ${levels.length} levels:`, levels.map(l => l.price));

    // Clear existing VL shapes first
    try {
      const clearResult = await sendToInjected('CLEAR_VL_SHAPES');
      console.log(`🧹 Cleared ${clearResult.removed} existing VL shapes`);
    } catch (err) {
      console.warn('Could not clear existing VL shapes:', err);
    }

    const results = [];

    for (const level of levels) {
      try {
        const result = await sendToInjected('DRAW_LINE', {
          price: level.price,
          label: level.label || `VL ${level.price}`,
          options: {
            linecolor: options.color || '#02A9DE',
            linewidth: options.width || 2,
            linestyle: options.style || 0, // Solid
            ...options
          }
        });

        if (result.shapeId) {
          drawnShapeIds.push(result.shapeId);
          results.push({ price: level.price, shapeId: result.shapeId, success: true });
        }
      } catch (err) {
        console.error('❌ Failed to draw level:', level.price, err);
        results.push({ price: level.price, success: false, error: err.message });
      }
    }

    // Save drawn shape IDs for cleanup
    await browser.storage.local.set({ drawnShapeIds });

    return {
      success: true,
      drawn: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
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
