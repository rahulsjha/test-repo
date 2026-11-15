const $ = id => document.getElementById(id);
let filter = 'open', records = [], busy = false, recommendation = null;

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', ...options.headers } });
  // A proxy or crashed server may answer with non-JSON; keep the friendly message instead of a parser error.
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}

function render() {
  const shown = records.filter(item => filter === 'all' || item.status === filter);
  $('requests').replaceChildren(...shown.map(item => {
    const card = document.createElement('article'); card.className = 'request';
    const body = document.createElement('div');
    body.append(text('h3', item.title), text('p', item.detail));
    const meta = text('p', '', 'meta');
    meta.append(text('span', `${item.guest} · Room ${item.room}`), text('span', item.urgency, `pill ${item.urgency}`));
    if (item.status === 'resolved') meta.append(text('span', 'Handled', 'pill resolved'));
    meta.append(text('time', new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'));
    body.append(meta);
    const button = text('button', item.status === 'open' ? 'Mark handled' : 'Reopen', 'handle');
    button.type = 'button'; button.disabled = busy; button.setAttribute('aria-label', `${button.textContent}: ${item.title}`);
    button.addEventListener('click', () => update(item));
    card.append(text('span', item.guest[0], 'guest-icon'), body, button);
    return card;
  }));
  const open = records.filter(item => item.status === 'open').length;
  $('open-count').textContent = `${open} open`; $('nav-count').textContent = open;
  $('empty').hidden = busy || !$('error').hidden || shown.length > 0;
  $('empty').textContent = filter === 'resolved' ? 'Handled requests will appear here.' : 'All caught up. Your guests are in good hands.';
  $('refresh').disabled = busy;
  $('handle-next').disabled = busy;
  for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
}

function showError(error) {
  $('error').textContent = error.name === 'TimeoutError' ? 'The request took too long. Refresh the inbox to check its current state.' : error instanceof TypeError ? 'We could not reach the inbox. Check your connection, then refresh.' : error.message;
  $('error').hidden = false;
}

async function load() {
  if (busy) return;
  busy = true; $('status').textContent = 'Refreshing your inbox…'; $('error').hidden = true; render();
  try { records = (await api('/api/requests')).requests; await loadRecommendation(); }
  catch (error) { showError(error); recommendationUnavailable(); }
  finally { busy = false; $('status').textContent = ''; render(); }
}

async function update(item) {
  if (busy) return;
  // Clear any earlier success text so a failure can never sit next to "Request marked handled."
  busy = true; $('error').hidden = true; $('status').textContent = ''; render();
  const done = item.status === 'open' ? 'Request marked handled.' : 'Request reopened.';
  let saved = false;
  try {
    await api(`/api/requests/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ status: item.status === 'open' ? 'resolved' : 'open' }) });
    saved = true;
    records = (await api('/api/requests')).requests;
    await loadRecommendation();
    $('status').textContent = done;
  } catch (error) {
    showError(error);
    // The save worked but the refresh did not: say both, and do not offer a recommendation that may be stale.
    if (saved) { $('error').textContent = `${done.slice(0, -1)}, but the inbox could not refresh. Refresh to check the current state.`; recommendationUnavailable(); }
  } finally { busy = false; render(); }
}

for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; render(); });
$('refresh').addEventListener('click', load);
void load();

async function loadRecommendation() {
  $('next-status').textContent = 'Finding the next request…';
  $('next-reason').textContent = '';
  $('next-meta').textContent = '';
  $('next-error').hidden = true;
  $('handle-next').hidden = true;
  recommendation = null;
  try {
    const result = await api('/api/next-request');
    recommendation = result.request;
    $('next-status').textContent = recommendation ? recommendation.title : 'Nothing to handle right now.'; // the reason says whether the queue is empty or snoozed
    // Usability: show who and where, so the operator can act without hunting through the inbox.
    if (recommendation) $('next-meta').textContent = `${recommendation.guest} · Room ${recommendation.room} · ${recommendation.urgency}`;
    $('next-reason').textContent = result.reason;
    $('handle-next').hidden = !recommendation;
  } catch (error) {
    recommendationUnavailable(error.message);
  }
}

function recommendationUnavailable(message = 'Refresh the inbox to try again.') {
  recommendation = null;
  $('next-status').textContent = 'Recommendation unavailable.';
  $('next-reason').textContent = '';
  $('next-meta').textContent = '';
  $('next-error').textContent = message;
  $('next-error').hidden = false;
  $('handle-next').hidden = true;
}
$('handle-next').addEventListener('click', () => {
  if (recommendation && !busy) void update({ ...recommendation, status: 'open' });
});
