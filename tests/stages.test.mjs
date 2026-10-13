import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
function setup() {
  const items = new Map(), emitted = []; let chosen = '';
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
  vm.runInNewContext(readFileSync(new URL('../docs/stages.js', import.meta.url), 'utf8'), { document, Event, window: { dispatchEvent(event) { emitted.push(event.type); } } });
  return { get, sage, astra, document, emitted, chosen: () => chosen, submit() { form.listeners.submit({ preventDefault() {} }); } };
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
