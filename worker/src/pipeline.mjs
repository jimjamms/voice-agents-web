import { chatOptions } from './chat-options.mjs';
import { memoryContext, extractFact, sharedTurnContext } from './memory.mjs';
import pipelineAgents from './pipeline_agents.json' with { type: 'json' };

const API = 'https://api.openai.com/v1';
const MAX_AUDIO_BYTES = 4_000_000;
const MAX_TEXT = 1600;
const formats = new Map([
  ['audio/webm', 'webm'], ['audio/mp4', 'm4a'], ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'], ['audio/ogg', 'ogg'], ['audio/x-m4a', 'm4a'],
]);
const json = (body, status, cors) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
});
function safeHistory(value) {
  if (typeof value !== 'string' || value.length > 22000) return [];
  let parsed;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(-12).filter(m => m && ['user', 'assistant'].includes(m.role) &&
    typeof m.content === 'string' && m.content.length <= MAX_TEXT
  ).map(({ role, content }) => ({ role, content }));
}
function encode(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
async function upstream(path, options) {
  const response = await fetch(`${API}${path}`, options);
  if (!response.ok) {
    console.error('OpenAI pipeline request failed:', path, response.status);
    throw new Error('Voice service unavailable. Please try again.');
  }
  return response;
}
export async function pipelineTurn(request, env, cors) {
  if (!(request.headers.get('content-type') || '').startsWith('multipart/form-data'))
    return json({ error: 'Expected recorded audio.' }, 415, cors);
  if (Number(request.headers.get('content-length')) > MAX_AUDIO_BYTES + 100000)
    return json({ error: 'Recording is too large.' }, 413, cors);
  try {
    const form = await request.formData();
    const name = form.get('agent');
    const agent = Object.hasOwn(pipelineAgents, name) ? pipelineAgents[name] : null;
    const audio = form.get('audio');
    const greeting = form.get('greeting') === 'true';
    const memoryDeferred = !greeting && form.get('defer_memory') === 'true';
    if (!agent) return json({ error: 'Unknown agent.' }, 400, cors);
    if (!greeting && (!(audio instanceof Blob) || !audio.size || audio.size > MAX_AUDIO_BYTES))
      return json({ error: 'Recording is missing or too large.' }, 400, cors);
    const format = greeting ? null : formats.get(audio.type.split(';')[0]);
    if (!greeting && !format) return json({ error: 'Unsupported recording format.' }, 415, cors);
    const speaker = String(form.get('speaker') || 'Unknown').trim().slice(0, 40) || 'Unknown';
    let memories = [];
    const rawMemories = form.get('memories');
    if (typeof rawMemories === 'string' && rawMemories.length <= 15000) {
      try { memories = JSON.parse(rawMemories); } catch {}
    }
    const memoryMode = form.get('memory_mode') === 'isolated' ? 'isolated' : 'shared';
    let sharedTurns = [];
    const rawSharedTurns = form.get('shared_turns');
    if (memoryMode === 'shared' && typeof rawSharedTurns === 'string' && rawSharedTurns.length <= 35000) {
      try { sharedTurns = JSON.parse(rawSharedTurns); } catch {}
    }
    const recentContext = memoryMode === 'shared' ? sharedTurnContext(speaker, sharedTurns, agent.name) : '';
    const rounds = { 'first-choice': 'Sage chooses the country, first city and its activity one question at a time.', 'first-review': 'Astra checks the first stop against budget and timing, then invites a return to Sage.', 'second-choice': 'Sage chooses the second city and its activity using the initial practical check, then invites Astra.', 'final-plan': 'Astra finalizes the full route and budget and asks for explicit approval.' };
    const round = Object.hasOwn(rounds, form.get('planning_round')) ? rounds[form.get('planning_round')] : '';
    const roundContext = round ? '\n\nCurrent planning round: ' + round + ' This is a progress hint; the latest conversation may already have advanced beyond the saved checklist. Respect newer completed decisions and user requests. Follow the current memory mode; this hint does not imply access to the other agent’s private facts.' : '';
    const handoff = agent.handoff[speaker.toLowerCase() === 'unknown' ? 'disabled' : memoryMode];
    const context = memoryContext(speaker, memories, agent.name);
    const authorization = { authorization: `Bearer ${env.OPENAI_API_KEY}` };
    let transcript = '', reply;
    if (greeting) {
      const returning = safeHistory(form.get('history')).length > 0;
      reply = returning ? (name === 'sage' ? "Welcome back! It’s Sage. What would you like to explore for your trip today?" : "Welcome back. It’s Astra. What part of your itinerary would you like to work on?") : name === 'sage' ? "Hi, I’m Sage! I’ll help you choose destinations and fun activities. Which country would you like to visit?" : "Hi, I’m Astra. I’ll help check how your trip ideas fit your time and budget. What would you like to check first?";
    } else {
      const input = new FormData();
      input.set('file', audio, `turn.${format}`);
      input.set('model', 'whisper-1');
      input.set('language', 'en');
      const transcription = await (await upstream('/audio/transcriptions', {
        method: 'POST', headers: authorization, body: input,
      })).json();
      transcript = String(transcription.text || '').trim().slice(0, MAX_TEXT);
      if (!transcript) return json({ error: 'I could not hear anything. Try speaking again.' }, 422, cors);
      const chat = await (await upstream('/chat/completions', {
        method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...chatOptions(env.VOICE_CHAT_MODEL || env.PIPELINE_CHAT_MODEL || 'gpt-6-astra'),
          messages: [{ role: 'system', content: agent.prompt + '\n\n' + handoff + roundContext }, ...(context ? [{ role: 'system', content: context }] : []), ...safeHistory(form.get('history')), ...(recentContext ? [{ role: 'system', content: recentContext }] : []),
            { role: 'user', content: transcript }],
        }),
      })).json();
      reply = String(chat.choices?.[0]?.message?.content || '').trim().slice(0, 3500);
      if (!reply) throw new Error('Empty model reply.');
    }
    const factPromise = greeting || memoryDeferred ? Promise.resolve(null) : extractFact(env, agent.name, speaker, transcript, reply);
    const speech = await upstream('/audio/speech', {
      method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: agent.voice,
        instructions: agent.instructions, input: reply, response_format: 'mp3' }),
    });
    return json({ transcript, reply, greeting, memoryDeferred, fact: await factPromise, traits: agent.traits, audio: encode(await speech.arrayBuffer()), mimeType: 'audio/mpeg' }, 200, cors);
  } catch (error) {
    console.error('Pipeline turn failed:', error);
    return json({ error: 'Could not complete this turn. Check API billing and try again.' }, 502, cors);
  }
}
