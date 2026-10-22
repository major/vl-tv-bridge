const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SYMBOL_STRING = '={"adjustment":"splits","currency-id":"USD","symbol":"NASDAQ:AMD"}';
const PLOT_TIMESTAMP = 1611585000; // 2021-01-25T14:30:00.000Z

/**
 * Build a fake chart with shapes, line tool alert state, and main series state.
 * Each line tool records alert binding calls in `chart.bindingCalls` and keeps its linked
 * alert id, which can be seeded with `options.linkedAlerts`.
 */
function createAlertChart(shapes = {}, options = {}) {
  const texts = new Map(Object.entries(shapes));
  const linkedAlerts = new Map(Object.entries(options.linkedAlerts || {}));
  const bindingCalls = [];
  // The facade only "knows" an alert after `facadePollsBeforeKnown` lookups, like a late push event.
  let facadePolls = 0;
  const facadeKnows = () => !options.facadeNeverKnows && facadePolls > (options.facadePollsBeforeKnown || 0);
  const facade = {
    getAlertSync() {
      facadePolls++;
      return facadeKnows() ? {} : null;
    }
  };
  const bindingMethods = id => ({
    alertId: () => linkedAlerts.get(id),
    async setAlert(alertId) {
      if (options.failSetAlert) throw new Error('bind failed');
      bindingCalls.push(['setAlert', id, alertId]);
      // TradingView silently unlinks the line when its alert list does not know the alert yet.
      if (facadeKnows()) linkedAlerts.set(id, alertId);
    },
    removeAlert() {
      bindingCalls.push(['removeAlert', id, linkedAlerts.get(id)]);
      linkedAlerts.delete(id);
    }
  });
  const model = {
    getLineToolById(id) {
      if (options.missingLineTool === id) return null;
      const plotOverrides = (options.plotOverrides && options.plotOverrides[id]) || {};
      return {
        ...(options.noBindingMethods ? {} : bindingMethods(id)),
        toolname: 'LineToolHorzRay',
        idForAlert: () => (options.drawingIds && options.drawingIds[id]) || `drawing-${id}`,
        stateForAlertAsync: async () => ({
          id,
          title: 'Ray',
          interval: '1W',
          text: texts.get(id),
          plots: [{
            type: 'LinePlot',
            timestamp: PLOT_TIMESTAMP,
            offset1: 162,
            offset2: 163,
            price1: 213.4,
            price2: 213.4,
            extendBackward: false,
            extendForward: true,
            ...plotOverrides
          }]
        })
      };
    },
    chartAlertsFacade: () => (options.noFacade ? null : facade),
    mainSeries: () => ({
      stateForAlertAsync: async () => ({ symbolString: SYMBOL_STRING, interval: '1W' })
    })
  };
  return {
    bindingCalls,
    symbol: () => 'NASDAQ:AMD',
    resolution: () => '1W',
    getShapeById(id) {
      if (!texts.has(id)) return null;
      return { getProperties: () => ({ text: texts.get(id) }) };
    },
    _chartWidget: { model: () => ({ model: () => model }) }
  };
}

/** Build a fake pricealerts API that records every request and answers by path. */
function createPricealertsFetch(options = {}) {
  const requests = [];
  let nextAlertId = options.nextAlertId || 9001;
  const respond = (requestPath) => {
    if (requestPath === '/list_alerts') {
      return options.listError
        ? { s: 'error', errmsg: options.listError }
        : { s: 'ok', r: options.alerts || [] };
    }
    if (requestPath === '/create_alert') {
      return options.failCreate
        ? { s: 'error', errmsg: 'create failed' }
        : { s: 'ok', r: { alert_id: nextAlertId++ } };
    }
    if (requestPath === '/delete_alerts') {
      return options.failDelete
        ? { s: 'error', errmsg: 'delete failed' }
        : { s: 'ok', r: {} };
    }
    return { s: 'error', errmsg: `unexpected ${requestPath}` };
  };
  const fetch = async (url, init) => {
    const requestPath = url.replace('https://pricealerts.tradingview.com', '');
    requests.push({
      path: requestPath,
      method: init.method,
      credentials: init.credentials,
      contentType: init.headers ? init.headers['Content-Type'] : undefined,
      body: init.body === undefined ? undefined : JSON.parse(init.body)
    });
    const body = respond(requestPath);
    return { ok: true, status: 200, json: async () => body };
  };
  return { requests, fetch };
}

/** Load the injected bridge into an isolated VM with a fake chart and fetch. */
function loadInjected(chart, { pathname = '/chart/RQKT80iA/AMD/', fetch } = {}) {
  const listeners = { message: [] };
  const postedMessages = [];
  const warnings = [];
  const window = {
    top: null,
    location: { pathname },
    vlTvBridgeInjected: false,
    addEventListener(type, handler) {
      listeners[type].push(handler);
    },
    postMessage(message) {
      postedMessages.push(message);
    }
  };
  window.top = window;
  // Logs are silenced; warnings are kept so tests can assert on the alert diagnostics.
  const quietConsole = { log() {}, error() {}, warn: (...args) => warnings.push(args) };
  const context = vm.createContext({
    console: quietConsole,
    window,
    fetch,
    // Run polling delays right away so tests stay fast.
    setTimeout: callback => Promise.resolve().then(callback),
    TradingViewApi: { activeChart: () => chart }
  });
  const script = fs.readFileSync(path.join(__dirname, '..', 'firefox', 'injected.js'), 'utf8');
  vm.runInContext(script, context);

  return {
    postedMessages,
    get warnings() {
      return plain(warnings);
    },
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

/** Send a SYNC_ALERTS request for one kind and return its bridge response. */
async function syncAlerts(injected, context, desired, records = [], kind = 'levels') {
  return injected.send('SYNC_ALERTS', { kind, context, desired, records });
}

/** Build a live TradingView alert that points at one drawing. */
function shapeAlert(alertId, drawingId) {
  return { alert_id: alertId, conditions: [{ series: [{ type: 'line', drawing_id: drawingId }] }] };
}

/** Build a stored alert record in the shape the content script persists. */
function record(alertId, shapeId, price, message) {
  return { alertId, shapeId, price, message };
}

/** Return the create_alert payloads that were sent, in order. */
function createPayloads(fetchState) {
  return fetchState.requests
    .filter(request => request.path === '/create_alert')
    .map(request => request.body.payload);
}

test('create payload matches the TradingView HAR shape for a horizontal ray', async () => {
  const chart = createAlertChart({ 'shape-1': '● VL #5 $4.8B' }, { drawingIds: { 'shape-1': 'XdnpJk' } });
  const fetchState = createPricealertsFetch();
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);
  const expected = {
    conditions: [{
      type: 'cross',
      frequency: 'on_first_fire',
      series: [
        { type: 'barset' },
        {
          type: 'line',
          tool: 'LineToolHorzRay',
          base_time: '2021-01-25T14:30:00.000Z',
          offset1: 162,
          price1: 213.4,
          offset2: 163,
          price2: 213.4,
          extend_forward: true,
          extend_backward: false,
          drawing_id: 'XdnpJk',
          layout_id: 'RQKT80iA'
        }
      ],
      resolution: '1W'
    }],
    symbol: SYMBOL_STRING,
    resolution: '1W',
    message: 'VL #5 $4.8B',
    sound_file: 'alert/fired',
    sound_duration: 0,
    popup: true,
    auto_deactivate: false,
    email: true,
    sms_over_email: false,
    mobile_push: true,
    web_hook: null,
    name: null,
    expiration_policy: { policy: 'never' },
    active: true,
    ignore_warnings: true
  };

  const response = await syncAlerts(injected, context, [{ shapeId: 'shape-1', price: 213.4 }]);

  assert.equal(response.error, null);
  const [request] = fetchState.requests.filter(entry => entry.path === '/create_alert');
  assert.equal(request.method, 'POST');
  assert.equal(request.credentials, 'include');
  assert.equal(request.contentType, 'text/plain;charset=UTF-8');
  assert.deepEqual(request.body, { payload: expected });
});

test('creates an alert for each new desired item and returns its record', async () => {
  const chart = createAlertChart({ 'shape-1': '● VL #1 $214M', 'shape-2': '● VL #2 $120M' });
  const fetchState = createPricealertsFetch();
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);

  const response = await syncAlerts(injected, context, [
    { shapeId: 'shape-1', price: 214 },
    { shapeId: 'shape-2', price: 120 }
  ]);

  assert.equal(response.error, null);
  assert.deepEqual(plain(response.result), {
    success: true,
    created: 2,
    deleted: 0,
    kept: 0,
    skipped: 0,
    failed: 0,
    records: [
      record(9001, 'shape-1', 214, 'VL #1 $214M'),
      record(9002, 'shape-2', 120, 'VL #2 $120M')
    ],
    errors: [],
    skippedDetails: []
  });
  assert.deepEqual(plain(chart.bindingCalls), [
    ['setAlert', 'shape-1', 9001],
    ['setAlert', 'shape-2', 9002]
  ]);
});

test('waits for TradingView to learn about a new alert before linking the line', async () => {
  const chart = createAlertChart({ 'shape-1': '● VL #1 $214M' }, { facadePollsBeforeKnown: 3 });
  const fetchState = createPricealertsFetch();
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);

  const response = await syncAlerts(injected, context, [{ shapeId: 'shape-1', price: 214 }]);

  assert.equal(response.error, null);
  assert.equal(response.result.success, true);
  assert.deepEqual(plain(chart.bindingCalls), [['setAlert', 'shape-1', 9001]]);
});

for (const [name, chartOptions, reason] of [
  ['setAlert throws', { failSetAlert: true }, 'bind failed'],
  ['setAlert is missing', { noBindingMethods: true }, 'TradingView alert internals unavailable: setAlert'],
  ['the alerts facade is missing', { noFacade: true }, 'TradingView alert internals unavailable: alerts facade'],
  ['TradingView never learns about the alert', { facadeNeverKnows: true }, 'TradingView did not load alert 9001 in time']
]) {
  test(`keeps the created record and reports an error when ${name}`, async () => {
    const chart = createAlertChart({ 'shape-1': '● VL #1 $214M' }, chartOptions);
    const fetchState = createPricealertsFetch();
    const injected = loadInjected(chart, { fetch: fetchState.fetch });
    const context = await getContext(injected);

    const response = await syncAlerts(injected, context, [{ shapeId: 'shape-1', price: 214 }]);

    assert.equal(response.error, null);
    const result = plain(response.result);
    assert.equal(result.success, false);
    assert.equal(result.created, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.records, [record(9001, 'shape-1', 214, 'VL #1 $214M')]);
    assert.deepEqual(result.errors, [`Shape shape-1: alert 9001 created but not linked to the line: ${reason}`]);
  });
}

for (const [name, linkedAlerts, expectedCalls] of [
  ['re-links a kept alert when the line lost its link', {}, [['setAlert', 'shape-1', 77]]],
  ['leaves a kept alert alone when the line is already linked', { 'shape-1': 77 }, []]
]) {
  test(name, async () => {
    const chart = createAlertChart({ 'shape-1': '● VL #1 $214M' }, { linkedAlerts });
    const fetchState = createPricealertsFetch({ alerts: [shapeAlert(77, 'drawing-shape-1')] });
    const injected = loadInjected(chart, { fetch: fetchState.fetch });
    const context = await getContext(injected);

    const response = await syncAlerts(injected, context, [{ shapeId: 'shape-1', price: 214 }],
      [record(77, 'shape-1', 214, 'VL #1 $214M')]);

    assert.equal(response.error, null);
    assert.equal(response.result.kept, 1);
    assert.deepEqual(plain(chart.bindingCalls), expectedCalls);
  });
}

test('unlinks a still-drawn line from its deleted alert but keeps a newer link', async () => {
  const chart = createAlertChart({ 'shape-1': '● VL #1 $214M', 'shape-2': '● VL #2 $120M' },
    { linkedAlerts: { 'shape-1': 66, 'shape-2': 67 } });
  const fetchState = createPricealertsFetch({
    alerts: [shapeAlert(66, 'drawing-shape-1'), shapeAlert(67, 'drawing-shape-2')]
  });
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);

  // shape-1 moved price, so 66 is replaced by a new alert; shape-2 is no longer desired.
  const response = await syncAlerts(injected, context, [{ shapeId: 'shape-1', price: 215 }], [
    record(66, 'shape-1', 214, 'VL #1 $214M'),
    record(67, 'shape-2', 120, 'VL #2 $120M')
  ]);

  assert.equal(response.error, null);
  assert.equal(response.result.deleted, 2);
  assert.deepEqual(plain(chart.bindingCalls), [
    ['setAlert', 'shape-1', 9001],
    ['removeAlert', 'shape-2', 67]
  ]);
});

test('keeps a record whose alert, shape, price, and message still match without creating again', async () => {
  const chart = createAlertChart({ 'shape-1': '● VL #1 $214M' });
  const fetchState = createPricealertsFetch({ alerts: [shapeAlert(77, 'drawing-shape-1')] });
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);
  const saved = record(77, 'shape-1', 214, 'VL #1 $214M');

  const response = await syncAlerts(injected, context, [{ shapeId: 'shape-1', price: 214 }], [saved]);

  assert.equal(response.error, null);
  assert.deepEqual(plain(response.result), {
    success: true,
    created: 0,
    deleted: 0,
    kept: 1,
    skipped: 0,
    failed: 0,
    records: [saved],
    errors: [],
    skippedDetails: []
  });
  assert.deepEqual(createPayloads(fetchState), []);
});

test('skips a drawing that already has a manual alert, reports its alert id, and does not record it', async () => {
  const chart = createAlertChart({ 'shape-1': '● VL #1 $214M' });
  const fetchState = createPricealertsFetch({ alerts: [shapeAlert(55, 'drawing-shape-1')] });
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);

  const response = await syncAlerts(injected, context, [{ shapeId: 'shape-1', price: 214 }]);

  assert.equal(response.error, null);
  assert.deepEqual(plain(response.result), {
    success: true,
    created: 0,
    deleted: 0,
    kept: 0,
    skipped: 1,
    failed: 0,
    records: [],
    errors: [],
    skippedDetails: [{ shapeId: 'shape-1', message: 'VL #1 $214M', alertId: 55 }]
  });
  assert.deepEqual(createPayloads(fetchState), []);
  assert.deepEqual(fetchState.requests.filter(entry => entry.path === '/delete_alerts'), []);
  assert.deepEqual(injected.warnings, [
    ['🔔 VL alert', { shapeId: 'shape-1', message: 'VL #1 $214M', reason: 'drawing already has an alert 55' }]
  ]);
});

test('a non-finite plot number fails the item before any create_alert is sent', async () => {
  const chart = createAlertChart({ 'shape-1': '● VL #1 $214M', 'shape-2': '● VL #2 $120M' },
    { plotOverrides: { 'shape-1': { offset1: NaN } } });
  const fetchState = createPricealertsFetch();
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);

  const response = await syncAlerts(injected, context, [
    { shapeId: 'shape-1', price: 214 },
    { shapeId: 'shape-2', price: 120 }
  ]);

  assert.equal(response.error, null);
  const result = plain(response.result);
  assert.equal(result.success, false);
  assert.equal(result.created, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.errors, ['Shape shape-1: TradingView line not ready for alerts: offset1=NaN']);
  assert.deepEqual(createPayloads(fetchState).map(payload => payload.message), ['VL #2 $120M']);
  assert.equal(injected.warnings.length, 1);
  assert.equal(injected.warnings[0][1].reason, 'TradingView line not ready for alerts: offset1=NaN');
});

test('deletes a stale record through delete_alerts and re-creates the moved price alert', async () => {
  const chart = createAlertChart({ 'shape-1': '● VL #5 $4.8B' });
  const fetchState = createPricealertsFetch({ alerts: [shapeAlert(66, 'drawing-shape-1')] });
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);

  const response = await syncAlerts(injected, context, [{ shapeId: 'shape-1', price: 213.4 }],
    [record(66, 'shape-1', 200, 'VL #5 $4.8B')]);

  assert.equal(response.error, null);
  assert.deepEqual(plain(response.result), {
    success: true,
    created: 1,
    deleted: 1,
    kept: 0,
    skipped: 0,
    failed: 0,
    records: [record(9001, 'shape-1', 213.4, 'VL #5 $4.8B')],
    errors: [],
    skippedDetails: []
  });
  const deletes = fetchState.requests.filter(entry => entry.path === '/delete_alerts');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].method, 'POST');
  assert.deepEqual(deletes[0].body, { payload: { alert_ids: [66] } });
});

test('deletes stored alerts whose shape is no longer desired in one call', async () => {
  const chart = createAlertChart({ 'shape-1': '● VL #1 $214M' });
  const fetchState = createPricealertsFetch({
    alerts: [shapeAlert(66, 'drawing-shape-1'), shapeAlert(67, 'drawing-shape-9')]
  });
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);

  const response = await syncAlerts(injected, context, [], [
    record(66, 'shape-1', 214, 'VL #1 $214M'),
    record(67, 'shape-9', 300, 'VL #9 $10M')
  ]);

  assert.equal(response.error, null);
  assert.deepEqual(plain(response.result), {
    success: true,
    created: 0,
    deleted: 2,
    kept: 0,
    skipped: 0,
    failed: 0,
    records: [],
    errors: [],
    skippedDetails: []
  });
  const deletes = fetchState.requests.filter(entry => entry.path === '/delete_alerts');
  assert.deepEqual(deletes.map(entry => entry.body), [{ payload: { alert_ids: [66, 67] } }]);
});

test('drops a record whose alert vanished instead of deleting it', async () => {
  const chart = createAlertChart({ 'shape-1': '● VL #1 $214M' });
  const fetchState = createPricealertsFetch({ alerts: [] });
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);

  const response = await syncAlerts(injected, context, [{ shapeId: 'shape-1', price: 214 }],
    [record(88, 'shape-1', 214, 'VL #1 $214M')]);

  assert.equal(response.error, null);
  assert.deepEqual(plain(response.result), {
    success: true,
    created: 1,
    deleted: 0,
    kept: 0,
    skipped: 0,
    failed: 0,
    records: [record(9001, 'shape-1', 214, 'VL #1 $214M')],
    errors: [],
    skippedDetails: []
  });
  assert.deepEqual(fetchState.requests.filter(entry => entry.path === '/delete_alerts'), []);
});

test('keeps stale records when delete_alerts fails so the next sync retries', async () => {
  const chart = createAlertChart({});
  const fetchState = createPricealertsFetch({ alerts: [shapeAlert(66, 'drawing-shape-1')], failDelete: true });
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);
  const stale = record(66, 'shape-1', 214, 'VL #1 $214M');

  const response = await syncAlerts(injected, context, [], [stale]);

  assert.equal(response.error, null);
  assert.deepEqual(plain(response.result), {
    success: false,
    created: 0,
    deleted: 0,
    kept: 0,
    skipped: 0,
    failed: 0,
    records: [stale],
    errors: ['Could not delete alerts: delete failed'],
    skippedDetails: []
  });
});

test('returns the saved records unchanged when list_alerts fails', async () => {
  const chart = createAlertChart({ 'shape-1': '● VL #1 $214M' });
  const fetchState = createPricealertsFetch({ listError: 'list failed' });
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);
  const saved = record(66, 'shape-1', 214, 'VL #1 $214M');

  const response = await syncAlerts(injected, context, [{ shapeId: 'shape-1', price: 214 }], [saved]);

  assert.equal(response.error, null);
  assert.deepEqual(plain(response.result), {
    success: false,
    created: 0,
    deleted: 0,
    kept: 0,
    skipped: 0,
    failed: 0,
    records: [saved],
    errors: ['list failed'],
    skippedDetails: []
  });
  assert.deepEqual(fetchState.requests.map(entry => entry.path), ['/list_alerts']);
});

test('fails an item with a clear error when TradingView internals are missing while others proceed', async () => {
  const chart = createAlertChart({ 'shape-1': '● VL #1 $214M', 'shape-2': '● VL #2 $120M' },
    { missingLineTool: 'shape-1' });
  const fetchState = createPricealertsFetch();
  const injected = loadInjected(chart, { fetch: fetchState.fetch });
  const context = await getContext(injected);

  const response = await syncAlerts(injected, context, [
    { shapeId: 'shape-1', price: 214 },
    { shapeId: 'shape-2', price: 120 }
  ]);

  assert.equal(response.error, null);
  const result = plain(response.result);
  assert.equal(result.success, false);
  assert.equal(result.created, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.records, [record(9001, 'shape-2', 120, 'VL #2 $120M')]);
  assert.deepEqual(result.errors, ['Shape shape-1: TradingView alert internals unavailable: line tool']);
  assert.deepEqual(createPayloads(fetchState).map(payload => payload.message), ['VL #2 $120M']);
});

for (const [text, message] of [
  ['● VL #1 $214M', 'VL #1 $214M'],
  ['◆ VL #2 $3B', 'VL #2 $3B'],
  ['VL 214', 'VL 214']
]) {
  test(`alert message strips trade markers from "${text}"`, async () => {
    const chart = createAlertChart({ 'shape-1': text });
    const fetchState = createPricealertsFetch();
    const injected = loadInjected(chart, { fetch: fetchState.fetch });
    const context = await getContext(injected);

    const response = await syncAlerts(injected, context, [{ shapeId: 'shape-1', price: 214 }]);

    assert.equal(response.error, null);
    assert.deepEqual(createPayloads(fetchState).map(payload => payload.message), [message]);
  });
}
