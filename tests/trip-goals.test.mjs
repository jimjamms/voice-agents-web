import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChoices, tripReady } from '../worker/src/trip-goals.mjs';
import { notesTurn } from '../worker/src/notes.mjs';
const complete = { countries: ['Japan'], cities: ['Tokyo', 'Kyoto', 'Osaka'], activities: ['Food tour'], cityActivities: { Tokyo: 'Food tour', Kyoto: 'Temple walk', Osaka: 'Market visit' }, budget: { amount: 2500, currency: 'USD', scope: 'per person' }, itinerary: { timing: '9 days', route: 'Tokyo 3 days, Kyoto 3 days, Osaka 3 days', transport: 'Trains between cities', lodging: 'Midrange hotels near stations', costs: 'Estimated flights 900, hotels 700, trains 250, food and activities 400; total 2250 USD' }, finalized: true };
test('completion requires destination choices, confirmed budget and finalized logistics', () => {
  assert.equal(tripReady(normalizeChoices(complete)), true);
  assert.equal(tripReady(normalizeChoices({ ...complete, countries: [] })), false);
  assert.equal(tripReady(normalizeChoices({ ...complete, cities: ['Tokyo'] })), false);
  assert.equal(tripReady(normalizeChoices({ ...complete, cityActivities: {} })), false);
  assert.equal(tripReady(normalizeChoices({ ...complete, activities: ['Food tour', 'Hiking'] })), true);
  assert.equal(tripReady(normalizeChoices({ ...complete, activities: ['Food tour', 'Hiking', 'Museums'] })), true);
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
    const request = new Request('https://worker.test/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'astra', userText: 'I approve the complete itinerary and the 2500 USD per-person budget.', reply: 'Great.', notes: '' }) });
    const response = await notesTurn(request, { OPENAI_API_KEY: 'test' }, {}); const data = await response.json();
    assert.equal(response.status, 200); assert.equal(data.ready, true);
    assert.match(prompt.messages[0].content, /Agent suggestions do not count/);
    assert.match(prompt.messages[0].content, /one user-confirmed activity assigned to EACH chosen city/);
  } finally { globalThis.fetch = original; }
});

test('destinations alone, unapproved plans and incomplete logistics cannot unlock the form', () => {
  for (const change of [{ budget: null }, { finalized: false }, { itinerary: null },
    { itinerary: { ...complete.itinerary, lodging: '' } }, { itinerary: { ...complete.itinerary, costs: '' } }]) {
    assert.equal(tripReady(normalizeChoices({ ...complete, ...change })), false);
  }
  assert.equal(tripReady(normalizeChoices({ countries: complete.countries, cities: complete.cities, activities: complete.activities })), false);
  assert.throws(() => normalizeChoices({ ...complete, budget: { amount: -1, currency: 'USD', scope: 'per person' } }));
  assert.throws(() => normalizeChoices({ ...complete, budget: { amount: 2500, currency: '', scope: 'per person' } }));
});
test('new final approval requires Astra, and changes invalidate existing approval', async () => {
  const original = globalThis.fetch;
  let generated = complete;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ notes: 'Complete itinerary', choices: generated }) } }] });
  const request = (agent, choices) => new Request('https://worker.test/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent, userText: 'Update the trip', reply: 'Updated.', notes: 'Existing trip', choices }) });
  try {
    assert.equal((await (await notesTurn(request('sage', { ...complete, finalized: false }), {}, {})).json()).ready, false);
    assert.equal((await (await notesTurn(request('sage', complete), {}, {})).json()).ready, true);
    generated = { ...complete, budget: { ...complete.budget, amount: 3000 } };
    const revised = await (await notesTurn(request('astra', complete), {}, {})).json();
    assert.equal(revised.ready, false); assert.equal(revised.choices.finalized, false);
  } finally { globalThis.fetch = original; }
});


test('two cities require their own confirmed activities, with no guessed assignment from legacy lists', () => {
  const two = { ...complete, cities: ['Tokyo', 'Kyoto'], cityActivities: { Tokyo: 'Food tour', Kyoto: 'Temple walk' } };
  assert.equal(tripReady(normalizeChoices(two)), true);
  assert.equal(tripReady(normalizeChoices({ ...two, cityActivities: { Tokyo: 'Food tour' } })), false);
  assert.equal(tripReady(normalizeChoices({ ...two, cityActivities: undefined })), false);
  assert.equal(tripReady(normalizeChoices({ ...two, cityActivities: { Tokyo: 'Food tour', Osaka: 'Market' } })), false);
  assert.throws(() => normalizeChoices({ ...two, cityActivities: { Kyoto: '' } }));
  assert.deepEqual(normalizeChoices({ ...two, cityActivities: { tokyo: 'Food tour', KYOTO: 'Temple walk' } }).cityActivities, two.cityActivities);
});


test('first practical review belongs to Astra, survives a second city, and resets on revised budget', async () => {
  const original = globalThis.fetch;
  let generated = { ...complete, firstCityReviewed: 'Tokyo' };
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ notes: 'Need to know\n- Tokyo: Food tour', choices: generated }) } }] });
  const send = async (agent, choices) => {
    const request = new Request('https://worker.test/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent, userText: '9 days, 2500 USD per person.', reply: 'That first stop fits. Talk to Sage to choose your next city.', notes: '', choices }) });
    return (await (await notesTurn(request, {}, {})).json()).choices;
  };
  try {
    const first = { ...complete, cities: ['Tokyo'], firstCityReviewed: null };
    assert.equal((await send('sage', first)).firstCityReviewed, null);
    assert.equal((await send('astra', first)).firstCityReviewed, 'Tokyo');
    assert.equal((await send('sage', { ...first, firstCityReviewed: 'Tokyo' })).firstCityReviewed, 'Tokyo');
    generated = { ...generated, budget: { ...generated.budget, amount: 3000 } };
    assert.equal((await send('sage', { ...first, firstCityReviewed: 'Tokyo' })).firstCityReviewed, null);
  } finally { globalThis.fetch = original; }
});
