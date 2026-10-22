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
  const warnings = [];
  const context = vm.createContext({
    window,
    browser,
    document,
    console: { log() {}, warn: (...args) => warnings.push(args), error() {} },
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
    get warnings() {
      return plain(warnings);
    },
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

test('levels reconcile normalized lines without issuing bulk clears', async () => {
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
      { type: 'level', price: 10, timestamp: 123, label: 'support' }
    ],
    options: { color: '#123456', width: 3, opacity: 40, style: 2 }
  });

  assert.equal(response.success, true);
  assert.equal(response.drawn, 1);
  assert.equal(response.removed, 1);
  assert.equal(reconcileData.kind, 'levels');
  assert.deepEqual(JSON.parse(JSON.stringify(reconcileData.items)), [
    {
      type: 'level', price: 10, timestamp: 123, label: 'support',
      options: { linecolor: '#123456', linewidth: 3, lineopacity: 40, linestyle: 2 }
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

// 🔔 Alert sync: content script scope selection, storage, and failure isolation.

const LEVEL_ALERTS_KEY = 'vlAlerts:/chart/layout-1/|NASDAQ:AAPL|0:levels';
const TRADE_ALERTS_KEY = 'vlAlerts:/chart/layout-1/|NASDAQ:AAPL|0:trades';
const NO_ALERTS = { created: 0, deleted: 0, kept: 0, skipped: 0, failed: 0 };
const OK_SYNC = { success: true, created: 0, deleted: 0, kept: 0, skipped: 0, failed: 0, records: [], errors: [] };

/** Copy a value out of the vm realm so deepEqual compares plain data. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Build level items with prices 10, 11, ... and the given ranks (undefined means no rank). */
function levelsWithRanks(ranks) {
  return ranks.map((rank, index) => ({ type: 'level', price: 10 + index, rank }));
}

/** Build trade items with prices 20, 21, ... and the given displayed ranks. */
function tradesWithRanks(ranks) {
  return ranks.map((rank, index) => ({ price: 20 + index, timestamp: index + 1, rank }));
}

/** Return the desired alert targets expected for drawn indexes, using the level or trade price base. */
function expectedTargets(indexes, basePrice = 10) {
  return indexes.map(index => ({ shapeId: `shape-${index}`, price: basePrice + index }));
}

/** Return the SYNC_ALERTS payloads sent to the injected script, in order. */
function syncCommands(harness) {
  return harness.commands.filter(command => command.command === 'SYNC_ALERTS').map(command => command.data);
}

/**
 * Build a harness where reconcile succeeds except for failedIndexes, and SYNC_ALERTS
 * answers with syncResponse or throws syncError.
 */
function createAlertHarness({ initialStorage = {}, failedIndexes = [], syncResponse = OK_SYNC, syncError } = {}) {
  return createHarness({
    initialStorage,
    respond: async (command, data) => {
      if (command === 'GET_DRAWING_CONTEXT') return contextResponse();
      if (command === 'RECONCILE_DRAWINGS') return {
        success: failedIndexes.length === 0,
        results: data.items.map((item, index) => failedIndexes.includes(index)
          ? { success: false, error: 'bad item' }
          : { success: true, shapeId: `shape-${index}` }),
        records: [],
        removed: 0
      };
      if (command === 'SYNC_ALERTS') {
        if (syncError) throw new Error(syncError);
        return syncResponse;
      }
      throw new Error(`Unexpected injected command ${command}`);
    }
  });
}

test('trades all syncs only trades while levels off never calls the alert bridge', async () => {
  // Arrange
  const harness = createAlertHarness({ initialStorage: { tradeAlertScope: 'all' } });

  // Act
  const levelResponse = await harness.send({ type: 'DRAW_LEVELS', levels: levelsWithRanks([1, 2]) });
  const tradeResponse = await harness.send({ type: 'DRAW_NOTES', trades: tradesWithRanks([1, undefined]) });

  // Assert
  const syncs = syncCommands(harness);
  assert.deepEqual(syncs.map(sync => sync.kind), ['trades']);
  assert.deepEqual(plain(syncs[0].desired), expectedTargets([0, 1], 20));
  assert.deepEqual(plain(levelResponse.alerts), NO_ALERTS);
  assert.deepEqual(plain(tradeResponse.alerts), NO_ALERTS);
});

test('top1 trades and top3 levels target the best ranks, best first', async () => {
  // Arrange
  const harness = createAlertHarness({ initialStorage: { tradeAlertScope: 'top1', levelAlertScope: 'top3' } });

  // Act
  await harness.send({ type: 'DRAW_LEVELS', levels: levelsWithRanks([2, 1, 4, undefined, 3]) });
  await harness.send({ type: 'DRAW_NOTES', trades: tradesWithRanks([3, 1, 2]) });

  // Assert
  const [levelSync, tradeSync] = syncCommands(harness);
  assert.deepEqual(plain(levelSync.desired), expectedTargets([1, 0, 4], 10));
  assert.deepEqual(plain(tradeSync.desired), expectedTargets([1], 20));
});

test('scope decides which drawn items get alerts', async t => {
  // Stored records make every case call SYNC_ALERTS, so the desired list is always observable.
  const cases = [
    { name: 'off targets nothing', scope: 'off', ranks: [1, 2], expected: [] },
    { name: 'unknown scope behaves like off', scope: 'bogus', ranks: [1], expected: [] },
    { name: 'top1 keeps only rank 1', scope: 'top1', ranks: [1, 2, 3, undefined], expected: [0] },
    { name: 'top3 keeps ranks 1 to 3', scope: 'top3', ranks: [1, 2, 3, 4, undefined], expected: [0, 1, 2] },
    { name: 'all keeps ranked and unranked items', scope: 'all', ranks: [1, undefined, 4], expected: [0, 1, 2] },
    { name: 'failed drawings never get alerts', scope: 'top3', ranks: [1, 2, 3, 4], failedIndexes: [0, 2], expected: [1, 3] },
    { name: 'top3 keeps the best drawn ranks when all-time #1 is missing', scope: 'top3', ranks: [7, 2, 9, 5, undefined], expected: [1, 3, 0] },
    { name: 'top1 keeps the best drawn rank even when it is not #1', scope: 'top1', ranks: [4, 2, 6], expected: [1] }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const harness = createAlertHarness({
        initialStorage: {
          levelAlertScope: testCase.scope,
          [LEVEL_ALERTS_KEY]: [{ alertId: 7, shapeId: 'old', price: 1, message: 'old' }]
        },
        failedIndexes: testCase.failedIndexes
      });

      await harness.send({ type: 'DRAW_LEVELS', levels: levelsWithRanks(testCase.ranks) });

      const syncs = syncCommands(harness);
      assert.equal(syncs.length, 1);
      assert.deepEqual(plain(syncs[0].desired), expectedTargets(testCase.expected));
    });
  }
});

test('both scopes off with no stored records never sends SYNC_ALERTS', async () => {
  // Arrange
  const harness = createAlertHarness();

  // Act
  const levelResponse = await harness.send({ type: 'DRAW_LEVELS', levels: levelsWithRanks([1]) });
  const tradeResponse = await harness.send({ type: 'DRAW_NOTES', trades: tradesWithRanks([1]) });
  const clearResponse = await harness.send({ type: 'CLEAR_DRAWN' });

  // Assert
  assert.equal(syncCommands(harness).length, 0);
  assert.deepEqual(plain(levelResponse.alerts), NO_ALERTS);
  assert.deepEqual(plain(tradeResponse.alerts), NO_ALERTS);
  assert.deepEqual(plain(clearResponse.alerts), NO_ALERTS);
});

test('scope off still deletes alerts stored for the chart', async () => {
  // Arrange
  const stored = [{ alertId: 7, shapeId: 'old-shape', price: 10, message: 'VL #1' }];
  const harness = createAlertHarness({
    initialStorage: { [LEVEL_ALERTS_KEY]: stored },
    syncResponse: { ...OK_SYNC, deleted: 1 }
  });

  // Act
  const response = await harness.send({ type: 'DRAW_LEVELS', levels: [] });

  // Assert
  const [sync] = syncCommands(harness);
  assert.deepEqual(plain(sync.desired), []);
  assert.deepEqual(plain(sync.records), stored);
  assert.equal(response.alerts.deleted, 1);
  assert.equal(response.success, true);
});

test('returned alert records are saved even when the sync reports errors', async () => {
  // Arrange
  const returned = [{ alertId: 9, shapeId: 'shape-0', price: 20, message: 'VL #1' }];
  const harness = createAlertHarness({
    initialStorage: { tradeAlertScope: 'all' },
    syncResponse: { ...OK_SYNC, success: false, created: 1, failed: 1, records: returned, errors: ['create failed'] }
  });

  // Act
  const response = await harness.send({ type: 'DRAW_NOTES', trades: tradesWithRanks([1]) });

  // Assert
  assert.deepEqual(harness.storage[TRADE_ALERTS_KEY], returned);
  assert.equal(response.alerts.created, 1);
  assert.equal(response.alerts.failed, 1);
  assert.equal(response.alerts.error, 'create failed');
});

test('alert failures never change drawing success', async t => {
  const cases = [
    {
      name: 'sync reports failure',
      syncResponse: { ...OK_SYNC, success: false, failed: 1, errors: ['boom'] },
      expectedError: 'boom'
    },
    { name: 'bridge rejects', syncError: 'bridge down', expectedError: 'bridge down' },
    { name: 'response is malformed', syncResponse: null, expectedError: 'Invalid alert sync response' }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const harness = createAlertHarness({
        initialStorage: { levelAlertScope: 'all' },
        syncResponse: testCase.syncResponse,
        syncError: testCase.syncError
      });

      const response = await harness.send({ type: 'DRAW_LEVELS', levels: levelsWithRanks([1]) });

      assert.equal(response.success, true);
      assert.equal(response.drawn, 1);
      assert.equal(response.alerts.error, testCase.expectedError);
    });
  }
});

test('failed alert sync passes the first three errors through and warns with the full result', async () => {
  // Arrange
  const syncResult = { ...OK_SYNC, success: false, failed: 4, errors: ['e1', 'e2', 'e3', 'e4'] };
  const harness = createAlertHarness({
    initialStorage: { levelAlertScope: 'all' },
    syncResponse: syncResult
  });

  // Act
  const response = await harness.send({ type: 'DRAW_LEVELS', levels: levelsWithRanks([1]) });

  // Assert
  assert.equal(response.alerts.failed, 4);
  assert.deepEqual(plain(response.alerts.errors), ['e1', 'e2', 'e3']);
  assert.equal(response.alerts.error, 'e1; e2; e3; e4');
  assert.deepEqual(harness.warnings, [['🔔 VL alert sync', plain(syncResult)]]);
});

test('skipped alerts are counted and warned without adding errors', async () => {
  // Arrange
  const syncResult = { ...OK_SYNC, skipped: 1, skippedDetails: [{ shapeId: 'shape-0', message: 'VL #1', alertId: 55 }] };
  const harness = createAlertHarness({
    initialStorage: { levelAlertScope: 'all' },
    syncResponse: syncResult
  });

  // Act
  const response = await harness.send({ type: 'DRAW_LEVELS', levels: levelsWithRanks([1]) });

  // Assert
  assert.equal(response.success, true);
  assert.equal(response.alerts.skipped, 1);
  assert.equal(response.alerts.error, undefined);
  assert.equal(response.alerts.errors, undefined);
  assert.equal(harness.warnings.length, 1);
});

test('clean alert sync neither warns nor reports errors', async () => {
  // Arrange
  const harness = createAlertHarness({ initialStorage: { levelAlertScope: 'all' }, syncResponse: { ...OK_SYNC, created: 1 } });

  // Act
  const response = await harness.send({ type: 'DRAW_LEVELS', levels: levelsWithRanks([1]) });

  // Assert
  assert.deepEqual(plain(response.alerts), { ...NO_ALERTS, created: 1 });
  assert.deepEqual(harness.warnings, []);
});

test('clear deletes tracked alerts for both kinds and reports one combined summary', async () => {
  // Arrange
  const harness = createAlertHarness({
    initialStorage: {
      tradeAlertScope: 'all',
      [LEVEL_ALERTS_KEY]: [{ alertId: 1, shapeId: 'a', price: 10, message: 'VL #1' }],
      [TRADE_ALERTS_KEY]: [{ alertId: 2, shapeId: 'b', price: 20, message: 'VL #2' }]
    },
    syncResponse: { ...OK_SYNC, deleted: 1 }
  });

  // Act
  const response = await harness.send({ type: 'CLEAR_DRAWN' });

  // Assert
  const syncs = syncCommands(harness);
  assert.deepEqual(syncs.map(sync => sync.kind), ['levels', 'trades']);
  assert.ok(syncs.every(sync => sync.desired.length === 0));
  assert.equal(response.success, true);
  assert.deepEqual(plain(response.alerts), { ...NO_ALERTS, deleted: 2 });
  assert.deepEqual(harness.storage[LEVEL_ALERTS_KEY], []);
  assert.deepEqual(harness.storage[TRADE_ALERTS_KEY], []);
});
