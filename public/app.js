// Beads Explorer UI. Plain ES module; issue text only ever reaches the page as text nodes or sanitised Markdown.
import {
  PRIORITIES, STATUSES, TYPES, blockersOf, buildGraph, byPriorityThenId, childrenOf, compareIds, epicProgress,
  extractUpdateBlock, filterIssues, insights, isBlocked, isReady, normalizeIssues,
} from '/model.mjs';

const TOKEN = document.querySelector('meta[name="beads-ui-token"]').content;
const REPO = document.querySelector('meta[name="beads-ui-repo"]')?.content ?? '';
const OWNER = document.querySelector('meta[name="beads-ui-owner"]')?.content ?? '';
document.getElementById('repo-name').textContent = REPO;
if (REPO) document.title = `${REPO} · Beads Explorer`;
const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', blocked: 'Blocked', deferred: 'Deferred', pinned: 'Pinned', hooked: 'Hooked', closed: 'Closed' };
const VIEWS = ['board', 'list', 'graph', 'epics', 'insights', 'memories'];
const CLOSED_CAP = 50;
const REFRESH_MS = 30000;

const state = {
  model: { issues: [], byId: new Map() },
  fetchedAt: null,
  filters: { query: '', statuses: [], priorities: [], types: [], label: '', parent: '' },
  view: 'board',
  selected: null, // keyboard highlight
  open: null, // id shown in the drawer
  detail: null,
  tab: 'details',
  memories: null,
  memoryQuery: '',
  sort: { key: 'priority', dir: 1 },
  bulk: new Set(),
  graph: { parents: false, closed: false, connectedOnly: true, depth: 2, focus: null },
  editing: 0,
  chatStatus: null,
  streams: new Map(), // issue id -> AbortController of a running chat
  nav: [],
};
let cy = null;

// ---------- small helpers ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
// The app's own elements are looked up once, before any issue text is on the page.
const CHROME = Object.fromEntries(['search', 'modal', 'drawer', 'sync', 'f-label', 'f-parent', 'main', 'toasts', 'f-status', 'f-priority', 'f-type', 'freshness', 'clear-filters', 'refresh', 'new-issue']
  .map((id) => [`#${id}`, document.getElementById(id)]));
const $ = (sel) => CHROME[sel] ?? CHROME['#main'].querySelector(sel);
const statusEl = (s) => h('span', { class: `status st-${s}` }, STATUS_LABEL[s] ?? s);
const prioEl = (p) => h('span', { class: `prio p${p}`, title: `Priority ${p}` }, `P${p}`);
const idEl = (id) => h('span', { class: 'id' }, id);
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const shortDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

function toast(message, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : null }, message);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-beads-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${method} ${path} failed (${res.status})`), { status: res.status });
  return data;
}

/** Markdown → sanitised element, with issue ids turned into links. Falls back to plain text when the libraries did not load. */
function md(text, { empty = 'Nothing written yet.' } = {}) {
  if (!text || !text.trim()) return h('p', { class: 'empty' }, empty);
  const box = h('div', { class: 'md' });
  if (window.marked && window.DOMPurify) {
    box.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true, breaks: true }), {
      FORBID_ATTR: ['id', 'name', 'style', 'class', 'form', 'formaction', 'tabindex', 'autofocus'],
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'dialog', 'iframe', 'object', 'embed', 'svg', 'math', 'details'],
    });
    for (const a of box.querySelectorAll('a[href]')) {
      if (!a.getAttribute('href').startsWith('#')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    }
  } else {
    box.style.whiteSpace = 'pre-wrap';
    box.textContent = text;
  }
  linkifyIds(box);
  return box;
}

const ID_IN_TEXT = /\b[a-z0-9]+-[a-z0-9]+(?:\.[a-z0-9]+)*\b/g;
function linkifyIds(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(ID_IN_TEXT)) {
      if (!state.model.byId.has(m[0])) continue;
      parts.push(text.slice(last, m.index), h('a', { href: issueHref(m[0]), class: 'issue-link', title: state.model.byId.get(m[0]).title }, m[0]));
      last = m.index + m[0].length;
    }
    if (!parts.length) continue;
    parts.push(text.slice(last));
    node.replaceWith(...parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : p)));
  }
}

const issueHref = (id) => `#/${state.view === 'memories' ? 'board' : state.view}/${encodeURIComponent(id)}`;

// ---------- modal ----------
function modal({ title, fields = [], submit = 'Save', danger = false, text = '' }) {
  const dlg = $('#modal');
  return new Promise((resolve) => {
    const inputs = {};
    const form = h('form', { method: 'dialog' },
      text ? h('p', {}, text) : null,
      fields.map((f) => {
        let input;
        if (f.type === 'select') input = h('select', { name: f.name }, f.options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(f.value ?? '') }, l)));
        else if (f.type === 'textarea') input = h('textarea', { name: f.name, rows: 6 }, f.value ?? '');
        else if (f.type === 'checkbox') input = h('input', { name: f.name, type: 'checkbox', checked: Boolean(f.value) });
        else input = h('input', { name: f.name, value: f.value ?? '', required: f.required, list: f.list, placeholder: f.placeholder ?? '', autocomplete: 'off' });
        inputs[f.name] = input;
        return f.type === 'checkbox' ? h('label', { style: 'display:flex;flex-direction:row;gap:8px;align-items:center' }, input, f.label) : h('label', {}, f.label, input);
      }),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn ghost', onClick: () => { dlg.close(); resolve(null); } }, 'Cancel'),
        h('button', { type: 'submit', class: danger ? 'btn danger' : 'btn' }, submit)));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const [k, el] of Object.entries(inputs)) out[k] = el.type === 'checkbox' ? el.checked : el.value;
      if (fields.some((f) => f.required && !String(out[f.name]).trim())) return;
      dlg.close();
      resolve(out);
    });
    dlg.replaceChildren(h('h2', {}, title), form);
    dlg.onclose = () => resolve(null);
    dlg.showModal();
    form.querySelector('input, textarea, select')?.focus();
  });
}

// ---------- data ----------
async function loadIssues({ quiet = false } = {}) {
  try {
    const data = await api('GET', '/api/issues');
    state.model = normalizeIssues(data.issues);
    state.fetchedAt = data.fetchedAt;
    renderFilters();
    if (state.editing !== 'main') render();
  } catch (error) {
    if (!quiet) toast(error.message, 'error');
  }
}

async function loadDetail(id) {
  try {
    state.detail = await api('GET', `/api/issues/${encodeURIComponent(id)}`);
  } catch (error) {
    state.detail = null;
    toast(error.message, 'error');
  }
  if (state.open === id && state.editing !== 'drawer') renderDrawer();
}

async function mutate(promise, success) {
  try {
    const result = await promise;
    if (success) toast(success);
    state.editing = 0;
    if (result?.id && result.id === state.open && 'comments' in result) { state.detail = result; renderDrawer(); }
    else if (state.open) loadDetail(state.open);
    await loadIssues({ quiet: true });
    return result ?? true;
  } catch (error) {
    toast(error.message, 'error');
    // Show what bd really holds now: a conflict means newer data, any failure means the control may show an unsaved value.
    state.editing = 0;
    await loadIssues({ quiet: true });
    if (state.open) await loadDetail(state.open); else render();
    return null;
  }
}

/**
 * Edits carry the updated_at of the version the user was looking at: the drawer's version for drawer edits,
 * the card's version for a drag. The server refuses with 409 if bd changed the issue since.
 */
const freshness = (id) => (id === state.open && state.drawerUpdatedAt ? state.drawerUpdatedAt : state.model.byId.get(id)?.updated_at);
const patchIssue = (id, patch, success = 'Saved', expected = freshness(id)) => mutate(api('PATCH', `/api/issues/${encodeURIComponent(id)}`, { ...patch, expectedUpdatedAt: expected }), success);

async function setStatus(id, status, expected = freshness(id)) {
  const issue = state.model.byId.get(id);
  if (!issue || issue.status === status) return;
  if (status === 'closed') {
    const open = blockersOf(issue, state.model.byId);
    const fields = [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }];
    if (open.length) fields.push({ name: 'force', type: 'checkbox', label: `Close even though ${open.map((b) => b.id).join(', ')} still block${open.length === 1 ? 's' : ''} it` });
    const out = await modal({ title: `Close ${id}`, text: issue.title, fields, submit: 'Close issue' });
    if (!out) { render(); if (state.open) renderDrawer(); return null; }
    const close = (force) => api('POST', `/api/issues/${encodeURIComponent(id)}/close`, { reason: out.reason, force, expectedUpdatedAt: expected });
    try {
      return await mutate(close(out.force === true).catch(async (error) => {
        // bd also refuses pinned issues and gates; offer its --force when it says so.
        if (out.force || !/--force/.test(error.message)) throw error;
        const again = await modal({ title: `bd refused to close ${id}`, text: error.message, submit: 'Close anyway', danger: true });
        if (!again) throw Object.assign(new Error('Not closed.'), { quiet: true });
        return close(true);
      }), `Closed ${id}`);
    } finally { if (state.open) renderDrawer(); }
  }
  // The server reopens a closed issue (bd reopen) before setting another status.
  return patchIssue(id, { status }, issue.status === 'closed' ? `Reopened ${id}: ${STATUS_LABEL[status]}` : `${id}: ${STATUS_LABEL[status]}`, expected);
}

// ---------- routing ----------
function route() {
  const [, view = 'board', id = ''] = location.hash.split('/');
  let decoded = '';
  try { decoded = decodeURIComponent(id); } catch { /* a malformed link opens nothing */ }
  if (state.view !== view) state.editing = 0;
  if (view === 'issue') {
    openIssue(decoded);
    return;
  }
  state.view = VIEWS.includes(view) ? view : 'board';
  if (state.view === 'graph') state.graph.focus = decoded || state.graph.focus;
  for (const a of document.querySelectorAll('#views a')) a.toggleAttribute('aria-current', false), a.dataset.view === state.view && a.setAttribute('aria-current', 'page');
  if (decoded) openIssue(decoded, { push: false });
  else closeDrawer({ push: false });
  render();
}

function openIssue(id, { push = true } = {}) {
  if (!id) return;
  if (state.open !== id) {
    state.editing = 0;
    state.drawerUpdatedAt = null;
    if (!state.open) state.returnFocusId = document.activeElement?.closest?.('[data-id]')?.dataset.id ?? null;
    state.focusDrawer = true;
  }
  state.open = id;
  state.selected = id;
  state.detail = null;
  if (push) {
    const next = `#/${state.view}/${encodeURIComponent(id)}`;
    if (location.hash !== next) { location.hash = next; return; }
  }
  renderDrawer();
  loadDetail(id);
  highlightSelected();
}

function closeDrawer({ push = true } = {}) {
  const wasOpen = Boolean(state.open);
  state.editing = 0;
  state.drawerUpdatedAt = null;
  state.open = null;
  state.detail = null;
  state.tab = 'details';
  $('#drawer').hidden = true;
  $('#drawer').replaceChildren();
  if (wasOpen && state.returnFocusId) state.pendingFocusId = state.returnFocusId;
  state.returnFocusId = null;
  // Changing the hash re-renders the view, which then moves focus back to the card or row; otherwise do it now.
  if (push && location.hash.split('/').length > 2) location.hash = `#/${state.view}`;
  else if (push) focusPending();
}

// ---------- filters ----------
function renderFilters() {
  if (document.getElementById('filters').contains(document.activeElement) && document.activeElement.matches('select, .chip')) return;
  const counts = (key) => state.model.issues.reduce((m, i) => m.set(i[key], (m.get(i[key]) ?? 0) + 1), new Map());
  const chipSet = (container, values, key, label, count) => {
    container.replaceChildren(...values.map((v) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(state.filters[key].includes(v)),
      onClick: (e) => {
        const list = state.filters[key];
        state.filters[key] = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
        e.currentTarget.setAttribute('aria-pressed', String(state.filters[key].includes(v)));
        render();
      },
    }, `${label(v)} ${count.get(v) ?? 0}`)));
  };
  chipSet($('#f-status'), STATUSES.filter((s) => !['pinned', 'hooked'].includes(s) || counts('status').has(s)), 'statuses', (s) => STATUS_LABEL[s], counts('status'));
  chipSet($('#f-priority'), PRIORITIES, 'priorities', (p) => `P${p}`, counts('priority'));
  chipSet($('#f-type'), TYPES.filter((t) => counts('issue_type').has(t)), 'types', (t) => t, counts('issue_type'));
  const labels = [...new Set(state.model.issues.flatMap((i) => i.labels))].sort();
  fillSelect($('#f-label'), [['', 'Any label'], ...labels.map((l) => [l, l])], state.filters.label);
  const parents = [...new Set(state.model.issues.map((i) => i.parent).filter(Boolean))].map((id) => state.model.byId.get(id)).filter(Boolean).sort((a, b) => compareIds(a.id, b.id));
  fillSelect($('#f-parent'), [['', 'Any'], ...parents.map((p) => [p.id, `${p.id} ${p.title.slice(0, 40)}`])], state.filters.parent);
}

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

const visibleIssues = () => filterIssues(state.model.issues, state.filters);

// ---------- views ----------
function render() {
  const main = $('#main');
  state.nav = [];
  if (state.editing === 'main') state.editing = 0;
  if (cy && state.view !== 'graph') { cy.destroy(); cy = null; }
  const views = { board: renderBoard, list: renderList, graph: renderGraph, epics: renderEpics, insights: renderInsights, memories: renderMemories };
  main.replaceChildren(...[views[state.view]()].flat(Infinity).filter(Boolean));
  if (state.view === 'graph') drawGraph();
  highlightSelected();
  focusPending();
  updateFreshness();
}

function viewHead(title, ...extra) {
  return h('div', { class: 'view-head' }, h('h1', {}, title), ...extra);
}

function card(issue) {
  const ready = isReady(issue, state.model.byId);
  const blocked = isBlocked(issue, state.model.byId);
  return h('article', {
    class: 'card', draggable: 'true', dataset: { id: issue.id }, tabindex: '0', 'aria-label': `${issue.id} ${issue.title}`,
    onClick: () => openIssue(issue.id),
    onKeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openIssue(issue.id); },
    onDragstart: (e) => { e.dataTransfer.setData('text/plain', JSON.stringify({ id: issue.id, updatedAt: issue.updated_at })); e.dataTransfer.effectAllowed = 'move'; },
  },
  h('div', { class: 'card-meta' }, idEl(issue.id), prioEl(issue.priority), h('span', { class: 'tag' }, issue.issue_type),
    ready ? h('span', { class: 'flag-ready' }, 'ready') : null, blocked && issue.status !== 'blocked' ? h('span', { class: 'flag-blocked' }, 'blocked') : null),
  h('div', { class: 'card-title' }, issue.title),
  issue.labels.length ? h('div', { class: 'card-meta' }, issue.labels.slice(0, 4).map((l) => h('span', { class: 'tag' }, l))) : null);
}

function renderBoard() {
  const issues = visibleIssues();
  const rare = new Set(['pinned', 'hooked']);
  const statuses = state.filters.statuses.length ? STATUSES.filter((s) => state.filters.statuses.includes(s))
    : STATUSES.filter((s) => !rare.has(s) || issues.some((i) => i.status === s));
  state.nav = [];
  const columns = statuses.map((status) => {
    let list = issues.filter((i) => i.status === status);
    list = status === 'closed'
      ? list.sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)))
      : list.sort((a, b) => byPriorityThenId(a, b) || String(b.updated_at).localeCompare(String(a.updated_at)));
    const shown = status === 'closed' ? list.slice(0, CLOSED_CAP) : list;
    state.nav.push(...shown.map((i) => i.id));
    const col = h('section', { class: 'column', 'aria-label': STATUS_LABEL[status], dataset: { status } },
      h('div', { class: 'column-head' }, statusEl(status), h('span', { class: 'muted small' }, list.length)),
      h('div', { class: 'cards' }, shown.map(card)),
      list.length > shown.length ? h('p', { class: 'more muted' }, `${list.length - shown.length} more closed: use List`) : null);
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      try {
        const { id, updatedAt } = JSON.parse(e.dataTransfer.getData('text/plain'));
        setStatus(id, status, updatedAt);
      } catch { /* not one of our cards */ }
    });
    return col;
  });
  return [viewHead('Board', h('span', { class: 'muted small' }, `${issues.length} issues · drag a card to change its status`)), h('div', { class: 'board' }, columns)];
}

const SORTS = {
  id: (a, b) => compareIds(a.id, b.id),
  title: (a, b) => a.title.localeCompare(b.title),
  status: (a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status),
  priority: byPriorityThenId,
  type: (a, b) => String(a.issue_type).localeCompare(String(b.issue_type)),
  updated: (a, b) => String(a.updated_at).localeCompare(String(b.updated_at)),
  parent: (a, b) => String(a.parent ?? '').localeCompare(String(b.parent ?? ''), 'en', { numeric: true }),
};

function renderList() {
  const issues = visibleIssues().sort((a, b) => SORTS[state.sort.key](a, b) * state.sort.dir);
  state.nav = issues.map((i) => i.id);
  for (const id of state.bulk) if (!state.model.byId.has(id)) state.bulk.delete(id);
  const head = (key, label) => h('th', { 'aria-sort': state.sort.key === key ? (state.sort.dir > 0 ? 'ascending' : 'descending') : null },
    h('button', { type: 'button', onClick: () => { state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 }; render(); } },
      label, state.sort.key === key ? (state.sort.dir > 0 ? ' ↑' : ' ↓') : ''));
  const all = h('input', { type: 'checkbox', 'aria-label': 'Select all shown', checked: issues.length > 0 && issues.every((i) => state.bulk.has(i.id)),
    onChange: (e) => { for (const i of issues) e.target.checked ? state.bulk.add(i.id) : state.bulk.delete(i.id); render(); } });
  const rows = issues.map((i) => h('tr', { dataset: { id: i.id }, tabindex: '0', onClick: (e) => { if (e.target.type !== 'checkbox') openIssue(i.id); },
    onKeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openIssue(i.id); } },
    h('td', {}, h('input', { type: 'checkbox', 'aria-label': `Select ${i.id}`, checked: state.bulk.has(i.id),
      onChange: (e) => { e.target.checked ? state.bulk.add(i.id) : state.bulk.delete(i.id); render(); } })),
    h('td', {}, idEl(i.id)), h('td', {}, i.title), h('td', {}, statusEl(i.status)), h('td', {}, prioEl(i.priority)),
    h('td', {}, h('span', { class: 'tag' }, i.issue_type)), h('td', { class: 'muted small', title: i.updated_at }, ago(i.updated_at)),
    h('td', {}, i.parent ? idEl(i.parent) : '')));
  const bulk = state.bulk.size ? h('div', { class: 'bulk' },
    h('b', {}, `${state.bulk.size} selected`),
    h('label', {}, 'Set status ', h('select', { onChange: (e) => bulkSet('status', e.target.value) }, h('option', { value: '' }, '…'), STATUSES.map((s) => h('option', { value: s }, STATUS_LABEL[s])))),
    h('label', {}, 'Set priority ', h('select', { onChange: (e) => bulkSet('priority', e.target.value) }, h('option', { value: '' }, '…'), PRIORITIES.map((p) => h('option', { value: p }, `P${p}`)))),
    h('button', { type: 'button', class: 'btn ghost small', onClick: () => { state.bulk.clear(); render(); } }, 'Clear selection')) : null;
  return [viewHead('List', h('span', { class: 'muted small' }, `${issues.length} issues`)), bulk,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, all), head('id', 'Id'), head('title', 'Title'), head('status', 'Status'), head('priority', 'Pri'), head('type', 'Type'), head('updated', 'Updated'), head('parent', 'Parent'))),
      h('tbody', {}, rows)))];
}

async function bulkSet(field, raw) {
  if (raw === '') return;
  const ids = [...state.bulk];
  let reason = null;
  if (field === 'status' && raw === 'closed') {
    const out = await modal({ title: `Close ${ids.length} issues`, fields: [{ name: 'reason', label: 'Reason (used for every one)', type: 'textarea', required: true }], submit: 'Close them' });
    if (!out) return render();
    reason = out.reason;
  }
  const body = reason ? { ids, close: true, reason } : { ids, patch: { [field]: field === 'priority' ? Number(raw) : raw } };
  const ok = await mutate(api('POST', '/api/bulk', body).catch(async (error) => {
    if (!reason || !/--force/.test(error.message)) throw error;
    const again = await modal({ title: 'bd refused some of these', text: `${error.message} The others are closed. Close the refused ones anyway?`, submit: 'Close anyway', danger: true });
    if (!again) throw Object.assign(new Error('The refused issues were left open.'), { quiet: true });
    return api('POST', '/api/bulk', { ...body, force: true });
  }), `Updated ${ids.length} issues`);
  if (ok) state.bulk.clear();
  render();
}

function renderGraph() {
  const g = state.graph;
  const check = (key, label) => h('label', {}, h('input', { type: 'checkbox', checked: g[key], onChange: (e) => { g[key] = e.target.checked; render(); } }), label);
  return [viewHead('Dependency graph', h('span', { class: 'muted small', id: 'graph-count' })),
    h('div', { class: 'graph-tools' },
      check('parents', 'Parent links'), check('closed', 'Closed issues'), check('connectedOnly', 'Only linked issues'),
      h('label', {}, 'Focus ', h('input', { class: 'inline-input', list: 'all-ids', value: g.focus ?? '', placeholder: 'issue id',
        onChange: (e) => { g.focus = e.target.value.trim() || null; location.hash = g.focus ? `#/graph/${encodeURIComponent(g.focus)}` : '#/graph'; } })),
      h('label', {}, 'Depth ', h('input', { type: 'number', min: 1, max: 6, value: g.depth, onChange: (e) => { g.depth = Math.max(1, Math.min(6, Number(e.target.value) || 2)); render(); } })),
      g.focus ? h('button', { type: 'button', class: 'btn ghost small', onClick: () => { g.focus = null; location.hash = '#/graph'; } }, 'Clear focus') : null,
      h('button', { type: 'button', class: 'btn ghost small', onClick: () => cy?.fit(undefined, 30) }, 'Fit')),
    idList(),
    h('div', { id: 'graph', role: 'img', 'aria-label': 'Dependency graph; use the List view for the same issues as text' }),
    h('div', { class: 'legend' },
      h('span', {}, h('i'), 'blocks (arrow points to the issue that waits)'),
      h('span', {}, h('i', { class: 'dashed' }), 'parent → child'),
      h('span', {}, 'ring: ', h('b', { class: 'flag-ready' }, 'green = ready'), ' / ', h('b', { class: 'flag-blocked' }, 'red = blocked')))];
}

function idList() {
  return h('datalist', { id: 'all-ids' }, state.model.issues.map((i) => h('option', { value: i.id }, i.title.slice(0, 60))));
}

function drawGraph() {
  const el = $('#graph');
  if (!window.cytoscape) {
    el.replaceChildren(h('p', { class: 'empty', style: 'padding:16px' }, 'The graph library did not load (public/vendor/cytoscape.min.js). Reload the page; if it persists, check the server output.'));
    return;
  }
  if (window.cytoscapeDagre && !drawGraph.registered) { window.cytoscape.use(window.cytoscapeDagre); drawGraph.registered = true; }
  const g = state.graph;
  const filtered = { issues: visibleIssues(), byId: state.model.byId };
  const focus = g.focus && state.model.byId.has(g.focus) ? g.focus : null;
  let { nodes, edges } = buildGraph(focus ? state.model : filtered, { includeParents: g.parents, includeClosed: g.closed, focus, depth: g.depth });
  if (g.connectedOnly && !focus) {
    const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
    nodes = nodes.filter((n) => linked.has(n.id));
  }
  $('#graph-count').textContent = `${nodes.length} issues · ${edges.length} links`;
  if (!nodes.length) {
    el.replaceChildren(h('p', { class: 'empty', style: 'padding:16px' }, 'No linked issues match. Turn on parent links or closed issues, or clear the filters.'));
    return;
  }
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const statusColour = { open: v('--s-open'), in_progress: v('--s-progress'), blocked: v('--s-blocked'), deferred: v('--s-deferred'), closed: v('--s-closed') };
  const short = (t) => (t.length > 42 ? `${t.slice(0, 40)}…` : t);
  cy = window.cytoscape({
    container: el,
    elements: [
      ...nodes.map((n) => ({ data: { id: n.id, label: `${n.id}\n${short(n.title)}`, colour: statusColour[n.status] ?? v('--muted'), ring: n.ready ? v('--ready') : n.blocked ? v('--s-blocked') : v('--line-strong'), focus: n.id === focus ? 1 : 0 } })),
      ...edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, kind: e.kind } })),
    ],
    style: [
      { selector: 'node', style: { shape: 'round-rectangle', width: 230, height: 44, label: 'data(label)', 'text-wrap': 'wrap', 'text-valign': 'center', 'text-halign': 'center', 'font-family': 'IBM Plex Mono, monospace', 'font-size': 10, color: v('--fg'), 'background-color': v('--panel'), 'border-width': 3, 'border-color': 'data(ring)', 'text-max-width': '214px' } },
      { selector: 'node', style: { 'underlay-color': 'data(colour)', 'underlay-opacity': 0.18, 'underlay-padding': 0, 'underlay-shape': 'round-rectangle' } },
      { selector: 'node[focus = 1]', style: { 'border-width': 5, 'border-color': v('--focus') } },
      { selector: 'edge', style: { width: 1.6, 'curve-style': 'bezier', 'line-color': v('--muted'), 'target-arrow-color': v('--muted'), 'target-arrow-shape': 'triangle' } },
      { selector: 'edge[kind = "parent"]', style: { 'line-style': 'dashed', opacity: 0.5, 'target-arrow-shape': 'none' } },
      { selector: ':selected', style: { 'border-color': v('--focus') } },
    ],
    layout: window.cytoscapeDagre ? { name: 'dagre', rankDir: 'LR', nodeSep: 18, rankSep: 70, padding: 20 } : { name: 'breadthfirst', directed: true, padding: 20 },
  });
  cy.on('tap', 'node', (e) => openIssue(e.target.id()));
}

function miniList(items, cap = 12) {
  if (!items.length) return h('p', { class: 'empty' }, 'None.');
  return [h('ul', { class: 'mini-list' }, items.slice(0, cap).map((i) => h('li', {}, h('button', { type: 'button', class: 'mini-item', onClick: () => openIssue(i.id) }, idEl(i.id), prioEl(i.priority), h('span', { class: 't', title: i.title }, i.title))))),
    items.length > cap ? h('p', { class: 'muted small' }, `and ${items.length - cap} more`) : null];
}

function renderEpics() {
  const { issues } = state.model;
  const parents = new Set(issues.map((i) => i.parent).filter(Boolean));
  const epics = issues.filter((i) => i.issue_type === 'epic' || parents.has(i.id))
    .sort((a, b) => (a.status === 'closed') - (b.status === 'closed') || byPriorityThenId(a, b));
  const panels = epics.map((e) => {
    const p = epicProgress(e.id, issues);
    const kids = childrenOf(e.id, issues);
    const ready = kids.filter((k) => isReady(k, state.model.byId));
    const inProgress = kids.filter((k) => k.status === 'in_progress');
    return h('section', { class: 'panel' },
      h('h2', {}, idEl(e.id), h('span', {}, e.title)),
      h('div', { class: 'row small' }, statusEl(e.status), prioEl(e.priority), h('span', { class: 'muted' }, `${p.closed} of ${p.total} done · ${p.percent}%`)),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': p.percent, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `${e.id} progress` }, h('span', { style: `width:${p.percent}%` })),
      inProgress.length ? [h('b', { class: 'small' }, 'In progress'), miniList(inProgress, 5)] : null,
      h('b', { class: 'small' }, `Ready (${ready.length})`), miniList(ready, 6),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn ghost small', onClick: () => openIssue(e.id) }, 'Open'),
        h('button', { type: 'button', class: 'btn ghost small', onClick: () => { state.filters.parent = e.id; renderFilters(); location.hash = '#/list'; } }, 'Children in List'),
        h('button', { type: 'button', class: 'btn ghost small', onClick: () => { Object.assign(state.graph, { parents: true, focus: e.id, depth: 2 }); location.hash = `#/graph/${encodeURIComponent(e.id)}`; } }, 'Graph')));
  });
  state.nav = epics.map((e) => e.id);
  return [viewHead('Epics', h('span', { class: 'muted small' }, `${epics.length} with children`)), h('div', { class: 'grid' }, panels)];
}

function countBars(title, counts, label = (k) => k) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return h('section', { class: 'panel' }, h('h2', {}, title),
    h('div', { class: 'counts' }, entries.map(([k, n]) => h('div', { class: 'count-row' }, h('span', {}, label(k)), h('div', { class: 'bar' }, h('span', { style: `width:${(n / max) * 100}%` })), h('b', {}, n)))));
}

function renderInsights() {
  const i = insights(state.model, new Date(), { owner: OWNER });
  const listPanel = (title, items, note) => h('section', { class: 'panel' }, h('h2', {}, title, h('span', { class: 'muted small' }, items.length)), note ? h('p', { class: 'muted small' }, note) : null, miniList(items));
  return [viewHead('Insights', h('span', { class: 'muted small' }, `${state.model.issues.length} issues in all`)),
    h('div', { class: 'grid' },
      countBars('By status', i.byStatus, (k) => STATUS_LABEL[k] ?? k),
      countBars('By priority', i.byPriority, (k) => `P${k}`),
      countBars('By type', i.byType),
      listPanel('Ready to work on', i.ready, 'Open, nothing open blocking it, not deferred (bd ready).'),
      listPanel('Urgent: P0 and P1 open', i.urgent),
      OWNER ? listPanel(`Waiting on ${OWNER}`, i.forOwner, `Titles starting "${OWNER}:" or labelled ${OWNER.toLowerCase()}.`) : null,
      listPanel('Blocked', i.blocked),
      listPanel('Stale: no update in 14 days', i.stale),
      listPanel('Closed in the last 7 days', i.recentlyClosed))];
}

function renderMemories() {
  if (state.memories === null) {
    api('GET', '/api/memories').then((d) => { state.memories = d.memories; if (state.view === 'memories') render(); }).catch((e) => toast(e.message, 'error'));
    return [viewHead('Memories'), h('p', { class: 'muted' }, 'Loading…')];
  }
  const q = state.memoryQuery.toLowerCase();
  const list = state.memories.filter((m) => !q || m.key.includes(q) || m.text.toLowerCase().includes(q)).sort((a, b) => a.key.localeCompare(b.key));
  const search = h('input', { class: 'inline-input', type: 'search', placeholder: 'Search memories', value: state.memoryQuery, 'aria-label': 'Search memories', style: 'width:240px',
    onInput: (e) => { state.memoryQuery = e.target.value; render(); const box = $('#main input[type=search]'); box.focus(); box.setSelectionRange(box.value.length, box.value.length); } });
  return [viewHead('Memories', h('span', { class: 'muted small' }, `${state.memories.length} saved with bd remember`), search,
    h('button', { type: 'button', class: 'btn small', onClick: newMemory }, 'New memory')),
    list.length ? h('div', { class: 'memories' }, list.map(memoryCard)) : h('p', { class: 'empty' }, 'No memories match.')];
}

function memoryCard(m) {
  const text = h('div', { class: 'memory-text' }, m.text);
  linkifyIds(text);
  const box = h('article', { class: 'memory' },
    h('div', { class: 'memory-head' }, h('code', {}, m.key),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn ghost small', onClick: () => editMemory(m, box) }, 'Edit'),
        h('button', { type: 'button', class: 'btn danger small', onClick: () => deleteMemory(m) }, 'Delete'))),
    text);
  return box;
}

function editMemory(m, box) {
  state.editing = 'main';
  const area = h('textarea', { 'aria-label': `Memory ${m.key}` }, m.text);
  const done = () => { state.editing = 0; render(); };
  box.replaceChildren(h('div', { class: 'memory-head' }, h('code', {}, m.key)), area,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', onClick: async () => {
        try {
          await api('PUT', `/api/memories/${encodeURIComponent(m.key)}`, { text: area.value, expectedText: m.text });
          m.text = area.value;
          toast(`Saved ${m.key}`);
        } catch (e) {
          toast(e.message, 'error');
          if (e.status !== 409) return;
          state.memories = null; // reload the newer text instead of overwriting it
        }
        done();
      } }, 'Save'),
      h('button', { type: 'button', class: 'btn ghost small', onClick: done }, 'Cancel')));
  area.focus();
}

async function deleteMemory(m) {
  const ok = await modal({ title: `Delete memory ${m.key}?`, text: 'bd forget removes it for every session. This cannot be undone here.', submit: 'Delete', danger: true });
  if (!ok) return;
  try { await api('DELETE', `/api/memories/${encodeURIComponent(m.key)}`); toast(`Deleted ${m.key}`); state.memories = null; render(); } catch (e) { toast(e.message, 'error'); }
}

async function newMemory() {
  const out = await modal({ title: 'New memory', fields: [
    { name: 'key', label: 'Key (lowercase, dashes)', required: true, placeholder: 'release-checklist' },
    { name: 'text', label: 'What to remember', type: 'textarea', required: true },
  ], submit: 'Save memory' });
  if (!out) return;
  try { await api('PUT', `/api/memories/${encodeURIComponent(out.key.trim())}`, { text: out.text, create: true }); toast(`Saved ${out.key}`); state.memories = null; render(); } catch (e) { toast(e.message, 'error'); }
}

// ---------- drawer ----------
function renderDrawer() {
  const drawer = $('#drawer');
  const id = state.open;
  if (!id) return closeDrawer({ push: false });
  const issue = state.detail?.id === id ? { ...state.model.byId.get(id), ...state.detail } : state.model.byId.get(id);
  drawer.hidden = false;
  if (!issue) {
    drawer.replaceChildren(h('div', { class: 'drawer-body' }, h('p', { class: 'empty' }, `No issue ${id}.`), h('button', { type: 'button', class: 'btn ghost', onClick: () => closeDrawer() }, 'Close')));
    return;
  }
  if (state.editing === 'drawer') state.editing = 0;
  const titleHadFocus = document.activeElement?.classList.contains('drawer-title') && drawer.contains(document.activeElement);
  if (state.detail?.id === id) state.drawerUpdatedAt = issue.updated_at;
  else if (!state.drawerUpdatedAt) state.drawerUpdatedAt = issue.updated_at;
  const tab = (name, label) => h('button', { type: 'button', role: 'tab', id: `tab-${name}`, 'aria-controls': 'drawer-panel', 'aria-selected': String(state.tab === name), tabindex: state.tab === name ? '0' : '-1',
    onClick: () => { state.tab = name; renderDrawer(); },
    onKeydown: (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { state.tab = state.tab === 'details' ? 'chat' : 'details'; renderDrawer(); drawer.querySelector('[role=tab][aria-selected=true]')?.focus(); } } }, label);
  const head = h('div', { class: 'drawer-head' },
    h('div', { class: 'drawer-top' }, idEl(issue.id),
      h('button', { type: 'button', class: 'linkish small', onClick: () => navigator.clipboard?.writeText(issue.id).then(() => toast('Id copied'), () => {}) }, 'Copy id'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn ghost small', onClick: () => { Object.assign(state.graph, { focus: issue.id }); location.hash = `#/graph/${encodeURIComponent(issue.id)}`; } }, 'Show in graph'),
      h('button', { type: 'button', class: 'btn ghost small', 'aria-label': 'Close panel', onClick: () => closeDrawer() }, '✕')),
    titleBlock(issue),
    h('div', { class: 'tabs', role: 'tablist' }, tab('details', 'Details'), tab('chat', 'Ask AI')));
  const panel = state.tab === 'chat' ? chatPanel(issue) : detailsPanel(issue);
  panel.id = 'drawer-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `tab-${state.tab}`);
  drawer.replaceChildren(head, panel);
  // Keep focus on the title through the re-render that follows loading the details.
  if (state.focusDrawer || titleHadFocus) { state.focusDrawer = false; head.querySelector('.drawer-title')?.focus(); }
}

function titleBlock(issue) {
  const title = h('h2', { class: 'drawer-title' }, issue.title);
  const startEdit = () => {
    state.editing = 'drawer';
    const input = h('input', { value: issue.title, 'aria-label': 'Title', class: 'title-input' });
    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      state.editing = 0;
      const next = input.value.trim();
      if (save && next && next !== issue.title) await patchIssue(issue.id, { title: next });
      else renderDrawer();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    title.replaceWith(input);
    input.focus();
    input.select();
  };
  title.addEventListener('dblclick', startEdit);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); startEdit(); } });
  title.tabIndex = 0;
  title.title = 'Double-click (or Enter) to edit';
  return title;
}

function detailsPanel(issue) {
  const { byId, issues } = state.model;
  const statusSelect = h('select', { 'aria-label': 'Status', onChange: (e) => setStatus(issue.id, e.target.value) }, STATUSES.map((s) => h('option', { value: s, selected: s === issue.status }, STATUS_LABEL[s])));
  const prioSelect = h('select', { 'aria-label': 'Priority', onChange: (e) => patchIssue(issue.id, { priority: Number(e.target.value) }) }, PRIORITIES.map((p) => h('option', { value: p, selected: p === issue.priority }, `P${p}`)));
  const assignee = h('input', { value: issue.assignee ?? '', placeholder: 'nobody', 'aria-label': 'Assignee',
    onChange: (e) => patchIssue(issue.id, { assignee: e.target.value.trim() }) });
  const blockers = blockersOf(issue, byId);
  const allBlockers = (issue.dependencies ?? []).filter((d) => (d.type ?? d.dependency_type) === 'blocks').map((d) => byId.get(d.depends_on_id ?? d.id)).filter(Boolean);
  const dependents = issues.filter((i) => i.dependencies.some((d) => d.type === 'blocks' && d.depends_on_id === issue.id));
  const children = childrenOf(issue.id, issues);
  const ready = isReady(issue, byId);

  return h('div', { class: 'drawer-body' },
    h('div', { class: 'fields' },
      h('span', {}, 'Status'), h('div', { class: 'row' }, statusSelect, ready ? h('span', { class: 'flag-ready' }, 'ready') : null, blockers.length ? h('span', { class: 'flag-blocked' }, `blocked by ${blockers.length}`) : null),
      h('span', {}, 'Priority'), prioSelect,
      h('span', {}, 'Type'), h('span', {}, h('span', { class: 'tag' }, issue.issue_type)),
      h('span', {}, 'Assignee'), assignee,
      h('span', {}, 'Labels'), labelsEditor(issue),
      h('span', {}, 'Parent'), issue.parent ? h('a', { href: issueHref(issue.parent) }, idEl(issue.parent), ' ', byId.get(issue.parent)?.title ?? '') : h('span', { class: 'muted' }, 'none'),
      h('span', {}, 'Created'), h('span', { class: 'small' }, shortDate(issue.created_at), issue.created_by ? ` by ${issue.created_by}` : ''),
      h('span', {}, 'Updated'), h('span', { class: 'small', title: issue.updated_at }, ago(issue.updated_at)),
      issue.closed_at ? [h('span', {}, 'Closed'), h('span', { class: 'small' }, shortDate(issue.closed_at))] : null,
      issue.defer_until ? [h('span', {}, 'Deferred until'), h('span', { class: 'small' }, shortDate(issue.defer_until))] : null),
    issue.close_reason ? textSection(issue, 'close_reason', 'Close reason', { editable: false }) : null,
    textSection(issue, 'description', 'Description'),
    textSection(issue, 'design', 'Design'),
    textSection(issue, 'acceptance', 'Acceptance', { source: 'acceptance_criteria' }),
    textSection(issue, 'notes', 'Notes', { append: true }),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h3', {}, `Blocked by (${allBlockers.length})`)),
      depList(allBlockers, (b) => removeDep(issue.id, b.id)),
      h('div', { class: 'section-head' }, h('h3', {}, `Blocks (${dependents.length})`)),
      depList(dependents, (d) => removeDep(d.id, issue.id)),
      addDependency(issue)),
    children.length ? h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h3', {}, `Children (${children.filter((c) => c.status === 'closed').length}/${children.length} done)`)), depList(children)) : null,
    commentsSection(issue),
    h('div', { class: 'row' },
      issue.status === 'closed'
        ? h('button', { type: 'button', class: 'btn ghost', onClick: () => setStatus(issue.id, 'open') }, 'Reopen')
        : h('button', { type: 'button', class: 'btn ghost', onClick: () => setStatus(issue.id, 'closed') }, 'Close issue'),
      h('button', { type: 'button', class: 'btn ghost', onClick: () => { state.tab = 'chat'; renderDrawer(); } }, 'Ask AI about this')));
}

function labelsEditor(issue) {
  const input = h('input', { class: 'inline-input', placeholder: 'add label', 'aria-label': 'Add label',
    onKeydown: (e) => { if (e.key === 'Enter' && e.target.value.trim()) patchIssue(issue.id, { addLabels: [e.target.value.trim()] }); } });
  return h('div', { class: 'labels' }, (issue.labels ?? []).map((l) => h('span', { class: 'tag' }, l,
    h('button', { type: 'button', 'aria-label': `Remove label ${l}`, onClick: () => patchIssue(issue.id, { removeLabels: [l] }) }, '×'))), input);
}

function textSection(issue, field, label, { editable = true, source = field, append = false } = {}) {
  const value = issue[source] ?? '';
  const section = h('section', { class: 'section' });
  const view = () => {
    section.replaceChildren(
      h('div', { class: 'section-head' }, h('h3', {}, label),
        append && value ? h('button', { type: 'button', class: 'linkish small', onClick: () => edit(true) }, 'Append') : null,
        editable ? h('button', { type: 'button', class: 'linkish small', onClick: () => edit(false) }, value ? 'Edit' : 'Add') : null),
      md(value, { empty: editable ? `No ${label.toLowerCase()} yet.` : '' }));
  };
  const edit = (appending) => {
    state.editing = 'drawer';
    const area = h('textarea', { 'aria-label': appending ? `Append to ${label}` : label }, appending ? '' : value);
    const stop = () => { state.editing = 0; view(); };
    section.replaceChildren(h('div', { class: 'section-head' }, h('h3', {}, appending ? `Append to ${label.toLowerCase()}` : `Edit ${label.toLowerCase()}`)), area,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small', onClick: async () => {
          state.editing = 0;
          if (appending) { if (area.value.trim()) await patchIssue(issue.id, { appendNotes: area.value.trim() }, 'Note added'); else view(); }
          else await patchIssue(issue.id, { [field]: area.value });
        } }, 'Save'),
        h('button', { type: 'button', class: 'btn ghost small', onClick: stop }, 'Cancel'),
        h('span', { class: 'muted small' }, 'Markdown · Ctrl/⌘+Enter saves')));
    area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) section.querySelector('.btn').click(); if (e.key === 'Escape') { e.stopPropagation(); stop(); } });
    area.focus();
  };
  view();
  return section;
}

function depList(items, onRemove) {
  if (!items.length) return h('p', { class: 'empty' }, 'None.');
  return h('ul', { class: 'dep-list' }, items.map((i) => h('li', {}, idEl(i.id), statusEl(i.status),
    h('button', { type: 'button', class: 't linkish-plain', title: i.title, onClick: () => openIssue(i.id) }, i.title),
    onRemove ? h('button', { type: 'button', class: 'x', 'aria-label': `Remove link to ${i.id}`, onClick: () => onRemove(i) }, '×') : h('span'))));
}

function addDependency(issue) {
  const kind = h('select', { 'aria-label': 'Link kind', class: 'inline-input', style: 'width:auto' }, h('option', { value: 'blockedBy' }, 'is blocked by'), h('option', { value: 'blocks' }, 'blocks'));
  const other = h('input', { class: 'inline-input', list: 'all-ids', placeholder: 'issue id', 'aria-label': 'Other issue id' });
  return h('div', { class: 'row small' }, idList(), 'This issue ', kind, other,
    h('button', { type: 'button', class: 'btn ghost small', onClick: () => {
      const id = other.value.trim();
      if (!state.model.byId.has(id)) return toast(`No issue ${id}`, 'error');
      const body = kind.value === 'blockedBy' ? { issue: issue.id, dependsOn: id } : { issue: id, dependsOn: issue.id };
      mutate(api('POST', '/api/deps', body), 'Link added');
    } }, 'Add link'));
}

async function removeDep(issueId, dependsOn) {
  const ok = await modal({ title: 'Remove this link?', text: `${issueId} will no longer depend on ${dependsOn}.`, submit: 'Remove', danger: true });
  if (ok) mutate(api('DELETE', '/api/deps', { issue: issueId, dependsOn }), 'Link removed');
}

function commentsSection(issue) {
  const comments = state.detail?.id === issue.id ? state.detail.comments ?? [] : null;
  const area = h('textarea', { 'aria-label': 'New comment', style: 'min-height:70px', placeholder: 'Add a comment (Markdown)' });
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', {}, `Comments${comments ? ` (${comments.length})` : ''}`)),
    comments === null ? h('p', { class: 'muted small' }, 'Loading…')
      : comments.length ? comments.map((c) => h('div', { class: 'comment' }, h('div', { class: 'muted small' }, c.author ?? '', ' · ', shortDate(c.created_at)), md(c.text)))
        : h('p', { class: 'empty' }, 'No comments.'),
    area,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', onClick: () => area.value.trim() && mutate(api('POST', `/api/issues/${encodeURIComponent(issue.id)}/comments`, { text: area.value }), 'Comment added') }, 'Add comment')));
}

// ---------- AI chat ----------
// Chats live in memory per issue (and in localStorage, keyed by the folder the server runs in), so a stream keeps
// writing to its chat while the drawer re-renders, switches tabs or shows another issue.
const chats = new Map();
const chatKey = (id) => `beads-ui:chat:${state.chatStatus?.cwdKey ?? 'default'}:${id}`;
function getChat(id) {
  if (!chats.has(id)) {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(chatKey(id))); } catch { /* blocked storage: start empty */ }
    chats.set(id, { sessionId: stored?.sessionId ?? null, messages: Array.isArray(stored?.messages) ? stored.messages : [], streaming: null });
  }
  return chats.get(id);
}
function saveChat(id) {
  const chat = chats.get(id);
  try { localStorage.setItem(chatKey(id), JSON.stringify({ sessionId: chat.sessionId, messages: chat.messages })); } catch { /* storage full or blocked */ }
}
/** Repaints the chat if it is the one on screen. */
function repaintChat(id) {
  if (state.open === id && state.tab === 'chat') state.paintChat?.();
}

const AUTH_HELP = 'Your Claude Code sign-in has expired or is missing. Run `claude` in a terminal and sign in (/login), then try again. Or restart this tool with ANTHROPIC_API_KEY set.';

async function sendChat(issue, message) {
  const chat = getChat(issue.id);
  if (chat.streaming) return;
  chat.messages.push({ role: 'user', content: message });
  const reply = { role: 'assistant', content: '', live: true };
  chat.messages.push(reply);
  const controller = new AbortController();
  chat.streaming = controller;
  repaintChat(issue.id);
  const history = chat.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m !== reply && m.content).slice(0, -1).map(({ role, content }) => ({ role, content }));
  let frame = 0;
  const repaint = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; repaintChat(issue.id); }); };
  const insertBefore = (m) => { const at = chat.messages.indexOf(reply); chat.messages.splice(at >= 0 ? at : chat.messages.length, 0, m); };
  try {
    const res = await fetch(`/api/chat/${encodeURIComponent(issue.id)}`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-beads-token': TOKEN },
      body: JSON.stringify({ message, sessionId: chat.sessionId, history }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `Chat failed (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const raw of parts) {
        if (!raw.startsWith('data:')) continue;
        const event = JSON.parse(raw.slice(5));
        if (event.type === 'text') reply.content += event.delta;
        else if (event.type === 'tool') insertBefore({ role: 'tool', content: `${event.name} ${event.detail}`.trim() });
        else if (event.type === 'done') { if (event.sessionId) chat.sessionId = event.sessionId; }
        else if (event.type === 'error') chat.messages.push({ role: 'error', content: event.auth ? `${AUTH_HELP}\n\n(${event.message})` : event.message });
        repaint();
      }
    }
  } catch (error) {
    chat.messages.push(error.name === 'AbortError' ? { role: 'tool', content: 'Stopped.' } : { role: 'error', content: error.message });
  } finally {
    chat.streaming = null;
    delete reply.live;
    if (!reply.content) { const at = chat.messages.indexOf(reply); if (at >= 0) chat.messages.splice(at, 1); }
    saveChat(issue.id);
    repaintChat(issue.id);
  }
}

function chatPanel(issue) {
  const chat = getChat(issue.id);
  const log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
  const area = h('textarea', { 'aria-label': `Ask about ${issue.id}`, placeholder: `Ask about ${issue.id}. Enter sends, Shift+Enter adds a line.` });
  const sendBtn = h('button', { type: 'submit', class: 'btn small' }, 'Send');
  const stopBtn = h('button', { type: 'button', class: 'btn ghost small', onClick: () => chat.streaming?.abort() }, 'Stop');
  const newBtn = h('button', { type: 'button', class: 'btn ghost small', onClick: () => { chat.sessionId = null; chat.messages = []; saveChat(issue.id); paint(); } }, 'New chat');
  const status = h('span', { class: 'muted small' });
  const panel = h('div', { class: 'drawer-body chat' });

  function paint() {
    const busy = Boolean(chat.streaming);
    stopBtn.hidden = !busy;
    sendBtn.disabled = busy || state.chatStatus?.mode === 'none';
    newBtn.disabled = busy;
    log.replaceChildren(...(chat.messages.length ? chat.messages.map((m) => messageEl(issue, m)) : [h('p', { class: 'empty' }, `Ask anything about ${issue.id}: what is left, how to approach it, whether it is still needed. The AI can read the repository and beads but cannot change anything; suggested changes appear as a card you can apply.`)]));
    log.lastElementChild?.scrollIntoView({ block: 'end' });
  }
  state.paintChat = paint;

  const form = h('form', { class: 'chat-form', onSubmit: (e) => { e.preventDefault(); const text = area.value.trim(); if (text) { area.value = ''; sendChat(issue, text); } } },
    area, h('div', { class: 'row' }, sendBtn, stopBtn, newBtn, status));
  area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });

  const showMode = () => {
    const s = state.chatStatus;
    if (!s) return;
    if (s.mode === 'none') {
      area.disabled = true;
      status.textContent = 'No AI available: install Claude Code (the claude command) or start the tool with ANTHROPIC_API_KEY set.';
    } else if (s.mode === 'cli' && !s.loggedIn) {
      status.textContent = 'Claude Code is not signed in: run claude in a terminal and /login, or start this tool with ANTHROPIC_API_KEY set.';
    } else status.textContent = s.mode === 'api' ? `Anthropic API · ${s.model}` : 'Claude Code · read-only (Read, Grep, Glob)';
    paint();
  };
  if (state.chatStatus === null) {
    state.chatStatus = undefined;
    api('GET', '/api/chat/status').then((s) => {
      state.chatStatus = s;
      chats.clear(); // re-read the stored chats under this folder's key
      if (state.open === issue.id && state.tab === 'chat') renderDrawer();
    }).catch(() => { state.chatStatus = null; });
  }
  panel.append(log, form);
  showMode();
  paint();
  setTimeout(() => area.focus(), 0);
  return panel;
}

const stripSuggestion = (text) => text.replace(/```beads-update[\s\S]*?(```|$)/g, '').trim();

function messageEl(issue, m) {
  if (m.role === 'user') return h('div', { class: 'msg user' }, m.content);
  if (m.role === 'tool') return h('div', { class: 'msg tool' }, `› ${m.content}`);
  if (m.role === 'error') return h('div', { class: 'msg error', role: 'alert' }, m.content);
  const box = h('div', { class: `msg assistant${m.live ? ' typing' : ''}` }, md(stripSuggestion(m.content), { empty: '' }));
  if (m.live) return box;
  const suggestion = extractUpdateBlock(m.content);
  if (!suggestion) return box;
  const current = state.model.byId.get(issue.id) ?? issue;
  const changed = Object.entries(suggestion).filter(([k, v]) => k === 'appendNotes' || String(current[k] ?? '') !== String(v));
  if (!changed.length && !m.applied) return box;
  const row = ([k, v]) => {
    if (k === 'priority') return [h('dt', {}, 'Priority'), h('dd', {}, `P${current.priority} → P${v}`)];
    if (k === 'status') return [h('dt', {}, 'Status'), h('dd', {}, `${STATUS_LABEL[current.status]} → ${STATUS_LABEL[v]}`)];
    if (k === 'appendNotes') return [h('dt', {}, 'Add to notes'), h('dd', {}, v)];
    return [h('dt', {}, k), h('dd', {}, h('div', { class: 'muted' }, 'Now: ', current[k] || '(empty)'), h('div', {}, 'New: ', v))];
  };
  const cardEl = h('div', { class: 'suggestion' },
    h('h4', {}, m.applied ? `Applied to ${issue.id}` : `Suggested change to ${issue.id}`),
    m.applied ? null : h('dl', {}, changed.map(row)),
    m.applied ? null : h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', onClick: async (e) => {
        e.currentTarget.disabled = true;
        const patch = Object.fromEntries(changed);
        const closing = patch.status === 'closed';
        delete patch.status;
        if (!closing && suggestion.status && suggestion.status !== current.status) patch.status = suggestion.status;
        let ok = true;
        if (Object.keys(patch).length) ok = Boolean(await patchIssue(issue.id, patch, 'Applied the suggestion'));
        if (ok && closing) ok = Boolean(await setStatus(issue.id, 'closed'));
        if (ok) { m.applied = true; saveChat(issue.id); }
        repaintChat(issue.id);
      } }, 'Apply'),
      h('span', { class: 'muted small' }, 'Nothing changes until you apply. Notes are added, never replaced.')));
  return h('div', { class: 'chat-log' }, box, cardEl);
}

function focusPending() {
  if (!state.pendingFocusId) return;
  const el = document.querySelector(`#main [data-id="${CSS.escape(state.pendingFocusId)}"]`);
  state.pendingFocusId = null;
  el?.focus();
}

// ---------- keyboard, freshness, wiring ----------
function highlightSelected() {
  for (const el of document.querySelectorAll('.card.selected, tr.selected')) el.classList.remove('selected');
  if (!state.selected) return;
  const sel = CSS.escape(state.selected);
  const el = document.querySelector(`.card[data-id="${sel}"], tr[data-id="${sel}"]`);
  el?.classList.add('selected');
  return el;
}

let pendingG = false;
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select, [contenteditable]') || $('#modal').open;
  if (e.key === 'Escape' && !$('#modal').open) {
    if (typing) { e.target.blur(); return; }
    if (state.open) { closeDrawer(); return; }
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (pendingG) {
    pendingG = false;
    const target = { b: 'board', l: 'list', g: 'graph', e: 'epics', i: 'insights', m: 'memories' }[e.key];
    if (target) { e.preventDefault(); location.hash = `#/${target}`; }
    return;
  }
  if (e.key === 'g') { pendingG = true; setTimeout(() => { pendingG = false; }, 1200); return; }
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); return; }
  if (e.key === 'r') { loadIssues(); return; }
  if (e.key === 'n') { newIssue(); return; }
  if (e.key === 'j' || e.key === 'k') {
    if (!state.nav.length) return;
    const at = state.nav.indexOf(state.selected);
    state.selected = state.nav[Math.max(0, Math.min(state.nav.length - 1, at < 0 ? 0 : at + (e.key === 'j' ? 1 : -1)))];
    highlightSelected()?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (e.key === 'Enter' && state.selected && state.nav.includes(state.selected) && !e.target.closest('button, a, [tabindex], #drawer')) openIssue(state.selected);
});

function updateFreshness() {
  $('#freshness').textContent = state.fetchedAt ? `Updated ${ago(state.fetchedAt)}` : 'Loading…';
}

async function newIssue() {
  const epics = state.model.issues.filter((i) => i.issue_type === 'epic' && i.status !== 'closed').sort((a, b) => compareIds(a.id, b.id));
  const out = await modal({ title: 'New issue', fields: [
    { name: 'title', label: 'Title', required: true },
    { name: 'type', label: 'Type', type: 'select', value: 'task', options: TYPES.map((t) => [t, t]) },
    { name: 'priority', label: 'Priority', type: 'select', value: '2', options: PRIORITIES.map((p) => [p, `P${p}`]) },
    { name: 'parent', label: 'Parent epic (optional)', type: 'select', value: state.filters.parent, options: [['', 'None'], ...epics.map((e) => [e.id, `${e.id} ${e.title.slice(0, 50)}`])] },
    { name: 'description', label: 'Description (Markdown)', type: 'textarea' },
  ], submit: 'Create' });
  if (!out) return;
  const created = await mutate(api('POST', '/api/issues', { ...out, priority: Number(out.priority), parent: out.parent || undefined }), null);
  if (created?.id) { toast(`Created ${created.id}`); openIssue(created.id); }
}

$('#search').addEventListener('input', (e) => { state.filters.query = e.target.value; render(); });
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = state.nav[0]; if (first) openIssue(first); } });
$('#f-label').addEventListener('change', (e) => { state.filters.label = e.target.value; render(); });
$('#f-parent').addEventListener('change', (e) => { state.filters.parent = e.target.value; render(); });
$('#clear-filters').addEventListener('click', () => { state.filters = { query: '', statuses: [], priorities: [], types: [], label: '', parent: '' }; $('#search').value = ''; renderFilters(); render(); });
$('#refresh').addEventListener('click', () => { if (state.view === 'memories' && state.editing !== 'main') state.memories = null; loadIssues().then(() => toast('Reloaded from bd')); });
$('#new-issue').addEventListener('click', newIssue);
$('#sync').addEventListener('click', async () => {
  try { const r = await api('POST', '/api/sync'); toast(r.ok ? 'bd dolt push done' : `Sync: ${r.output}`, r.ok ? '' : 'error'); } catch (e) { toast(e.message, 'error'); }
});
api('GET', '/api/sync').then((s) => { $('#sync').hidden = !s.hasRemote; }).catch(() => { $('#sync').hidden = true; });
window.addEventListener('hashchange', route);
window.addEventListener('focus', () => { if (state.view === 'memories' && state.editing !== 'main') state.memories = null; loadIssues({ quiet: true }); });
setInterval(() => { if (!document.hidden && state.editing !== 'main') loadIssues({ quiet: true }); }, REFRESH_MS);
setInterval(updateFreshness, 1000);

$('#main').replaceChildren(h('p', { class: 'muted' }, 'Loading issues from bd…'));
await loadIssues();
route();
