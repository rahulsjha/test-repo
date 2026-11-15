import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const seed = JSON.parse(readFileSync(new URL('./requests.json', import.meta.url), 'utf8'));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 4096) chunks.push(chunk);
  }
  if (size > 4096) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Send a JSON object.'), { status: 400 }); }
}

// Urgency first (unknown values last), then oldest createdAt (unparseable dates last),
// then ascending request ID, numeric-aware so GD-99 sorts before GD-100.
const urgencyRank = { urgent: 0, normal: 1, low: 2 };
const rankOf = item => urgencyRank[item.urgency] ?? 3;
const timeOf = item => { const time = Date.parse(item.createdAt); return Number.isNaN(time) ? Infinity : time; };
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function compareRequests(a, b) {
  return order(rankOf(a), rankOf(b)) || order(timeOf(a), timeOf(b))
    || String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
}

function reasonFor(request) {
  const level = urgencyRank[request.urgency] === undefined ? 'Unrecognised urgency (ranked after low)' : `${request.urgency[0].toUpperCase()}${request.urgency.slice(1)} priority`;
  const time = timeOf(request);
  const since = time === Infinity ? 'creation time unknown' : `waiting since ${new Date(time).toISOString().slice(11, 16)} UTC`;
  return `${level}, ${since}. Oldest open request at this urgency.`;
}

// snoozedUntil must be a full ISO 8601 timestamp with a timezone (Z or ±hh:mm) and a real
// calendar date. Date.parse alone is too lenient: it rolls 2026-02-31 into March, reads
// 12345 as the year 12345, and reads zone-less times in the server's local timezone.
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
export function snoozeEnd(value) {
  const match = typeof value === 'string' && ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}
// Only a valid, still-future snooze hides a request. Missing, invalid or expired values do not.
const isSnoozed = (item, now) => { const end = snoozeEnd(item.snoozedUntil); return end !== null && end > now; };
const utcTime = time => `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// A new server starts with independent fictional records. A browser reload keeps changes;
// restarting the process resets them. The exercise does not need a database or credentials.
// `now` is injectable so tests can fix the clock; snoozes are checked on every read, so no scheduler is needed.
export function createStarterServer({ requests = seed, now = Date.now } = {}) {
  const records = structuredClone(requests);
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && files.has(pathname)) {
        const [file, type] = files.get(pathname);
        res.writeHead(200, { 'Content-Type': type });
        return res.end(readFileSync(new URL(`./public/${file}`, import.meta.url)));
      }
      if (req.method === 'GET' && pathname === '/api/next-request') {
        const current = now();
        const open = records.filter(item => item.status === 'open');
        const snoozed = open.filter(item => isSnoozed(item, current));
        const request = open.filter(item => !isSnoozed(item, current))
          .reduce((best, item) => (!best || compareRequests(item, best) < 0 ? item : best), null);
        const hidden = snoozed.length ? ` ${snoozed.length} snoozed request${snoozed.length === 1 ? '' : 's'} hidden for now.` : '';
        const wake = snoozed.length ? utcTime(snoozed.reduce((min, item) => Math.min(min, snoozeEnd(item.snoozedUntil)), Infinity)) : '';
        const reason = request ? reasonFor(request) + hidden
          : snoozed.length ? `No requests to handle right now. ${snoozed.length} open request${snoozed.length === 1 ? ' is' : 's are'} snoozed; the earliest returns at ${wake}.`
          : 'No open requests remain.';
        return json(res, 200, { request, reason });
      }
      if (req.method === 'GET' && pathname === '/api/requests') {
        return json(res, 200, { requests: records.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) });
      }
      const match = pathname.match(/^\/api\/requests\/([A-Z0-9-]+)$/);
      if (req.method === 'PATCH' && match) {
        const record = records.find(item => item.id === match[1]);
        if (!record) return json(res, 404, { error: 'Request not found.' });
        const body = await readBody(req);
        if (!body || Array.isArray(body) || !['open', 'resolved'].includes(body.status)) return json(res, 400, { error: 'Status must be open or resolved.' });
        record.status = body.status;
        return json(res, 200, { request: record });
      }
      return json(res, 404, { error: 'This route is not available.' });
    } catch (error) {
      json(res, error.status || 500, { error: error.status ? error.message : 'The request could not be completed.' });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 43211);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  createStarterServer().listen(port, '127.0.0.1', () => console.log(`Guest desk: http://127.0.0.1:${port}`));
}
