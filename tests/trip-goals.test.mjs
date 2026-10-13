import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChoices, tripReady } from '../worker/src/trip-goals.mjs';
import { notesTurn } from '../worker/src/notes.mjs';
const complete = { countries: ['Japan'], cities: ['Tokyo', 'Kyoto', 'Osaka'], activities: ['Food tour'] };
test('completion requires one country, three distinct cities and one or two activities', () => {
  assert.equal(tripReady(normalizeChoices(complete)), true);
  assert.equal(tripReady(normalizeChoices({ ...complete, countries: [] })), false);
  assert.equal(tripReady(normalizeChoices({ ...complete, cities: ['Tokyo', 'Kyoto'] })), false);
  assert.equal(tripReady(normalizeChoices({ ...complete, activities: [] })), false);
  assert.equal(tripReady(normalizeChoices({ ...complete, activities: ['Food tour', 'Hiking'] })), true);
  assert.equal(tripReady(normalizeChoices({ ...complete, activities: ['Food tour', 'Hiking', 'Museums'] })), false);
});
test('duplicate cities and malformed choices cannot satisfy the target', () => {
  const result = normalizeChoices({ ...complete, cities: ['Tokyo', 'tokyo', ' Tokyo '] });
  assert.equal(result.cities.length, 1); assert.equal(tripReady(result), false);
  assert.throws(() => normalizeChoices({ ...complete, activities: [42] }));
});
test('notes service returns server-checked progress and instructs extraction to exclude suggestions', async () => {
  const original = globalThis.fetch; let prompt;
  globalThis.fetch = async (_url, init) => { prompt = JSON.parse(init.body); return Response.json({ choices: [{ message: { content: JSON.stringify({ notes: 'Japan: Tokyo, Kyoto, Osaka. Food tour.', choices: complete }) } }] }); };
  try {
    const request = new Request('https://worker.test/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'sage', userText: 'I choose Japan, Tokyo, Kyoto, Osaka, and a food tour.', reply: 'Great.', notes: '' }) });
    const response = await notesTurn(request, { OPENAI_API_KEY: 'test' }, {}); const data = await response.json();
    assert.equal(response.status, 200); assert.equal(data.ready, true);
    assert.match(prompt.messages[0].content, /Agent suggestions do not count/);
    assert.match(prompt.messages[0].content, /Preserve all selected activities even if more than two/);
  } finally { globalThis.fetch = original; }
});
