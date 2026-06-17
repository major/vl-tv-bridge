/**
 * VL TradingView Bridge - Injected Script
 *
 * Runs in TradingView page context with access to TradingViewApi.
 * Communicates with content script via postMessage.
 */

(function() {
  'use strict';

  // Prevent multiple instances - critical since script persists across extension reloads
  if (window.vlTvBridgeInjected) {
    console.log('💉 VL-TV Bridge: Injected script already running, skipping');
    return;
  }
  window.vlTvBridgeInjected = true;

  console.log('💉 VL-TV Bridge: Injected into TradingView page context');

  /**
   * Get the TradingView chart API
   */
  function getChartApi() {
    if (typeof TradingViewApi !== 'undefined' && TradingViewApi.activeChart) {
      return TradingViewApi.activeChart();
    }
    return null;
  }

  /**
   * Check if TradingView API is ready
   */
  function checkReady() {
    const chart = getChartApi();
    const ready = chart !== null;

    // Detailed debug info
    const debug = {
      hasTradingViewApi: typeof TradingViewApi !== 'undefined',
      hasActiveChart: typeof TradingViewApi !== 'undefined' && typeof TradingViewApi.activeChart === 'function',
      chartReturned: chart !== null,
      chartType: chart ? typeof chart : 'null'
    };

    if (ready) {
      debug.hasCreateShape = typeof chart.createShape === 'function';
      debug.hasRemoveEntity = typeof chart.removeEntity === 'function';
      debug.hasGetAllShapes = typeof chart.getAllShapes === 'function';
    }

    console.log('🔍 TradingView API check:', debug);

    return { ready, debug };
  }

  /**
   * Get the current chart symbol
   */
  function getSymbol() {
    const chart = getChartApi();

    // Method 1: From chart API
    if (chart) {
      try {
        if (chart.symbol) {
          const sym = typeof chart.symbol === 'function' ? chart.symbol() : chart.symbol;
          if (sym) {
            console.log('📈 Symbol from chart.symbol():', sym);
            return { symbol: cleanSymbol(sym) };
          }
        }
      } catch (e) {
        console.warn('Could not get symbol from chart API:', e);
      }
    }

    // Method 2: From URL
    try {
      const urlMatch = window.location.pathname.match(/\/chart\/[^\/]+\/([A-Z0-9]+)/i) ||
                       window.location.pathname.match(/\/symbols\/([A-Z0-9:]+)/i);
      if (urlMatch) {
        const sym = urlMatch[1];
        console.log('📈 Symbol from URL:', sym);
        return { symbol: cleanSymbol(sym) };
      }
    } catch (e) {
      console.warn('Could not get symbol from URL:', e);
    }

    // Method 3: From page title (usually "SYMBOL — TradingView")
    try {
      const titleMatch = document.title.match(/^([A-Z0-9]+)/);
      if (titleMatch) {
        const sym = titleMatch[1];
        console.log('📈 Symbol from title:', sym);
        return { symbol: cleanSymbol(sym) };
      }
    } catch (e) {
      console.warn('Could not get symbol from title:', e);
    }

    // Method 4: From the symbol search box
    try {
      const symbolEl = document.querySelector('[data-name="legend-source-title"]') ||
                       document.querySelector('.chart-markup-table .pane-legend-title__description') ||
                       document.querySelector('[class*="symbolTitle"]');
      if (symbolEl) {
        const sym = symbolEl.textContent.trim().split(/[\s·]/)[0];
        console.log('📈 Symbol from DOM:', sym);
        return { symbol: cleanSymbol(sym) };
      }
    } catch (e) {
      console.warn('Could not get symbol from DOM:', e);
    }

    console.warn('⚠️ Could not determine chart symbol');
    return { symbol: null };
  }

  /**
   * Clean symbol string (remove exchange prefix and country suffixes, preserve share classes)
   */
  function cleanSymbol(sym) {
    if (!sym) return null;

    // Remove exchange prefix (e.g., "NASDAQ:AAPL" -> "AAPL")
    const parts = sym.split(':');
    let ticker = parts[parts.length - 1].toUpperCase();

    // Strip country suffixes (.US, .UK, etc.) but preserve share class suffixes (.A, .B)
    const countrySuffixes = ['.US', '.UK', '.DE', '.FR', '.JP', '.HK', '.AU', '.CA'];
    for (const suffix of countrySuffixes) {
      if (ticker.endsWith(suffix)) {
        ticker = ticker.slice(0, -suffix.length);
        break;
      }
    }

    return ticker;
  }

  /**
   * Draw a horizontal line on the chart
   */
  async function drawLine(data) {
    const chart = getChartApi();
    if (!chart) {
      const error = 'TradingView chart API not available';
      console.error('❌', error);
      console.error('🔍 Debug: typeof TradingViewApi =', typeof TradingViewApi);
      if (typeof TradingViewApi !== 'undefined') {
        console.error('🔍 Debug: TradingViewApi.activeChart =', typeof TradingViewApi.activeChart);
      }
      throw new Error(error);
    }

    const { price, label, options = {} } = data;

    // Default styling - VL cyan theme
    // Only pass TradingView-compatible properties (no spread to avoid extra props)
    const overrides = {
      linecolor: options.linecolor || '#02A9DE',
      linewidth: options.linewidth || 2,
      linestyle: options.linestyle || 0, // 0=solid, 1=dotted, 2=dashed
      showLabel: true,
      textcolor: options.textcolor || options.linecolor || '#02A9DE',
      fontsize: options.fontsize || 12,
      bold: options.bold !== false,
      horzLabelsAlign: 'right',
      vertLabelsAlign: 'top'
    };

    console.log('🎨 INJECTED: Line overrides:', JSON.stringify(overrides));

    const shapeConfig = {
      shape: 'horizontal_line',
      text: label || `VL ${price}`,
      overrides: overrides
    };

    console.log(`📐 INJECTED: Creating line at $${price} with label "${shapeConfig.text}"`);

    try {
      const shapeId = await chart.createShape(
        { price: price },
        shapeConfig
      );

      if (!shapeId) {
        console.warn('⚠️ createShape returned falsy value:', shapeId);
        throw new Error('createShape returned no ID');
      }

      console.log(`✅ Drew line at $${price}, ID: ${shapeId}`);
      return { shapeId, price };
    } catch (err) {
      console.error('❌ Failed to draw line at', price);
      console.error('❌ Error:', err.message || err);
      console.error('❌ Stack:', err.stack);

      // Try to get more debug info
      try {
        const chartInfo = {
          hasCreateShape: typeof chart.createShape === 'function',
          hasRemoveEntity: typeof chart.removeEntity === 'function',
          hasGetAllShapes: typeof chart.getAllShapes === 'function',
        };
        console.error('🔍 Chart capabilities:', chartInfo);
      } catch (e) {
        console.error('🔍 Could not inspect chart:', e);
      }

      throw err;
    }
  }

  /**
   * Draw a zone (clustered levels) as a thick horizontal line at the midpoint
   */
  async function drawZone(data) {
    const chart = getChartApi();
    if (!chart) {
      const error = 'TradingView chart API not available';
      console.error('❌', error);
      throw new Error(error);
    }

    const { highPrice, lowPrice, midPrice, label, options = {} } = data;

    // Use thick line at midpoint to represent the zone
    // Only pass TradingView-compatible properties (no spread to avoid extra props)
    const overrides = {
      linecolor: options.linecolor || '#02A9DE',
      linewidth: options.linewidth || 4, // Thick line for zones (vs 2 for single levels)
      linestyle: options.linestyle || 0, // Solid
      showLabel: true,
      textcolor: options.textcolor || options.linecolor || '#02A9DE',
      fontsize: options.fontsize || 12,
      bold: options.bold !== false,
      horzLabelsAlign: 'right',
      vertLabelsAlign: 'top'
    };

    console.log('🎨 INJECTED: Zone overrides:', JSON.stringify(overrides));

    const shapeConfig = {
      shape: 'horizontal_line',
      text: label || `VL Zone [${lowPrice.toFixed(2)}-${highPrice.toFixed(2)}]`,
      overrides: overrides
    };

    console.log(`📐 INJECTED: Creating zone at $${midPrice.toFixed(2)} (range: $${lowPrice.toFixed(2)}-$${highPrice.toFixed(2)}) with label "${shapeConfig.text}"`);

    try {
      const shapeId = await chart.createShape(
        { price: midPrice },
        shapeConfig
      );

      if (!shapeId) {
        console.warn('⚠️ createShape returned falsy value:', shapeId);
        throw new Error('createShape returned no ID');
      }

      console.log(`✅ Drew zone at $${midPrice.toFixed(2)}, ID: ${shapeId}`);
      return { shapeId, highPrice, lowPrice, midPrice };
    } catch (err) {
      console.error('❌ Failed to draw zone at', midPrice);
      console.error('❌ Error:', err.message || err);
      throw err;
    }
  }

  /**
   * Get the visible time range on the chart
   * Returns {from, to} as Unix timestamps (seconds), or null if unavailable
   */
  function getVisibleTimeRange() {
    const chart = getChartApi();
    if (!chart) return null;

    try {
      const range = chart.getVisibleRange();
      if (range && typeof range.from === 'number' && typeof range.to === 'number') {
        return range;
      }
    } catch (e) {
      console.warn('⚠️ Could not get visible time range:', e);
    }
    return null;
  }

  /**
   * Draw a horizontal ray on the chart for a large trade.
   * Uses the actual trade timestamp as the ray start point.
   */
  async function drawNote(data) {
    const chart = getChartApi();
    if (!chart) {
      const error = 'TradingView chart API not available';
      console.error('❌', error);
      throw new Error(error);
    }

    const { price, timestamp, rank, originalRank, darkPool, sweep, dollarVolume, options = {} } = data;
    const validRank = Number.isInteger(rank) && rank >= 1 && rank <= 100;

    if (!validRank) {
      console.log(`📍 Trade #${rank} has invalid rank, skipping`);
      return { skipped: true, price, timestamp, rank, reason: 'invalid_rank' };
    }

    const visibleRange = getVisibleTimeRange();
    if (visibleRange) {
      if (timestamp < visibleRange.from || timestamp > visibleRange.to) {
        console.log(`📍 Trade #${rank} is outside visible range, skipping`);
        return { skipped: true, price, timestamp, rank, reason: 'outside_visible_range' };
      }
    }

    const color = darkPool
      ? (options.tradeDarkPoolColor || 'rgba(255, 152, 0, 1)')
      : (options.tradeLitColor || 'rgba(41, 98, 255, 1)');

    let volLabel = '';
    if (dollarVolume) {
      if (dollarVolume >= 1e9) {
        volLabel = ` $${Math.round(dollarVolume / 1e9)}B`;
      } else if (dollarVolume >= 1e6) {
        volLabel = ` $${Math.round(dollarVolume / 1e6)}M`;
      }
    }

    const marker = sweep ? '◆' : '●';
    const originalRankLabel = options.showOriginalTradeRank && Number.isInteger(originalRank) && originalRank !== rank
      ? ` (#${originalRank})`
      : '';
    const labelText = `${marker} VL #${rank}${originalRankLabel}${volLabel}`;

    const overrides = {
      linecolor: color,
      linewidth: options.tradeThickness || 2,
      linestyle: options.linestyle || 0,
      showLabel: true,
      textcolor: options.textcolor || color,
      fontsize: options.fontsize || 12,
      bold: options.bold !== false
    };

    const shapeConfig = {
      shape: 'horizontal_ray',
      text: labelText,
      zOrder: 'top',
      overrides: overrides
    };

    console.log(`📝 INJECTED v3: shape=${shapeConfig.shape}, price=$${price.toFixed(2)}, time=${timestamp}, rank=#${rank}`);

    try {
      const shapeId = await chart.createShape({ price: price, time: timestamp }, shapeConfig);

      if (!shapeId) {
        console.warn('⚠️ createShape returned falsy value:', shapeId);
        throw new Error('createShape returned no ID');
      }

      console.log(`✅ Drew trade ray at $${price.toFixed(2)}, ID: ${shapeId}`);
      return { shapeId, price, timestamp, rank };
    } catch (err) {
      console.error('❌ Failed to draw trade ray at', price);
      console.error('❌ Error:', err.message || err);
      throw err;
    }
  }

  /**
   * Remove a shape from the chart
   */
  async function removeShape(data) {
    const chart = getChartApi();
    if (!chart) {
      throw new Error('TradingView chart API not available');
    }

    const { shapeId } = data;

    try {
      chart.removeEntity(shapeId);
      console.log(`🗑️ Removed shape: ${shapeId}`);
      return { success: true, shapeId };
    } catch (err) {
      console.error('❌ Failed to remove shape:', err);
      throw err;
    }
  }

  /**
   * Get all shapes on the chart
   */
  function getAllShapes() {
    const chart = getChartApi();
    if (!chart) return { shapes: [] };

    try {
      const shapes = chart.getAllShapes();
      return { shapes };
    } catch (e) {
      return { shapes: [] };
    }
  }

  /**
   * Remove all shapes with text starting with "VL"
   * This clears previous VL levels before drawing new ones
   */
  async function clearVlShapes() {
    const chart = getChartApi();
    if (!chart) return { removed: 0 };

    let removed = 0;

    try {
      const allShapes = chart.getAllShapes();
      console.log(`🔍 Checking ${allShapes.length} shapes for VL prefix...`);

      for (const shape of allShapes) {
        try {
          // Get shape properties to check the text
          const shapeObj = chart.getShapeById(shape.id);
          if (!shapeObj) continue;

          // Try to get the text property
          const props = shapeObj.getProperties ? shapeObj.getProperties() : null;
          const text = props?.text || shape.name || '';

          if (text.startsWith('VL')) {
            chart.removeEntity(shape.id);
            removed++;
            console.log(`🗑️ Removed VL shape: ${shape.id} ("${text}")`);
          }
        } catch (e) {
          // Shape might not have text or be accessible
        }
      }
    } catch (e) {
      console.error('Error clearing VL shapes:', e);
    }

    console.log(`✅ Cleared ${removed} VL shapes`);
    return { removed };
  }

  /**
   * Remove only VL horizontal line shapes (not circles)
   * This clears previous VL levels before drawing new ones
   */
  async function clearVlLines() {
    const chart = getChartApi();
    if (!chart) return { removed: 0 };

    let removed = 0;

    try {
      const allShapes = chart.getAllShapes();
      console.log(`🔍 Checking ${allShapes.length} shapes for VL lines...`);

      for (const shape of allShapes) {
        try {
          // Only target horizontal_line shapes
          if (shape.name !== 'horizontal_line') continue;

          // Get shape properties to check the text
          const shapeObj = chart.getShapeById(shape.id);
          if (!shapeObj) continue;

          const props = shapeObj.getProperties ? shapeObj.getProperties() : null;
          const text = props?.text || '';

          if (text.startsWith('VL')) {
            chart.removeEntity(shape.id);
            removed++;
            console.log(`🗑️ Removed VL line: ${shape.id} ("${text}")`);
          }
        } catch (e) {
          // Shape might not have text or be accessible
        }
      }
    } catch (e) {
      console.error('Error clearing VL lines:', e);
    }

    console.log(`✅ Cleared ${removed} VL lines`);
    return { removed };
  }

  /**
   * Remove only VL trade marker shapes (not horizontal lines).
   * Clears current horizontal rays and legacy text notes before drawing new trades.
   */
  async function clearVlNotes() {
    const chart = getChartApi();
    if (!chart) return { removed: 0 };

    let removed = 0;

    try {
      const allShapes = chart.getAllShapes();
      console.log(`🔍 Checking ${allShapes.length} shapes for VL trade markers...`);

      for (const shape of allShapes) {
        try {
          if (shape.name !== 'horizontal_ray' && shape.name !== 'text_note') continue;

          const shapeObj = chart.getShapeById(shape.id);
          if (!shapeObj) continue;

          const props = shapeObj.getProperties ? shapeObj.getProperties() : null;
          const text = props?.text || '';

          if (isVlTradeText(text)) {
            chart.removeEntity(shape.id);
            removed++;
            console.log(`🗑️ Removed VL trade marker: ${shape.id} ("${text}")`);
          }
        } catch (e) {
          // Shape might not have text or be accessible
        }
      }
    } catch (e) {
      console.error('Error clearing VL trade markers:', e);
    }

    console.log(`✅ Cleared ${removed} VL trade markers`);
    return { removed };
  }

  function isVlTradeText(text) {
    return text.startsWith('VL') || text.startsWith('● VL') || text.startsWith('◆ VL');
  }

  /**
   * Handle messages from content script
   */
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'vl-tv-content') return;

    const { messageId, command, data } = event.data;
    console.log('📨 Injected received command:', command);

    let result = null;
    let error = null;

    try {
      switch (command) {
        case 'CHECK_READY':
          result = checkReady();
          break;

        case 'GET_SYMBOL':
          result = getSymbol();
          break;

        case 'DRAW_LINE':
          result = await drawLine(data);
          break;

        case 'DRAW_ZONE':
          result = await drawZone(data);
          break;

        case 'DRAW_NOTE':
          result = await drawNote(data);
          break;

        case 'REMOVE_SHAPE':
          result = await removeShape(data);
          break;

        case 'GET_ALL_SHAPES':
          result = getAllShapes();
          break;

        case 'GET_VISIBLE_RANGE':
          result = getVisibleTimeRange();
          break;

        case 'CLEAR_VL_SHAPES':
          result = await clearVlShapes();
          break;

        case 'CLEAR_VL_LINES':
          result = await clearVlLines();
          break;

        case 'CLEAR_VL_NOTES':
          result = await clearVlNotes();
          break;

        default:
          error = `Unknown command: ${command}`;
      }
    } catch (err) {
      error = err.message;
    }

    // Send response back to content script
    window.postMessage({
      source: 'vl-tv-injected',
      messageId,
      result,
      error
    }, '*');
  });

  // Signal that we're ready
  window.postMessage({
    source: 'vl-tv-injected',
    type: 'READY'
  }, '*');

})();
