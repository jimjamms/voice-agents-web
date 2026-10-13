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
    ...(['text', 'voice', 'greeting'].includes(turn.inputMode || turn.input_mode) ? { input_mode: turn.inputMode || turn.input_mode } : {}),
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
    const results = await env.LOG_DB.batch(turns.map(turn => env.LOG_DB.prepare(`INSERT INTO chat_turns (turn_id, participant_id, session_id, speaker_lower, timestamp, payload, interrupted)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_name_ids WHERE name_id = ? AND logs_blocked = 1 AND julianday(?) <= julianday(deleted_at)) ON CONFLICT(turn_id) DO UPDATE SET interrupted=MAX(chat_turns.interrupted,excluded.interrupted)
      WHERE chat_turns.participant_id=excluded.participant_id AND chat_turns.session_id=excluded.session_id`).bind(
        turn.turn_id, turn.participant_id, turn.session_id, turn.speaker.toLowerCase(), turn.timestamp, JSON.stringify(turn), turn.interrupted ? 1 : 0, turn.speaker.toLowerCase(), turn.timestamp)));
    return json({ saved: turns.map(turn => turn.turn_id), discarded: turns.filter((_turn, i) => (results[i].meta?.changes ?? results[i].changes) === 0).map(turn => turn.turn_id) }, 200, cors);
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
  const name = data.name.trim().toLowerCase();
  const empty = JSON.stringify({ notes: '', choices: { countries: [], cities: [], activities: [], budget: null, itinerary: null, finalized: false }, memories: { shared: [], sage: [], astra: [] } });
  const statements = [env.LOG_DB.prepare(`INSERT INTO deleted_name_ids(name_id, trip_blocked, logs_blocked, generation, deleted_at) VALUES(?, 0, ?, ?, ?)
    ON CONFLICT(name_id) DO UPDATE SET trip_blocked = 0, logs_blocked = MAX(deleted_name_ids.logs_blocked, excluded.logs_blocked),
    generation = deleted_name_ids.generation + excluded.generation,
    deleted_at = CASE WHEN excluded.logs_blocked = 1 THEN excluded.deleted_at ELSE deleted_name_ids.deleted_at END`).bind(name, data.logs ? 1 : 0, data.trip ? 1 : 0, new Date().toISOString())];
  if (data.trip) statements.push(env.LOG_DB.prepare(`INSERT INTO trip_profiles(name_id, payload, version) VALUES(?, ?, 1)
    ON CONFLICT(name_id) DO UPDATE SET payload = excluded.payload, version = trip_profiles.version + 1, updated_at = CURRENT_TIMESTAMP`).bind(name, empty));
  if (data.logs) statements.push(env.LOG_DB.prepare('DELETE FROM chat_turns WHERE speaker_lower = ?').bind(name));
  try {
    const result = await env.LOG_DB.batch(statements);
    let index = 1;
    return json({ name, profilesDeleted: data.trip ? result[index++].meta.changes : 0, turnsDeleted: data.logs ? result[index].meta.changes : 0 }, 200, cors);
  } catch { return json({ error: 'Could not delete data. Check the database migrations and try again.' }, 503, cors); }
}

export async function listUsers(request, env, cors) {
  if (!env.LOG_ADMIN_KEY) return json({ error: 'Host user listing is not configured.' }, 503, cors);
  if (!validKey(request.headers.get('authorization')?.replace(/^Bearer /, ''), env.LOG_ADMIN_KEY)) return json({ error: 'Invalid host key.' }, 401, cors);
  if (!env.LOG_DB) return json({ error: 'User storage is not configured.' }, 503, cors);
  const url = new URL(request.url);
  const cursor = (url.searchParams.get('cursor') || '').trim().toLowerCase();
  const search = (url.searchParams.get('q') || '').trim().toLowerCase();
  const limit = Number(url.searchParams.get('limit') || 100);
  if (cursor.length > 40 || search.length > 40 || !Number.isInteger(limit) || limit < 1 || limit > 100) return json({ error: 'Invalid user-list filter.' }, 400, cors);
  try {
    const { results } = await env.LOG_DB.prepare(`WITH names AS (
      SELECT name_id FROM trip_profiles UNION SELECT speaker_lower AS name_id FROM chat_turns
    ), filtered AS (SELECT name_id FROM names WHERE instr(name_id, ?) > 0), chats AS (
      SELECT speaker_lower, COUNT(*) AS turn_count, MAX(received_at) AS last_seen FROM chat_turns GROUP BY speaker_lower
    ) SELECT n.name_id, p.payload, p.updated_at, COALESCE(c.turn_count, 0) AS turn_count,
      COALESCE(d.generation, 0) AS generation,
      CASE WHEN c.last_seen IS NULL OR julianday(p.updated_at) >= julianday(c.last_seen)
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', p.updated_at) ELSE c.last_seen END AS last_saved,
      (SELECT COUNT(*) FROM filtered) AS total_count
    FROM filtered n LEFT JOIN trip_profiles p ON p.name_id = n.name_id
      LEFT JOIN chats c ON c.speaker_lower = n.name_id LEFT JOIN deleted_name_ids d ON d.name_id = n.name_id
    WHERE n.name_id > ? ORDER BY n.name_id LIMIT ?`).bind(search, cursor, limit + 1).all();
    const page = results.slice(0, limit);
    const users = page.map(row => {
      let profile;
      try { profile = row.payload ? JSON.parse(row.payload) : null; } catch { profile = null; }
      const hasTrip = Boolean(profile && (profile.notes?.trim() || profile.choices?.countries?.length || profile.choices?.cities?.length || profile.choices?.budget ||
        Object.values(profile.memories || {}).some(value => Array.isArray(value) && value.length)));
      return { nameId: row.name_id, chatTurns: Number(row.turn_count), lastSaved: row.last_saved || null,
        tripStatus: hasTrip ? 'Saved trip' : row.generation > 0 && profile ? 'Trip reset' : profile ? 'New trip' : 'Logs only' };
    });
    return json({ users, total: Number(results[0]?.total_count || 0), nextCursor: results.length > limit ? page.at(-1).name_id : null }, 200, cors);
  } catch { return json({ error: 'Could not load users. Check the database migrations and try again.' }, 503, cors); }
}

export async function exportMemories(request, env, cors) {
  if (!env.LOG_ADMIN_KEY) return json({ error: 'Host memory export is not configured.' }, 503, cors);
  if (!validKey(request.headers.get('authorization')?.replace(/^Bearer /, ''), env.LOG_ADMIN_KEY)) return json({ error: 'Invalid host key.' }, 401, cors);
  if (!env.LOG_DB) return json({ error: 'Memory storage is not configured.' }, 503, cors);
  const url = new URL(request.url);
  const speaker = (url.searchParams.get('speaker') || '').trim().toLowerCase();
  const cursor = (url.searchParams.get('cursor') || '').trim().toLowerCase();
  const limit = Number(url.searchParams.get('limit') || 50);
  if (speaker.length > 40 || cursor.length > 40 || !Number.isInteger(limit) || limit < 1 || limit > 50) return json({ error: 'Invalid memory filter.' }, 400, cors);
  try {
    let sql = "SELECT name_id, payload, version, strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AS updated_at FROM trip_profiles WHERE name_id > ?";
    const params = [cursor];
    if (speaker) { sql += ' AND name_id = ?'; params.push(speaker); }
    sql += ' ORDER BY name_id LIMIT ?'; params.push(limit + 1);
    const { results } = await env.LOG_DB.prepare(sql).bind(...params).all();
    const page = results.slice(0, limit);
    const profiles = page.map(row => {
      const profile = JSON.parse(row.payload);
      const memories = Object.fromEntries(['shared', 'sage', 'astra', 'recentShared'].map(bucket => [bucket, Array.isArray(profile.memories?.[bucket]) ? profile.memories[bucket] : []]));
      return { name_id: row.name_id, updated_at: row.updated_at, version: Number(row.version), memories };
    });
    return json({ profiles, nextCursor: results.length > limit ? page.at(-1).name_id : null }, 200, cors);
  } catch { return json({ error: 'Could not export memories. Check the saved profiles and try again.' }, 503, cors); }
}
