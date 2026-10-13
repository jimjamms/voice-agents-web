import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import worker from '../worker/src/index.mjs';
import { notesTurn } from '../worker/src/notes.mjs';
const source = readFileSync(new URL('../docs/notes.js', import.meta.url), 'utf8');
function setup(storage = new Map(), fetcher = async () => Response.json({ notes: 'Destination: Kyoto' })) {
  const element = () => ({ value: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {}, select() {} });
  const textarea = element(), status = element(), clear = element(), copy = element(); let speaker = 'Jenny';
  const context = { window: {}, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, fetch: fetcher, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  const notes = context.window.createTripNotes({ textarea, status, clear, copy, speaker: () => speaker, base: () => 'https://worker.test', code: () => 'test-code' });
  return { notes, textarea, status, clear, context, name(value) { speaker = value; notes.refresh(); }, edit(value) { textarea.value = value; textarea.listeners.input(); } };
}
const turn = { agent: 'sage', speaker: 'Jenny', transcript: 'I chose Kyoto.', reply: 'A four-day trip could work.' };
test('notepad persists by speaker and combines both agent turns in order', async () => {
  const storage = new Map(); const inputs = [];
  const app = setup(storage, async (_url, init) => { const data = JSON.parse(init.body); inputs.push(data); return Response.json({ notes: data.notes ? data.notes + '\nDuration: four days' : 'Destination: Kyoto' }); });
  await Promise.all([app.notes.update(turn), app.notes.update({ ...turn, agent: 'astra' })]);
  assert.equal(inputs[1].notes, 'Destination: Kyoto');
  assert.equal(app.textarea.value, 'Destination: Kyoto\nDuration: four days');
  const reload = setup(storage); assert.equal(reload.textarea.value, app.textarea.value);
  reload.name('Other'); assert.equal(reload.textarea.value, '');
  reload.name('JENNY'); assert.equal(reload.textarea.value, app.textarea.value);
});
test('a manual edit during extraction is preserved', async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const app = setup(new Map(), () => { started(); return new Promise(resolve => { release = resolve; }); });
  const update = app.notes.update(turn); await ready;
  app.edit('My own itinerary'); release(Response.json({ notes: 'Generated itinerary' })); await update;
  assert.equal(app.textarea.value, 'My own itinerary'); assert.match(app.status.textContent, /edits were kept/);
});
test('clearing notes invalidates running and queued updates', async () => {
  let release, started; let calls = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const app = setup(new Map(), () => { calls++; started(); return new Promise(resolve => { release = resolve; }); });
  const first = app.notes.update(turn); const second = app.notes.update(turn); await ready;
  app.clear.listeners.click(); release(Response.json({ notes: 'Old itinerary' })); await Promise.all([first, second]);
  assert.equal(app.textarea.value, ''); assert.equal(calls, 1);
});
test('late notes for another speaker do not replace the visible notepad', async () => {
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  const app = setup(new Map(), () => { started(); return new Promise(resolve => { release = resolve; }); });
  const update = app.notes.update(turn); await ready; app.name('Other'); app.edit('Other trip');
  release(Response.json({ notes: 'Kyoto trip' })); await update;
  assert.equal(app.textarea.value, 'Other trip'); app.name('Jenny'); assert.equal(app.textarea.value, 'Kyoto trip');
});
test('failed notes extraction preserves saved notes', async () => {
  const app = setup(new Map(), async () => Response.json({ error: 'Unavailable' }, { status: 502 }));
  app.edit('Existing itinerary'); await app.notes.update(turn);
  assert.equal(app.textarea.value, 'Existing itinerary'); assert.match(app.status.textContent, /Could not auto-update/);
});
test('notes route requires the existing access code', async () => {
  const env = { PUBLIC_ORIGIN: 'https://example.github.io', DEMO_ACCESS_CODE: 'correct', OPENAI_API_KEY: 'secret', DEMO_RATE_LIMITER: { async limit() { return { success: true }; } } };
  const response = await worker.fetch(new Request('https://worker.test/notes', { method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, 'content-type': 'application/json', 'x-demo-code': 'wrong' }, body: '{}' }), env);
  assert.equal(response.status, 401);
});
test('notes extraction distinguishes suggestions from confirmed plans and validates output', async () => {
  const original = globalThis.fetch; let prompt;
  globalThis.fetch = async (_url, init) => { prompt = JSON.parse(init.body); return Response.json({ choices: [{ message: { content: JSON.stringify({ notes: 'Destination: Kyoto\nIdeas / unconfirmed: Osaka day trip' }) } }] }); };
  try {
    const request = () => new Request('https://worker.test/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'sage', userText: 'Kyoto is my choice.', reply: 'You could visit Osaka too.', notes: '' }) });
    const response = await notesTurn(request(), { OPENAI_API_KEY: 'secret', PIPELINE_CHAT_MODEL: 'configured-model' }, {});
    assert.equal(response.status, 200); assert.match((await response.json()).notes, /unconfirmed/);
    assert.equal(prompt.model, 'configured-model'); assert.match(prompt.messages[0].content, /Never turn a suggested destination/);
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'Not valid JSON' } }] });
    assert.equal((await notesTurn(request(), { OPENAI_API_KEY: 'secret' }, {})).status, 502);
  } finally { globalThis.fetch = original; }
});
test('notes endpoint rejects oversized notes', async () => {
  const response = await notesTurn(new Request('https://worker.test/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'sage', userText: 'Hi', reply: 'Hello', notes: 'x'.repeat(6001) }) }), {}, {});
  assert.equal(response.status, 400);
});
