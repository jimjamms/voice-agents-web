import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { memoryContext, extractFact, sharedTurnContext } from '../worker/src/memory.mjs';
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
    assert.equal(chat.model, 'configured-model'); assert.match(chat.messages[0].content, /Current memory mode: shared/); assert.match(chat.messages[1].content, /learned by Sage, not by you/);
    fd.set('memory_mode', 'isolated'); fd.set('memories', '[]');
    const isolatedResponse = await worker.fetch(new Request('https://worker.test/turn', { method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, 'x-demo-code': 'test' }, body: fd }), env);
    assert.equal(isolatedResponse.status, 200);
    const isolatedChat = JSON.parse(calls.filter(call => call.url.endsWith('/chat/completions')).at(-2).init.body);
    assert.match(isolatedChat.messages[0].content, /Current memory mode: isolated/);
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



test('Recorded reply streams word groups without waiting for audio and cancels on stop', () => {
  const shown = []; const frames = new Map(); let next = 0;
  const playback = { paused: true, currentTime: 0, duration: NaN, addEventListener() {}, pause() {}, removeAttribute() {} };
  const context = { window: {}, URL: { revokeObjectURL() {} }, requestAnimationFrame(fn) { frames.set(++next, fn); return next; }, cancelAnimationFrame(id) { frames.delete(id); } };
  vm.runInNewContext(readFileSync(new URL('../docs/pipeline.js', import.meta.url), 'utf8'), context);
  const transport = context.window.createPipelineTransport({ playback, isSelected: () => true, onReplyStart: () => text => shown.push(text) });
  transport.beginReply('Visit Kyoto and Osaka then explore Tokyo.');
  assert.equal(shown.at(-1), 'Visit Kyoto');
  const step = now => { const [id, tick] = frames.entries().next().value; frames.delete(id); tick(now); };
  step(0); step(60); assert.equal(shown.at(-1), 'Visit Kyoto and Osaka');
  transport.stopPlayback(); assert.equal(shown.at(-1), 'Visit Kyoto and Osaka then explore Tokyo.');
  assert.equal(frames.size, 0);
});

test('Realtime session receives shared, isolated or unavailable handoff instructions', () => {
  assert.match(sessionConfig(agents.sage, 'tap', 'model', 'shared').instructions, /Do not give a message to repeat or copy/);
  assert.match(sessionConfig(agents.astra, 'tap', 'model', 'isolated').instructions, /provide a short summary/);
  assert.match(sessionConfig(agents.sage, 'tap', 'model', 'invalid').instructions, /Cross-agent memory is unavailable/);
});

test('recent shared exchanges preserve multiple new details before summary extraction, survive reload and respect isolation', () => {
  const storage = new Map(), memory = browser(storage);
  memory.recordShared('Jenny', 'shared', 'sage', 'Budget is 2500 USD per person; 9 days; Tokyo, Kyoto, Osaka.', 'Astra can finalize those plans.', '2026-10-13T08:00:00Z');
  const loaded = browser(storage);
  assert.match(loaded.context('Jenny', 'shared', 'astra'), /2500 USD/);
  assert.match(loaded.context('Jenny', 'shared', 'astra'), /Tokyo, Kyoto, Osaka/);
  assert.ok(!loaded.context('Jenny', 'isolated', 'astra').includes('2500 USD'));
  loaded.recordShared('Jenny', 'isolated', 'sage', 'Secret isolated choice', 'Okay');
  assert.equal(loaded.recentShared('Jenny').length, 1);
  const revision = loaded.revision('Jenny'); loaded.forget('Jenny');
  assert.equal(loaded.recentShared('Jenny').length, 0); assert.ok(loaded.revision('Jenny') > revision);
  assert.equal(browser(storage).recentShared('Jenny').length, 0);
});
test('shared context is bounded and explicitly prioritizes latest user corrections over earlier facts', () => {
  const turn = { agent: 'sage', transcript: 'Actually my budget is 2500 USD, not 1500.', reply: 'I will use the new budget.' };
  const context = sharedTurnContext('Jenny', [turn], 'Astra');
  assert.match(context, /supersede older memories/); assert.match(context, /2500 USD/);
  assert.equal(sharedTurnContext('Unknown', [turn], 'Astra'), '');
  assert.equal(sharedTurnContext('Jenny', [{ ...turn, transcript: 'x'.repeat(3501) }], 'Astra'), '');
});
test('recorded handoff uses recent shared details even when extraction fails; isolated mode ignores them', async () => {
  const original = globalThis.fetch; const chats = [];
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/audio/transcriptions')) return Response.json({ text: 'Can you finalize the plan?' });
    if (url.endsWith('/audio/speech')) return new Response(new Uint8Array([1]));
    const data = JSON.parse(init.body);
    if (data.messages[0].content.startsWith('Extract')) return new Response('', { status: 500 });
    chats.push(data); return Response.json({ choices: [{ message: { content: 'Let us finalize it.' } }] });
  };
  try {
    const fd = new FormData(); fd.set('agent', 'astra'); fd.set('speaker', 'Jenny'); fd.set('memories', '[]');
    fd.set('shared_turns', JSON.stringify([{ agent: 'sage', transcript: 'My budget is 2500 USD for 9 days in Japan.', reply: 'Great.' }]));
    fd.set('audio', new Blob(['audio'], { type: 'audio/webm' }), 'turn.webm');
    const env = { PUBLIC_ORIGIN: 'https://example.github.io', DEMO_ACCESS_CODE: 'test', OPENAI_API_KEY: 'key', DEMO_RATE_LIMITER: { async limit() { return { success: true }; } } };
    const send = () => worker.fetch(new Request('https://worker.test/turn', { method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, 'x-demo-code': 'test' }, body: fd }), env);
    assert.equal((await send()).status, 200); assert.match(JSON.stringify(chats[0]), /2500 USD/);
    fd.set('memory_mode', 'isolated'); assert.equal((await send()).status, 200);
    assert.ok(!JSON.stringify(chats[1]).includes('2500 USD'));
  } finally { globalThis.fetch = original; }
});


test('first greeting uses only TTS, selected voice, no fake user transcript or memory extraction', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(new Uint8Array([1, 2]));
  };
  try {
    const env = { PUBLIC_ORIGIN: 'https://example.github.io', DEMO_ACCESS_CODE: 'test', OPENAI_API_KEY: 'key', DEMO_RATE_LIMITER: { async limit() { return { success: true }; } } };
    for (const agent of ['sage', 'astra']) {
      const fd = new FormData(); fd.set('agent', agent); fd.set('greeting', 'true');
      const response = await worker.fetch(new Request('https://worker.test/turn', { method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, 'x-demo-code': 'test' }, body: fd }), env);
      const data = await response.json();
      assert.equal(response.status, 200); assert.equal(data.greeting, true);
      assert.equal(data.transcript, ''); assert.equal(data.fact, null);
      assert.match(data.reply, agent === 'sage' ? /I’m Sage/ : /I’m Astra/);
      assert.ok(data.reply.split(/\s+/).length < 35);
      assert.equal(calls.at(-1).body.voice, agent === 'sage' ? 'marin' : 'cedar');
    }
    assert.equal(calls.length, 2); assert.ok(calls.every(call => call.url.endsWith('/audio/speech')));
  } finally { globalThis.fetch = original; }
});


test('blocked greeting playback is retried before starting the microphone', async () => {
  let played = 0;
  const playback = { addEventListener() {}, async play() { played++; } };
  const context = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../docs/pipeline.js', import.meta.url), 'utf8'), context);
  const transport = context.window.createPipelineTransport({ playback, onState() {} });
  transport.pendingPlayback = true;
  await transport.press();
  assert.equal(played, 1); assert.equal(transport.pendingPlayback, false);
  assert.equal(transport.recording, false); assert.equal(transport.playing, true);
});
