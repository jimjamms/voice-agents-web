import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import worker from '../worker/src/index.mjs';
import { notesTurn, includeSelectedCities } from '../worker/src/notes.mjs';
const source = readFileSync(new URL('../docs/notes.js', import.meta.url), 'utf8');
function setup(storage = new Map(), fetcher = async () => Response.json({ notes: 'Destination: Kyoto' })) {
  const element = () => ({ value: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {}, select() {} });
  const textarea = element(), status = element(), clear = element(), copy = element(); let speaker = 'Jenny'; const notifications = [];
  const context = { window: {}, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, fetch: fetcher, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  const notes = context.window.createTripNotes({ textarea, status, clear, copy, speaker: () => speaker, base: () => 'https://worker.test', code: () => 'test-code', onChange: value => notifications.push(value) });
  return { notes, textarea, status, clear, context, notifications, name(value) { speaker = value; notes.refresh(); }, edit(value) { textarea.value = value; notes.saved[notes.key()] = value; notes.bump(notes.key()); notes.persist(notes.key()); } };
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
test('a newer saved version during extraction is preserved', async () => {
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
  globalThis.fetch = async (_url, init) => { prompt = JSON.parse(init.body); return Response.json({ choices: [{ message: { content: JSON.stringify({ notes: 'Destination: Kyoto\nIdeas / unconfirmed: Osaka day trip', choices: { countries: [], cities: ['Kyoto'], activities: [] } }) } }] }); };
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

test('notepad is read-only and has no user edit listener', () => {
  const app = setup();
  assert.equal(app.textarea.readOnly, true);
  assert.equal(app.textarea.listeners.input, undefined);
});

test('confirmed choices persist and publish completion with the notepad', async () => {
  const storage = new Map(); const choices = { countries: ['Japan'], cities: ['Tokyo', 'Kyoto', 'Osaka'], activities: ['Food tour', 'Hiking'], budget: { amount: 2500, currency: 'USD', scope: 'per person' }, itinerary: { timing: '9 days', route: 'Tokyo, Kyoto, Osaka', transport: 'Train', lodging: 'Hotels near stations', costs: 'Estimated total 2250 USD' }, finalized: true };
  const app = setup(storage, async () => Response.json({ notes: 'Confirmed Japan itinerary', choices }));
  await app.notes.update(turn);
  assert.equal(app.notifications.at(-1).ready, true); assert.equal(app.notifications.at(-1).updated, true);
  const reload = setup(storage); assert.equal(reload.notifications.at(-1).ready, true);
  assert.equal(reload.notifications.at(-1).updated, false);
  app.clear.listeners.click(); assert.equal(app.notifications.at(-1).ready, false);
});

test('legacy saved destination choices do not unlock the form without budget and final approval', () => {
  const storage = new Map([['sage-astra-trip-notes-v1', JSON.stringify({ jenny: { notes: 'Japan trip', choices: { countries: ['Japan'], cities: ['Tokyo', 'Kyoto', 'Osaka'], activities: ['Hiking'] } } })]]);
  const app = setup(storage);
  assert.equal(app.notifications.at(-1).ready, false);
  assert.equal(app.notifications.at(-1).choices.budget, null);
});

test('every selected city is visible even if the model omits the route from its checklist', () => {
  const notes = includeSelectedCities('Need to know\n- Budget: 2500 USD\nTo do\n[ ] Book trains', ['Tokyo', 'Kyoto', 'Osaka']);
  for (const city of ['Tokyo', 'Kyoto', 'Osaka']) assert.ok(notes.includes(city));
  assert.match(notes, /Book trains/);
  const complete = 'Need to know\n- Cities: Tokyo, Kyoto, Osaka';
  assert.equal(includeSelectedCities(complete, ['Tokyo', 'Kyoto', 'Osaka']), complete);
});
test('notepad receives the preceding proposal to resolve a short city acceptance', async () => {
  const original = globalThis.fetch; let supplied;
  globalThis.fetch = async (_url, init) => {
    const messages = JSON.parse(init.body).messages; supplied = JSON.parse(messages[1].content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ notes: 'To do\n[ ] Choose travel dates', choices: { countries: ['Japan'], cities: ['Tokyo', 'Kyoto', 'Osaka'], activities: [] } }) } }] });
  };
  try {
    const priorConversation = [{ role: 'assistant', content: 'Shall we choose Tokyo, Kyoto, and Osaka?', agent: 'sage' }];
    const request = new Request('https://worker.test/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'sage', userText: 'Yes, those three.', reply: 'Great.', notes: '', priorConversation }) });
    const response = await notesTurn(request, { OPENAI_API_KEY: 'test' }, {}); const data = await response.json();
    assert.equal(response.status, 200); assert.deepEqual(supplied.priorConversation, priorConversation);
    assert.equal(data.choices.cities.length, 3); assert.match(data.notes, /Tokyo → Kyoto → Osaka/); assert.equal(data.ready, false);
  } finally { globalThis.fetch = original; }
});
test('browser sends the preceding conversation along with the current turn', async () => {
  let sent;
  const app = setup(new Map(), async (_url, init) => { sent = JSON.parse(init.body); return Response.json({ notes: 'Need to know\n- Cities: Kyoto' }); });
  await app.notes.update({ ...turn, priorConversation: [{ role: 'assistant', content: 'Would you like Kyoto?', agent: 'sage' }] });
  assert.equal(sent.priorConversation[0].content, 'Would you like Kyoto?');
});
