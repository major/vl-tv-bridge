const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadInjected(chart) {
  const listeners = { message: [] };
  const postedMessages = [];
  const window = {
    top: null,
    vlTvBridgeInjected: false,
    addEventListener(type, handler) {
      listeners[type].push(handler);
    },
    postMessage(message) {
      postedMessages.push(message);
    }
  };
  window.top = window;

  const context = vm.createContext({
    console,
    window,
    TradingViewApi: {
      activeChart: () => chart
    }
  });
  const script = fs.readFileSync(path.join(__dirname, '..', 'firefox', 'injected.js'), 'utf8');
  vm.runInContext(script, context);

  return {
    postedMessages,
    async send(command, data = {}) {
      const event = {
        source: window,
        data: {
          source: 'vl-tv-content',
          messageId: command,
          command,
          data
        }
      };
      await Promise.all(listeners.message.map(handler => handler(event)));
      return postedMessages.findLast(message => message.messageId === command);
    }
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('DRAW_LINE applies configured opacity to level color', async () => {
  const createShapeCalls = [];
  const chart = {
    createShape(point, config) {
      createShapeCalls.push({ point, config });
      return 'line-1';
    }
  };
  const injected = loadInjected(chart);

  const response = await injected.send('DRAW_LINE', {
    price: 123.45,
    label: 'VL #1',
    options: {
      linecolor: '#112233',
      lineopacity: 50
    }
  });

  assert.equal(response.error, null);
  assert.equal(createShapeCalls.length, 1);
  assert.equal(createShapeCalls[0].config.overrides.linecolor, 'rgba(17, 34, 51, 0.5)');
  assert.equal(createShapeCalls[0].config.overrides.textcolor, 'rgba(17, 34, 51, 0.5)');
});

test('DRAW_NOTE creates a horizontal ray from the actual trade timestamp', async () => {
  const createShapeCalls = [];
  const chart = {
    createShape(point, config) {
      createShapeCalls.push({ point, config });
      return 'ray-1';
    },
    createMultipointShape() {
      throw new Error('text_note path should not be used for trades');
    },
    getVisibleRange() {
      return { from: 1700000000, to: 1800000000 };
    }
  };
  const injected = loadInjected(chart);

  const response = await injected.send('DRAW_NOTE', {
    price: 123.45,
    timestamp: 1712345678,
    rank: 2,
    darkPool: true,
    dollarVolume: 250000000
  });

  assert.equal(response.error, null);
  assert.deepEqual(plain(response.result), {
    shapeId: 'ray-1',
    price: 123.45,
    timestamp: 1712345678,
    rank: 2
  });
  assert.equal(createShapeCalls.length, 1);
  assert.deepEqual(plain(createShapeCalls[0].point), { price: 123.45, time: 1712345678 });
  assert.equal(createShapeCalls[0].config.shape, 'horizontal_ray');
  assert.equal(createShapeCalls[0].config.text, '● VL #2 $250M');
  assert.equal(createShapeCalls[0].config.overrides.linecolor, 'rgba(255, 152, 0, 1)');
  assert.equal(createShapeCalls[0].config.overrides.showLabel, true);
});

test('DRAW_NOTE uses sweep marker and custom trade ray styling', async () => {
  const createShapeCalls = [];
  const chart = {
    createShape(point, config) {
      createShapeCalls.push({ point, config });
      return `ray-${createShapeCalls.length}`;
    },
    getVisibleRange() {
      return { from: 1700000000, to: 1800000000 };
    }
  };
  const injected = loadInjected(chart);

  await injected.send('DRAW_NOTE', {
    price: 36.8,
    timestamp: 1712345678,
    rank: 1,
    sweep: true,
    darkPool: false,
    dollarVolume: 1459892.8,
    options: {
      tradeLitColor: '#112233',
      tradeDarkPoolColor: '#445566',
      tradeThickness: 4
    }
  });
  await injected.send('DRAW_NOTE', {
    price: 70.34,
    timestamp: 1712345679,
    rank: 3,
    sweep: false,
    darkPool: true,
    dollarVolume: 1360000,
    options: {
      tradeLitColor: '#112233',
      tradeDarkPoolColor: '#445566',
      tradeThickness: 4
    }
  });

  assert.equal(createShapeCalls[0].config.text, '◆ VL #1 $1M');
  assert.equal(createShapeCalls[0].config.overrides.linecolor, '#112233');
  assert.equal(createShapeCalls[0].config.overrides.linewidth, 4);
  assert.equal(createShapeCalls[1].config.text, '● VL #3 $1M');
  assert.equal(createShapeCalls[1].config.overrides.linecolor, '#445566');
  assert.equal(createShapeCalls[1].config.overrides.linewidth, 4);
});

test('DRAW_NOTE can include original trade rank in label', async () => {
  const createShapeCalls = [];
  const chart = {
    createShape(point, config) {
      createShapeCalls.push({ point, config });
      return 'ray-1';
    },
    getVisibleRange() {
      return { from: 1700000000, to: 1800000000 };
    }
  };
  const injected = loadInjected(chart);

  await injected.send('DRAW_NOTE', {
    price: 123.45,
    timestamp: 1712345678,
    rank: 10,
    originalRank: 5,
    dollarVolume: 85000000,
    options: {
      showOriginalTradeRank: true
    }
  });

  assert.equal(createShapeCalls[0].config.text, '● VL #10 (#5) $85M');
});

test('DRAW_NOTE omits original trade rank when it matches current rank', async () => {
  const createShapeCalls = [];
  const chart = {
    createShape(point, config) {
      createShapeCalls.push({ point, config });
      return 'ray-1';
    },
    getVisibleRange() {
      return { from: 1700000000, to: 1800000000 };
    }
  };
  const injected = loadInjected(chart);

  await injected.send('DRAW_NOTE', {
    price: 123.45,
    timestamp: 1712345678,
    rank: 2,
    originalRank: 2,
    dollarVolume: 85000000,
    options: {
      showOriginalTradeRank: true
    }
  });

  assert.equal(createShapeCalls[0].config.text, '● VL #2 $85M');
});

test('DRAW_NOTE omits original trade rank unless enabled with an integer rank', async () => {
  const createShapeCalls = [];
  const chart = {
    createShape(point, config) {
      createShapeCalls.push({ point, config });
      return `ray-${createShapeCalls.length}`;
    },
    getVisibleRange() {
      return { from: 1700000000, to: 1800000000 };
    }
  };
  const injected = loadInjected(chart);

  const cases = [
    { originalRank: 5, options: { showOriginalTradeRank: false } },
    { options: { showOriginalTradeRank: true } },
    { originalRank: '5', options: { showOriginalTradeRank: true } },
    { originalRank: 5.5, options: { showOriginalTradeRank: true } },
    { originalRank: null, options: { showOriginalTradeRank: true } }
  ];

  for (const testCase of cases) {
    await injected.send('DRAW_NOTE', {
      price: 123.45,
      timestamp: 1712345678,
      rank: 10,
      dollarVolume: 85000000,
      ...testCase
    });
  }

  assert.deepEqual(createShapeCalls.map(call => call.config.text), [
    '● VL #10 $85M',
    '● VL #10 $85M',
    '● VL #10 $85M',
    '● VL #10 $85M',
    '● VL #10 $85M'
  ]);
});

test('DRAW_NOTE applies horzLabelsAlign from options with right as default', async () => {
  const createShapeCalls = [];
  const chart = {
    createShape(point, config) {
      createShapeCalls.push({ point, config });
      return `ray-${createShapeCalls.length}`;
    },
    getVisibleRange() {
      return { from: 1700000000, to: 1800000000 };
    }
  };
  const injected = loadInjected(chart);

  // Default (no option) should be right
  await injected.send('DRAW_NOTE', {
    price: 10,
    timestamp: 1712345678,
    rank: 1,
    dollarVolume: 1000
  });

  // Explicit left
  await injected.send('DRAW_NOTE', {
    price: 20,
    timestamp: 1712345678,
    rank: 2,
    dollarVolume: 2000,
    options: { horzLabelsAlign: 'left' }
  });

  // Explicit right
  await injected.send('DRAW_NOTE', {
    price: 30,
    timestamp: 1712345678,
    rank: 3,
    dollarVolume: 3000,
    options: { horzLabelsAlign: 'right' }
  });

  assert.equal(createShapeCalls.length, 3);
  assert.equal(createShapeCalls[0].config.overrides.horzLabelsAlign, 'right');
  assert.equal(createShapeCalls[1].config.overrides.horzLabelsAlign, 'left');
  assert.equal(createShapeCalls[2].config.overrides.horzLabelsAlign, 'right');
});

test('DRAW_NOTE only creates shapes for ranks from 1 through 100', async () => {
  const createShapeCalls = [];
  const chart = {
    createShape(point, config) {
      createShapeCalls.push({ point, config });
      return `ray-${createShapeCalls.length}`;
    },
    getVisibleRange() {
      return { from: 1700000000, to: 1800000000 };
    }
  };
  const injected = loadInjected(chart);

  const responses = [];
  for (const rank of [0, 1, 100, 101, undefined, '2']) {
    responses.push(await injected.send('DRAW_NOTE', {
      price: 6.22,
      timestamp: 1712345678,
      rank,
      dollarVolume: 58998410
    }));
  }

  assert.deepEqual(createShapeCalls.map(call => call.config.text), [
    '● VL #1 $59M',
    '● VL #100 $59M'
  ]);
  assert.deepEqual(responses.map(response => plain(response.result)), [
    { skipped: true, price: 6.22, timestamp: 1712345678, rank: 0, reason: 'invalid_rank' },
    { shapeId: 'ray-1', price: 6.22, timestamp: 1712345678, rank: 1 },
    { shapeId: 'ray-2', price: 6.22, timestamp: 1712345678, rank: 100 },
    { skipped: true, price: 6.22, timestamp: 1712345678, rank: 101, reason: 'invalid_rank' },
    { skipped: true, price: 6.22, timestamp: 1712345678, reason: 'invalid_rank' },
    { skipped: true, price: 6.22, timestamp: 1712345678, rank: '2', reason: 'invalid_rank' }
  ]);
});

test('CLEAR_VL_NOTES removes existing VL horizontal rays and legacy notes', async () => {
  const removed = [];
  const chart = {
    getAllShapes() {
      return [
        { id: 'ray-1', name: 'horizontal_ray' },
        { id: 'note-1', name: 'text_note' },
        { id: 'line-1', name: 'horizontal_line' },
        { id: 'user-ray', name: 'horizontal_ray' }
      ];
    },
    getShapeById(id) {
      const texts = {
        'ray-1': '● VL #1 $1B',
        'note-1': 'VL #2 $250M',
        'line-1': 'VL 123.45',
        'user-ray': 'User Ray'
      };
      return {
        getProperties: () => ({ text: texts[id] })
      };
    },
    removeEntity(id) {
      removed.push(id);
    }
  };
  const injected = loadInjected(chart);

  const response = await injected.send('CLEAR_VL_NOTES');

  assert.equal(response.error, null);
  assert.deepEqual(plain(response.result), { removed: 2 });
  assert.deepEqual(removed, ['ray-1', 'note-1']);
});
