import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker from '../worker/src/index.mjs';
const env = { PUBLIC_ORIGIN: 'https://example.github.io', DEMO_ACCESS_CODE: 'test', OPENAI_API_KEY: 'key', PIPELINE_CHAT_MODEL: 'gpt-6-astra', DEMO_RATE_LIMITER: { async limit() { return { success: true }; } } };
function form(text = 'I choose Tokyo and Kyoto.') {
  const fd = new FormData(); fd.set('agent', 'sage'); fd.set('speaker', 'Jenny'); fd.set('text', text); fd.set('defer_memory', 'true'); return fd;
}
const send = fd => worker.fetch(new Request('https://worker.test/turn', { method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, 'x-demo-code': 'test' }, body: fd }), env);
test('typed messages use GPT-6 and the same isolated/public-notepad context without transcription or TTS by default', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    return Response.json({ choices: [{ message: { content: 'Which activity would you like in Tokyo?' } }] });
  };
  try {
    const fd = form(); fd.set('memory_mode', 'isolated'); fd.set('trip_choices', JSON.stringify({ countries: ['Japan'], cities: ['Tokyo'], cityActivities: { Tokyo: 'Food tour' } }));
    const response = await send(fd), data = await response.json();
    assert.equal(response.status, 200); assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/chat/completions'));
    assert.equal(calls[0].body.model, 'gpt-6-astra'); assert.equal(calls[0].body.reasoning_effort, 'low');
    assert.equal(calls[0].body.messages.at(-1).content, 'I choose Tokyo and Kyoto.');
    assert.match(JSON.stringify(calls[0].body.messages), /Public trip notepad/);
    assert.equal(data.transcript, 'I choose Tokyo and Kyoto.'); assert.equal(data.inputMode, 'text'); assert.equal(data.audio, null); assert.equal(data.memoryDeferred, true);
  } finally { globalThis.fetch = original; }
});
test('typed messages optionally generate speech without requesting microphone transcription', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return url.endsWith('/audio/speech') ? new Response(new Uint8Array([1, 2])) : Response.json({ choices: [{ message: { content: 'Great choice.' } }] });
  };
  try {
    const fd = form(); fd.set('reply_audio', 'true');
    const data = await (await send(fd)).json();
    assert.equal(calls.length, 2); assert.equal(calls[1].body.voice, 'marin'); assert.equal(data.audio, 'AQI=');
    assert.ok(calls.every(call => !call.url.endsWith('/audio/transcriptions')));
  } finally { globalThis.fetch = original; }
});
test('invalid typed input and mixed text/audio are rejected before any AI call', async () => {
  for (const fd of [form('   '), form('x'.repeat(1601))]) assert.equal((await send(fd)).status, 400);
  const mixed = form(); mixed.set('audio', new Blob(['audio'], { type: 'audio/webm' }), 'turn.webm');
  assert.equal((await send(mixed)).status, 400);
  const greeting = form(); greeting.set('greeting', 'true'); assert.equal((await send(greeting)).status, 400);
});
test('text transport works without microphone/browser recording APIs and follows normal turn callbacks', async () => {
  const turns = [], messages = []; let sent;
  const context = { window: {}, FormData, AbortController,
    fetch: async (_url, init) => { sent = init.body; return Response.json({ transcript: 'Tokyo please', reply: 'Which activity?', inputMode: 'text', memoryDeferred: true, audio: null }); } };
  vm.runInNewContext(readFileSync(new URL('../docs/pipeline.js', import.meta.url), 'utf8'), context);
  const transport = context.window.createPipelineTransport({
    playback: { addEventListener() {}, pause() {}, removeAttribute() {} }, onState() {}, onStatus() {},
    agent: () => 'sage', speaker: () => 'Jenny', memoryMode: () => 'isolated', code: () => 'test', base: () => 'https://worker.test',
    memories: () => [], history: () => [], onTurn: turn => turns.push(turn), onMessage: (role, content) => messages.push({ role, content }),
  });
  assert.equal(await transport.sendText('Tokyo please'), true);
  assert.equal(sent.get('text'), 'Tokyo please'); assert.equal(sent.get('reply_audio'), 'false'); assert.equal(sent.has('audio'), false); assert.equal(sent.has('greeting'), false);
  assert.equal(turns[0].speaker, 'Jenny'); assert.equal(turns[0].agent, 'sage');
  assert.deepEqual(messages, [{ role: 'user', content: 'Tokyo please' }, { role: 'assistant', content: 'Which activity?' }]);
  assert.equal(transport.busy, false); assert.equal(transport.playing, false);
});
