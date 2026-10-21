const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/** Create a controllable TradingView chart double and its tracked shape state. */
function createChart(options = {}) {
  let nextId = 1;
  const entries = new Map();
  const calls = { created: [], removed: [], setProperties: [], setPoints: [] };
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
        setProperties(properties) {
          calls.setProperties.push({ id, properties });
          if (entry.failSetProperties) throw new Error('setProperties failed');
          entry.properties = { ...entry.properties, ...properties };
        },
        setPoints(points) {
          calls.setPoints.push({ id, points });
          if (entry.failSetPoints === true || entry.failSetPoints > 0) {
            if (typeof entry.failSetPoints === 'number') entry.failSetPoints--;
            throw new Error('setPoints failed');
          }
          entry.points = points.map(point => ({ ...point, time: point.time ? point.time + (options.snapSeconds || 0) : point.time }));
        }
      };
      if (entry.noSetProperties) delete shape.setProperties;
      if (entry.noSetPoints) delete shape.setPoints;
      return shape;
    },
    createShape(point, config) {
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
      calls.removed.push(id);
      if (options.failRemove) throw new Error('removeEntity failed');
      entries.delete(id);
    },
    getVisibleRange() {
      return null;
    }
  };
  return { chart, entries, calls };
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

test('reconciliation retains shape identity while updating rank, label, and style', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'trades', [trade(10, 100, 1)], []);
  const id = first.result.records[0].shapeId;
  const second = await reconcile(injected, context, 'trades', [trade(10, 100, 2, { options: { tradeLitColor: '#123456' } })], first.result.records);

  assert.equal(second.result.success, true);
  assert.equal(state.calls.created.length, 1);
  assert.equal(state.calls.removed.length, 0);
  assert.equal(second.result.results[0].shapeId, id);
  assert.equal(second.result.results[0].updated, true);
  assert.equal(state.entries.get(id).properties.text, '● VL #2');
  assert.equal(state.entries.get(id).properties.linecolor, '#123456');
});

test('reconciliation does not call setters when the requested properties already match', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const item = level(10);
  const first = await reconcile(injected, context, 'levels', [item], []);
  const second = await reconcile(injected, context, 'levels', [item], first.result.records);

  assert.equal(second.result.success, true);
  assert.equal(second.result.results[0].reused, true);
  assert.equal(second.result.results[0].updated, undefined);
  assert.deepEqual(state.calls.setProperties, []);
  assert.deepEqual(state.calls.setPoints, []);
});

test('reconciliation adds desired drawings and removes obsolete drawings in the category only', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10), level(20)], []);
  const retainedId = first.result.records[1].shapeId;
  const second = await reconcile(injected, context, 'levels', [level(20), level(30)], first.result.records);

  assert.equal(second.result.success, true);
  assert.equal(state.calls.created.length, 3);
  assert.deepEqual(state.calls.removed, [first.result.records[0].shapeId]);
  assert.deepEqual(plain(second.result.records.map(record => record.shapeId)), [retainedId, 'shape-3']);
});

test('duplicates are matched one-to-one and manual drawings remain untouched', async () => {
  const state = createChart();
  state.entries.set('manual', { name: 'horizontal_line', points: [{ price: 50 }], properties: { text: 'My line' } });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10), level(10)], []);
  const second = await reconcile(injected, context, 'levels', [level(10), level(10)], first.result.records);

  assert.equal(second.result.success, true);
  assert.equal(state.calls.created.length, 2);
  assert.equal(state.calls.removed.length, 0);
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
  const emptyLevels = await reconcile(injected, context, 'levels', [], levels.result.records);

  assert.equal(trades.result.success, true);
  assert.equal(emptyLevels.result.success, true);
  assert.equal(state.entries.has(levels.result.records[0].shapeId), false);
  assert.equal(state.entries.has(trades.result.records[0].shapeId), true);
  assert.equal(state.entries.has('manual'), true);
});

test('zone identity changes when constituent membership changes', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  /** Build a zone whose constituent membership can be varied. */
  const zone = levels => ({ type: 'zone', highPrice: 12, lowPrice: 8, midPrice: 10, timestamp: 100, levels, label: 'VL Zone' });
  const first = await reconcile(injected, context, 'levels', [zone([{ price: 8, timestamp: 90 }, { price: 12, timestamp: 95 }])], []);
  const second = await reconcile(injected, context, 'levels', [zone([{ price: 8, timestamp: 90 }, { price: 11, timestamp: 95 }, { price: 12, timestamp: 95 }])], first.result.records);

  assert.equal(second.result.success, true);
  assert.notEqual(second.result.records[0].shapeId, first.result.records[0].shapeId);
  assert.deepEqual(state.calls.removed, [first.result.records[0].shapeId]);
});

test('records preserve requested times and actual snapped points across VM sessions', async () => {
  const state = createChart({ snapSeconds: 3 });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10, 100)], []);
  const record = first.result.records[0];

  assert.deepEqual(JSON.parse(JSON.stringify(record.points)), [{ price: 10, time: 103 }]);
  const secondInjected = loadInjected(state);
  const second = await reconcile(secondInjected, await getContext(secondInjected), 'levels', [level(10, 100)], [record]);
  assert.equal(second.result.success, true);
  assert.equal(second.result.results[0].reused, true);
  assert.equal(state.calls.created.length, 1);
});

test('moved recorded drawings are replaced and deleted recorded drawings are recreated', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10)], []);
  const oldId = first.result.records[0].shapeId;
  state.entries.get(oldId).points[0].price = 11;
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

test('unique legacy drawings are adopted and their anchor is normalized in place', async () => {
  const state = createChart();
  state.entries.set('legacy', { name: 'horizontal_ray', points: [{ price: 10, time: 90 }], properties: { text: 'VL old' } });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const response = await reconcile(injected, context, 'levels', [level(10, 100)], []);

  assert.equal(response.result.success, true);
  assert.equal(response.result.results[0].reused, true);
  assert.equal(response.result.results[0].updated, true);
  assert.deepEqual(plain(state.calls.setPoints), [{ id: 'legacy', points: [{ price: 10, time: 100 }] }]);
  assert.equal(state.calls.created.length, 0);
});

test('failed legacy point normalization retries the same shape without recording the requested key', async () => {
  const state = createChart();
  state.entries.set('legacy', {
    name: 'horizontal_ray',
    points: [{ price: 10, time: 90 }],
    properties: { text: 'VL old' },
    failSetPoints: 1
  });
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10, 100)], []);

  assert.equal(first.result.success, false);
  assert.deepEqual(plain(first.result.records), []);
  const retry = await reconcile(injected, context, 'levels', [level(10, 100)], first.result.records);

  assert.equal(retry.result.success, true);
  assert.equal(retry.result.results[0].shapeId, 'legacy');
  assert.deepEqual(plain(state.calls.setPoints), [
    { id: 'legacy', points: [{ price: 10, time: 100 }] },
    { id: 'legacy', points: [{ price: 10, time: 100 }] }
  ]);
  assert.deepEqual(plain(state.entries.get('legacy').points), [{ price: 10, time: 100 }]);
});

test('saved custom-labeled levels retain identity across label and style changes, then clear', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10, null, 'support #1')], []);
  const id = first.result.records[0].shapeId;
  const updated = await reconcile(injected, context, 'levels', [level(10, null, 'support #2', { linewidth: 5 })], first.result.records);
  const updatedProperties = state.entries.get(id).properties;
  const cleared = await reconcile(injected, context, 'levels', [], updated.result.records);

  assert.equal(updated.result.success, true);
  assert.equal(updated.result.results[0].shapeId, id);
  assert.equal(updated.result.results[0].updated, true);
  assert.equal(state.calls.created.length, 1);
  assert.equal(updatedProperties.text, 'support #2');
  assert.equal(updatedProperties.linewidth, 5);
  assert.equal(cleared.result.success, true);
  assert.deepEqual(plain(cleared.result.removed), [id]);
  assert.equal(state.entries.has(id), false);
});

test('saved renamed trade records retain the same ray and repair its label', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'trades', [trade(10, 100, 1)], []);
  const id = first.result.records[0].shapeId;
  state.entries.get(id).properties.text = 'Renamed by user';
  const updated = await reconcile(injected, context, 'trades', [trade(10, 100, 2)], first.result.records);

  assert.equal(updated.result.success, true);
  assert.equal(updated.result.results[0].shapeId, id);
  assert.equal(updated.result.results[0].updated, true);
  assert.equal(state.calls.created.length, 1);
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

test('missing required setters fail before mutation', async () => {
  const state = createChart();
  state.entries.set('existing', { name: 'horizontal_line', points: [{ price: 10 }], properties: { text: 'VL old', linecolor: '#000000' } });
  const shape = state.chart.getShapeById('existing');
  state.entries.get('existing').noSetProperties = true;
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const response = await reconcile(injected, context, 'levels', [level(10)], []);

  assert.match(response.error, /setProperties/);
  assert.equal(state.calls.created.length, 0);
  assert.equal(state.calls.removed.length, 0);
  assert.ok(shape);
});

test('failed creation keeps old drawings and records for a safe retry', async () => {
  const state = createChart();
  const injected = loadInjected(state);
  const context = await getContext(injected);
  const first = await reconcile(injected, context, 'levels', [level(10)], []);
  state.chart.createShape = () => { throw new Error('createShape failed'); };
  const second = await reconcile(injected, context, 'levels', [level(20)], first.result.records);

  assert.equal(second.result.success, false);
  assert.deepEqual(state.calls.removed, []);
  assert.deepEqual(second.result.records, first.result.records);
  assert.equal(state.entries.has(first.result.records[0].shapeId), true);
});

test('partial creation retains both stale and newly-created records without deleting stale drawings', async () => {
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
  assert.deepEqual(plain(state.calls.removed), []);
  assert.equal(second.result.records.length, 2);
  assert.equal(second.result.records[0].shapeId, first.result.records[0].shapeId);
  assert.equal(second.result.records[1].key, JSON.stringify(['level', 10, null]));
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

test('a context switch after a create reports failure and does not delete stale drawings', async () => {
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
