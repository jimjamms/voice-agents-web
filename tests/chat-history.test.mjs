import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
function setup(frameTools = {}) {
  const elements = new Map(); let options, noteOptions, cloudOptions; let counter = 0; const emitted = [];
  function element(id) {
    return { id, children: [], listeners: {}, value: id === 'memory-mode' ? 'shared' : '', disabled: false,
      dataset: {}, scrollTop: 0, scrollHeight: 100, classList: { toggle() {}, remove() {} },
      click() { this.listeners.click?.(); },
      setAttribute() {}, addEventListener(type, handler) { this.listeners[type] = handler; },
      append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
      querySelector() { return null; }, pause() {}, focus() {},
    };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const cards = ['sage', 'astra'].map(name => { const item = get(name); item.dataset.agent = name; item.querySelector = () => element('indicator'); return item; });
  const document = { body: { dataset: { stage: 'planning' } }, querySelector: selector => get(selector.slice(1)), querySelectorAll: () => cards,
    createElement: () => element('new'), addEventListener() {} };
  const transport = { isLocked: () => false, stop() {}, busy: false, active: false };
  const testWindow = { createTripCloud(value) { cloudOptions = value; return { async load() {} }; }, dispatchEvent(event) { emitted.push(event.type); }, createTripNotes(value) { noteOptions = value; return { update() {}, refresh() {} }; }, createPipelineTransport(value) { options = value; return transport; }, addEventListener() {}, AgentMemory: { forget() { return true; } } };
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'window.handleTestEvent = handleEvent; })();'), { document, Event, CustomEvent, crypto: { randomUUID: () => `session-${++counter}` }, clearTimeout,
    window: testWindow, ...frameTools });
  return { get, options, transport, noteOptions, cloudOptions, emitted, event: testWindow.handleTestEvent, click: id => get(id).listeners.click(), change: (id, value) => { get(id).value = value; get(id).listeners.change(); } };
}
test('switching agents restores messages and model history without duplicating entries', () => {
  const app = setup();
  assert.equal(app.get('conversation').dataset.agent, 'sage');
  app.options.onMessage('user', 'Hello Sage', { name: 'Jenny', score: 1 });
  app.options.onMessage('assistant', 'Hi Jenny');
  app.click('astra'); assert.equal(app.get('conversation').dataset.agent, 'astra'); assert.equal(app.options.history().length, 0);
  app.options.onMessage('user', 'Hello Astra'); app.options.onMessage('assistant', 'Welcome');
  app.click('sage');
  assert.equal(app.get('conversation').dataset.agent, 'sage');
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


test('Realtime transcript deltas update one bubble and completion saves one message', () => {
  const app = setup();
  app.event({ type: 'response.output_audio_transcript.delta', item_id: 'reply-1', delta: 'Visit ' });
  const bubble = app.get('messages').children.at(-1).children[1];
  assert.equal(bubble.textContent, 'Visit '); assert.equal(app.options.history().length, 0);
  app.event({ type: 'response.output_audio_transcript.delta', item_id: 'reply-1', delta: 'Kyoto.' });
  assert.equal(bubble.textContent, 'Visit Kyoto.');
  app.event({ type: 'response.output_audio_transcript.done', item_id: 'reply-1', transcript: 'Visit Kyoto.' });
  assert.equal(app.get('messages').children.length, 1); assert.equal(app.options.history().length, 1);
});



test('Realtime hides partial words until their boundary arrives', () => {
  const app = setup();
  app.event({ type: 'response.output_audio_transcript.delta', item_id: 'words', delta: 'Visit Kyo' });
  const bubble = app.get('messages').children.at(-1).children[1];
  assert.equal(bubble.textContent, 'Visit ');
  app.event({ type: 'response.output_audio_transcript.delta', item_id: 'words', delta: 'to.' });
  assert.equal(bubble.textContent, 'Visit Kyoto.');
});

test('Switch agent shows only the active companion and preserves each chat', () => {
  const app = setup();
  assert.equal(app.get('sage').hidden, false); assert.equal(app.get('astra').hidden, true);
  app.options.onMessage('user', 'Sage trip ideas');
  app.click('switch-agent');
  assert.equal(app.get('sage').hidden, true); assert.equal(app.get('astra').hidden, false);
  assert.equal(app.options.history().length, 0);
  app.options.onMessage('user', 'Astra itinerary');
  app.click('switch-agent');
  assert.equal(app.get('sage').hidden, false); assert.equal(app.get('astra').hidden, true);
  assert.equal(app.options.history()[0].content, 'Sage trip ideas');
});

test('automatic completion waits until the current audio reply finishes', () => {
  const app = setup(); app.transport.playing = true;
  app.noteOptions.onChange({ key: 'unknown', notes: 'Confirmed trip', updated: true, ready: true, choices: { countries: ['Japan'], cities: ['Tokyo', 'Kyoto', 'Osaka'], activities: ['Hiking'] } });
  assert.ok(!app.emitted.includes('trip-goal:complete'));
  app.transport.playing = false; app.options.onState();
  assert.ok(app.emitted.includes('trip-goal:complete'));
});

test('handoff cue follows recommendations, clears on switching, and ignores mentions and negation', () => {
  const app = setup();
  for (const reply of ['Switch to Astra to finalize the budget.', 'Astra can help with the route.', 'I recommend talking with Astra next.']) {
    app.options.onMessage('assistant', reply);
    assert.equal(app.get('switch-agent').dataset.suggested, 'true');
  }
  for (const reply of ['Astra and I have different personalities.', "You do not need to switch to Astra yet.", 'Let us explore Japan.']) {
    app.options.onMessage('assistant', reply);
    assert.equal(app.get('switch-agent').dataset.suggested, 'false');
  }
  app.options.onMessage('assistant', 'Talk to Astra for logistics.'); app.click('switch-agent');
  assert.equal(app.get('switch-agent').dataset.suggested, 'false');
  app.options.onMessage('assistant', 'Sage can help you choose activities.');
  assert.equal(app.get('switch-agent').dataset.suggested, 'true');
  app.click('reset'); assert.equal(app.get('switch-agent').dataset.suggested, 'false');
});

test('speaking animation follows playback and clears when playback stops', () => {
  const app = setup();
  app.transport.playing = true; app.options.onState();
  assert.equal(app.get('sage').dataset.speaking, 'true');
  assert.equal(app.get('astra').dataset.speaking, 'false');
  app.transport.playing = false; app.options.onState();
  assert.equal(app.get('sage').dataset.speaking, 'false');
  app.click('astra'); app.transport.playing = true; app.options.onState();
  assert.equal(app.get('astra').dataset.speaking, 'true');
  assert.equal(app.get('sage').dataset.speaking, 'false');
});

test('cloud chats restore separately by agent and memory mode without duplicating messages', () => {
  const app = setup(); app.change('speaker-name', 'Jenny');
  const turns = [
    { agent: 'sage', engine: 'pipeline', memory_sharing_mode: 'shared', speaker: 'Jenny', user_text: 'Japan ideas', agent_reply: 'Try Kyoto', session_id: 'sage-saved' },
    { agent: 'astra', engine: 'pipeline', memory_sharing_mode: 'shared', speaker: 'Jenny', user_text: 'Japan budget', agent_reply: 'Plan train costs', session_id: 'astra-saved' },
    { agent: 'sage', engine: 'pipeline', memory_sharing_mode: 'isolated', speaker: 'Jenny', user_text: 'Private ideas', agent_reply: 'Hiking', session_id: 'isolated-saved' },
  ];
  app.cloudOptions.chats('jenny', turns);
  assert.deepEqual(Array.from(app.options.history(), item => item.content), ['Japan ideas', 'Try Kyoto']);
  app.click('astra'); assert.equal(app.options.history()[1].content, 'Plan train costs');
  app.click('sage'); app.click('isolated-memory'); assert.equal(app.options.history()[0].content, 'Private ideas');
  app.click('shared-memory'); app.cloudOptions.chats('jenny', turns);
  assert.equal(app.options.history().length, 2);
});
