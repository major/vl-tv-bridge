const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const contentSource = fs.readFileSync(path.join(__dirname, '../firefox/content-script.js'), 'utf8');
const injectedSource = fs.readFileSync(path.join(__dirname, '../firefox/injected.js'), 'utf8');

/** Create a chart fixture with TradingView-like shape APIs and snapped timestamps. */
function createChart({ symbol = 'NASDAQ:AAPL', snapSeconds = 0 } = {}) {
  const entries = new Map();
  const calls = { created: [], removed: [], setProperties: [], setPoints: [] };
  let nextId = 1;
  const snapPoint = point => ({
    ...point,
    ...(Number.isFinite(point.time) && point.time > 0 ? { time: point.time + snapSeconds } : {})
  });

  const chart = {
    symbol: () => symbol,
    getAllShapes() {
      return Array.from(entries, ([id, entry]) => ({ id, name: entry.name }));
    },
    getShapeById(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      return {
        getProperties: () => entry.properties,
        getPoints: () => entry.points.map(point => ({ ...point })),
        setProperties(properties) {
          calls.setProperties.push(id);
          Object.assign(entry.properties, properties);
        },
        setPoints(points) {
          calls.setPoints.push(id);
          entry.points = points.map(snapPoint);
        }
      };
    },
    createShape(point, config) {
      const id = `shape-${nextId++}`;
      calls.created.push(id);
      entries.set(id, {
        name: config.shape,
        points: [snapPoint(point)],
        properties: { text: config.text, ...config.overrides }
      });
      return id;
    },
    removeEntity(id) {
      calls.removed.push(id);
      entries.delete(id);
    },
    getVisibleRange() {
      return null;
    }
  };

  return { chart, entries, calls };
}

/** Load both production scripts in one VM with browser-like message and storage APIs. */
function createBridge({ chartState, storage = {}, pathname = '/chart/integration' }) {
  const listeners = new Set();
  let runtimeListener;
  const window = {
    top: null,
    location: { pathname },
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') listeners.delete(listener);
    },
    postMessage(data) {
      const event = { source: window, data };
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener(event);
      });
    }
  };
  window.top = window;

  const browser = {
    runtime: {
      getURL: file => file,
      onMessage: { addListener(listener) { runtimeListener = listener; } }
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: storage[key] === undefined ? undefined : structuredClone(storage[key]) };
        },
        async set(values) {
          Object.assign(storage, structuredClone(values));
        }
      }
    }
  };
  const document = {
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    createElement: () => ({ remove() {} }),
    getElementById: () => null
  };
  const context = vm.createContext({
    window,
    browser,
    document,
    TradingViewApi: { activeChart: () => chartState.chart, activeChartIndex: () => 0 },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date,
    Math
  });

  vm.runInContext(contentSource, context);
  vm.runInContext(injectedSource, context);
  return {
    async send(message) {
      return new Promise(resolve => runtimeListener(message, {}, resolve));
    }
  };
}

/** Return one normalized test level with an optional custom label. */
function level(price, timestamp = null, label = `VL ${price}`) {
  return { type: 'level', price, timestamp, label };
}

/** Return one valid trade item for the real injected reconciliation path. */
function trade(price, timestamp, rank = 1, extras = {}) {
  return { price, timestamp, rank, ...extras };
}

test('repeated level and trade refreshes replace only their own chart shapes', async () => {
  const chartState = createChart();
  chartState.entries.set('manual', {
    name: 'horizontal_line', points: [{ price: 99 }], properties: { text: 'My support' }
  });
  const bridge = createBridge({ chartState });
  const levels = [level(10, 100)];
  const trades = [trade(20, 200)];

  const firstLevels = await bridge.send({ type: 'DRAW_LEVELS', symbol: 'NASDAQ:AAPL', levels });
  const firstTrades = await bridge.send({ type: 'DRAW_NOTES', symbol: 'NASDAQ:AAPL', trades });
  const levelId = firstLevels.results[0].shapeId;
  const tradeId = firstTrades.results[0].shapeId;
  const refreshedLevels = await bridge.send({ type: 'DRAW_LEVELS', symbol: 'NASDAQ:AAPL', levels });
  const refreshedLevelId = refreshedLevels.results[0].shapeId;

  assert.notEqual(refreshedLevelId, levelId);
  assert.equal(chartState.entries.has(levelId), false);
  assert.equal(chartState.entries.has(tradeId), true);
  assert.equal(chartState.entries.has('manual'), true);

  const refreshedTrades = await bridge.send({ type: 'DRAW_NOTES', symbol: 'NASDAQ:AAPL', trades });
  const refreshedTradeId = refreshedTrades.results[0].shapeId;

  assert.notEqual(refreshedTradeId, tradeId);
  assert.equal(chartState.entries.has(tradeId), false);
  assert.equal(chartState.entries.has(refreshedLevelId), true);
  assert.equal(chartState.entries.has('manual'), true);
  assert.deepEqual(chartState.calls, {
    created: [levelId, tradeId, refreshedLevelId, refreshedTradeId],
    removed: [levelId, tradeId],
    setProperties: [],
    setPoints: []
  });
});

test('changed ranks, labels, and styles are applied to replacement shapes', async () => {
  const chartState = createChart();
  const bridge = createBridge({ chartState });
  const firstLevel = await bridge.send({ type: 'DRAW_LEVELS', levels: [level(10, null, 'VL support')] });
  const firstTrade = await bridge.send({ type: 'DRAW_NOTES', trades: [trade(20, 200, 1)] });
  const levelId = firstLevel.results[0].shapeId;
  const tradeId = firstTrade.results[0].shapeId;

  const nextLevel = await bridge.send({
    type: 'DRAW_LEVELS', levels: [level(10, null, 'VL resistance')], options: { color: '#123456' }
  });
  const nextTrade = await bridge.send({
    type: 'DRAW_NOTES', trades: [trade(20, 200, 2)], options: { tradeLitColor: '#654321' }
  });

  const nextLevelId = nextLevel.results[0].shapeId;
  const nextTradeId = nextTrade.results[0].shapeId;

  assert.notEqual(nextLevelId, levelId);
  assert.notEqual(nextTradeId, tradeId);
  assert.equal(chartState.entries.has(levelId), false);
  assert.equal(chartState.entries.has(tradeId), false);
  assert.equal(chartState.entries.get(nextLevelId).properties.text, 'VL resistance');
  assert.equal(chartState.entries.get(nextLevelId).properties.linecolor, '#123456');
  assert.equal(chartState.entries.get(nextTradeId).properties.text, '● VL #2');
  assert.equal(chartState.entries.get(nextTradeId).properties.linecolor, '#654321');
  assert.equal(chartState.calls.created.length, 4);
  assert.deepEqual(chartState.calls.removed, [levelId, tradeId]);
});

test('category replacement and empty batches preserve trades and manual drawings', async () => {
  const chartState = createChart();
  chartState.entries.set('manual', {
    name: 'horizontal_line', points: [{ price: 99 }], properties: { text: 'My support' }
  });
  const bridge = createBridge({ chartState });
  const oldLevels = await bridge.send({ type: 'DRAW_LEVELS', levels: [level(10), level(20)] });
  const retainedId = oldLevels.results[1].shapeId;
  const trades = await bridge.send({ type: 'DRAW_NOTES', trades: [trade(30, 300)] });
  const tradeId = trades.results[0].shapeId;
  const replacement = await bridge.send({ type: 'DRAW_LEVELS', levels: [level(20), level(40)] });
  const replacementIds = replacement.results.map(result => result.shapeId);

  assert.notEqual(replacementIds[0], retainedId);
  assert.equal(chartState.entries.has(oldLevels.results[0].shapeId), false);
  assert.equal(chartState.entries.has(retainedId), false);
  assert.equal(chartState.entries.has(replacementIds[0]), true);
  assert.equal(chartState.entries.has(replacementIds[1]), true);
  assert.deepEqual(chartState.calls.removed, oldLevels.results.map(result => result.shapeId));
  assert.equal(chartState.entries.has(tradeId), true);
  assert.equal(chartState.entries.has('manual'), true);
  const empty = await bridge.send({ type: 'DRAW_LEVELS', levels: [] });
  assert.equal(empty.success, true);
  assert.equal(chartState.entries.has(replacementIds[0]), false);
  assert.equal(chartState.entries.has(replacementIds[1]), false);
  assert.equal(chartState.entries.has(tradeId), true);
  assert.equal(chartState.entries.has('manual'), true);
  assert.deepEqual(chartState.calls.removed, [...oldLevels.results.map(result => result.shapeId), ...replacementIds]);
});

test('clear removes drawings only from the active context and preserves custom labels', async () => {
  const storage = {};
  const activeChart = createChart();
  const otherChart = createChart({ symbol: 'NASDAQ:MSFT' });
  const activeBridge = createBridge({ chartState: activeChart, storage });
  const otherBridge = createBridge({ chartState: otherChart, storage });
  const active = await activeBridge.send({ type: 'DRAW_LEVELS', levels: [level(10, 100, 'support')] });
  const other = await otherBridge.send({ type: 'DRAW_LEVELS', levels: [level(10, 100, 'VL support')] });
  const repeated = await activeBridge.send({ type: 'DRAW_LEVELS', levels: [level(10, 100, 'support')] });
  const repeatedId = repeated.results[0].shapeId;

  assert.notEqual(repeatedId, active.results[0].shapeId);
  assert.equal(activeChart.entries.has(active.results[0].shapeId), false);
  assert.equal(activeChart.entries.get(repeatedId).properties.text, 'support');
  assert.equal(activeChart.calls.created.length, 2);
  assert.deepEqual(activeChart.calls.removed, [active.results[0].shapeId]);

  const cleared = await activeBridge.send({ type: 'CLEAR_DRAWN' });
  assert.equal(cleared.success, true);
  assert.equal(activeChart.entries.has(repeatedId), false);
  assert.deepEqual(activeChart.calls.removed, [active.results[0].shapeId, repeatedId]);
  assert.equal(otherChart.entries.has(other.results[0].shapeId), true);
});

test('symbol mismatch does not mutate the chart or storage', async () => {
  const chartState = createChart();
  const storage = {};
  const bridge = createBridge({ chartState, storage });

  const response = await bridge.send({ type: 'DRAW_LEVELS', symbol: 'NASDAQ:MSFT', levels: [level(10)] });
  assert.equal(response.success, false);
  assert.equal(chartState.calls.created.length, 0);
  assert.deepEqual(storage, {});
});

test('reload replaces the shape and persists TradingView-snapped timestamps', async () => {
  const chartState = createChart({ snapSeconds: 5 });
  const storage = {};
  const firstBridge = createBridge({ chartState, storage });
  const first = await firstBridge.send({ type: 'DRAW_LEVELS', levels: [level(10, 100)] });
  const id = first.results[0].shapeId;
  const records = storage['vlDrawings:["/chart/integration","NASDAQ:AAPL",0]:levels'];

  assert.deepEqual(records[0].points, [{ price: 10, time: 105 }]);
  const reloadedBridge = createBridge({ chartState, storage });
  const second = await reloadedBridge.send({ type: 'DRAW_LEVELS', levels: [level(10, 100)] });
  const replacementId = second.results[0].shapeId;
  const updatedRecords = storage['vlDrawings:["/chart/integration","NASDAQ:AAPL",0]:levels'];

  assert.notEqual(replacementId, id);
  assert.equal(chartState.entries.has(id), false);
  assert.deepEqual(updatedRecords[0].points, [{ price: 10, time: 105 }]);
  assert.equal(updatedRecords[0].shapeId, replacementId);
  assert.equal(chartState.calls.created.length, 2);
  assert.deepEqual(chartState.calls.removed, [id]);
});
