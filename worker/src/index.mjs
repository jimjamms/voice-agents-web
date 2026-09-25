import agents from './agents.json' with { type: 'json' };

const REALTIME = 'https://api.openai.com/v1/realtime/calls';
const MAX_SDP_BYTES = 32_000;
const corsFor = origin => ({
  'access-control-allow-origin': origin,
  'access-control-allow-headers': 'content-type, x-demo-code',
  'access-control-allow-methods': 'POST, OPTIONS',
  'cache-control': 'no-store',
  'vary': 'Origin',
});
const json = (body, status, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
});
function validCode(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < given.length; i++) mismatch |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}
export function sessionConfig(agent, mode, model = 'gpt-realtime-2.1') {
  return {
    type: 'realtime', model, instructions: agent.instructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        transcription: { model: 'whisper-1' },
        turn_detection: mode === 'handsfree' ? {
          type: 'server_vad', prefix_padding_ms: 300, silence_duration_ms: 800,
          create_response: true, interrupt_response: true,
        } : null,
      },
      output: { voice: agent.voice },
    },
  };
}
export default {
  async fetch(request, env) {
    const allowedOrigin = env.PUBLIC_ORIGIN?.replace(/\/$/, '');
    if (!allowedOrigin || request.headers.get('origin') !== allowedOrigin) {
      return json({ error: 'Origin not allowed.' }, 403);
    }
    const cors = corsFor(allowedOrigin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname !== '/session' || request.method !== 'POST') return json({ error: 'Not found.' }, 404, cors);
    if (!env.OPENAI_API_KEY || !env.DEMO_ACCESS_CODE || !env.DEMO_RATE_LIMITER) {
      return json({ error: 'Voice service is not configured.' }, 503, cors);
    }
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.DEMO_RATE_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'Too many new sessions. Wait a minute and try again.' }, 429, cors);
    if (!validCode(request.headers.get('x-demo-code'), env.DEMO_ACCESS_CODE)) {
      return json({ error: 'Invalid demo access code.' }, 401, cors);
    }
    const agent = agents[url.searchParams.get('agent')];
    const mode = url.searchParams.get('mode');
    if (!agent || !['tap', 'handsfree'].includes(mode)) return json({ error: 'Choose an agent and mode.' }, 400, cors);
    if (!(request.headers.get('content-type') || '').startsWith('application/sdp')) {
      return json({ error: 'Expected a WebRTC session offer.' }, 415, cors);
    }
    if (Number(request.headers.get('content-length')) > MAX_SDP_BYTES) {
      return json({ error: 'Session offer is too large.' }, 413, cors);
    }
    try {
      const sdp = await request.text();
      if (!sdp.startsWith('v=0') || !sdp.includes('m=audio') || sdp.length > MAX_SDP_BYTES) {
        return json({ error: 'Invalid WebRTC session offer.' }, 400, cors);
      }
      const form = new FormData();
      form.set('sdp', sdp);
      form.set('session', JSON.stringify(sessionConfig(agent, mode, env.REALTIME_MODEL || 'gpt-realtime-2.1')));
      const response = await fetch(REALTIME, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: form,
      });
      if (!response.ok) {
        console.error('OpenAI Realtime connection failed:', response.status);
        return json({ error: 'Could not start a Realtime session. Check model access and API billing.' }, 502, cors);
      }
      return new Response(await response.text(), {
        status: 200, headers: { ...cors, 'content-type': 'application/sdp' },
      });
    } catch (error) {
      console.error('Realtime session error:', error);
      return json({ error: 'Could not connect to the voice service. Try again.' }, 502, cors);
    }
  },
};
