const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/**
 * Load firefox/background.js into a vm context with mocked browser and fetch.
 * Every progress message, tab message, and Chart0 request is appended to
 * `log` in order, so tests can check that progress comes before each step.
 */
function loadBackground(settings = {}) {
  const log = [];
  const progressMessages = [];

  const context = vm.createContext({
    AbortController,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url) => {
      const text = String(url);

      if (text.includes('/TradeLevels?Ticker=SPY')) {
        return {
          ok: true,
          url: text,
          text: async () => '<input name="__RequestVerificationToken" value="test-token" />'
        };
      }

      if (text.endsWith('/Chart0/GetChartTradeLevels')) {
        log.push('fetch levels');
        return {
          ok: true,
          status: 200,
          url: text,
          json: async () => settings.levelsData ?? [{ Price: 36.8, TradeLevelRank: 1, Dollars: 1459892.8, Volume: 39671, Trades: 1, Dates: '2026-05-19 - 2026-05-19' }]
        };
      }

      if (text.endsWith('/Chart0/GetAllPriceVolumeTradeData')) {
        log.push('fetch trades');
        return {
          ok: true,
          status: 200,
          url: text,
          json: async () => [[], settings.tradesData ?? [], [], [], [], [], []]
        };
      }

      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    },
    browser: {
      cookies: { getAll: async () => [{ name: '.ASPXAUTH' }] },
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: settings.sendMessage ?? (async (message) => {
          progressMessages.push(message);
          log.push(`progress ${message.action} ${message.stage} ${message.step}/${message.totalSteps}`);
          return undefined;
        })
      },
      storage: { local: { get: async () => ({}) } },
      tabs: {
        sendMessage: async (tabId, message) => {
          log.push(`tab ${message.type}`);
          if (message?.type === 'GET_VISIBLE_RANGE') {
            return { range: null };
          }
          return {};
        }
      },
      webRequest: {
        filterResponseData: () => ({}),
        onBeforeRequest: { addListener() {} },
        onBeforeSendHeaders: { addListener() {} }
      }
    },
    tickerMap: { tvToVl: ticker => ticker.toUpperCase() }
  });

  const script = fs.readFileSync(path.join(__dirname, '..', 'firefox', 'background.js'), 'utf8');
  vm.runInContext(script, context);
  context.log = log;
  context.progressMessages = progressMessages;
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const progressCases = [
  {
    action: 'levels',
    run: context => context.fetchAndDraw('CRDU', 123),
    expectedProgress: [
      { type: 'FETCH_PROGRESS', action: 'levels', symbol: 'CRDU', stage: 'fetch', step: 1, totalSteps: 2 },
      { type: 'FETCH_PROGRESS', action: 'levels', symbol: 'CRDU', stage: 'draw', step: 2, totalSteps: 2 }
    ],
    expectedLog: [
      'progress levels fetch 1/2',
      'fetch levels',
      'progress levels draw 2/2',
      'tab DRAW_LEVELS'
    ]
  },
  {
    action: 'trades',
    run: context => context.fetchAndDrawTrades('CRDU', 123, 10),
    expectedProgress: [
      { type: 'FETCH_PROGRESS', action: 'trades', symbol: 'CRDU', stage: 'range', step: 1, totalSteps: 3 },
      { type: 'FETCH_PROGRESS', action: 'trades', symbol: 'CRDU', stage: 'fetch', step: 2, totalSteps: 3 },
      { type: 'FETCH_PROGRESS', action: 'trades', symbol: 'CRDU', stage: 'draw', step: 3, totalSteps: 3 }
    ],
    expectedLog: [
      'progress trades range 1/3',
      'tab GET_VISIBLE_RANGE',
      'progress trades fetch 2/3',
      'fetch trades',
      'progress trades draw 3/3',
      'tab DRAW_NOTES'
    ]
  }
];

for (const progressCase of progressCases) {
  test(`${progressCase.action} with a tab emits progress steps in order before each network or tab call`, async () => {
    // Arrange
    const context = loadBackground();

    // Act
    const result = await progressCase.run(context);

    // Assert
    assert.equal(result.success, true);
    assert.deepEqual(plain(context.progressMessages), progressCase.expectedProgress);
    assert.deepEqual(context.log, progressCase.expectedLog);
  });

  test(`${progressCase.action} without a tab still emits progress and returns the fetch result`, async () => {
    // Arrange
    const context = loadBackground();
    const run = progressCase.action === 'levels'
      ? () => context.fetchAndDraw('CRDU')
      : () => context.fetchAndDrawTrades('CRDU', null, 10);

    // Act
    const result = await run();

    // Assert
    const fetchStep = progressCase.expectedProgress.find(event => event.stage === 'fetch');
    assert.equal(result.success, true);
    assert.equal(result.drawResult, undefined);
    assert.deepEqual(plain(context.progressMessages), [{ ...fetchStep, step: 1, totalSteps: 1 }]);
  });
}

const brokenSendMessages = {
  'rejects (popup closed)': () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
  'throws synchronously': () => {
    throw new Error('extension context invalidated');
  }
};

for (const [label, sendMessage] of Object.entries(brokenSendMessages)) {
  test(`progress send that ${label} does not break the levels fetch`, async () => {
    // Arrange
    const context = loadBackground({ sendMessage });

    // Act
    const result = await context.fetchAndDraw('CRDU', 123);

    // Assert
    assert.equal(result.success, true);
    assert.equal(result.levels.length, 1);
    assert.deepEqual(plain(result.drawResult), {});
    assert.ok(context.log.includes('tab DRAW_LEVELS'));
  });
}
