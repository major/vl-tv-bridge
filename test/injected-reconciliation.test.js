const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/** Create a controllable TradingView chart double and its tracked shape state. */
function createChart(options = {}) {
  let nextId = 1;
  const entries = new Map();
  const calls = { created: [], removed: [], events: [] };
  const chart = {
    symbol: () => options.symbol || 'NASDAQ:AAPL',
    getAllShapes() {
      return Array.from(entries, ([id, entry]) => ({ id, name: entry.name }));
    },
    getShapeById(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      const shape = {
        getProperties() {
          if (entry.failProperties) throw new Error('properties unavailable');
          return entry.properties;
        },
        getPoints() {
          if (entry.failPoints) throw new Error('points unavailable');
          return entry.points;
        },
      };
      return shape;
    },
    createShape(point, config) {
      calls.events.push('create');
      if (options.failCreate) throw new Error('createShape failed');
      const id = `shape-${nextId++}`;
      calls.created.push({ id, point, config });
      entries.set(id, {
        name: config.shape,
        points: [{ ...point, time: point.time ? point.time + (options.snapSeconds || 0) : point.time }],
        properties: { text: config.text, ...config.overrides }
      });
      return id;
    },
    removeEntity(id) {
      calls.events.push('remove');
      calls.removed.push(id);
      if (options.failRemove) throw new Error('removeEntity failed');
      entries.delete(id);
    },
    getVisibleRange() {
      return null;
    }
  };
  return { chart, entries, calls, options };
}

/** Load the injected bridge into an isolated VM with message capture. */
function loadInjected(chartState, options = {}) {
  const listeners = { message: [] };
  const postedMessages = [];
  const window = {
    top: null,
    location: { pathname: options.pathname || '/chart/abc' },
    vlTvBridgeInjected: false,
    addEventListener(type, handler) {
      listeners[type].push(handler);
    },
    postMessage(message) {
      postedMessages.push(message);
    }
  };
  window.top = window;
  const tradingViewApi = {
    activeChart: () => chartState.chart,
    activeChartIndex: options.activeChartIndex ? () => options.activeChartIndex() : undefined
  };
  const context = vm.createContext({ console, window, TradingViewApi: tradingViewApi });
  const script = fs.readFileSync(path.join(__dirname, '..', 'firefox', 'injected.js'), 'utf8');
  vm.runInContext(script, context);

  return {
    postedMessages,
    async send(command, data = {}) {
      const event = {
        source: window,
        data: { source: 'vl-tv-content', messageId: `${command}-${postedMessages.length}`, command, data }
      };
      await Promise.all(listeners.message.map(handler => handler(event)));
      return postedMessages.findLast(message => message.messageId === event.data.messageId);
    }
  };
}

/** Build a level drawing input with the standard options fields. */
function level(price, timestamp = null, label = `VL ${price}`, options = {}) {
  return { type: 'level', price, timestamp, label, options };
}

/** Build a trade drawing input with optional normalized data fields. */
function trade(price, timestamp, rank = 1, extras = {}) {
  return { price, timestamp, rank, dollarVolume: 0, ...extras };
}

/** Convert VM-owned values into host-realm values for strict assertions. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Request the active chart identity from an injected script instance. */
async function getContext(injected) {
  const response = await injected.send('GET_DRAWING_CONTEXT');
  assert.equal(response.error, null);
  return response.result;
}

/** Send a category reconciliation request and return its bridge response. */
async function reconcile(injected, context, kind, items, records = []) {
  return injected.send('RECONCILE_DRAWINGS', { context, kind, items, records });
}

test('reconciliation replaces owned drawings when rank, label, or style changes', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'trades', [trade(10, 100, 1)], []);
  const id = first.result.records[0].shapeId;
  const second = await reconcile(injected, context, 'trades', [trade(10, 100, 2, { options: { tradeLitColor: '#123456' } })], first.result.records);

  assert.equal(second.result.success, true);
  assert.equal(state.calls.created.length, 2);
  assert.deepEqual(state.calls.removed, [id]);
  assert.notEqual(second.result.results[0].shapeId, id);
  assert.equal(second.result.results[0].reused, undefined);
  assert.equal(second.result.results[0].updated, undefined);
  assert.equal(state.entries.get(second.result.results[0].shapeId).properties.text, '● VL #2');
  assert.equal(state.entries.get(second.result.results[0].shapeId).properties.linecolor, '#123456');
});

test('reconciliation replaces drawings even when the requested definition is unchanged', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const item = level(10);
  const first = await reconcile(injected, context, 'levels', [item], []);
  const second = await reconcile(injected, context, 'levels', [item], first.result.records);

  assert.equal(second.result.success, true);
  assert.notEqual(second.result.results[0].shapeId, first.result.records[0].shapeId);
  assert.equal(second.result.results[0].reused, undefined);
  assert.equal(second.result.results[0].updated, undefined);
  assert.deepEqual(state.calls.events, ['create', 'remove', 'create']);
});

test('reconciliation deletes every owned drawing before creating replacement drawings', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10), level(20)], []);
  const second = await reconcile(injected, context, 'levels', [level(20), level(30)], first.result.records);

  assert.equal(second.result.success, true);
  assert.equal(state.calls.created.length, 4);
  assert.deepEqual(state.calls.removed, plain(first.result.records.map(record => record.shapeId)));
  assert.deepEqual(state.calls.events, ['create', 'create', 'remove', 'remove', 'create', 'create']);
  assert.deepEqual(plain(second.result.records.map(record => record.shapeId)), ['shape-3', 'shape-4']);
});

test('removal events happen before replacement creation events', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10)], []);
  state.calls.events.length = 0;

  await reconcile(injected, context, 'levels', [level(20)], first.result.records);

  assert.deepEqual(state.calls.events, ['remove', 'create']);
});

test('duplicate owned drawings are replaced and manual drawings remain untouched', async () => {
  const state = createChart();
  state.entries.set('manual', { name: 'horizontal_line', points: [{ price: 50 }], properties: { text: 'My line' } });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10), level(10)], []);
  const second = await reconcile(injected, context, 'levels', [level(10), level(10)], first.result.records);

  assert.equal(second.result.success, true);
  assert.equal(state.calls.created.length, 4);
  assert.deepEqual(state.calls.removed, ['shape-1', 'shape-2']);
  assert.equal(second.result.records.length, 2);
  assert.equal(state.entries.has('manual'), true);
});

test('levels and trades reconcile separately and preserve unrelated shapes', async () => {
  const state = createChart();
  state.entries.set('manual', { name: 'horizontal_ray', points: [{ price: 99, time: 100 }], properties: { text: 'Manual' } });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const levels = await reconcile(injected, context, 'levels', [level(10)], []);
  const trades = await reconcile(injected, context, 'trades', [trade(20, 200)], []);
  const replacedLevels = await reconcile(injected, context, 'levels', [level(11)], levels.result.records);
  assert.equal(state.entries.has(trades.result.records[0].shapeId), true);
  const emptyLevels = await reconcile(injected, context, 'levels', [], replacedLevels.result.records);
  assert.equal(state.entries.has(trades.result.records[0].shapeId), true);
  const emptyTrades = await reconcile(injected, context, 'trades', [], trades.result.records);

  assert.equal(replacedLevels.result.success, true);
  assert.equal(emptyLevels.result.success, true);
  assert.equal(emptyTrades.result.success, true);
  assert.equal(state.entries.has(levels.result.records[0].shapeId), false);
  assert.equal(state.entries.has(replacedLevels.result.records[0].shapeId), false);
  assert.equal(state.entries.has(trades.result.records[0].shapeId), false);
  assert.equal(state.entries.has('manual'), true);
});

test('reconciliation rejects non-level items before mutation', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const zone = { type: 'zone', highPrice: 12, lowPrice: 8, midPrice: 10, timestamp: 100, label: 'VL Zone' };
  const response = await reconcile(injected, context, 'levels', [zone], []);

  assert.match(response.error, /must have type 'level'/);
  assert.equal(state.calls.created.length, 0);
  assert.equal(state.calls.removed.length, 0);
});

test('skipped trade results are preserved while old owned trade drawings are removed', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'trades', [trade(10, 100)], []);

  const skipped = await reconcile(injected, context, 'trades', [trade(10, 100, 0)], first.result.records);

  assert.equal(skipped.result.success, true);
  assert.deepEqual(plain(skipped.result.results), [{
    skipped: true,
    price: 10,
    timestamp: 100,
    rank: 0,
    reason: 'invalid_rank'
  }]);
  assert.deepEqual(plain(skipped.result.removed), [first.result.records[0].shapeId]);
  assert.deepEqual(plain(skipped.result.records), []);
});

test('replacement records preserve requested times and actual snapped points across VM sessions', async () => {
  const state = createChart({ snapSeconds: 3 });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10, 100)], []);
  const record = first.result.records[0];

  assert.deepEqual(JSON.parse(JSON.stringify(record.points)), [{ price: 10, time: 103 }]);
  const secondInjected = loadInjected(state);
  const second = await reconcile(secondInjected, await getContext(secondInjected), 'levels', [level(10, 100)], [record]);
  assert.equal(second.result.success, true);
  assert.notEqual(second.result.records[0].shapeId, record.shapeId);
  assert.deepEqual(plain(second.result.records[0].points), [{ price: 10, time: 103 }]);
  assert.equal(state.calls.created.length, 2);
  assert.deepEqual(state.calls.removed, [record.shapeId]);
});

test('replacement uses the current chart anchor after chart history loads', async () => {
  const state = createChart({ snapSeconds: 3 });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10, 100)], []);
  const originalRecord = first.result.records[0];
  state.options.snapSeconds = 0;
  const afterHistoryLoads = await reconcile(injected, context, 'levels', [level(10, 100)], [originalRecord]);

  assert.equal(afterHistoryLoads.result.success, true);
  assert.notEqual(afterHistoryLoads.result.results[0].shapeId, originalRecord.shapeId);
  assert.deepEqual(plain(afterHistoryLoads.result.records[0].points), [{ price: 10, time: 100 }]);
  assert.equal(state.calls.created.length, 2);
  assert.deepEqual(state.calls.removed, [originalRecord.shapeId]);
});

test('a failed replacement does not retain a deleted shape recovery record', async () => {
  const state = createChart({ snapSeconds: 3 });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10, 100)], []);
  const originalRecord = first.result.records[0];
  state.chart.createShape = () => { throw new Error('createShape failed'); };
  const failed = await reconcile(injected, context, 'levels', [level(10, 100)], [originalRecord]);

  assert.equal(failed.result.success, false);
  assert.deepEqual(plain(failed.result.records), []);
  assert.equal(state.entries.has(originalRecord.shapeId), false);
  assert.deepEqual(state.calls.removed, [originalRecord.shapeId]);
});

test('recorded drawings are always replaced and missing recorded drawings are recreated', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10)], []);
  const oldId = first.result.records[0].shapeId;
  const moved = await reconcile(injected, context, 'levels', [level(10)], first.result.records);
  assert.equal(moved.result.success, true);
  assert.notEqual(moved.result.records[0].shapeId, oldId);
  assert.deepEqual(state.calls.removed, [oldId]);

  const missingId = moved.result.records[0].shapeId;
  state.entries.delete(missingId);
  const missing = await reconcile(injected, context, 'levels', [level(10)], moved.result.records);
  assert.equal(missing.result.success, true);
  assert.notEqual(missing.result.records[0].shapeId, missingId);
});

test('a unique legacy drawing is deleted instead of adopted', async () => {
  const state = createChart();
  state.entries.set('legacy', { name: 'horizontal_ray', points: [{ price: 10, time: 90 }], properties: { text: 'VL old' } });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const response = await reconcile(injected, context, 'levels', [level(10, 100)], []);

  assert.equal(response.result.success, true);
  assert.notEqual(response.result.results[0].shapeId, 'legacy');
  assert.deepEqual(state.calls.removed, ['legacy']);
  assert.equal(state.calls.created.length, 1);
  assert.equal(state.entries.has('legacy'), false);
});

test('failed legacy replacement does not retain a deleted legacy drawing record', async () => {
  const state = createChart();
  state.entries.set('legacy', {
    name: 'horizontal_ray',
    points: [{ price: 10, time: 90 }],
    properties: { text: 'VL old' }
  });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  state.chart.createShape = () => { throw new Error('createShape failed'); };
  const first = await reconcile(injected, context, 'levels', [level(10, 100)], []);

  assert.equal(first.result.success, false);
  assert.deepEqual(plain(first.result.records), []);
  assert.equal(state.entries.has('legacy'), false);
  assert.deepEqual(state.calls.removed, ['legacy']);
});

test('saved custom-labeled levels remain owned across replacement, then clear', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10, null, 'support #1')], []);
  const oldId = first.result.records[0].shapeId;
  const updated = await reconcile(injected, context, 'levels', [level(10, null, 'support #2', { linewidth: 5 })], first.result.records);
  const id = updated.result.records[0].shapeId;
  const updatedProperties = state.entries.get(id).properties;
  const cleared = await reconcile(injected, context, 'levels', [], updated.result.records);

  assert.equal(updated.result.success, true);
  assert.notEqual(id, oldId);
  assert.deepEqual(state.calls.removed, [oldId, id]);
  assert.equal(state.calls.created.length, 2);
  assert.equal(updatedProperties.text, 'support #2');
  assert.equal(updatedProperties.linewidth, 5);
  assert.equal(cleared.result.success, true);
  assert.deepEqual(plain(cleared.result.removed), [id]);
  assert.equal(state.entries.has(id), false);
});

test('saved renamed trade records remain owned and are replaced with the requested label', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'trades', [trade(10, 100, 1)], []);
  const oldId = first.result.records[0].shapeId;
  state.entries.get(oldId).properties.text = 'Renamed by user';
  const updated = await reconcile(injected, context, 'trades', [trade(10, 100, 2)], first.result.records);
  const id = updated.result.records[0].shapeId;

  assert.equal(updated.result.success, true);
  assert.notEqual(id, oldId);
  assert.deepEqual(state.calls.removed, [oldId]);
  assert.equal(state.calls.created.length, 2);
  assert.equal(state.entries.get(id).properties.text, '● VL #2');
});

test('manual horizontal lines without text properties do not block reconciliation', async () => {
  const state = createChart();
  state.entries.set('manual', { name: 'horizontal_line', points: [{ price: 50 }], properties: { linecolor: '#123456' } });
  state.entries.set('custom-manual', { name: 'horizontal_line', points: [{ price: 10 }], properties: { text: 'support' } });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const response = await reconcile(injected, context, 'levels', [level(10)], []);

  assert.equal(response.result.success, true);
  assert.equal(state.entries.has('manual'), true);
  assert.equal(state.entries.has('custom-manual'), true);
  assert.equal(state.calls.created.length, 1);
  assert.notEqual(response.result.results[0].shapeId, 'custom-manual');
});

test('preflight failures do not mutate the chart', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  state.chart.getAllShapes = undefined;
  const response = await reconcile(injected, context, 'levels', [level(10)], []);

  assert.match(response.error, /getAllShapes/);
  assert.equal(state.calls.created.length, 0);
  assert.equal(state.calls.removed.length, 0);
});

test('malformed records fail preflight before owned drawings are removed', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10)], []);

  const response = await reconcile(injected, context, 'levels', [level(20)], [{
    shapeId: first.result.records[0].shapeId,
    key: 'valid-key',
    points: []
  }]);

  assert.match(response.error, /exactly one point/);
  assert.deepEqual(state.calls.removed, []);
  assert.equal(state.entries.has(first.result.records[0].shapeId), true);
  assert.equal(state.calls.created.length, 1);
});

test('missing required create and remove APIs fail before mutation', async () => {
  const state = createChart();
  state.entries.set('existing', { name: 'horizontal_line', points: [{ price: 10 }], properties: { text: 'VL old' } });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const originalCreateShape = state.chart.createShape;
  state.chart.createShape = undefined;
  const response = await reconcile(injected, context, 'levels', [level(10)], []);

  assert.match(response.error, /createShape/);
  assert.equal(state.calls.created.length, 0);
  assert.equal(state.calls.removed.length, 0);
  assert.equal(state.entries.has('existing'), true);

  state.chart.createShape = originalCreateShape;
  state.chart.removeEntity = undefined;
  const missingRemove = await reconcile(injected, context, 'levels', [level(10)], []);
  assert.match(missingRemove.error, /removeEntity/);
  assert.equal(state.calls.created.length, 0);
  assert.equal(state.entries.has('existing'), true);
});

test('failed creation leaves deleted old drawings out of recovery records', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10)], []);
  state.chart.createShape = () => { throw new Error('createShape failed'); };
  const second = await reconcile(injected, context, 'levels', [level(20)], first.result.records);

  assert.equal(second.result.success, false);
  assert.deepEqual(state.calls.removed, [first.result.records[0].shapeId]);
  assert.deepEqual(plain(second.result.records), []);
  assert.equal(state.entries.has(first.result.records[0].shapeId), false);
});

test('partial creation keeps only new recovery records and retries by replacing them', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(5)], []);
  const originalCreate = state.chart.createShape;
  let createCount = 0;
  state.chart.createShape = (point, config) => {
    createCount++;
    if (createCount === 2) throw new Error('second create failed');
    return originalCreate(point, config);
  };
  const second = await reconcile(injected, context, 'levels', [level(10), level(20)], first.result.records);

  assert.equal(second.result.success, false);
  assert.deepEqual(plain(state.calls.removed), [first.result.records[0].shapeId]);
  assert.equal(state.entries.has(first.result.records[0].shapeId), false);
  assert.equal(second.result.records.length, 1);
  assert.equal(second.result.records[0].key, JSON.stringify(['level', 10, null]));
  const partialId = second.result.records[0].shapeId;

  const retry = await reconcile(injected, context, 'levels', [level(10), level(20)], second.result.records);

  assert.equal(retry.result.success, true);
  assert.deepEqual(plain(state.calls.removed), [first.result.records[0].shapeId, partialId]);
  assert.equal(state.entries.has(partialId), false);
  assert.equal(retry.result.records.length, 2);
  assert.equal(retry.result.records.some(record => record.shapeId === partialId), false);
});

test('a failed removal stops before creating any requested drawing', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10)], []);
  state.options.failRemove = true;

  const failed = await reconcile(injected, context, 'levels', [level(20)], first.result.records);

  assert.equal(failed.result.success, false);
  assert.equal(state.calls.created.length, 1);
  assert.deepEqual(state.calls.removed, [first.result.records[0].shapeId]);
  assert.equal(state.entries.has(first.result.records[0].shapeId), true);
  assert.deepEqual(plain(failed.result.records), plain(first.result.records));
});

test('successful deletions are removed from recovery records before a later deletion fails', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10), level(20)], []);
  const removedId = first.result.records[0].shapeId;
  const failedId = first.result.records[1].shapeId;
  const originalRemoveEntity = state.chart.removeEntity;
  state.chart.removeEntity = id => {
    if (id === failedId) {
      state.calls.events.push('remove');
      state.calls.removed.push(id);
      throw new Error('removeEntity failed');
    }
    return originalRemoveEntity(id);
  };

  const failed = await reconcile(injected, context, 'levels', [level(30)], first.result.records);

  assert.equal(failed.result.success, false);
  assert.deepEqual(plain(failed.result.removed), [removedId]);
  assert.deepEqual(plain(failed.result.records.map(record => record.shapeId)), [failedId]);
  assert.equal(state.entries.has(removedId), false);
  assert.equal(state.entries.has(failedId), true);
  assert.equal(state.calls.created.length, 2);
});

test('an empty category removes its owned shapes', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10)], []);
  const empty = await reconcile(injected, context, 'levels', [], first.result.records);

  assert.equal(empty.result.success, true);
  assert.deepEqual(plain(empty.result.records), []);
  assert.deepEqual(plain(empty.result.removed), [first.result.records[0].shapeId]);
});

test('context changes before reconciliation fail without mutating the captured chart', async () => {
  const state = createChart();
  const other = createChart({ symbol: 'NASDAQ:MSFT' });
  let active = state.chart;
  const injected = loadInjected({ get chart() { return active; } });
  const context = await getContext(injected);
  active = other.chart;
  const response = await reconcile(injected, context, 'levels', [level(10)], []);

  assert.match(response.error, /context/);
  assert.equal(state.calls.created.length, 0);
});

test('drawing context includes the active chart index when exposed', async () => {
  const state = createChart();
  const injected = loadInjected(state, { activeChartIndex: () => 3, pathname: '/chart/layout' });
  const context = await getContext(injected);

  assert.deepEqual(plain(context), {
    key: JSON.stringify(['/chart/layout', 'NASDAQ:AAPL', 3]),
    symbol: 'AAPL'
  });
});

test('a context switch after create reports failure and preserves its recovery record', async () => {
  const state = createChart();
  const other = createChart({ symbol: 'NASDAQ:MSFT' });
  let active = state.chart;
  state.chart.createShape = function(point, config) {
    const id = `created-${state.calls.created.length + 1}`;
    state.calls.created.push({ id, point, config });
    state.entries.set(id, { name: config.shape, points: [point], properties: { text: config.text, ...config.overrides } });
    active = other.chart;
    return id;
  };
  const injected = loadInjected({ get chart() { return active; } });
  const context = await getContext(injected);
  const response = await reconcile(injected, context, 'levels', [level(10)], []);

  assert.equal(response.result.success, false);
  assert.deepEqual(state.calls.removed, []);
  assert.equal(response.result.records.length, 1);
});
