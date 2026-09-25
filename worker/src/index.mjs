import agents from './agents.json' with { type: 'json' };

const OPENAI = 'https://api.openai.com/v1';
const MAX_AUDIO_BYTES = 4_000_000;
const MAX_HISTORY = 12;
const MAX_TEXT = 1600;
const allowedTypes = new Map([
  ['audio/webm', 'webm'], ['audio/mp4', 'm4a'], ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'], ['audio/ogg', 'ogg'], ['audio/x-m4a', 'm4a'],
]);

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
function safeHistory(value) {
  if (typeof value !== 'string' || value.length > 22000) return [];
  let parsed;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(-MAX_HISTORY).filter(m =>
    m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length <= MAX_TEXT
  ).map(({ role, content }) => ({ role, content }));
}
async function upstream(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    console.error('OpenAI request failed:', response.status, url);
    throw new Error('Voice service unavailable. Please try again.');
  }
  return response;
}
function authHeader(key) { return { authorization: `Bearer ${key}` }; }
function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin');
    const allowed = env.PUBLIC_ORIGIN?.replace(/\/$/, '');
    const cors = { 'access-control-allow-origin': allowed || '', 'vary': 'Origin', 'cache-control': 'no-store', 'access-control-allow-headers': 'content-type, x-demo-code', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (!allowed || origin !== allowed) return json({ error: 'Origin not allowed.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (new URL(request.url).pathname !== '/turn' || request.method !== 'POST') return json({ error: 'Not found.' }, 404, cors);
    if (!env.OPENAI_API_KEY || !env.DEMO_ACCESS_CODE || !env.DEMO_RATE_LIMITER) return json({ error: 'Service not configured.' }, 503, cors);
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const limit = await env.DEMO_RATE_LIMITER.limit({ key: ip });
    if (!limit.success) return json({ error: 'Too many requests. Try again in a minute.' }, 429, cors);
    const code = request.headers.get('x-demo-code') || '';
    if (!code || code.length !== env.DEMO_ACCESS_CODE.length) return json({ error: 'Invalid access code.' }, 401, cors);
    let mismatch = 0;
    for (let i = 0; i < code.length; i++) mismatch |= code.charCodeAt(i) ^ env.DEMO_ACCESS_CODE.charCodeAt(i);
    if (mismatch) return json({ error: 'Invalid access code.' }, 401, cors);
    if (!(request.headers.get('content-type') || '').startsWith('multipart/form-data')) return json({ error: 'Expected recorded audio.' }, 415, cors);
    if (Number(request.headers.get('content-length')) > MAX_AUDIO_BYTES + 50000) return json({ error: 'Recording is too large.' }, 413, cors);
    try {
      const form = await request.formData();
      const agent = agents[form.get('agent')];
      const audio = form.get('audio');
      if (!agent) return json({ error: 'Unknown agent.' }, 400, cors);
      if (!(audio instanceof Blob) || !audio.size || audio.size > MAX_AUDIO_BYTES) return json({ error: 'Recording is missing or too large.' }, 400, cors);
      const mediaType = audio.type.split(';')[0];
      const extension = allowedTypes.get(mediaType);
      if (!extension) return json({ error: 'Unsupported recording format.' }, 415, cors);
      const formData = new FormData();
      formData.append('model', 'whisper-1');
      formData.append('language', 'en');
      formData.append('file', audio, `recording.${extension}`);
      const transcriptResponse = await upstream(`${OPENAI}/audio/transcriptions`, { method: 'POST', headers: authHeader(env.OPENAI_API_KEY), body: formData });
      const transcription = await transcriptResponse.json();
      const transcript = String(transcription.text || '').trim().slice(0, MAX_TEXT);
      if (!transcript) return json({ error: 'I could not hear anything. Try speaking again.' }, 422, cors);
      const history = safeHistory(form.get('history'));
      const completionResponse = await upstream(`${OPENAI}/chat/completions`, { method: 'POST', headers: { ...authHeader(env.OPENAI_API_KEY), 'content-type': 'application/json' }, body: JSON.stringify({ model: env.CHAT_MODEL || 'gpt-4.1-mini', messages: [{ role: 'system', content: agent.prompt }, ...history, { role: 'user', content: transcript }] }) });
      const completion = await completionResponse.json();
      const reply = String(completion.choices?.[0]?.message?.content || '').trim().slice(0, 3500);
      if (!reply) throw new Error('No response was generated. Please try again.');
      const speechResponse = await upstream(`${OPENAI}/audio/speech`, { method: 'POST', headers: { ...authHeader(env.OPENAI_API_KEY), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: agent.voice, instructions: agent.instructions, input: reply, response_format: 'mp3' }) });
      return json({ transcript, reply, audio: base64(await speechResponse.arrayBuffer()), mimeType: 'audio/mpeg' }, 200, cors);
    } catch (error) {
      console.error('Turn failed:', error);
      return json({ error: error.message === 'Voice service unavailable. Please try again.' ? error.message : 'Could not complete this turn. Please try again.' }, 502, cors);
    }
  }
};
