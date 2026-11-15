import test from 'node:test';
import assert from 'node:assert/strict';
import { createStarterServer } from '../server.js';

async function fixture(t, options) {
  const server = createStarterServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
}

test('the starter serves its page, script, and fictional request inbox', async t => {
  const call = await fixture(t);
  assert.match(await (await call('/')).text(), /Small requests/);
  assert.match((await call('/app.js')).headers.get('content-type'), /javascript/);
  const response = await call('/api/requests');
  assert.equal(response.status, 200);
  const { requests } = await response.json();
  assert.equal(requests.length, 6);
  assert.equal(requests.filter(item => item.status === 'open').length, 5);
});

test('handling a request is reflected by the next read and is safe to repeat', async t => {
  const call = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const response = await call('/api/requests/GD-103', { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
    assert.equal(response.status, 200);
  }
  assert.equal((await (await call('/api/requests')).json()).requests.find(item => item.id === 'GD-103').status, 'resolved');
  const other = await fixture(t);
  assert.equal((await (await other('/api/requests')).json()).requests.find(item => item.id === 'GD-103').status, 'open');
});

test('invalid updates and unknown paths do not mutate the inbox or expose source', async t => {
  const call = await fixture(t);
  for (const body of ['null', '{}', 'not-json', '{"status":"missing"}']) assert.equal((await call('/api/requests/GD-103', { method: 'PATCH', body })).status, 400);
  assert.equal((await call('/api/requests/GD-999', { method: 'PATCH', body: '{"status":"resolved"}' })).status, 404);
  assert.equal((await call('/server.js')).status, 404);
  assert.equal((await call('/package.json')).status, 404);
  assert.equal((await call('/api/requests/GD-103', { method: 'PATCH', body: ' '.repeat(4097) })).status, 413);
});

test('an empty inbox remains a successful response', async t => {
  const call = await fixture(t, { requests: [] });
  assert.deepEqual(await (await call('/api/requests')).json(), { requests: [] });
});

const next = async call => (await call('/api/next-request')).json();
const record = (id, urgency, createdAt, status = 'open') => ({ id, guest: 'Test', room: '1', title: id, detail: '', urgency, status, createdAt });

test('next request never recommends a resolved request and breaks exact ties by ascending ID', async t => {
  const call = await fixture(t);
  // GD-104 is the oldest urgent request but is resolved; GD-103 and GD-105 are tied on urgency and time.
  const first = await next(call);
  assert.equal(first.request.id, 'GD-103');
  assert.equal(first.request.status, 'open');
  assert.match(first.reason, /Urgent priority, waiting since 08:30 UTC/);
});

test('next request walks the queue in urgency, age, ID order and ends with request:null', async t => {
  const call = await fixture(t);
  const seen = [];
  for (let result = await next(call), guard = 0; result.request && guard < 10; result = await next(call), guard++) {
    seen.push(result.request.id);
    assert.equal((await call(`/api/requests/${result.request.id}`, { method: 'PATCH', body: '{"status":"resolved"}' })).status, 200);
  }
  assert.deepEqual(seen, ['GD-103', 'GD-105', 'GD-102', 'GD-106', 'GD-101']);
  assert.deepEqual(await next(call), { request: null, reason: 'No open requests remain.' });
});

test('an empty or fully resolved queue returns request:null with a reason', async t => {
  for (const requests of [[], [record('GD-1', 'urgent', '2026-11-03T08:00:00Z', 'resolved')]]) {
    const call = await fixture(t, { requests });
    const result = await next(call);
    assert.equal(result.request, null);
    assert.equal(result.reason, 'No open requests remain.');
  }
});

test('ID ties are numeric-aware and parsed times are compared, not strings', async t => {
  const call = await fixture(t, { requests: [
    record('GD-100', 'normal', '2026-11-03T08:00:00Z'),
    record('GD-99', 'normal', '2026-11-03T08:00:00Z'),
    record('GD-1', 'normal', '2026-11-03T13:00:00+05:30'), // 07:30 UTC, earliest despite the later-looking string
  ] });
  assert.equal((await next(call)).request.id, 'GD-1');
  await call('/api/requests/GD-1', { method: 'PATCH', body: '{"status":"resolved"}' });
  assert.equal((await next(call)).request.id, 'GD-99');
});

test('unknown urgency and unreadable dates sort last instead of crashing', async t => {
  const call = await fixture(t, { requests: [
    record('GD-1', 'critical', '2026-11-03T07:00:00Z'),
    record('GD-2', 'low', 'not-a-date'),
    record('GD-3', 'low', '2026-11-03T09:00:00Z'),
  ] });
  const order = [];
  for (let result = await next(call), guard = 0; result.request && guard < 10; result = await next(call), guard++) {
    order.push([result.request.id, result.reason]);
    await call(`/api/requests/${result.request.id}`, { method: 'PATCH', body: '{"status":"resolved"}' });
  }
  assert.deepEqual(order.map(([id]) => id), ['GD-3', 'GD-2', 'GD-1']);
  assert.match(order[1][1], /creation time unknown/);
  assert.match(order[2][1], /Unrecognised urgency/);
});

// Step 3: snoozedUntil. The clock is fixed so results do not depend on when the tests run.
const NOW = Date.parse('2026-11-03T09:00:00Z');
const snoozedFixture = (t, requests) => fixture(t, { requests, now: () => NOW });
const snooze = (id, urgency, createdAt, snoozedUntil, status = 'open') => ({ ...record(id, urgency, createdAt, status), ...(snoozedUntil !== undefined && { snoozedUntil }) });

test('a valid future snooze hides the request; the next one by the usual order is chosen', async t => {
  const call = await snoozedFixture(t, [
    snooze('GD-1', 'urgent', '2026-11-03T08:00:00Z', '2026-11-03T10:00:00Z'),        // future: hidden
    snooze('GD-2', 'urgent', '2026-11-03T08:30:00Z', '2026-11-03T14:30:00+05:30'),   // = 09:00 UTC, not later than now: shown
    snooze('GD-3', 'urgent', '2026-11-03T08:30:00Z'),
  ]);
  const result = await next(call);
  assert.equal(result.request.id, 'GD-2'); // GD-2 beats GD-3 on ID; GD-1 is skipped
  assert.match(result.reason, /1 snoozed request hidden for now\./);
});

test('expired, missing and invalid snooze values do not hide a request', async t => {
  const values = {
    expired: '2026-11-03T08:59:59Z', missing: undefined, empty: '', text: 'tomorrow', nullValue: null,
    number: 1893456000000, numericString: '12345', impossibleDate: '2026-11-31T10:00:00Z', badMonth: '2026-13-01T10:00:00Z',
    noTimezone: '2026-11-04T10:00:00', dateOnly: '2026-11-04', notIso: 'Nov 4 2026', badHour: '2026-11-03T25:00:00Z',
  };
  for (const [label, value] of Object.entries(values)) {
    const call = await snoozedFixture(t, [snooze('GD-1', 'urgent', '2026-11-03T08:00:00Z', value), snooze('GD-2', 'low', '2026-11-03T07:00:00Z')]);
    const result = await next(call);
    assert.equal(result.request.id, 'GD-1', `${label} (${JSON.stringify(value)}) should not hide GD-1`);
    assert.doesNotMatch(result.reason, /snoozed/, label);
  }
});

test('snooze does not change ordering or the resolved rule', async t => {
  const call = await snoozedFixture(t, [
    snooze('GD-1', 'urgent', '2026-11-03T07:00:00Z', '2026-11-03T08:00:00Z', 'resolved'), // expired snooze, still resolved
    snooze('GD-2', 'normal', '2026-11-03T08:20:00Z', '2026-11-03T08:00:00Z'),             // expired
    snooze('GD-3', 'normal', '2026-11-03T08:10:00Z', 'not-a-date'),                      // invalid
    snooze('GD-4', 'urgent', '2026-11-03T08:00:00Z', '2026-11-04T00:00:00.123456Z'),     // future, microseconds
    snooze('GD-5', 'low', '2026-11-03T06:00:00Z'),
  ]);
  const seen = [];
  for (let result = await next(call), guard = 0; result.request && guard < 10; result = await next(call), guard++) {
    seen.push(result.request.id);
    await call(`/api/requests/${result.request.id}`, { method: 'PATCH', body: '{"status":"resolved"}' });
  }
  assert.deepEqual(seen, ['GD-3', 'GD-2', 'GD-5']);
});

test('when every open request is snoozed, request is null and the reason says when one returns', async t => {
  const call = await snoozedFixture(t, [
    snooze('GD-1', 'urgent', '2026-11-03T08:00:00Z', '2026-11-03T11:00:00Z'),
    snooze('GD-2', 'low', '2026-11-03T08:00:00Z', '2026-11-03T10:15:00+00:00'),
    snooze('GD-3', 'low', '2026-11-03T08:00:00Z', '2026-11-03T08:00:00Z', 'resolved'),
  ]);
  assert.deepEqual(await next(call), { request: null, reason: 'No requests to handle right now. 2 open requests are snoozed; the earliest returns at 2026-11-03 10:15 UTC.' });
});

test('a snooze expires on the next read without any scheduler', async t => {
  let clock = NOW;
  const call = await fixture(t, { requests: [snooze('GD-1', 'urgent', '2026-11-03T08:00:00Z', '2026-11-03T09:30:00Z')], now: () => clock });
  assert.equal((await next(call)).request, null);
  clock = Date.parse('2026-11-03T09:30:00Z'); // equal: no longer later than now
  assert.equal((await next(call)).request.id, 'GD-1');
});
