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

      if (String(url).includes('/Chart0/GetTradeLevels')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ Price: 36.8, TradeLevelRank: 1, Dollars: 1459892.8, Volume: 39671, Trades: 1, Dates: '2026-05-19 - 2026-05-19' }]
          })
        };
      }

      if (String(url).includes('/Chart0/GetTrades')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: settings.tradesData || [] })
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
      cookies: { getAll: async () => [{ name: '.ASPXAUTH' }] },
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

test('trade request matches the VolumeLeaders Chart0 GetTrades HAR shape', async () => {
  const context = loadBackground({ yearRange: 1 });

  await context.fetchVlTrades('CRDU', 5, null, new Date('2026-06-08T12:00:00Z'));

  const tradeRequest = context.fetchCalls.find(call => String(call.url).endsWith('/Chart0/GetTrades'));
  const body = Object.fromEntries(new URLSearchParams(tradeRequest.options.body));
  const expectedBody = {
    'draw': '2',
    'columns[0][data]': 'FullTimeString24',
    'columns[0][name]': 'FullTimeString24',
    'columns[0][searchable]': 'true',
    'columns[0][orderable]': 'false',
    'columns[0][search][value]': '',
    'columns[0][search][regex]': 'false',
    'columns[1][data]': 'Volume',
    'columns[1][name]': 'Sh',
    'columns[1][searchable]': 'true',
    'columns[1][orderable]': 'false',
    'columns[1][search][value]': '',
    'columns[1][search][regex]': 'false',
    'columns[2][data]': 'Price',
    'columns[2][name]': 'Price',
    'columns[2][searchable]': 'true',
    'columns[2][orderable]': 'false',
    'columns[2][search][value]': '',
    'columns[2][search][regex]': 'false',
    'columns[3][data]': 'Dollars',
    'columns[3][name]': '$$',
    'columns[3][searchable]': 'true',
    'columns[3][orderable]': 'false',
    'columns[3][search][value]': '',
    'columns[3][search][regex]': 'false',
    'columns[4][data]': 'DollarsMultiplier',
    'columns[4][name]': 'RS',
    'columns[4][searchable]': 'true',
    'columns[4][orderable]': 'false',
    'columns[4][search][value]': '',
    'columns[4][search][regex]': 'false',
    'columns[5][data]': 'TradeRank',
    'columns[5][name]': 'R',
    'columns[5][searchable]': 'true',
    'columns[5][orderable]': 'false',
    'columns[5][search][value]': '',
    'columns[5][search][regex]': 'false',
    'columns[6][data]': 'LastComparibleTradeDate',
    'columns[6][name]': 'Last Comp',
    'columns[6][searchable]': 'true',
    'columns[6][orderable]': 'false',
    'columns[6][search][value]': '',
    'columns[6][search][regex]': 'false',
    'start': '0',
    'length': '5',
    'search[value]': '',
    'search[regex]': 'false',
    'StartDateKey': '20250608',
    'EndDateKey': '20260608',
    'Ticker': 'CRDU',
    'VolumeProfile': '0',
    'Levels': '5',
    'MinVolume': '0',
    'MaxVolume': '2000000000',
    'MinDollars': '500000',
    'MaxDollars': '30000000000',
    'DarkPools': '-1',
    'Sweeps': '-1',
    'LatePrints': '-1',
    'SignaturePrints': '-1',
    'TradeCount': '5',
    'MinPrice': '0',
    'MaxPrice': '100000',
    'VCD': '0',
    'TradeRank': '-1',
    'TradeRankSnapshot': '-1',
    'IncludePremarket': '1',
    'IncludeRTH': '1',
    'IncludeAH': '1',
    'IncludeOpening': '1',
    'IncludeClosing': '1',
    'IncludePhantom': '1',
    'IncludeOffsetting': '1'
  };

  assert.equal(String(tradeRequest.url), 'https://www.volumeleaders.com/Chart0/GetTrades');
  assert.equal(tradeRequest.options.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.equal(tradeRequest.options.headers.Accept, 'application/json, text/javascript, */*; q=0.01');
  assert.equal(tradeRequest.options.headers.Origin, 'https://www.volumeleaders.com');
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

  const tradeRequest = context.fetchCalls.find(call => String(call.url).endsWith('/Chart0/GetTrades'));
  const body = Object.fromEntries(new URLSearchParams(tradeRequest.options.body));

  assert.deepEqual(plain(context.tabMessages[0]), {
    tabId: 123,
    message: { type: 'GET_VISIBLE_RANGE' }
  });
  assert.equal(body.StartDateKey, '20260310');
  assert.equal(body.EndDateKey, '20260608');
  assert.equal(body.TradeCount, '10');
  assert.equal(tradeRequest.options.headers.Referer, 'https://www.volumeleaders.com/Chart0?StartDate=2026-03-10&EndDate=2026-06-08&Ticker=CRDU&MinVolume=0&MaxVolume=2000000000&MinDollars=500000&MaxDollars=30000000000&MinPrice=0&MaxPrice=100000&DarkPools=-1&Sweeps=-1&LatePrints=-1&SignaturePrints=-1&VolumeProfile=0&Levels=10&TradeCount=10&VCD=0&TradeRank=-1&TradeRankSnapshot=-1&IncludePremarket=1&IncludeRTH=1&IncludeAH=1&IncludeOpening=1&IncludeClosing=1&IncludePhantom=1&IncludeOffsetting=1');
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
      DarkPool: 0,
      Sweep: 1,
      FullDateTime: '2026-05-19T09:36:02'
    }, {
      Date: '/Date(1779148860000)/',
      Ticker: 'VT',
      Price: 123.45,
      TradeRank: 2,
      Dollars: 2000000,
      Volume: 10000,
      DarkPool: '1',
      Sweep: 1,
      FullDateTime: '2026-05-19T09:37:02'
    }]
  });

  const result = await context.fetchVlTrades('CRDU', 5, null, new Date('2026-06-08T12:00:00Z'));

  assert.equal(result.trades[0].sweep, true);
  assert.equal(result.trades[1].darkPool, true);
  assert.equal(result.trades[1].sweep, true);
});

test('level request matches the VolumeLeaders Chart0 GetTradeLevels HAR shape', async () => {
  const context = loadBackground({ yearRange: 1, levelCount: 5, tradeCount: 3 });

  const result = await context.fetchVlLevels('CRDU', new Date('2026-06-08T12:00:00Z'));

  const levelRequest = context.fetchCalls.find(call => String(call.url).endsWith('/Chart0/GetTradeLevels'));
  const body = Object.fromEntries(new URLSearchParams(levelRequest.options.body));
  const expectedBody = {
    'draw': '2',
    'columns[0][data]': 'Price',
    'columns[0][name]': 'Price',
    'columns[0][searchable]': 'true',
    'columns[0][orderable]': 'false',
    'columns[0][search][value]': '',
    'columns[0][search][regex]': 'false',
    'columns[1][data]': 'Dollars',
    'columns[1][name]': '$$',
    'columns[1][searchable]': 'true',
    'columns[1][orderable]': 'false',
    'columns[1][search][value]': '',
    'columns[1][search][regex]': 'false',
    'columns[2][data]': 'Volume',
    'columns[2][name]': 'Sh',
    'columns[2][searchable]': 'true',
    'columns[2][orderable]': 'false',
    'columns[2][search][value]': '',
    'columns[2][search][regex]': 'false',
    'columns[3][data]': 'Trades',
    'columns[3][name]': 'Trades',
    'columns[3][searchable]': 'true',
    'columns[3][orderable]': 'false',
    'columns[3][search][value]': '',
    'columns[3][search][regex]': 'false',
    'columns[4][data]': 'RelativeSize',
    'columns[4][name]': 'RS',
    'columns[4][searchable]': 'true',
    'columns[4][orderable]': 'false',
    'columns[4][search][value]': '',
    'columns[4][search][regex]': 'false',
    'columns[5][data]': 'CumulativeDistribution',
    'columns[5][name]': 'PCT',
    'columns[5][searchable]': 'true',
    'columns[5][orderable]': 'false',
    'columns[5][search][value]': '',
    'columns[5][search][regex]': 'false',
    'columns[6][data]': 'TradeLevelRank',
    'columns[6][name]': 'Rank',
    'columns[6][searchable]': 'true',
    'columns[6][orderable]': 'false',
    'columns[6][search][value]': '',
    'columns[6][search][regex]': 'false',
    'columns[7][data]': 'Dates',
    'columns[7][name]': 'Dates',
    'columns[7][searchable]': 'true',
    'columns[7][orderable]': 'false',
    'columns[7][search][value]': '',
    'columns[7][search][regex]': 'false',
    'start': '0',
    'length': '-1',
    'search[value]': '',
    'search[regex]': 'false',
    'StartDate': '2025-06-08',
    'EndDate': '2026-06-08',
    'Ticker': 'CRDU',
    'Levels': '5'
  };

  assert.equal(String(levelRequest.url), 'https://www.volumeleaders.com/Chart0/GetTradeLevels');
  assert.equal(levelRequest.options.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.equal(levelRequest.options.headers.Accept, 'application/json, text/javascript, */*; q=0.01');
  assert.equal(levelRequest.options.headers.Origin, 'https://www.volumeleaders.com');
  assert.equal(levelRequest.options.headers.Referer, 'https://www.volumeleaders.com/Chart0?StartDate=2025-06-08&EndDate=2026-06-08&Ticker=CRDU&MinVolume=0&MaxVolume=2000000000&MinDollars=500000&MaxDollars=30000000000&MinPrice=0&MaxPrice=100000&DarkPools=-1&Sweeps=-1&LatePrints=-1&SignaturePrints=-1&VolumeProfile=0&Levels=5&TradeCount=3&VCD=0&TradeRank=-1&TradeRankSnapshot=-1&IncludePremarket=1&IncludeRTH=1&IncludeAH=1&IncludeOpening=1&IncludeClosing=1&IncludePhantom=1&IncludeOffsetting=1');
  assert.deepEqual(body, expectedBody);
  assert.equal(result.levels[0].price, 36.8);
});
