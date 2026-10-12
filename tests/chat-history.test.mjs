import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
function setup() {
  const elements = new Map(); let options; let counter = 0;
  function element(id) {
    return { id, children: [], listeners: {}, value: id === 'memory-mode' ? 'shared' : '', disabled: false,
      dataset: {}, scrollTop: 0, scrollHeight: 100, classList: { toggle() {}, remove() {} },
      setAttribute() {}, addEventListener(type, handler) { this.listeners[type] = handler; },
      append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
      querySelector() { return null; }, pause() {}, focus() {},
    };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const cards = ['sage', 'astra'].map(name => { const item = get(name); item.dataset.agent = name; item.querySelector = () => element('indicator'); return item; });
  const document = { querySelector: selector => get(selector.slice(1)), querySelectorAll: () => cards,
    createElement: () => element('new'), addEventListener() {} };
  const transport = { isLocked: () => false, stop() {}, busy: false, active: false };
  vm.runInNewContext(source, { document, crypto: { randomUUID: () => `session-${++counter}` }, clearTimeout,
    window: { createPipelineTransport(value) { options = value; return transport; }, addEventListener() {},
      AgentMemory: { forget() { return true; } } } });
  return { get, options, click: id => get(id).listeners.click(), change: (id, value) => { get(id).value = value; get(id).listeners.change(); } };
}
test('switching agents restores messages and model history without duplicating entries', () => {
  const app = setup();
  app.options.onMessage('user', 'Hello Sage', { name: 'Jenny', score: 1 });
  app.options.onMessage('assistant', 'Hi Jenny');
  app.click('astra'); assert.equal(app.options.history().length, 0);
  app.options.onMessage('user', 'Hello Astra'); app.options.onMessage('assistant', 'Welcome');
  app.click('sage');
  assert.deepEqual(Array.from(app.options.history(), entry => entry.content), ['Hello Sage', 'Hi Jenny']);
  assert.equal(app.get('messages').children[0].children[0].textContent, 'Jenny');
  assert.equal(app.get('messages').children[1].children[0].textContent, 'Sage');
  app.click('astra'); assert.equal(app.options.history()[1].content, 'Welcome');
  app.click('sage'); assert.equal(app.options.history().length, 2);
});
test('New conversation clears only the selected agent chat', () => {
  const app = setup(); app.options.onMessage('user', 'Sage question');
  app.click('astra'); app.options.onMessage('user', 'Astra question'); app.click('reset');
  assert.equal(app.options.history().length, 0);
  app.click('sage'); assert.equal(app.options.history()[0].content, 'Sage question');
  app.click('astra'); assert.equal(app.options.history().length, 0);
});
test('speaker and memory mode changes keep conversation histories separate', () => {
  const app = setup(); app.change('speaker-name', 'Jenny'); app.options.onMessage('user', 'Jenny shared chat');
  app.change('speaker-name', 'Other'); assert.equal(app.options.history().length, 0);
  app.change('speaker-name', 'JENNY'); assert.equal(app.options.history()[0].content, 'Jenny shared chat');
  app.click('isolated-memory'); assert.equal(app.options.history().length, 0);
  app.options.onMessage('user', 'Jenny separate chat'); app.click('shared-memory');
  assert.equal(app.options.history()[0].content, 'Jenny shared chat');
});
