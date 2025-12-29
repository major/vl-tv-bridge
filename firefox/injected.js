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
    const overrides = {
      linecolor: options.linecolor || '#02A9DE',
      linewidth: options.linewidth || 2,
      linestyle: options.linestyle || 0, // 0=solid, 1=dotted, 2=dashed
      showLabel: true,
      textcolor: options.textcolor || options.linecolor || '#02A9DE',
      fontsize: options.fontsize || 12,
      bold: options.bold !== false,
      horzLabelsAlign: options.horzLabelsAlign || 'right',
      vertLabelsAlign: options.vertLabelsAlign || 'middle',
      ...options
    };

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
    const overrides = {
      linecolor: options.linecolor || '#02A9DE',
      linewidth: options.linewidth || 4, // Thick line for zones (vs 2 for single levels)
      linestyle: options.linestyle || 0, // Solid
      showLabel: true,
      textcolor: options.textcolor || options.linecolor || '#02A9DE',
      fontsize: options.fontsize || 12,
      bold: options.bold !== false,
      horzLabelsAlign: options.horzLabelsAlign || 'right',
      vertLabelsAlign: options.vertLabelsAlign || 'middle',
      ...options
    };

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
   * Draw a circle on the chart for a large trade
   * Uses createMultipointShape with two points: center and edge
   *
   * If the trade's timestamp is before the visible chart range,
   * draws at the left edge with a "← hist" indicator in the label
   */
  async function drawCircle(data) {
    const chart = getChartApi();
    if (!chart) {
      const error = 'TradingView chart API not available';
      console.error('❌', error);
      throw new Error(error);
    }

    const { price, timestamp, rank, darkPool, options = {} } = data;

    // Check if trade is before visible range
    const visibleRange = getVisibleTimeRange();
    let effectiveTimestamp = timestamp;
    let isOffChart = false;

    if (visibleRange && timestamp < visibleRange.from) {
      // Trade is before visible range - use left edge instead
      effectiveTimestamp = visibleRange.from;
      isOffChart = true;
      console.log(`📍 Trade #${rank} is off-chart (${new Date(timestamp * 1000).toLocaleDateString()} < ${new Date(visibleRange.from * 1000).toLocaleDateString()}), drawing at left edge`);
    }

    // Calculate radius as percentage of price (default 2%)
    const radiusPercent = options.radiusPercent || 2;
    const priceRadius = price * (radiusPercent / 100);
    const edgePrice = price - priceRadius;

    // Time offset for edge point (7 days in seconds)
    const timeOffset = 7 * 24 * 60 * 60;
    const edgeTime = effectiveTimestamp + timeOffset;

    // Colors based on dark pool vs lit exchange
    // Dark pool = orange, Lit exchange = blue (VL cyan)
    const borderColor = darkPool
      ? (options.darkPoolColor || 'rgba(255, 152, 0, 1)')      // Orange
      : (options.litColor || 'rgba(2, 169, 222, 1)');          // VL Cyan
    const fillColor = darkPool
      ? (options.darkPoolFill || 'rgba(255, 152, 0, 0.2)')
      : (options.litFill || 'rgba(2, 169, 222, 0.2)');

    const overrides = {
      color: borderColor,
      backgroundColor: fillColor,
      fillBackground: true,
      linewidth: options.linewidth || 2,
      textColor: options.textColor || '#000000',
      fontSize: options.fontSize || 14,
      bold: options.bold !== false,
      showLabel: true,
      ...options.overrides
    };

    // Label includes "←" indicator if trade is off-chart (historical)
    const labelText = isOffChart ? `VL ←\n#${rank}` : `VL\n#${rank}`;

    const shapeConfig = {
      shape: 'circle',
      text: labelText,
      overrides: overrides
    };

    // Two points define the circle: center and edge
    // Uses effectiveTimestamp (may be adjusted to left edge for off-chart trades)
    const points = [
      { price: price, time: effectiveTimestamp },      // Center
      { price: edgePrice, time: edgeTime }             // Edge (defines radius)
    ];

    console.log(`🔵 INJECTED: Creating circle at $${price.toFixed(2)}, time ${effectiveTimestamp}${isOffChart ? ' (off-chart→left edge)' : ''}, rank #${rank}, darkPool=${darkPool}`);

    try {
      const shapeId = await chart.createMultipointShape(points, shapeConfig);

      if (!shapeId) {
        console.warn('⚠️ createMultipointShape returned falsy value:', shapeId);
        throw new Error('createMultipointShape returned no ID');
      }

      console.log(`✅ Drew circle at $${price.toFixed(2)}, ID: ${shapeId}${isOffChart ? ' (off-chart)' : ''}`);
      return { shapeId, price, timestamp, rank, isOffChart };
    } catch (err) {
      console.error('❌ Failed to draw circle at', price);
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
   * Remove only VL circle shapes (not horizontal lines)
   * This clears previous VL circles before drawing new ones
   */
  async function clearVlCircles() {
    const chart = getChartApi();
    if (!chart) return { removed: 0 };

    let removed = 0;

    try {
      const allShapes = chart.getAllShapes();
      console.log(`🔍 Checking ${allShapes.length} shapes for VL circles...`);

      for (const shape of allShapes) {
        try {
          // Only target circle shapes
          if (shape.name !== 'circle') continue;

          // Get shape properties to check the text
          const shapeObj = chart.getShapeById(shape.id);
          if (!shapeObj) continue;

          const props = shapeObj.getProperties ? shapeObj.getProperties() : null;
          const text = props?.text || '';

          if (text.startsWith('VL')) {
            chart.removeEntity(shape.id);
            removed++;
            console.log(`🗑️ Removed VL circle: ${shape.id} ("${text}")`);
          }
        } catch (e) {
          // Shape might not have text or be accessible
        }
      }
    } catch (e) {
      console.error('Error clearing VL circles:', e);
    }

    console.log(`✅ Cleared ${removed} VL circles`);
    return { removed };
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

        case 'DRAW_CIRCLE':
          result = await drawCircle(data);
          break;

        case 'REMOVE_SHAPE':
          result = await removeShape(data);
          break;

        case 'GET_ALL_SHAPES':
          result = getAllShapes();
          break;

        case 'CLEAR_VL_SHAPES':
          result = await clearVlShapes();
          break;

        case 'CLEAR_VL_LINES':
          result = await clearVlLines();
          break;

        case 'CLEAR_VL_CIRCLES':
          result = await clearVlCircles();
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
