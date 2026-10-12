import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { memoryContext, extractFact } from '../worker/src/memory.mjs';
import worker, { sessionConfig } from '../worker/src/index.mjs';
import agents from '../worker/src/agents.json' with { type: 'json' };
const source = readFileSync(new URL('../docs/memory.js', import.meta.url), 'utf8');
function browser(storage = new Map()) {
  const context = { window: {}, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } };
  vm.runInNewContext(source, context);
  return context.window.AgentMemory;
}
test('shared memory survives reload, matches name case, and attributes the other agent', () => {
  const storage = new Map(); const first = browser(storage);
  first.remember('Jenny', 'shared', 'sage', 'Jenny likes Hanabi.');
  const reloaded = browser(storage);
  assert.equal(reloaded.entries('jenny', 'shared', 'astra')[0].learned_by, 'Sage');
  assert.match(reloaded.context('JENNY', 'shared', 'astra'), /learned by Sage, not by you/);
  assert.equal(reloaded.entries('someone else', 'shared', 'astra').length, 0);
});
test('isolated memories stay with their agent and do not enter the shared store', () => {
  const memory = browser(); memory.remember('Jenny', 'isolated', 'sage', 'Likes Hanabi.');
  assert.equal(memory.entries('Jenny', 'isolated', 'astra').length, 0);
  assert.equal(memory.entries('Jenny', 'shared', 'sage').length, 0);
  assert.equal(memory.entries('Jenny', 'isolated', 'sage').length, 1);
});
test('caps facts, skips Unknown, and forgets only the selected speaker in all modes', () => {
  const memory = browser();
  for (let i = 0; i < 25; i++) memory.remember('Jenny', 'shared', 'sage', `Fact ${i}`);
  memory.remember('Jenny', 'isolated', 'astra', 'Astra fact');
  memory.remember('Other', 'shared', 'sage', 'Other fact');
  memory.remember('Unknown', 'shared', 'sage', 'Skipped');
  assert.equal(memory.entries('Jenny', 'shared', 'sage').length, 20);
  assert.equal(memory.entries('Unknown', 'shared', 'sage').length, 0);
  memory.forget('JENNY');
  assert.equal(memory.entries('Jenny', 'shared', 'sage').length, 0);
  assert.equal(memory.entries('Jenny', 'isolated', 'astra').length, 0);
  assert.equal(memory.entries('Other', 'shared', 'sage').length, 1);
});
test('worker bounds memory input and preserves attribution', () => {
  assert.equal(memoryContext('Unknown', ['fact'], 'Sage'), '');
  assert.match(memoryContext('Jenny', [{ fact: 'Likes Hanabi', learned_by: 'Sage' }], 'Astra'), /learned by Sage, not by you/);
  assert.ok(!memoryContext('Jenny', ['x'.repeat(601)], 'Astra').includes('xxx'));
  assert.match(sessionConfig(agents.sage, 'tap').instructions, /You are Sage/);
});
test('pipeline injects saved facts and extracts new ones with configured chat model', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/audio/transcriptions')) return Response.json({ text: 'I like Hanabi.' });
    if (url.endsWith('/audio/speech')) return new Response(new Uint8Array([1]));
    const data = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content: data.messages[0].content.startsWith('Extract') ? 'Jenny likes Hanabi.' : 'That sounds fun!' } }] });
  };
  try {
    const fd = new FormData(); fd.set('agent', 'astra'); fd.set('speaker', 'Jenny');
    fd.set('memories', JSON.stringify([{ fact: 'Jenny likes games.', learned_by: 'Sage' }]));
    fd.set('audio', new Blob(['audio'], { type: 'audio/webm' }), 'turn.webm');
    const env = { PUBLIC_ORIGIN: 'https://example.github.io', DEMO_ACCESS_CODE: 'test', OPENAI_API_KEY: 'key', PIPELINE_CHAT_MODEL: 'configured-model', DEMO_RATE_LIMITER: { async limit() { return { success: true }; } } };
    const response = await worker.fetch(new Request('https://worker.test/turn', { method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, 'x-demo-code': 'test' }, body: fd }), env);
    const data = await response.json();
    assert.equal(response.status, 200); assert.equal(data.fact, 'Jenny likes Hanabi.');
    const chat = JSON.parse(calls.find(call => call.url.endsWith('/chat/completions')).init.body);
    assert.equal(chat.model, 'configured-model'); assert.match(chat.messages[1].content, /learned by Sage, not by you/);
  } finally { globalThis.fetch = original; }
});
test('fact extraction failure does not fail the conversation', async () => {
  const original = globalThis.fetch; globalThis.fetch = async () => new Response('', { status: 500 });
  try { assert.equal(await extractFact({ OPENAI_API_KEY: 'key' }, 'Sage', 'Jenny', 'Hi', 'Hello'), null); }
  finally { globalThis.fetch = original; }
});
test('tap interruption stops playback and starts recording in one action', async () => {
  const context = { window: {}, URL: { revokeObjectURL() {} }, clearTimeout, clearInterval };
  vm.runInNewContext(readFileSync(new URL('../docs/pipeline.js', import.meta.url), 'utf8'), context);
  let interrupted = 0, recording = 0, paused = 0;
  const transport = context.window.createPipelineTransport({
    playback: { addEventListener() {}, pause() { paused++; }, removeAttribute() {}, hidden: false },
    onInterrupt() { interrupted++; },
  });
  transport.playing = true;
  transport.startTap = async () => { recording++; };
  await transport.press();
  assert.equal(interrupted, 1); assert.equal(paused, 1); assert.equal(recording, 1);
  assert.equal(transport.playing, false);
});

test('Recorded text follows audio position, ignores missing duration, and completes on interruption', () => {
  const events = {}; const shown = [];
  const playback = { currentTime: 0, duration: NaN, addEventListener(type, fn) { events[type] = fn; }, pause() {}, removeAttribute() {} };
  const context = { window: {}, URL: { revokeObjectURL() {} } };
  vm.runInNewContext(readFileSync(new URL('../docs/pipeline.js', import.meta.url), 'utf8'), context);
  const transport = context.window.createPipelineTransport({ playback, isSelected: () => true, onReplyStart: () => text => shown.push(text) });
  transport.beginReply('One two three four');
  events.timeupdate(); assert.equal(shown.length, 0);
  playback.duration = 4; playback.currentTime = 2; events.timeupdate();
  assert.equal(shown.at(-1), 'One two three four'.slice(0, 9));
  transport.stopPlayback(); assert.equal(shown.at(-1), 'One two three four');
  playback.currentTime = 3; events.timeupdate(); assert.equal(shown.at(-1), 'One two three four');
});
