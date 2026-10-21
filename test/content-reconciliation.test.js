const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const contentScript = fs.readFileSync(
  path.join(__dirname, '../firefox/content-script.js'),
  'utf8'
);

/** Load the content script with controllable bridge responses and storage failures. */
function createHarness({ respond, initialStorage = {}, storageErrors = {} } = {}) {
  const storage = { ...initialStorage };
  const commands = [];
  const messageListeners = new Set();
  let runtimeListener;
  const storageCalls = [];

  const window = {
    top: null,
    location: { pathname: '/chart/layout-1/' },
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') messageListeners.delete(listener);
    },
    postMessage(message) {
      commands.push(message);
      Promise.resolve().then(async () => {
        let result;
        let error;
        try {
          result = await respond?.(message.command, message.data);
        } catch (err) {
          error = err.message;
        }
        const event = {
          source: window,
          data: {
            source: 'vl-tv-injected',
            messageId: message.messageId,
            result,
            error
          }
        };
        for (const listener of [...messageListeners]) listener(event);
      });
    }
  };
  window.top = window;

  const browser = {
    runtime: {
      getURL: file => file,
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        }
      }
    },
    storage: {
      local: {
        async get(key) {
          storageCalls.push({ operation: 'get', key });
          if (storageErrors.get) throw new Error(storageErrors.get);
          return { [key]: storage[key] };
        },
        async set(value) {
          const key = Object.keys(value)[0];
          storageCalls.push({ operation: 'set', key, value: structuredClone(value[key]) });
          if (storageErrors.set) throw new Error(storageErrors.set);
          Object.assign(storage, structuredClone(value));
        }
      }
    }
  };

  const document = {
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    createElement() {
      return { remove() {} };
    },
    getElementById() {
      return null;
    }
  };
  const context = vm.createContext({
    window,
    browser,
    document,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Math,
    Date
  });
  vm.runInContext(contentScript, context);

  return {
    commands,
    storage,
    storageCalls,
    send(message) {
      return new Promise(resolve => {
        const returnedAsync = runtimeListener(message, {}, resolve);
        if (!returnedAsync) resolve(undefined);
      });
    }
  };
}

/** Return a chart context fixture with optional scope or symbol overrides. */
function contextResponse(overrides = {}) {
  return { key: '/chart/layout-1/|NASDAQ:AAPL|0', symbol: 'AAPL', ...overrides };
}

test('levels reconcile normalized lines and zones without issuing bulk clears', async () => {
  let reconcileData;
  const harness = createHarness({
    respond: async (command, data) => {
      if (command === 'GET_DRAWING_CONTEXT') return contextResponse();
      if (command === 'RECONCILE_DRAWINGS') {
        reconcileData = data;
        return {
          success: true,
          results: data.items.map((item, index) => ({ success: true, shapeId: `shape-${index}` })),
          records: [{ shapeId: 'shape-0', key: 'line-key', points: [] }],
          removed: 1
        };
      }
      throw new Error(`Unexpected injected command ${command}`);
    }
  });

  const response = await harness.send({
    type: 'DRAW_LEVELS',
    symbol: 'NASDAQ:AAPL.US',
    levels: [
      { type: 'level', price: 10, timestamp: 123, label: 'support' },
      {
        type: 'zone', highPrice: 12, lowPrice: 10, midPrice: 11, timestamp: 124,
        label: 'cluster', levels: [{ price: 10, timestamp: 123 }, { price: 12, timestamp: 124 }]
      }
    ],
    options: { color: '#123456', width: 3, opacity: 40, style: 2 }
  });

  assert.equal(response.success, true);
  assert.equal(response.drawn, 2);
  assert.equal(response.removed, 1);
  assert.equal(reconcileData.kind, 'levels');
  assert.deepEqual(JSON.parse(JSON.stringify(reconcileData.items)), [
    {
      type: 'level', price: 10, timestamp: 123, label: 'support',
      options: { linecolor: '#123456', linewidth: 3, lineopacity: 40, linestyle: 2 }
    },
    {
      type: 'zone', highPrice: 12, lowPrice: 10, midPrice: 11, timestamp: 124, label: 'cluster',
      levels: [{ price: 10, timestamp: 123 }, { price: 12, timestamp: 124 }],
      options: { linecolor: '#123456', linewidth: 4, lineopacity: 40, linestyle: 2 }
    }
  ]);
  assert.equal(harness.commands.some(command => command.command.startsWith('CLEAR_')), false);
  assert.ok(harness.storage['vlDrawings:/chart/layout-1/|NASDAQ:AAPL|0:levels']);
  assert.equal(Object.hasOwn(harness.storage, 'drawnShapeIds'), false);
});

test('trade reconcile keeps source metadata and aggregates dark-pool, lit, and skipped counts', async () => {
  let reconcileData;
  const harness = createHarness({
    respond: async (command, data) => {
      if (command === 'GET_DRAWING_CONTEXT') return contextResponse();
      if (command === 'RECONCILE_DRAWINGS') {
        reconcileData = data;
        return {
          success: false,
          results: [
            { success: true, shapeId: 'dark-shape' },
            { success: true, shapeId: 'lit-shape' },
            { skipped: true, reason: 'outside_visible_range' }
          ],
          records: [{ shapeId: 'dark-shape', key: 'trade', points: [] }],
          removed: 0,
          error: 'One item failed'
        };
      }
    }
  });

  const response = await harness.send({
    type: 'DRAW_NOTES',
    trades: [
      { price: 20, timestamp: 1, rank: 1, originalRank: 5, darkPool: true, sweep: true, dollars: 1e6 },
      { price: 21, timestamp: 2, rank: 2, darkPool: false, dollarVolume: 2e6 },
      { price: 22, timestamp: 3, rank: 3, darkPool: true }
    ],
    options: { tradeThickness: 4, tradeLitColor: '#abcdef' }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(reconcileData.items[0])), {
    price: 20, timestamp: 1, rank: 1, originalRank: 5, darkPool: true, sweep: true,
    dollarVolume: 1e6, options: { tradeThickness: 4, tradeLitColor: '#abcdef' }
  });
  assert.equal(response.success, false);
  assert.equal(response.drawn, 2);
  assert.equal(response.skipped, 1);
  assert.equal(response.darkPoolCount, 1);
  assert.equal(response.litCount, 1);
  assert.equal(response.failed, 0);
  assert.equal(response.error, 'One item failed');
  assert.equal(response.results[0].darkPool, true);
});

test('level and trade records use independent category keys for each chart context', async () => {
  let invocation = 0;
  const harness = createHarness({
    respond: async (command, data) => {
      if (command === 'GET_DRAWING_CONTEXT') return contextResponse();
      if (command === 'RECONCILE_DRAWINGS') {
        invocation += 1;
        assert.deepEqual(JSON.parse(JSON.stringify(data.records)), []);
        return { success: true, results: [], records: [{ shapeId: `id-${invocation}`, key: 'k', points: [] }], removed: 0 };
      }
    }
  });

  await harness.send({ type: 'DRAW_LEVELS', levels: [] });
  await harness.send({ type: 'DRAW_NOTES', trades: [] });
  assert.deepEqual(harness.storage['vlDrawings:/chart/layout-1/|NASDAQ:AAPL|0:levels'], [
    { shapeId: 'id-1', key: 'k', points: [] }
  ]);
  assert.deepEqual(harness.storage['vlDrawings:/chart/layout-1/|NASDAQ:AAPL|0:trades'], [
    { shapeId: 'id-2', key: 'k', points: [] }
  ]);
});

test('expected symbol mismatch stops before reconciliation or storage mutation', async () => {
  const harness = createHarness({
    respond: async command => command === 'GET_DRAWING_CONTEXT' ? contextResponse() : assert.fail(`Unexpected ${command}`),
    initialStorage: { 'vlDrawings:/chart/layout-1/|NASDAQ:AAPL|0:levels': [{ shapeId: 'existing' }] }
  });

  const response = await harness.send({ type: 'DRAW_LEVELS', symbol: 'NASDAQ:MSFT', levels: [] });
  assert.equal(response.success, false);
  assert.match(response.error, /symbol/i);
  assert.equal(harness.commands.length, 1);
  assert.deepEqual(harness.storageCalls, []);
  assert.deepEqual(harness.storage['vlDrawings:/chart/layout-1/|NASDAQ:AAPL|0:levels'], [{ shapeId: 'existing' }]);
});

test('partial core failure persists returned successful shape records and reports failures', async () => {
  const storageKey = 'vlDrawings:/chart/layout-1/|NASDAQ:AAPL|0:levels';
  const harness = createHarness({
    respond: async (command, data) => {
      if (command === 'GET_DRAWING_CONTEXT') return contextResponse();
      if (command === 'RECONCILE_DRAWINGS') return {
        success: false,
        results: [{ success: true, shapeId: 'existing-reused' }, { success: false, error: 'bad item' }],
        records: [{ shapeId: 'existing-reused', key: 'stable', points: [] }],
        removed: 0
      };
    },
    initialStorage: { [storageKey]: [{ shapeId: 'stale' }] }
  });

  const response = await harness.send({
    type: 'DRAW_LEVELS', levels: [{ type: 'level', price: 1 }, { type: 'level', price: 2 }]
  });
  assert.equal(response.success, false);
  assert.equal(response.drawn, 1);
  assert.equal(response.failed, 1);
  assert.deepEqual(harness.storage[storageKey], [{ shapeId: 'existing-reused', key: 'stable', points: [] }]);
});

test('explicit clear reconciles both categories only in the active context', async () => {
  const otherKey = 'vlDrawings:/chart/other|NASDAQ:AAPL|0:levels';
  const harness = createHarness({
    respond: async (command, data) => {
      if (command === 'GET_DRAWING_CONTEXT') return contextResponse();
      if (command === 'RECONCILE_DRAWINGS') return {
        success: true, results: [], records: [], removed: data.records.length
      };
    },
    initialStorage: {
      [otherKey]: [{ shapeId: 'other-chart' }],
      'vlDrawings:/chart/layout-1/|NASDAQ:AAPL|0:levels': [{ shapeId: 'level-1' }],
      'vlDrawings:/chart/layout-1/|NASDAQ:AAPL|0:trades': [{ shapeId: 'trade-1' }]
    }
  });

  const response = await harness.send({ type: 'CLEAR_DRAWN' });
  const batches = harness.commands.filter(command => command.command === 'RECONCILE_DRAWINGS');
  assert.equal(response.success, true);
  assert.equal(response.removed, 2);
  assert.deepEqual(batches.map(command => command.data.kind), ['levels', 'trades']);
  assert.deepEqual(JSON.parse(JSON.stringify(batches.map(command => command.data.items))), [[], []]);
  assert.deepEqual(harness.storage[otherKey], [{ shapeId: 'other-chart' }]);
  assert.deepEqual(harness.storage['vlDrawings:/chart/layout-1/|NASDAQ:AAPL|0:levels'], []);
  assert.deepEqual(harness.storage['vlDrawings:/chart/layout-1/|NASDAQ:AAPL|0:trades'], []);
});

test('drawing callbacks are serialized through completion', async () => {
  let resolveFirst;
  let reconcileCount = 0;
  const harness = createHarness({
    respond: async (command, data) => {
      if (command === 'GET_DRAWING_CONTEXT') return contextResponse();
      if (command === 'RECONCILE_DRAWINGS') {
        reconcileCount += 1;
        if (reconcileCount === 1) {
          await new Promise(resolve => { resolveFirst = resolve; });
        }
        return { success: true, results: [], records: [], removed: 0 };
      }
    }
  });

  const first = harness.send({ type: 'DRAW_LEVELS', levels: [] });
  await new Promise(resolve => setImmediate(resolve));
  const second = harness.send({ type: 'DRAW_NOTES', trades: [] });
  const third = harness.send({ type: 'CLEAR_DRAWN' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reconcileCount, 1);
  resolveFirst();
  await Promise.all([first, second, third]);
  assert.equal(reconcileCount, 4);
});

test('bridge and storage failures preserve stored records and return failure', async t => {
  const storageKey = 'vlDrawings:/chart/layout-1/|NASDAQ:AAPL|0:levels';
  await t.test('bridge rejects', async () => {
    const harness = createHarness({
      respond: async command => {
        if (command === 'GET_DRAWING_CONTEXT') return contextResponse();
        throw new Error('bridge failed');
      },
      initialStorage: { [storageKey]: [{ shapeId: 'keep-me' }] }
    });
    const response = await harness.send({ type: 'DRAW_LEVELS', levels: [] });
    assert.equal(response.success, false);
    assert.deepEqual(harness.storage[storageKey], [{ shapeId: 'keep-me' }]);
  });

  await t.test('storage set rejects', async () => {
    const harness = createHarness({
      respond: async command => command === 'GET_DRAWING_CONTEXT'
        ? contextResponse()
        : { success: true, results: [], records: [], removed: 0 },
      initialStorage: { [storageKey]: [{ shapeId: 'keep-me' }] },
      storageErrors: { set: 'storage unavailable' }
    });
    const response = await harness.send({ type: 'DRAW_LEVELS', levels: [] });
    assert.equal(response.success, false);
    assert.deepEqual(harness.storage[storageKey], [{ shapeId: 'keep-me' }]);
    assert.match(response.error, /storage unavailable/);
  });

  await t.test('storage get rejects', async () => {
    const harness = createHarness({
      respond: async command => command === 'GET_DRAWING_CONTEXT'
        ? contextResponse()
        : assert.fail(`Unexpected ${command}`),
      initialStorage: { [storageKey]: [{ shapeId: 'keep-me' }] },
      storageErrors: { get: 'storage unavailable' }
    });
    const response = await harness.send({ type: 'DRAW_LEVELS', levels: [] });
    assert.equal(response.success, false);
    assert.deepEqual(harness.storage[storageKey], [{ shapeId: 'keep-me' }]);
    assert.equal(harness.commands.length, 1);
  });

  await t.test('malformed core result is not persisted', async () => {
    const harness = createHarness({
      respond: async command => command === 'GET_DRAWING_CONTEXT'
        ? contextResponse()
        : { success: true, results: [], records: null, removed: 0 },
      initialStorage: { [storageKey]: [{ shapeId: 'keep-me' }] }
    });
    const response = await harness.send({ type: 'DRAW_LEVELS', levels: [] });
    assert.equal(response.success, false);
    assert.deepEqual(harness.storage[storageKey], [{ shapeId: 'keep-me' }]);
    assert.equal(harness.storageCalls.filter(call => call.operation === 'set').length, 0);
  });

  await t.test('missing per-item result is not persisted', async () => {
    const harness = createHarness({
      respond: async command => command === 'GET_DRAWING_CONTEXT'
        ? contextResponse()
        : { success: true, results: [], records: [], removed: 0 },
      initialStorage: { [storageKey]: [{ shapeId: 'keep-me' }] }
    });
    const response = await harness.send({
      type: 'DRAW_LEVELS', levels: [{ type: 'level', price: 5 }]
    });
    assert.equal(response.success, false);
    assert.deepEqual(harness.storage[storageKey], [{ shapeId: 'keep-me' }]);
    assert.equal(harness.storageCalls.filter(call => call.operation === 'set').length, 0);
  });
});
