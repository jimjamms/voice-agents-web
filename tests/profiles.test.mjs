import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { profileRequest } from '../worker/src/profiles.mjs';
import { deleteUserData, saveLogs } from '../worker/src/logs.mjs';
import worker from '../worker/src/index.mjs';
const profile = { notes: 'Japan trip', choices: { countries: ['Japan'], cities: ['Tokyo'], activities: ['Hiking'] }, memories: { shared: [{ fact: 'Prefers trains', learned_by: 'Astra' }], sage: ['Likes hiking'], astra: ['Budget conscious'] } };
function database() {
  const db = new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../worker/migrations/0003_deleted_name_ids.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../worker/migrations/0002_trip_profiles.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../worker/migrations/0001_chat_logs.sql', import.meta.url), 'utf8'));
  return { db, async batch(statements) { db.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; } catch (error) { db.exec('ROLLBACK'); throw error; } }, prepare(sql) { return { bind(...params) { return {
    async first() { return db.prepare(sql).get(...params); },
    async run() { const result = db.prepare(sql).run(...params); return { meta: { changes: result.changes } }; },
  }; } }; } };
}
const post = body => new Request('https://worker.test/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
test('name ID loads across devices case-insensitively and separates profiles', async () => {
  const db = database(); const env = { LOG_DB: db };
  assert.equal((await profileRequest(post({ action: 'save', name: ' Jenny-trip-4827 ', version: 0, profile }), env, {})).status, 200);
  const data = await (await profileRequest(post({ action: 'load', name: 'JENNY-TRIP-4827' }), env, {})).json();
  assert.equal(data.profile.notes, profile.notes); assert.equal(data.profile.memories.shared[0].learned_by, 'Astra'); assert.equal(data.version, 1);
  assert.equal((await (await profileRequest(post({ action: 'load', name: 'someone-else' }), env, {})).json()).profile, null);
  db.db.close();
});
test('stale device saves and duplicate initial saves cannot overwrite newer trip data', async () => {
  const db = database(), env = { LOG_DB: db };
  const save = (version, notes) => profileRequest(post({ action: 'save', name: 'Jenny', version, profile: { ...profile, notes } }), env, {});
  assert.equal((await save(0, 'First')).status, 200); assert.equal((await save(0, 'Duplicate')).status, 409);
  assert.equal((await save(1, 'Newer')).status, 200); assert.equal((await save(1, 'Stale')).status, 409);
  assert.equal((await (await profileRequest(post({ action: 'load', name: 'Jenny' }), env, {})).json()).profile.notes, 'Newer');
  assert.equal((await save(2, '')).status, 200); db.db.close();
});
test('profile endpoint requires origin and demo code and rejects malformed memories', async () => {
  const db = database(), env = { LOG_DB: db, PUBLIC_ORIGIN: 'https://example.github.io', DEMO_ACCESS_CODE: 'demo', OPENAI_API_KEY: 'secret', DEMO_RATE_LIMITER: { async limit() { return { success: true }; } } };
  const req = (origin, code) => new Request('https://worker.test/profile', { method: 'POST', headers: { origin, 'x-demo-code': code, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'load', name: 'Jenny' }) });
  assert.equal((await worker.fetch(req(env.PUBLIC_ORIGIN, 'wrong'), env)).status, 401);
  assert.equal((await worker.fetch(req('https://wrong.test', 'demo'), env)).status, 403);
  assert.equal((await worker.fetch(req(env.PUBLIC_ORIGIN, 'demo'), env)).status, 200);
  assert.equal((await profileRequest(post({ action: 'save', name: 'Jenny', version: 0, profile: { ...profile, memories: { ...profile.memories, sage: [42] } } }), env, {})).status, 400);
  db.db.close();
});
function client(fetcher, local = profile) {
  const handlers = {}, status = {}; let applied;
  const window = { addEventListener(type, fn) { handlers[type] = fn; } };
  vm.runInNewContext(readFileSync(new URL('../docs/cloud.js', import.meta.url), 'utf8'), { window, fetch: fetcher, AbortController, setTimeout: () => 1, clearTimeout() {} });
  const cloud = window.createTripCloud({ base: () => 'https://worker.test', code: () => 'demo', status, snapshot: () => local, apply(name, value) { applied = { name, value }; } });
  return { cloud, window, status, applied: () => applied };
}
test('client restores cloud data and imports local notes only for a new ID', async () => {
  const calls = [];
  const app = client(async (_url, init) => { const body = JSON.parse(init.body); calls.push(body); return Response.json(body.action === 'load' ? { version: 3, profile: { ...profile, notes: 'Remote trip' } } : { version: body.version + 1 }); });
  await app.cloud.load('JENNY'); assert.equal(app.applied().value.notes, 'Remote trip'); assert.equal(calls.length, 1);
  app.window.onTripProfileChange('jenny'); await app.cloud.flush(); assert.equal(calls[1].version, 3);
  const fresh = client(async (_url, init) => { const body = JSON.parse(init.body); return Response.json(body.action === 'load' ? { version: 0, profile: null } : { version: 1 }); });
  await fresh.cloud.load('new-trip'); assert.match(fresh.status.textContent, /saved across devices/);
});
test('failed initial load cannot upload a stale local profile; conflicts stop silent overwrite', async () => {
  let calls = 0;
  const failed = client(async () => { calls++; return Response.json({ error: 'Unavailable' }, { status: 503 }); });
  await assert.rejects(failed.cloud.load('Jenny')); failed.window.onTripProfileChange('jenny'); await failed.cloud.flush(); assert.equal(calls, 1);
  const app = client(async (_url, init) => { const body = JSON.parse(init.body); return body.action === 'load' ? Response.json({ version: 1, profile }) : Response.json({ error: 'Changed on another device' }, { status: 409 }); });
  await app.cloud.load('Jenny'); app.window.onTripProfileChange('jenny'); await app.cloud.flush(); assert.match(app.status.textContent, /another device/);
});

test('host deletion requires the private key and explicit name confirmation', async () => {
  const db = database(), env = { LOG_DB: db, LOG_ADMIN_KEY: 'private-key', PUBLIC_ORIGIN: 'https://example.github.io' };
  const request = (key, body, origin = env.PUBLIC_ORIGIN) => new Request('https://worker.test/logs/delete', { method: 'POST', headers: { origin, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const body = { name: 'Jenny', confirm: 'Jenny', trip: true, logs: true };
  assert.equal((await worker.fetch(request('demo-code', body), env)).status, 401);
  assert.equal((await worker.fetch(request('private-key', body, 'https://wrong.test'), env)).status, 403);
  assert.equal((await worker.fetch(request('private-key', { ...body, confirm: 'Other' }), env)).status, 400);
  assert.equal((await worker.fetch(request('private-key', { ...body, trip: false, logs: false }), env)).status, 400);
  db.db.close();
});
test('host deletion removes only the requested name and selected data categories', async () => {
  const db = database(), env = { LOG_DB: db, LOG_ADMIN_KEY: 'private-key' };
  for (const name of ['jenny', 'jenny-other']) {
    await profileRequest(post({ action: 'save', name, version: 0, profile }), env, {});
    db.db.prepare('INSERT INTO chat_turns(turn_id,participant_id,session_id,speaker_lower,timestamp,payload) VALUES(?,?,?,?,?,?)').run(name, 'p', 's', name, '2026-10-13T00:00:00Z', '{}');
  }
  const remove = (trip, logs) => deleteUserData(new Request('https://worker.test/logs/delete', { method: 'POST', headers: { authorization: 'Bearer private-key', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'JENNY', confirm: 'JENNY', trip, logs }) }), env, {});
  const first = await (await remove(false, true)).json(); assert.equal(first.turnsDeleted, 1); assert.equal(first.profilesDeleted, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM trip_profiles').get().n, 2);
  const second = await (await remove(true, true)).json(); assert.equal(second.profilesDeleted, 1); assert.equal(second.turnsDeleted, 0);
  assert.equal(db.db.prepare('SELECT name_id FROM trip_profiles').get().name_id, 'jenny-other');
  assert.equal(db.db.prepare('SELECT speaker_lower FROM chat_turns').get().speaker_lower, 'jenny-other');
  db.db.close();
});

test('remote deletion blocks cached profile recreation and queued log uploads from open devices', async () => {
  const db = database(), env = { LOG_DB: db, LOG_ADMIN_KEY: 'private-key' };
  await profileRequest(post({ action: 'save', name: 'Jenny', version: 0, profile }), env, {});
  const deletion = new Request('https://worker.test/logs/delete', { method: 'POST', headers: { authorization: 'Bearer private-key', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Jenny', confirm: 'Jenny', trip: true, logs: true }) });
  assert.equal((await deleteUserData(deletion, env, {})).status, 200);
  assert.equal((await profileRequest(post({ action: 'load', name: 'JENNY' }), env, {})).status, 410);
  for (const version of [0, 1]) assert.equal((await profileRequest(post({ action: 'save', name: 'jenny', version, profile }), env, {})).status, 410);
  const turn = { turn_id: 'queued-turn', participant_id: 'browser-1', session_id: 'session-1', timestamp: '2026-10-13T05:00:00Z', agent: 'sage', engine: 'pipeline', memory_sharing_mode: 'shared', speaker: 'JENNY', user_text: 'Old queued message', agent_reply: 'Old reply', interrupted: false };
  const upload = turns => new Request('https://worker.test/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turns }) });
  const result = await (await saveLogs(upload([turn, { ...turn, turn_id: 'other-turn', speaker: 'Other' }]), env, {})).json();
  assert.deepEqual(result.discarded, ['queued-turn']);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM trip_profiles').get().n, 0);
  assert.equal(db.db.prepare('SELECT speaker_lower FROM chat_turns').get().speaker_lower, 'other');
  db.db.close();
});
