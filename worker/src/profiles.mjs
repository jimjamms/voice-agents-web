import { normalizeChoices } from './trip-goals.mjs';
export function cleanProfile(data) {
  if (!data || typeof data.notes !== 'string' || data.notes.length > 6000) throw new Error('Invalid trip notes');
  const memories = {};
  for (const bucket of ['shared', 'sage', 'astra']) {
    const list = data.memories?.[bucket];
    if (!Array.isArray(list) || list.length > 20) throw new Error('Invalid memories');
    memories[bucket] = list.map(entry => {
      const fact = typeof entry === 'string' ? entry : entry?.fact;
      if (typeof fact !== 'string' || !fact.trim() || fact.length > 1000) throw new Error('Invalid memory');
      return bucket === 'shared' ? { fact, learned_by: entry.learned_by === 'Astra' ? 'Astra' : 'Sage' } : fact;
    });
  }
  const recent = data.memories?.recentShared || [];
  if (!Array.isArray(recent) || recent.length > 6) throw new Error('Invalid recent shared conversations');
  memories.recentShared = recent.map(turn => {
    if (!turn || !['sage', 'astra'].includes(turn.agent) || typeof turn.transcript !== 'string' || turn.transcript.length > 3500 ||
        typeof turn.reply !== 'string' || turn.reply.length > 1500 || typeof turn.at !== 'string' || !Number.isFinite(Date.parse(turn.at))) throw new Error('Invalid shared conversation');
    return { agent: turn.agent, transcript: turn.transcript, reply: turn.reply, at: new Date(turn.at).toISOString() };
  });
  const chatStarts = {};
  if (data.chatStarts != null) {
    if (typeof data.chatStarts !== 'object' || Array.isArray(data.chatStarts) || Object.keys(data.chatStarts).length > 8) throw new Error('Invalid chat state');
    for (const [bucket, timestamp] of Object.entries(data.chatStarts)) {
      if (!/^(shared|isolated):(pipeline|realtime):(sage|astra)$/.test(bucket) || typeof timestamp !== 'string' || timestamp.length > 30 || !Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid chat state');
      chatStarts[bucket] = new Date(timestamp).toISOString();
    }
  }
  return { notes: data.notes, choices: normalizeChoices(data.choices), memories, chatStarts, reviewed: data.reviewed === true };
}
export async function profileRequest(request, env, cors) {
  const json = (body, status = 200) => Response.json(body, { status, headers: cors });
  if (!env.LOG_DB) return json({ error: 'Cloud saving is not configured. Ask the host to apply the profile migration.' }, 503);
  try {
    if (!(request.headers.get('content-type') || '').startsWith('application/json')) return json({ error: 'Expected JSON.' }, 415);
    const raw = await request.text(); if (raw.length > 140000) return json({ error: 'Profile is too large.' }, 413);
    const data = JSON.parse(raw);
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 40 || data.name.trim().toLowerCase() === 'unknown') return json({ error: 'Enter a name ID of 1–40 characters.' }, 400);
    const id = data.name.trim().toLowerCase();
    const marker = await env.LOG_DB.prepare('SELECT generation FROM deleted_name_ids WHERE name_id = ?').bind(id).first();
    const generation = marker?.generation || 0;
    if (data.action === 'status') return json({ active: true, generation });
    if (data.action === 'load') {
      const row = await env.LOG_DB.prepare('SELECT payload, version FROM trip_profiles WHERE name_id = ?').bind(id).first();
      const profile = row ? JSON.parse(row.payload) : null;
      const { results } = await env.LOG_DB.prepare("SELECT payload, interrupted FROM chat_turns WHERE speaker_lower = ? AND COALESCE(json_extract(payload, '$.event_type'), '') != 'agent_switch' ORDER BY id DESC LIMIT 500").bind(id).all();
      const chatTurns = results.reverse().flatMap(item => {
        const turn = JSON.parse(item.payload);
        if (!['sage', 'astra'].includes(turn.agent) || !['shared', 'isolated'].includes(turn.memory_sharing_mode) || !['pipeline', 'realtime'].includes(turn.engine)) return [];
        const start = profile?.chatStarts?.[`${turn.memory_sharing_mode}:${turn.engine}:${turn.agent}`];
        if (start && turn.timestamp <= start) return [];
        return [{ ...turn, interrupted: Boolean(item.interrupted) }];
      });
      return json({ profile, chatTurns, version: row?.version || 0, generation });
    }
    if (data.action !== 'save' || !Number.isSafeInteger(data.version) || data.version < 0) return json({ error: 'Invalid profile request.' }, 400);
    let profile;
    try { profile = cleanProfile(data.profile); } catch (error) { return json({ error: error.message }, 400); }
    const payload = JSON.stringify(profile);
    const statement = data.version === 0 ? env.LOG_DB.prepare('INSERT INTO trip_profiles(name_id, payload, version) VALUES(?, ?, 1) ON CONFLICT(name_id) DO NOTHING').bind(id, payload) :
      env.LOG_DB.prepare('UPDATE trip_profiles SET payload = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE name_id = ? AND version = ?').bind(payload, id, data.version);
    const result = await statement.run();
    if (!result.meta.changes) return json({ error: 'This trip was changed on another device. Return to setup and enter the same name ID to reload before making more changes.' }, 409);
    return json({ version: data.version + 1 });
  } catch { return json({ error: 'Cloud saving is unavailable. Check the database migration and try again.' }, 503); }
}
