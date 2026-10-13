import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
function page(fetcher) {
  const elements = new Map(), calls = [];
  const node = () => ({ value: '', textContent: '', children: [], listeners: {}, attrs: {}, disabled: false, hidden: false,
    addEventListener(type, handler) { this.listeners[type] = handler; }, setAttribute(key, value) { this.attrs[key] = value; },
    append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, focus() { this.focused = true; } });
  const get = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  vm.runInNewContext(readFileSync(new URL('../docs/host-logs.js', import.meta.url), 'utf8'), {
    document: { querySelector: selector => get(selector.slice(1)), createElement: node }, URL,
    window: { VOICE_DEMO_CONFIG: { apiBaseUrl: 'https://worker.test' } },
    fetch: async (url, init) => { calls.push({ url: String(url), init }); return fetcher(url, init); },
  });
  return { get, calls, async load() { get('user-list-form').listeners.submit({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve)); },
    async more() { get('users-more').listeners.click(); await new Promise(resolve => setImmediate(resolve)); } };
}
test('host loads users with private authorization, clears the key, and selecting an ID does not delete anything', async () => {
  const app = page(async () => Response.json({ users: [{ nameId: 'jenny', chatTurns: 4, lastSaved: '2026-10-13T20:00:00Z', tripStatus: 'Saved trip' }], total: 1, nextCursor: null }));
  assert.equal(app.calls.length, 0); app.get('host-key').value = 'host-only';
  await app.load();
  assert.equal(app.calls[0].init.headers.authorization, 'Bearer host-only'); assert.equal(app.get('host-key').value, '');
  assert.equal(app.get('users-rows').children[0].children[0].textContent, 'jenny');
  app.get('delete-confirm').value = 'older-id';
  app.get('users-rows').children[0].children[4].children[0].listeners.click();
  assert.equal(app.get('log-speaker').value, 'jenny'); assert.equal(app.get('delete-name').value, 'jenny');
  assert.equal(app.get('delete-confirm').value, ''); assert.equal(app.calls.length, 1);
});
test('user pagination retains its search and appends distinct rows without retaining the host key', async () => {
  let count = 0;
  const app = page(async () => Response.json(count++ === 0 ? { users: [{ nameId: 'jenny', chatTurns: 1, tripStatus: 'Saved trip' }], total: 2, nextCursor: 'jenny' } : { users: [{ nameId: 'jenny_trip', chatTurns: 0, tripStatus: 'New trip' }], total: 2, nextCursor: null }));
  app.get('host-key').value = 'host-only'; app.get('user-search').value = 'Jenny'; await app.load();
  assert.equal(app.get('users-more').hidden, false); app.get('host-key').value = 'host-only'; await app.more();
  const url = new URL(app.calls[1].url); assert.equal(url.searchParams.get('cursor'), 'jenny'); assert.equal(url.searchParams.get('q'), 'Jenny');
  assert.equal(app.get('users-rows').children.length, 2); assert.equal(app.get('users-more').hidden, true); assert.equal(app.get('host-key').value, '');
});
test('user-list errors clear the host key and IDs containing markup remain literal text', async () => {
  const bad = page(async () => Response.json({ error: 'Invalid host key.' }, { status: 401 }));
  bad.get('host-key').value = 'wrong'; await bad.load();
  assert.equal(bad.get('host-key').value, ''); assert.match(bad.get('users-status').textContent, /Invalid host key/);
  const safe = page(async () => Response.json({ users: [{ nameId: '<img src=x onerror=alert(1)>', chatTurns: 0, tripStatus: 'New trip' }], total: 1, nextCursor: null }));
  safe.get('host-key').value = 'host-only'; await safe.load();
  const cell = safe.get('users-rows').children[0].children[0]; assert.equal(cell.textContent, '<img src=x onerror=alert(1)>'); assert.equal(cell.children.length, 0);
});
