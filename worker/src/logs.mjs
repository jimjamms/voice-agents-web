import agents from './pipeline_agents.json' with { type: 'json' };
const json = (value, status, cors) => new Response(JSON.stringify(value), { status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export function cleanTurn(turn) {
  if (!turn || !id(turn.turn_id) || !id(turn.participant_id) || !id(turn.session_id) ||
    !['sage','astra'].includes(turn.agent) || !['pipeline','realtime'].includes(turn.engine) ||
    !['shared','isolated'].includes(turn.memory_sharing_mode) || typeof turn.speaker !== 'string' || turn.speaker.length > 40 ||
    typeof turn.user_text !== 'string' || turn.user_text.length > 3500 || typeof turn.agent_reply !== 'string' || turn.agent_reply.length > 3500 ||
    typeof turn.timestamp !== 'string' || !Number.isFinite(Date.parse(turn.timestamp))) throw new Error('Invalid turn');
  return { turn_id: turn.turn_id, participant_id: turn.participant_id, session_id: turn.session_id,
    timestamp: new Date(turn.timestamp).toISOString(), agent: turn.agent, agent_name: agents[turn.agent].name,
    agent_traits: agents[turn.agent].traits, engine: turn.engine, memory_sharing_mode: turn.memory_sharing_mode,
    speaker: turn.speaker.trim() || 'Unknown', user_text: turn.user_text, agent_reply: turn.agent_reply, interrupted: turn.interrupted === true };
}
export async function saveLogs(request, env, cors) {
  if (!env.LOG_DB) return json({ error: 'Chat log storage is not configured.' }, 503, cors);
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) return json({ error: 'Expected JSON.' }, 415, cors);
  if (Number(request.headers.get('content-length')) > 50000) return json({ error: 'Log batch is too large.' }, 413, cors);
  const raw = await request.text(); if (raw.length > 50000) return json({ error: 'Log batch is too large.' }, 413, cors);
  let turns;
  try { const data = JSON.parse(raw); if (!Array.isArray(data.turns) || !data.turns.length || data.turns.length > 25) throw new Error(); turns = data.turns.map(cleanTurn); }
  catch { return json({ error: 'Invalid chat log batch.' }, 400, cors); }
  try {
    await env.LOG_DB.batch(turns.map(turn => env.LOG_DB.prepare(`INSERT INTO chat_turns (turn_id, participant_id, session_id, speaker_lower, timestamp, payload, interrupted)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET interrupted=MAX(chat_turns.interrupted,excluded.interrupted)
      WHERE chat_turns.participant_id=excluded.participant_id AND chat_turns.session_id=excluded.session_id`).bind(
        turn.turn_id, turn.participant_id, turn.session_id, turn.speaker.toLowerCase(), turn.timestamp, JSON.stringify(turn), turn.interrupted ? 1 : 0)));
    return json({ saved: turns.map(turn => turn.turn_id) }, 200, cors);
  } catch { return json({ error: 'Could not save chat logs. Try again.' }, 503, cors); }
}
export function validKey(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let mismatch = 0; for (let i=0;i<given.length;i++) mismatch |= given.charCodeAt(i)^expected.charCodeAt(i);
  return mismatch === 0;
}
export async function exportLogs(request, env, cors) {
  if (!env.LOG_ADMIN_KEY) return json({ error: 'Host export is not configured.' }, 503, cors);
  if (!validKey(request.headers.get('authorization')?.replace(/^Bearer /,''), env.LOG_ADMIN_KEY)) return json({ error: 'Invalid host key.' }, 401, cors);
  if (!env.LOG_DB) return json({ error: 'Chat log storage is not configured.' }, 503, cors);
  const url = new URL(request.url), cursor = Number(url.searchParams.get('cursor') || 0);
  const speaker = (url.searchParams.get('speaker') || '').trim().toLowerCase();
  const participant = url.searchParams.get('participant') || '';
  if (!Number.isSafeInteger(cursor) || cursor < 0 || speaker.length > 40 || (participant && !id(participant))) return json({ error: 'Invalid log filter.' }, 400, cors);
  let sql = 'SELECT id, received_at, payload, interrupted FROM chat_turns WHERE id > ?'; const params=[cursor];
  if (speaker) { sql+=' AND speaker_lower = ?'; params.push(speaker); }
  if (participant) { sql+=' AND participant_id = ?'; params.push(participant); }
  sql+=' ORDER BY id LIMIT 501';
  try {
    const { results } = await env.LOG_DB.prepare(sql).bind(...params).all();
    const page=results.slice(0,500);
    return json({ turns: page.map(row=>({ ...JSON.parse(row.payload), interrupted: Boolean(row.interrupted), received_at: row.received_at })), nextCursor: results.length>500 ? page.at(-1).id : null },200,cors);
  } catch { return json({ error: 'Could not export logs.' },503,cors); }
}

export async function deleteUserData(request, env, cors) {
  if (!env.LOG_ADMIN_KEY || !env.LOG_DB) return json({ error: 'Host data management is not configured.' }, 503, cors);
  if (!validKey(request.headers.get('authorization')?.replace(/^Bearer /, ''), env.LOG_ADMIN_KEY)) return json({ error: 'Invalid host key.' }, 401, cors);
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) return json({ error: 'Expected JSON.' }, 415, cors);
  const raw = await request.text();
  if (raw.length > 1000) return json({ error: 'Request too large.' }, 413, cors);
  let data;
  try { data = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON.' }, 400, cors); }
  if (!data || typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 40 ||
      data.confirm !== data.name.trim() || typeof data.trip !== 'boolean' || typeof data.logs !== 'boolean' || (!data.trip && !data.logs))
    return json({ error: 'Enter and confirm one name ID, and select data to delete.' }, 400, cors);
  const name = data.name.trim().toLowerCase(), statements = [];
  if (data.trip) statements.push(env.LOG_DB.prepare('DELETE FROM trip_profiles WHERE name_id = ?').bind(name));
  if (data.logs) statements.push(env.LOG_DB.prepare('DELETE FROM chat_turns WHERE speaker_lower = ?').bind(name));
  try {
    const result = await env.LOG_DB.batch(statements);
    let index = 0;
    return json({ name, profilesDeleted: data.trip ? result[index++].meta.changes : 0, turnsDeleted: data.logs ? result[index].meta.changes : 0 }, 200, cors);
  } catch { return json({ error: 'Could not delete data. Check the database migrations and try again.' }, 503, cors); }
}
