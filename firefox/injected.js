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

  function applyOpacity(color, opacity = 100) {
    const value = Number(opacity);
    const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 100;

    if (pct >= 100 || !/^#[0-9A-F]{6}$/i.test(color)) {
      return color;
    }

    const hex = color.slice(1);
    return `rgba(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)}, ${pct / 100})`;
  }

  /** Build the point, shape config, and original result fields for a level. */
  function buildLineDefinition(data) {
    const { price, timestamp, label, options = {} } = data;
    const hasValidTimestamp = Number.isFinite(timestamp) && timestamp > 0;
    const linecolor = applyOpacity(options.linecolor || '#02A9DE', options.lineopacity ?? 100);
    const overrides = {
      linecolor,
      linewidth: options.linewidth || 2,
      linestyle: options.linestyle || 0,
      showLabel: true,
      textcolor: options.textcolor || linecolor,
      fontsize: options.fontsize || 12,
      bold: options.bold !== false,
      horzLabelsAlign: 'right',
      vertLabelsAlign: 'top'
    };
    const point = hasValidTimestamp ? { price, time: timestamp } : { price };
    return {
      point,
      config: {
        shape: hasValidTimestamp ? 'horizontal_ray' : 'horizontal_line',
        text: label || `VL ${price}`,
        overrides
      },
      result: { price }
    };
  }

  /** Build the point, shape config, and original result fields for a zone. */
  function buildZoneDefinition(data) {
    const { highPrice, lowPrice, midPrice, timestamp, label, options = {} } = data;
    const hasValidTimestamp = Number.isFinite(timestamp) && timestamp > 0;
    const linecolor = applyOpacity(options.linecolor || '#02A9DE', options.lineopacity ?? 100);
    const overrides = {
      linecolor,
      linewidth: options.linewidth || 4,
      linestyle: options.linestyle || 0,
      showLabel: true,
      textcolor: options.textcolor || linecolor,
      fontsize: options.fontsize || 12,
      bold: options.bold !== false,
      horzLabelsAlign: 'right',
      vertLabelsAlign: 'top'
    };
    const point = hasValidTimestamp ? { price: midPrice, time: timestamp } : { price: midPrice };
    return {
      point,
      config: {
        shape: hasValidTimestamp ? 'horizontal_ray' : 'horizontal_line',
        text: label || `VL Zone [${lowPrice.toFixed(2)}-${highPrice.toFixed(2)}]`,
        overrides
      },
      result: { highPrice, lowPrice, midPrice }
    };
  }

  /** Build a trade definition, including the existing rank and visibility skips. */
  function buildTradeDefinition(data, visibleRange) {
    const { price, timestamp, rank, originalRank, darkPool, sweep, dollarVolume, options = {} } = data;
    const validRank = Number.isInteger(rank) && rank >= 1 && rank <= 100;
    if (!validRank) {
      return {
        skipped: true,
        result: { skipped: true, price, timestamp, rank, reason: 'invalid_rank' }
      };
    }
    if (visibleRange && (timestamp < visibleRange.from || timestamp > visibleRange.to)) {
      return {
        skipped: true,
        result: { skipped: true, price, timestamp, rank, reason: 'outside_visible_range' }
      };
    }

    const color = darkPool
      ? (options.tradeDarkPoolColor || 'rgba(244, 164, 96, 1)')
      : (options.tradeLitColor || 'rgba(146, 203, 249, 1)');
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
    return {
      point: { price, time: timestamp },
      config: {
        shape: 'horizontal_ray',
        text: `${marker} VL #${rank}${originalRankLabel}${volLabel}`,
        zOrder: 'top',
        overrides: {
          linecolor: color,
          linewidth: options.tradeThickness || 1,
          linestyle: options.linestyle || 0,
          showLabel: true,
          textcolor: options.textcolor || color,
          fontsize: options.fontsize || 12,
          bold: options.bold !== false,
          horzLabelsAlign: options.horzLabelsAlign || 'right'
        }
      },
      result: { price, timestamp, rank }
    };
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
    const definition = buildLineDefinition(data);
    const { price } = data;
    console.log('🎨 INJECTED: Line overrides:', JSON.stringify(definition.config.overrides));
    console.log(`📐 INJECTED: Creating line at $${price} with label "${definition.config.text}"`);

    try {
      const shapeId = await chart.createShape(definition.point, definition.config);

      if (!shapeId) {
        console.warn('⚠️ createShape returned falsy value:', shapeId);
        throw new Error('createShape returned no ID');
      }

      console.log(`✅ Drew line at $${price}, ID: ${shapeId}`);
      return { shapeId, ...definition.result };
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
    const definition = buildZoneDefinition(data);
    const { highPrice, lowPrice, midPrice } = data;
    console.log('🎨 INJECTED: Zone overrides:', JSON.stringify(definition.config.overrides));
    console.log(`📐 INJECTED: Creating zone at $${midPrice.toFixed(2)} (range: $${lowPrice.toFixed(2)}-$${highPrice.toFixed(2)}) with label "${definition.config.text}"`);

    try {
      const shapeId = await chart.createShape(definition.point, definition.config);

      if (!shapeId) {
        console.warn('⚠️ createShape returned falsy value:', shapeId);
        throw new Error('createShape returned no ID');
      }

      console.log(`✅ Drew zone at $${midPrice.toFixed(2)}, ID: ${shapeId}`);
      return { shapeId, ...definition.result };
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

    const { price, timestamp, rank } = data;
    let visibleRange = null;
    try {
      visibleRange = chart.getVisibleRange ? chart.getVisibleRange() : null;
    } catch (e) {
      console.warn('⚠️ Could not get visible time range:', e);
    }
    const definition = buildTradeDefinition(data, visibleRange);
    if (definition.skipped) return definition.result;
    console.log(`📝 INJECTED v3: shape=${definition.config.shape}, price=$${price.toFixed(2)}, time=${timestamp}, rank=#${rank}`);

    try {
      const shapeId = await chart.createShape(definition.point, definition.config);

      if (!shapeId) {
        console.warn('⚠️ createShape returned falsy value:', shapeId);
        throw new Error('createShape returned no ID');
      }

      console.log(`✅ Drew trade ray at $${price.toFixed(2)}, ID: ${shapeId}`);
      return { shapeId, ...definition.result };
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
          // Target level/zone lines and rays, but leave trade rays intact.
          if (shape.name !== 'horizontal_line' && shape.name !== 'horizontal_ray') continue;

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

  /** Read a stable identity for the currently active chart and symbol. */
  function drawingContextForChart(chart) {
    if (!chart) throw new Error('TradingView chart API not available');
    let rawSymbol;
    try {
      rawSymbol = typeof chart.symbol === 'function' ? chart.symbol() : chart.symbol;
    } catch (error) {
      throw new Error('Could not read the active chart symbol');
    }
    if (typeof rawSymbol !== 'string' || !rawSymbol.trim()) {
      throw new Error('Could not read the active chart symbol');
    }
    let chartIndex = 0;
    if (typeof TradingViewApi !== 'undefined' && typeof TradingViewApi.activeChartIndex === 'function') {
      try {
        chartIndex = TradingViewApi.activeChartIndex();
      } catch (error) {
        throw new Error('Could not read the active chart index');
      }
      if (chartIndex === undefined || chartIndex === null) {
        throw new Error('Could not read the active chart index');
      }
    }
    const symbol = cleanSymbol(rawSymbol);
    if (!symbol) throw new Error('Could not clean the active chart symbol');
    return {
      key: JSON.stringify([window.location.pathname, rawSymbol, chartIndex]),
      symbol
    };
  }

  /** Return the active chart context, failing if either chart or symbol is unreadable. */
  function getDrawingContext() {
    return drawingContextForChart(getChartApi());
  }

  /** Confirm that the requested chart context is still active. */
  function assertDrawingContext(expectedKey) {
    const activeContext = getDrawingContext();
    if (activeContext.key !== expectedKey) throw new Error('Drawing context changed during reconciliation');
  }

  /** Return a valid positive timestamp or null for a non-anchor timestamp. */
  function normalizedTimestamp(value) {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /** Validate and canonicalize a saved shape point array. */
  function canonicalPoints(points, description) {
    if (!Array.isArray(points) || points.length !== 1) {
      throw new Error(`${description} must contain exactly one point`);
    }
    return points.map(point => {
      if (!point || typeof point !== 'object' || !Number.isFinite(point.price)) {
        throw new Error(`${description} contains an unreadable point`);
      }
      if (point.time !== undefined && point.time !== null && !Number.isFinite(point.time)) {
        throw new Error(`${description} contains an unreadable time`);
      }
      const canonical = { price: point.price };
      if (Number.isFinite(point.time)) canonical.time = point.time;
      return canonical;
    });
  }

  /** Compare actual shape geometry using exact times and a small relative price tolerance. */
  function pointsEqual(left, right) {
    if (left.length !== right.length) return false;
    return left.every((point, index) => {
      const other = right[index];
      const tolerance = Math.max(1e-8, Math.abs(other.price) * 1e-8);
      return Math.abs(point.price - other.price) <= tolerance && point.time === other.time;
    });
  }

  /** Build the identity key used to track a desired level, zone, or trade. */
  function drawingIdentity(kind, item) {
    if (kind === 'trades') {
      return JSON.stringify(['trade', item.price, item.timestamp, Boolean(item.darkPool), Boolean(item.sweep)]);
    }
    if (item.type === 'level') {
      return JSON.stringify(['level', item.price, normalizedTimestamp(item.timestamp)]);
    }
    const members = (item.levels || []).map(level => [level.price, normalizedTimestamp(level.timestamp)]);
    members.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return JSON.stringify([
      'zone',
      item.lowPrice,
      item.highPrice,
      item.midPrice,
      normalizedTimestamp(item.timestamp),
      members
    ]);
  }

  /** Validate caller data and build every desired definition before chart mutation. */
  function buildReconciliationDefinitions(kind, items, chart) {
    if (!Array.isArray(items)) throw new Error('Reconciliation items must be an array');
    let visibleRange = null;
    if (kind === 'trades' && typeof chart.getVisibleRange === 'function') {
      try {
        visibleRange = chart.getVisibleRange();
      } catch (error) {
        throw new Error('Could not read the trade visibility range');
      }
      if (visibleRange && (!Number.isFinite(visibleRange.from) || !Number.isFinite(visibleRange.to))) {
        throw new Error('Trade visibility range is malformed');
      }
    }
    return items.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`Reconciliation item ${index} is malformed`);
      }
      const options = item.options === undefined ? {} : item.options;
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error(`Reconciliation item ${index} has malformed options`);
      }
      let definition;
      if (kind === 'trades') {
        if (!Number.isFinite(item.price) || !Number.isFinite(item.timestamp) || item.timestamp <= 0) {
          throw new Error(`Trade item ${index} has invalid price or timestamp`);
        }
        definition = buildTradeDefinition(item, visibleRange);
      } else if (item.type === 'level') {
        if (!Number.isFinite(item.price) || (item.timestamp != null && !Number.isFinite(item.timestamp))) {
          throw new Error(`Level item ${index} has invalid price or timestamp`);
        }
        definition = buildLineDefinition(item);
      } else if (item.type === 'zone') {
        if (![item.lowPrice, item.highPrice, item.midPrice].every(Number.isFinite) ||
            (item.timestamp != null && !Number.isFinite(item.timestamp))) {
          throw new Error(`Zone item ${index} has invalid bounds or timestamp`);
        }
        if (item.levels !== undefined && !Array.isArray(item.levels)) {
          throw new Error(`Zone item ${index} has malformed levels`);
        }
        for (const level of item.levels || []) {
          if (!level || !Number.isFinite(level.price) ||
              (level.timestamp != null && !Number.isFinite(level.timestamp))) {
            throw new Error(`Zone item ${index} has malformed constituent levels`);
          }
        }
        definition = buildZoneDefinition(item);
      } else {
        throw new Error(`Level item ${index} must have type 'level' or 'zone'`);
      }
      return {
        item,
        definition,
        key: definition.skipped ? null : drawingIdentity(kind, item),
        points: definition.skipped ? null : canonicalPoints([definition.point], `Definition ${index}`)
      };
    });
  }

  /** Return whether an inventory text belongs to a VL level or zone. */
  function isVlLevelText(text) {
    return /^VL(?:\s|$)/.test(text);
  }

  /** Return whether an inventory text belongs to a current or legacy trade. */
  function isOwnedTradeText(name, text) {
    return name === 'horizontal_ray'
      ? /^(?:●|◆)\sVL(?:\s|$)/.test(text)
      : name === 'text_note' && (text.startsWith('VL') || /^(?:●|◆)\sVL/.test(text));
  }

  /** Read owned shapes from the captured chart and reject incomplete inventory. */
  function readOwnedInventory(chart, kind, records) {
    if (typeof chart.getAllShapes !== 'function') throw new Error('Chart getAllShapes is unavailable');
    if (typeof chart.getShapeById !== 'function') throw new Error('Chart getShapeById is unavailable');
    let shapes;
    try {
      shapes = chart.getAllShapes();
    } catch (error) {
      throw new Error(`Chart getAllShapes failed: ${error.message || error}`);
    }
    if (!Array.isArray(shapes)) throw new Error('Chart getAllShapes returned malformed inventory');
    const savedIds = new Set(records.map(record => `${typeof record.shapeId}:${record.shapeId}`));
    const owned = [];
    for (const entry of shapes) {
      if (!entry || (typeof entry.id !== 'string' && typeof entry.id !== 'number') || typeof entry.name !== 'string') {
        throw new Error('Chart shape inventory contains a malformed entry');
      }
      if (!['horizontal_line', 'horizontal_ray', 'text_note'].includes(entry.name)) continue;
      let shape;
      let properties;
      try {
        shape = chart.getShapeById(entry.id);
        if (!shape || typeof shape.getProperties !== 'function') throw new Error('properties unavailable');
        properties = shape.getProperties();
      } catch (error) {
        throw new Error(`Could not read candidate shape ${entry.id} properties`);
      }
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
        throw new Error(`Candidate shape ${entry.id} has malformed properties`);
      }
      const text = properties.text === undefined ? '' : properties.text;
      if (typeof text !== 'string') throw new Error(`Candidate shape ${entry.id} has unreadable text properties`);
      const savedRecord = savedIds.has(`${typeof entry.id}:${entry.id}`);
      const levelType = ['horizontal_line', 'horizontal_ray'].includes(entry.name);
      const tradeType = ['horizontal_ray', 'text_note'].includes(entry.name);
      const levelOwned = levelType && (savedRecord || isVlLevelText(text));
      const tradeOwned = tradeType && (savedRecord || isOwnedTradeText(entry.name, text));
      if (!(kind === 'levels' ? levelOwned : tradeOwned)) continue;
      if (typeof shape.getPoints !== 'function') throw new Error(`Candidate shape ${entry.id} has no getPoints method`);
      let points;
      try {
        points = canonicalPoints(shape.getPoints(), `Shape ${entry.id} points`);
      } catch (error) {
        throw new Error(`Could not read candidate shape ${entry.id} points: ${error.message || error}`);
      }
      owned.push({
        id: entry.id,
        name: entry.name,
        shape,
        properties,
        points,
        text
      });
    }
    return owned;
  }

  /** Validate persisted records before they participate in matching. */
  function validateRecords(records) {
    if (!Array.isArray(records)) throw new Error('Reconciliation records must be an array');
    const ids = new Set();
    return records.map((record, index) => {
      if (!record || typeof record !== 'object' ||
          (typeof record.shapeId !== 'string' && typeof record.shapeId !== 'number') ||
          typeof record.key !== 'string') {
        throw new Error(`Reconciliation record ${index} is malformed`);
      }
      const idKey = `${typeof record.shapeId}:${record.shapeId}`;
      if (ids.has(idKey)) throw new Error(`Reconciliation records repeat shape ${record.shapeId}`);
      ids.add(idKey);
      return { shapeId: record.shapeId, key: record.key, points: canonicalPoints(record.points, `Record ${index} points`) };
    });
  }

  /** Check whether a candidate has the desired type and anchor geometry. */
  function candidateMatches(candidate, desired, exactTime) {
    if (candidate.name !== desired.definition.config.shape) return false;
    const target = desired.points[0];
    const actual = candidate.points[0];
    const tolerance = Math.max(1e-8, Math.abs(target.price) * 1e-8);
    if (Math.abs(actual.price - target.price) > tolerance) return false;
    return !exactTime || actual.time === target.time;
  }

  /** Return properties that differ from the requested text and drawing overrides. */
  function changedDrawingProperties(candidate, definition) {
    const requested = { text: definition.config.text, ...definition.config.overrides };
    const changed = {};
    for (const [key, value] of Object.entries(requested)) {
      if (!Object.is(candidate.properties[key], value)) changed[key] = value;
    }
    return changed;
  }

  /** Build one-to-one plans, preferring valid records and then exact legacy anchors. */
  function matchDesiredDrawings(desired, candidates, records) {
    const recordById = new Map(records.map(record => [`${typeof record.shapeId}:${record.shapeId}`, record]));
    const matchedCandidates = new Set();
    const plans = desired.map(entry => ({ ...entry, candidate: null, normalizePoints: false, changedProperties: {} }));
    for (const plan of plans) {
      if (plan.definition.skipped) continue;
      const match = candidates.find(candidate => {
        const record = recordById.get(`${typeof candidate.id}:${candidate.id}`);
        return !matchedCandidates.has(candidate) && record && record.key === plan.key &&
          pointsEqual(candidate.points, record.points) && candidateMatches(candidate, plan, false);
      });
      if (match) {
        plan.candidate = match;
        matchedCandidates.add(match);
      }
    }
    const legacyCandidates = candidates.filter(candidate =>
      !matchedCandidates.has(candidate) && !recordById.has(`${typeof candidate.id}:${candidate.id}`));
    for (const plan of plans) {
      if (plan.definition.skipped || plan.candidate) continue;
      const exact = legacyCandidates.find(candidate => !matchedCandidates.has(candidate) && candidateMatches(candidate, plan, true));
      if (exact) {
        plan.candidate = exact;
        matchedCandidates.add(exact);
      }
    }
    // Only an unambiguous remaining legacy pair may be adopted with a changed time anchor.
    for (const plan of plans) {
      if (plan.definition.skipped || plan.candidate) continue;
      const desiredPeers = plans.filter(other => !other.definition.skipped && !other.candidate &&
        other.definition.config.shape === plan.definition.config.shape && candidateMatches({
          name: other.definition.config.shape,
          points: other.points
        }, plan, false));
      const candidatePeers = legacyCandidates.filter(candidate => !matchedCandidates.has(candidate) && candidateMatches(candidate, plan, false));
      if (desiredPeers.length === 1 && candidatePeers.length === 1) {
        plan.candidate = candidatePeers[0];
        plan.normalizePoints = plan.candidate.points[0].time !== plan.points[0].time;
        matchedCandidates.add(plan.candidate);
      }
    }
    for (const plan of plans) {
      if (plan.candidate) plan.changedProperties = changedDrawingProperties(plan.candidate, plan.definition);
    }
    return { plans, matchedCandidates };
  }

  /** Snapshot actual geometry for a newly created or updated shape. */
  function actualPointsForShape(chart, shapeId) {
    const shape = chart.getShapeById(shapeId);
    if (!shape || typeof shape.getPoints !== 'function') throw new Error(`Could not read created shape ${shapeId} points`);
    return canonicalPoints(shape.getPoints(), `Shape ${shapeId} points`);
  }

  /** Create or reconcile all drawings in one category on the captured chart. */
  async function reconcileDrawings(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Reconciliation request is malformed');
    const { kind, items, records, context } = data;
    if (kind !== 'levels' && kind !== 'trades') throw new Error('Reconciliation kind must be levels or trades');
    if (!context || typeof context.key !== 'string') throw new Error('Drawing context is required');
    const chart = getChartApi();
    if (!chart) throw new Error('TradingView chart API not available');
    assertDrawingContext(context.key);
    const activeContext = drawingContextForChart(chart);
    if (activeContext.key !== context.key) throw new Error('Drawing context does not match the active chart');

    const definitions = buildReconciliationDefinitions(kind, items, chart);
    const savedRecords = validateRecords(records);
    const candidates = readOwnedInventory(chart, kind, savedRecords);
    const matching = matchDesiredDrawings(definitions, candidates, savedRecords);
    const staleCandidates = candidates.filter(candidate => !matching.matchedCandidates.has(candidate));
    const needsCreate = matching.plans.some(plan => !plan.definition.skipped && !plan.candidate);
    if (needsCreate && typeof chart.createShape !== 'function') throw new Error('Chart createShape is unavailable');
    if (staleCandidates.length && typeof chart.removeEntity !== 'function') throw new Error('Chart removeEntity is unavailable');
    for (const plan of matching.plans) {
      if (plan.candidate && Object.keys(plan.changedProperties).length && typeof plan.candidate.shape.setProperties !== 'function') {
        throw new Error(`Shape ${plan.candidate.id} needs unavailable setProperties`);
      }
      if (plan.candidate && plan.normalizePoints && typeof plan.candidate.shape.setPoints !== 'function') {
        throw new Error(`Shape ${plan.candidate.id} needs unavailable setPoints`);
      }
    }

    const results = definitions.map(entry => entry.definition.skipped
      ? { ...entry.definition.result, skipped: true }
      : null);
    const removed = [];
    const recordsById = new Map(savedRecords.map(record => [`${typeof record.shapeId}:${record.shapeId}`, record]));
    const desiredRecordsById = new Map();
    /** Save the newest recovery record for a shape, retaining it across later failures. */
    const storeRecord = record => {
      const idKey = `${typeof record.shapeId}:${record.shapeId}`;
      recordsById.set(idKey, record);
      desiredRecordsById.set(idKey, record);
    };
    /** Return recovery records for all prior and successfully changed shapes. */
    const partialRecords = () => Array.from(recordsById.values());
    let failedIndex = -1;
    let failure = null;

    for (let index = 0; index < matching.plans.length; index++) {
      const plan = matching.plans[index];
      if (plan.definition.skipped) continue;
      let attemptedShapeId = null;
      let pointNormalizationCompleted = false;
      try {
        assertDrawingContext(context.key);
        let shapeId;
        let actualPoints;
        let updated = false;
        if (plan.candidate) {
          shapeId = plan.candidate.id;
          if (plan.normalizePoints) {
            await plan.candidate.shape.setPoints(plan.points);
            pointNormalizationCompleted = true;
            assertDrawingContext(context.key);
            updated = true;
          }
          if (Object.keys(plan.changedProperties).length) {
            await plan.candidate.shape.setProperties(plan.changedProperties);
            assertDrawingContext(context.key);
            updated = true;
          }
          actualPoints = actualPointsForShape(chart, shapeId);
        } else {
          shapeId = await chart.createShape(plan.definition.point, plan.definition.config);
          if (!shapeId) throw new Error('createShape returned no ID');
          attemptedShapeId = shapeId;
          storeRecord({ shapeId, key: plan.key, points: plan.points });
          assertDrawingContext(context.key);
          actualPoints = actualPointsForShape(chart, shapeId);
        }
        const record = { shapeId, key: plan.key, points: actualPoints };
        storeRecord(record);
        results[index] = {
          shapeId,
          ...plan.definition.result,
          success: true,
          ...(plan.candidate ? { reused: true } : {}),
          ...(updated ? { updated: true } : {})
        };
      } catch (error) {
        failedIndex = index;
        failure = error;
        if (plan.candidate && plan.candidate.id !== undefined &&
            (!plan.normalizePoints || pointNormalizationCompleted)) {
          try {
            const currentPoints = actualPointsForShape(chart, plan.candidate.id);
            storeRecord({ shapeId: plan.candidate.id, key: plan.key, points: currentPoints });
          } catch (snapshotError) {
            // Retain the previous record if a failed mutation prevents a safe new snapshot.
          }
        } else if (attemptedShapeId !== null) {
          try {
            const currentPoints = actualPointsForShape(chart, attemptedShapeId);
            storeRecord({ shapeId: attemptedShapeId, key: plan.key, points: currentPoints });
          } catch (snapshotError) {
            // Keep the requested anchor as a recovery record if TradingView cannot expose the new points yet.
          }
        }
        results[index] = { ...plan.definition.result, success: false, error: error.message || String(error) };
        break;
      }
    }

    if (failure) {
      for (let index = failedIndex + 1; index < results.length; index++) {
        if (!results[index]) results[index] = { ...definitions[index].definition.result, success: false, error: 'Not attempted' };
      }
      return { success: false, results, removed, records: partialRecords(), error: failure.message || String(failure) };
    }

    for (const candidate of staleCandidates) {
      try {
        assertDrawingContext(context.key);
        await chart.removeEntity(candidate.id);
        assertDrawingContext(context.key);
        removed.push(candidate.id);
        recordsById.delete(`${typeof candidate.id}:${candidate.id}`);
      } catch (error) {
        return {
          success: false,
          results,
          removed,
          records: [...desiredRecordsById.values(), ...Array.from(recordsById.values()).filter(record =>
            !desiredRecordsById.has(`${typeof record.shapeId}:${record.shapeId}`) && !removed.some(id => id === record.shapeId))],
          error: error.message || String(error)
        };
      }
    }
    return { success: true, results, removed, records: Array.from(desiredRecordsById.values()) };
  }

  let reconciliationQueue = Promise.resolve();

  /** Run reconciliation requests in arrival order to keep chart state deterministic. */
  function enqueueReconciliation(data) {
    const queued = reconciliationQueue.then(() => reconcileDrawings(data));
    reconciliationQueue = queued.catch(() => undefined);
    return queued;
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

        case 'GET_DRAWING_CONTEXT':
          result = getDrawingContext();
          break;

        case 'RECONCILE_DRAWINGS':
          result = await enqueueReconciliation(data);
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
