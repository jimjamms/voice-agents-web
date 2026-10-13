import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
function setup(config = {}) {
  const items = new Map(), emitted = [], handlers = {}; let chosen = '';
  const get = id => { if (!items.has(id)) items.set(id, { hidden: false, value: '', checked: false, dataset: {}, listeners: {}, attrs: {}, classList: { toggle() {} }, addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; }, setCustomValidity(value) { this.error = value; }, dispatchEvent(event) { this.listeners[event.type]?.(event); }, focus() { this.focused = true; } }); return items.get(id); };
  const sage = get('sage-radio'), astra = get('astra-radio'); sage.value = 'sage'; sage.checked = true; astra.value = 'astra';
  const form = get('trip-setup'); form.querySelectorAll = () => [sage, astra];
  form.reportValidity = () => !get('speaker-name').error && !get('access-code').error;
  const document = { body: { dataset: { stage: 'setup' } }, querySelector(selector) {
    if (selector === '[data-agent].active') return { dataset: { agent: chosen || 'sage' } };
    if (selector.startsWith('[data-agent=')) return { click() { chosen = selector.includes('astra') ? 'astra' : 'sage'; } };
    return get(selector.slice(1));
  } };
  get('planning-stage').hidden = true;
  vm.runInNewContext(readFileSync(new URL('../docs/stages.js', import.meta.url), 'utf8'), { document, Event, URL, window: { VOICE_DEMO_CONFIG: config, addEventListener(type, fn) { handlers[type] = fn; }, dispatchEvent(event) { emitted.push(event.type); handlers[event.type]?.(event); } } });
  return { get, sage, astra, document, emitted, event(type, detail) { handlers[type]?.({ type, detail }); }, chosen: () => chosen, submit() { form.listeners.submit({ preventDefault() {} }); } };
}
test('setup requires name and demo code before revealing planning', () => {
  const page = setup(); page.get('speaker-name').value = '  '; page.get('access-code').value = 'demo'; page.submit();
  assert.equal(page.get('planning-stage').hidden, true); assert.equal(page.chosen(), '');
  page.get('speaker-name').value = 'Jenny'; page.get('access-code').value = ' '; page.submit();
  assert.equal(page.get('planning-stage').hidden, true);
});
test('setup opens the selected agent and focuses the planning heading', () => {
  const page = setup(); page.get('speaker-name').value = ' Jenny '; page.get('access-code').value = ' demo ';
  page.sage.checked = false; page.astra.checked = true; page.submit();
  assert.equal(page.chosen(), 'astra'); assert.equal(page.get('setup-stage').hidden, true);
  assert.equal(page.get('planning-stage').hidden, false); assert.equal(page.get('traveler-title').textContent, 'Jenny’s trip');
  assert.equal(page.get('traveler-title').focused, true); assert.equal(page.get('access-code').value, 'demo');
  assert.deepEqual(page.emitted, []);
});
test('Change setup requests voice shutdown and restores selected agent', () => {
  const page = setup(); page.get('speaker-name').value = 'Jenny'; page.get('access-code').value = 'demo';
  page.sage.checked = false; page.astra.checked = true; page.submit();
  page.get('change-setup').listeners.click();
  assert.deepEqual(page.emitted, ['trip-setup:open']); assert.equal(page.get('planning-stage').hidden, true);
  assert.equal(page.get('setup-stage').hidden, false); assert.equal(page.astra.checked, true);
  assert.equal(page.get('speaker-name').focused, true);
});

test('stage three requires completed choices and displays the completed notes', () => {
  const page = setup(); page.get('speaker-name').value = 'Jenny'; page.get('access-code').value = 'demo'; page.submit();
  page.event('trip-notes:updated', { key: 'jenny', notes: 'Japan: Tokyo, Kyoto', ready: false, choices: { countries: ['Japan'], cities: ['Tokyo', 'Kyoto'], activities: ['Hiking'] } });
  page.event('trip-goal:complete'); assert.equal(page.get('review-stage').hidden, true);
  page.event('trip-notes:updated', { key: 'jenny', notes: 'Japan: Tokyo, Kyoto, Osaka. Hiking.', ready: true, choices: { countries: ['Japan'], cities: ['Tokyo', 'Kyoto', 'Osaka'], activities: ['Hiking'], budget: { amount: 2500, currency: 'USD', scope: 'per person' }, itinerary: { timing: '9 days' }, finalized: true } });
  page.event('trip-goal:complete'); assert.equal(page.get('review-stage').hidden, false);
  assert.equal(page.get('planning-stage').hidden, true); assert.match(page.get('completed-notes').value, /Osaka/);
  assert.equal(page.get('google-form-link').hidden, true);
  page.get('back-to-planning').listeners.click(); assert.equal(page.get('planning-stage').hidden, false);
});
test('only configured Google Form URLs are shown', () => {
  assert.equal(setup({ googleFormUrl: 'https://example.com/' }).get('google-form-link').hidden, true);
  const page = setup({ googleFormUrl: 'https://docs.google.com/forms/d/e/test/viewform' });
  assert.equal(page.get('google-form-link').hidden, false); assert.match(page.get('google-form-link').href, /docs.google.com/);
});

test('budget and approval remain visible requirements and revisions return to planning', () => {
  const page = setup(); page.get('speaker-name').value = 'Jenny'; page.get('access-code').value = 'demo'; page.submit();
  const choices = { countries: ['Japan'], cities: ['Tokyo', 'Kyoto', 'Osaka'], activities: ['Hiking'], budget: null, finalized: false };
  page.event('trip-notes:updated', { key: 'jenny', notes: 'Trip', choices, ready: false });
  page.event('trip-goal:complete'); assert.equal(page.get('review-stage').hidden, true);
  assert.equal(page.get('budget-check').textContent, 'Budget pending');
  assert.match(page.get('trip-goal-hint').textContent, /spending limit/);
  const completed = { ...choices, budget: { amount: 2000, currency: 'USD', scope: 'whole trip' }, itinerary: { timing: '9 days' }, finalized: true };
  page.event('trip-notes:updated', { key: 'jenny', notes: 'Final trip', choices: completed, ready: true });
  page.event('trip-goal:complete'); assert.equal(page.get('review-stage').hidden, false);
  page.event('trip-notes:updated', { key: 'jenny', notes: 'Revised trip', choices: { ...completed, finalized: false }, ready: false });
  assert.equal(page.get('review-stage').hidden, true); assert.equal(page.get('planning-stage').hidden, false);
});

test('a deleted active name ID returns to setup and clears the completed notepad', () => {
  const page = setup(); page.get('speaker-name').value = 'Jenny'; page.get('access-code').value = 'demo'; page.submit();
  page.get('completed-notes').value = 'Old trip';
  page.event('trip-profile:deleted', { name: 'jenny', message: 'The host deleted this ID.' });
  assert.equal(page.document.body.dataset.stage, 'setup'); assert.equal(page.get('planning-stage').hidden, true);
  assert.equal(page.get('completed-notes').value, ''); assert.match(page.get('profile-login-status').textContent, /deleted/);
});

test('after returning from the form, agent replies never force another automatic redirect', () => {
  const page = setup(); page.get('speaker-name').value = 'Jenny'; page.get('access-code').value = 'demo'; page.submit();
  const choices = { countries: ['Japan'], cities: ['Tokyo', 'Kyoto', 'Osaka'], activities: ['Hiking'], budget: { amount: 2500, currency: 'USD', scope: 'per person' }, itinerary: { timing: '9 days' }, finalized: true };
  const update = (ready, notes) => page.event('trip-notes:updated', { key: 'jenny', notes, ready, choices });
  update(true, 'Complete trip'); page.event('trip-goal:complete');
  assert.equal(page.document.body.dataset.stage, 'review');
  page.get('back-to-planning').listeners.click();
  update(true, 'Trip with clarification'); page.event('trip-goal:complete');
  assert.equal(page.document.body.dataset.stage, 'planning');
  update(false, 'Revised trip awaiting approval'); update(true, 'Revised approved trip'); page.event('trip-goal:complete');
  assert.equal(page.document.body.dataset.stage, 'planning');
  assert.equal(page.get('continue-review').hidden, false);
  page.get('continue-review').listeners.click();
  assert.equal(page.document.body.dataset.stage, 'review');
  assert.equal(page.get('completed-notes').value, 'Revised approved trip');
});
