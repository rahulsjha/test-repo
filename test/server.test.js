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
