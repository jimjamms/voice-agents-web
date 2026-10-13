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
  return { notes: data.notes, choices: normalizeChoices(data.choices), memories };
}
export async function profileRequest(request, env, cors) {
  const json = (body, status = 200) => Response.json(body, { status, headers: cors });
  if (!env.LOG_DB) return json({ error: 'Cloud saving is not configured. Ask the host to apply the profile migration.' }, 503);
  try {
    if (!(request.headers.get('content-type') || '').startsWith('application/json')) return json({ error: 'Expected JSON.' }, 415);
    const raw = await request.text(); if (raw.length > 90000) return json({ error: 'Profile is too large.' }, 413);
    const data = JSON.parse(raw);
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 40 || data.name.trim().toLowerCase() === 'unknown') return json({ error: 'Enter a name ID of 1–40 characters.' }, 400);
    const id = data.name.trim().toLowerCase();
    const blocked = async () => Boolean(await env.LOG_DB.prepare('SELECT name_id FROM deleted_name_ids WHERE name_id = ? AND trip_blocked = 1').bind(id).first());
    const gone = () => json({ error: 'The host deleted this name ID’s saved trip. Use a new name ID to start again.' }, 410);
    if (await blocked()) return gone();
    if (data.action === 'load') {
      const row = await env.LOG_DB.prepare('SELECT payload, version FROM trip_profiles WHERE name_id = ? AND NOT EXISTS (SELECT 1 FROM deleted_name_ids WHERE name_id = ? AND trip_blocked = 1)').bind(id, id).first();
      return json({ profile: row ? JSON.parse(row.payload) : null, version: row?.version || 0 });
    }
    if (data.action !== 'save' || !Number.isSafeInteger(data.version) || data.version < 0) return json({ error: 'Invalid profile request.' }, 400);
    let profile;
    try { profile = cleanProfile(data.profile); } catch (error) { return json({ error: error.message }, 400); }
    const payload = JSON.stringify(profile);
    const statement = data.version === 0 ? env.LOG_DB.prepare('INSERT INTO trip_profiles(name_id, payload, version) SELECT ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM deleted_name_ids WHERE name_id = ? AND trip_blocked = 1) ON CONFLICT(name_id) DO NOTHING').bind(id, payload, id) :
      env.LOG_DB.prepare('UPDATE trip_profiles SET payload = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE name_id = ? AND version = ? AND NOT EXISTS (SELECT 1 FROM deleted_name_ids WHERE name_id = ? AND trip_blocked = 1)').bind(payload, id, data.version, id);
    const result = await statement.run();
    if (!result.meta.changes && await blocked()) return gone();
    if (!result.meta.changes) return json({ error: 'This trip was changed on another device. Return to setup and enter the same name ID to reload before making more changes.' }, 409);
    return json({ version: data.version + 1 });
  } catch { return json({ error: 'Cloud saving is unavailable. Check the database migration and try again.' }, 503); }
}
