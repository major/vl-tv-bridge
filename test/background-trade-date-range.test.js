const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBackground(settings = {}) {
  const fetchCalls = [];
  const tabMessages = [];
  const context = vm.createContext({
    AbortController,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    console,
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });

      if (String(url).includes('/TradeLevels?Ticker=SPY')) {
        return {
          ok: true,
          url: String(url),
          text: async () => '<input name="__RequestVerificationToken" value="test-token" />'
        };
      }

      if (String(url).includes('/Chart0/GetChartTradeLevels')) {
        const response = settings.levelResponse || {};
        return {
          ok: response.ok ?? true,
          status: response.status ?? 200,
          statusText: response.statusText ?? 'OK',
          url: response.url ?? String(url),
          redirected: response.redirected ?? false,
          json: async () => response.body ?? settings.levelsData ?? [{ Price: 36.8, TradeLevelRank: 1, Dollars: 1459892.8, Volume: 39671, Trades: 1, Dates: '2026-05-19 - 2026-05-19' }]
        };
      }

      if (String(url).includes('/Chart0/GetAllPriceVolumeTradeData')) {
        const response = settings.tradeResponse || {};
        // Response is array of arrays; index 1 = individual trades
        return {
          ok: response.ok ?? true,
          status: response.status ?? 200,
          statusText: response.statusText ?? 'OK',
          url: response.url ?? String(url),
          redirected: response.redirected ?? false,
          json: async () => response.body ?? [[], settings.tradesData ?? [], [], [], [], [], []]
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    },
    setTimeout,
    clearTimeout,
    browser: {
      cookies: { getAll: async () => settings.cookies ?? [{ name: '.ASPXAUTH' }] },
      runtime: { onMessage: { addListener() {} } },
      storage: { local: { get: async () => settings } },
      tabs: {
        sendMessage: async (tabId, message) => {
          tabMessages.push({ tabId, message });
          if (message?.type === 'GET_VISIBLE_RANGE') {
            return { range: settings.visibleRange || null };
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
  context.fetchCalls = fetchCalls;
  context.tabMessages = tabMessages;
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('trade visible range end date is clamped to today', () => {
  const { getTradeDateRange } = loadBackground();
  const now = new Date('2026-06-08T12:00:00Z');

  const range = getTradeDateRange({
    from: Date.parse('2025-09-16T00:00:00Z') / 1000,
    to: Date.parse('2026-07-22T00:00:00Z') / 1000
  }, 5, now);

  assert.deepEqual(plain(range), {
    startDate: '2025-09-16',
    endDate: '2026-06-08'
  });
});

test('trade fallback range uses configured year range', () => {
  const { getTradeDateRange } = loadBackground();
  const now = new Date('2026-06-08T12:00:00Z');

  assert.deepEqual(plain(getTradeDateRange(null, 2, now)), {
    startDate: '2024-06-08',
    endDate: '2026-06-08'
  });
});

test('trade request matches the VolumeLeaders GetAllPriceVolumeTradeData HAR shape', async () => {
  const context = loadBackground({ yearRange: 1 });

  await context.fetchVlTrades('CRDU', 5, null, new Date('2026-06-08T12:00:00Z'));

  const tradeRequest = context.fetchCalls.find(call => String(call.url).endsWith('/Chart0/GetAllPriceVolumeTradeData'));
  const body = JSON.parse(tradeRequest.options.body);
  const expectedBody = {
    StartDateKey: '20250608',
    EndDateKey: '20260608',
    Ticker: 'CRDU',
    VolumeProfile: 0,
    Levels: 5,
    MinVolume: 0,
    MaxVolume: 2000000000,
    MinDollars: 500000,
    MaxDollars: 30000000000,
    DarkPools: -1,
    Sweeps: -1,
    LatePrints: -1,
    SignaturePrints: -1,
    TradeCount: 5,
    MinPrice: 0,
    MaxPrice: 100000,
    VCD: 0,
    TradeRank: -1,
    TradeRankSnapshot: -1,
    IncludePremarket: 1,
    IncludeRTH: 1,
    IncludeAH: 1,
    IncludeOpening: 1,
    IncludeClosing: 1,
    IncludePhantom: 1,
    IncludeOffsetting: 1
  };

  assert.equal(String(tradeRequest.url), 'https://www.volumeleaders.com/Chart0/GetAllPriceVolumeTradeData');
  assert.equal(tradeRequest.options.headers['Content-Type'], 'application/json');
  assert.equal(tradeRequest.options.headers.Referer, 'https://www.volumeleaders.com/Chart0?StartDate=2025-06-08&EndDate=2026-06-08&Ticker=CRDU&MinVolume=0&MaxVolume=2000000000&MinDollars=500000&MaxDollars=30000000000&MinPrice=0&MaxPrice=100000&DarkPools=-1&Sweeps=-1&LatePrints=-1&SignaturePrints=-1&VolumeProfile=0&Levels=5&TradeCount=5&VCD=0&TradeRank=-1&TradeRankSnapshot=-1&IncludePremarket=1&IncludeRTH=1&IncludeAH=1&IncludeOpening=1&IncludeClosing=1&IncludePhantom=1&IncludeOffsetting=1');
  assert.deepEqual(body, expectedBody);
});

test('fetch and draw trades requests the current chart visible range', async () => {
  const visibleRange = {
    from: Date.parse('2026-03-10T00:00:00Z') / 1000,
    to: Date.parse('2026-06-08T00:00:00Z') / 1000
  };
  const context = loadBackground({ yearRange: 5, visibleRange });

  await context.fetchAndDrawTrades('CRDU', 123, 10);

  const tradeRequest = context.fetchCalls.find(call => String(call.url).endsWith('/Chart0/GetAllPriceVolumeTradeData'));
  const body = JSON.parse(tradeRequest.options.body);

  assert.deepEqual(plain(context.tabMessages[0]), {
    tabId: 123,
    message: { type: 'GET_VISIBLE_RANGE' }
  });
  assert.equal(body.StartDateKey, '20260310');
  assert.equal(body.EndDateKey, '20260608');
  assert.equal(body.TradeCount, 10);
});

test('trade response maps sweep flag for trade ray labels', async () => {
  const context = loadBackground({
    yearRange: 1,
    tradesData: [{
      Date: '/Date(1779148800000)/',
      Ticker: 'CRDU',
      Price: 36.8,
      TradeRank: 1,
      Dollars: 1459892.8,
      Volume: 39671,
      DarkPoolTrade: 0,
      Sweep: 1,
      FullDateTime: '2026-05-19T09:36:02'
    }, {
      Date: '/Date(1779148860000)/',
      Ticker: 'VT',
      Price: 123.45,
      TradeRank: 2,
      Dollars: 2000000,
      Volume: 10000,
      DarkPoolTrade: '1',
      Sweep: 1,
      FullDateTime: '2026-05-19T09:37:02'
    }]
  });

  const result = await context.fetchVlTrades('CRDU', 5, null, new Date('2026-06-08T12:00:00Z'));

  assert.equal(result.trades[0].sweep, true);
  assert.equal(result.trades[1].darkPool, true);
  assert.equal(result.trades[1].sweep, true);
});

test('trade response maps TradeRankSnapshot to originalRank', async () => {
  const context = loadBackground({
    yearRange: 1,
    tradesData: [{
      Date: '/Date(1779148800000)/',
      Ticker: 'CRDU',
      Price: 36.8,
      TradeRank: 10,
      TradeRankSnapshot: 5,
      Dollars: 85000000,
      Volume: 39671,
      DarkPoolTrade: 0,
      Sweep: 0,
      FullDateTime: '2026-05-19T09:36:02'
    }]
  });

  const result = await context.fetchVlTrades('CRDU', 5, null, new Date('2026-06-08T12:00:00Z'));

  assert.equal(result.trades[0].rank, 10);
  assert.equal(result.trades[0].originalRank, 5);
});

test('trade response reads DarkPoolTrade boolean from GetAllPriceVolumeTradeData', async () => {
  const context = loadBackground({
    yearRange: 1,
    tradesData: [{
      Date: '/Date(1782172800000)/',
      Ticker: 'SMH',
      Price: 624.7,
      TradeRank: 1,
      Dollars: 1311870000,
      Volume: 2100000,
      DarkPoolTrade: true,
      Sweep: false,
      FullDateTime: '2026-06-23T14:06:04'
    }, {
      Date: '/Date(1779148800000)/',
      Ticker: 'SMH',
      Price: 401.99,
      TradeRank: 2,
      Dollars: 610000000,
      Volume: 500000,
      DarkPoolTrade: false,
      Sweep: true,
      FullDateTime: '2026-05-19T09:36:02'
    }]
  });

  const result = await context.fetchVlTrades('SMH', 5, null, new Date('2026-06-23T16:00:00Z'));

  assert.equal(result.trades[0].darkPool, true);
  assert.equal(result.trades[0].sweep, false);
  assert.equal(result.trades[1].darkPool, false);
  assert.equal(result.trades[1].sweep, true);
});

test('trade response treats FullDateTime as New York market time', async () => {
  const context = loadBackground({
    yearRange: 1,
    tradesData: [{
      Date: '/Date(1780358400000)/',
      Ticker: 'BE',
      Price: 302.85,
      TradeRank: 4,
      Dollars: 434165760,
      Volume: 1433552,
      DarkPoolTrade: 1,
      Sweep: 0,
      FullDateTime: '2026-06-02T16:06:57'
    }]
  });

  const result = await context.fetchVlTrades('BE', 5, null, new Date('2026-06-11T16:37:00Z'));

  assert.equal(result.trades[0].timestamp, Date.parse('2026-06-02T20:06:57Z') / 1000);
  assert.equal(result.trades[0].darkPool, true);
});

test('level request matches the VolumeLeaders Chart0 GetChartTradeLevels HAR shape', async () => {
  const context = loadBackground({ yearRange: 1, levelCount: 5, tradeCount: 3 });

  const result = await context.fetchVlLevels('CRDU', new Date('2026-06-08T12:00:00Z'));

  const levelRequest = context.fetchCalls.find(call => String(call.url).endsWith('/Chart0/GetChartTradeLevels'));
  const body = JSON.parse(levelRequest.options.body);
  const expectedBody = {
    StartDateKey: '20250608',
    EndDateKey: '20260608',
    Ticker: 'CRDU',
    Levels: 5
  };

  assert.equal(String(levelRequest.url), 'https://www.volumeleaders.com/Chart0/GetChartTradeLevels');
  assert.equal(levelRequest.options.headers['Content-Type'], 'application/json');
  assert.equal(levelRequest.options.headers.Accept, 'application/json, text/javascript, */*; q=0.01');
  assert.equal(levelRequest.options.headers.Origin, 'https://www.volumeleaders.com');
  assert.equal(levelRequest.options.headers.Referer, 'https://www.volumeleaders.com/Chart0?StartDate=2025-06-08&EndDate=2026-06-08&Ticker=CRDU&MinVolume=0&MaxVolume=2000000000&MinDollars=500000&MaxDollars=30000000000&MinPrice=0&MaxPrice=100000&DarkPools=-1&Sweeps=-1&LatePrints=-1&SignaturePrints=-1&VolumeProfile=0&Levels=5&TradeCount=3&VCD=0&TradeRank=-1&TradeRankSnapshot=-1&IncludePremarket=1&IncludeRTH=1&IncludeAH=1&IncludeOpening=1&IncludeClosing=1&IncludePhantom=1&IncludeOffsetting=1');
  assert.deepEqual(body, expectedBody);
  assert.equal(result.levels[0].price, 36.8);
});

test('levels and trades fetch even when the auth cookie lookup is false', async () => {
  const context = loadBackground({ cookies: [], yearRange: 1 });

  assert.equal((await context.checkVlAuth()).authenticated, false);
  const levels = await context.fetchVlLevels('CRDU', new Date('2026-06-08T12:00:00Z'));
  const trades = await context.fetchVlTrades('CRDU', 5, null, new Date('2026-06-08T12:00:00Z'));

  assert.equal(levels.success, true);
  assert.equal(trades.success, true);
  assert.ok(context.fetchCalls.some(call => String(call.url).endsWith('/Chart0/GetChartTradeLevels')));
  assert.ok(context.fetchCalls.some(call => String(call.url).endsWith('/Chart0/GetAllPriceVolumeTradeData')));
  assert.ok(context.fetchCalls.filter(call => String(call.url).includes('/Chart0/')).every(call => call.options.credentials === 'include'));
});

test('level and trade fetches report authentication status and login redirects', async () => {
  const responses = [
    { ok: false, status: 401 },
    { ok: false, status: 403 },
    { ok: true, status: 200, url: 'https://www.volumeleaders.com/Account/Login?ReturnUrl=%2FChart0' }
  ];

  for (const response of responses) {
    const context = loadBackground({ levelResponse: response, tradeResponse: response });
    const now = new Date('2026-06-08T12:00:00Z');

    await assert.rejects(context.fetchVlLevels('CRDU', now), /session expired/i);
    await assert.rejects(context.fetchVlTrades('CRDU', 5, null, now), /session expired/i);
  }
});

test('malformed level and trade response shapes are not reported as empty results', async () => {
  const context = loadBackground({
    levelResponse: { body: { data: [] } },
    tradeResponse: { body: [] }
  });
  const now = new Date('2026-06-08T12:00:00Z');

  await assert.rejects(context.fetchVlLevels('CRDU', now), /Invalid VL levels response/);
  await assert.rejects(context.fetchVlTrades('CRDU', 5, null, now), /Invalid VL trades response/);
});

test('levels parse MinDate and propagate the earliest clustered anchor to drawing', async () => {
  const context = loadBackground({
    clusteringEnabled: true,
    clusterThreshold: 1,
    levelsData: [
      { Price: 100, TradeLevelRank: 1, Dollars: 1000000, Dates: '2026-05-19 - 2026-05-19', MinDate: '/Date(1779148800000)/' },
      { Price: 100.5, TradeLevelRank: 2, Dollars: 1000000, Dates: '2026-05-20 - 2026-05-20', MinDate: 1779062400 },
      { Price: 110, TradeLevelRank: 3, Dollars: 1000000, Dates: '2026-05-21 - 2026-05-21', MinDate: 'invalid' }
    ]
  });

  const levels = await context.fetchVlLevels('CRDU', new Date('2026-06-08T12:00:00Z'));
  assert.deepEqual(levels.levels.map(level => level.timestamp), [1779148800, 1779062400, null]);

  await context.fetchAndDraw('CRDU', 123);
  const drawMessage = context.tabMessages.find(entry => entry.message.type === 'DRAW_LEVELS').message;
  assert.equal(drawMessage.levels[0].type, 'zone');
  assert.equal(drawMessage.levels[0].timestamp, 1779062400);
  assert.equal(drawMessage.levels[1].timestamp, null);
});
