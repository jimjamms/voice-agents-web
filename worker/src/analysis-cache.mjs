export const ANALYSIS_VERSION = 'memory-metrics-opportunity-evidence-v6';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value))));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function countedFingerprint(records, totalRecords) {
  return hash({ totalRecords, records: records.map(r => [r.id, JSON.parse(r.payload), Boolean(r.interrupted)]).sort((a,b) => a[0]-b[0]) });
}
export async function analysisFingerprint(records, profilePayload, totalRecords, model) {
  const profile = profilePayload ? JSON.parse(profilePayload) : {};
  // Login/review flags and JSON key order do not change the evaluation source.
  return hash({ version: ANALYSIS_VERSION, model, totalRecords, profile: { memories: Object.fromEntries(['shared','sage','astra'].map(bucket => [bucket, (profile.memories?.[bucket] || []).map(v => typeof v === 'string' ? v : v?.fact).filter(v => typeof v === 'string')])) },
    records: records.map(r => [r.id, JSON.parse(r.payload), Boolean(r.interrupted)]).sort((a,b) => a[0]-b[0]) });
}
function decode(row) {
  const analysis = JSON.parse(row.payload);
  if (!Array.isArray(analysis?.analyzedTurnIds) || !analysis.scores || !analysis.opportunityAssessment) throw new Error('Unreadable analysis');
  const { savedReport, ...result } = analysis;
  return { analysis: result, savedReport };
}
export async function readAnalysis(db, name, fingerprint, model, matching = false) {
  let row;
  try { row = await db.prepare('SELECT data_fingerprint, analysis_version, model, payload, created_at FROM metrics_analyses WHERE name_id = ?').bind(name).first(); }
  catch { return { available: false, status: 'unavailable', message: 'Saved analysis storage is unavailable. Apply migration 0005_metrics_analyses.sql before analyzing.' }; }
  let history = [], archived, historyAvailable = true;
  try {
    history = (await db.prepare('SELECT id, created_at, model, analysis_version, data_fingerprint FROM metrics_analysis_history WHERE name_id = ? ORDER BY id DESC LIMIT 50').bind(name).all()).results;
    if (matching) archived = await db.prepare('SELECT payload, created_at, data_fingerprint, analysis_version, model FROM metrics_analysis_history WHERE name_id = ? AND data_fingerprint = ? AND analysis_version = ? AND model = ?').bind(name,fingerprint,ANALYSIS_VERSION,model).first();
  } catch { historyAvailable = false; }
  const activeMatches = row?.data_fingerprint === fingerprint && row.analysis_version === ANALYSIS_VERSION && row.model === model;
  const chosen = matching && archived ? archived : row;
  if (!chosen) return { available: true, historyAvailable, history, status: 'none' };
  try { return { available: true, historyAvailable, history, status: 'saved', savedAt: chosen.created_at,
    matchesCurrent: chosen.data_fingerprint === fingerprint && chosen.analysis_version === ANALYSIS_VERSION && chosen.model === model,
    fromHistory: Boolean(matching && archived && !activeMatches), ...decode(chosen) }; }
  catch { return { available: true, historyAvailable, history, status: 'none', message: 'The saved result could not be read. Analyze again to replace it.' }; }
}
export async function historicalAnalysis(db, name, id) {
  const row = await db.prepare('SELECT payload, created_at FROM metrics_analysis_history WHERE name_id = ? AND id = ?').bind(name,id).first();
  if (!row) return null;
  return { ...decode(row), savedAt: row.created_at };
}
export async function saveAnalysis(db, name, fingerprint, model, analysis, snapshot) {
  const payload = JSON.stringify(analysis);
  if (payload.length > 1_500_000) return { available: true, status: 'not_saved', message: 'Analysis is ready but too large to save. Download it to keep this result.' };
  try {
    // The first saved judgment for an exact source is canonical, including races.
    const result = await db.prepare(`WITH candidate(name_id,data_fingerprint,analysis_version,model,payload,created_at) AS (VALUES(?,?,?,?,?,?)),
      canonical AS (SELECT c.name_id,c.data_fingerprint,c.analysis_version,c.model,COALESCE(h.payload,c.payload) AS payload,COALESCE(h.created_at,c.created_at) AS created_at
      FROM candidate c LEFT JOIN metrics_analysis_history h ON h.name_id=c.name_id AND h.data_fingerprint=c.data_fingerprint AND h.analysis_version=c.analysis_version AND h.model=c.model)
      INSERT INTO metrics_analyses(name_id,data_fingerprint,analysis_version,model,payload,created_at)
      SELECT name_id,data_fingerprint,analysis_version,model,payload,created_at FROM canonical WHERE
      (SELECT COUNT(*) FROM chat_turns WHERE speaker_lower = ?) = ? AND
      COALESCE((SELECT MAX(id) FROM chat_turns WHERE speaker_lower = ?),0) = ? AND
      COALESCE((SELECT SUM(interrupted) FROM chat_turns WHERE speaker_lower = ?),0) = ? AND
      COALESCE((SELECT version FROM trip_profiles WHERE name_id = ?),0) = ? AND
      COALESCE((SELECT generation FROM deleted_name_ids WHERE name_id = ?),0) = ?
      ON CONFLICT(name_id) DO UPDATE SET data_fingerprint=excluded.data_fingerprint,analysis_version=excluded.analysis_version,
      model=excluded.model,payload=excluded.payload,created_at=excluded.created_at
      WHERE metrics_analyses.data_fingerprint != excluded.data_fingerprint OR metrics_analyses.analysis_version != excluded.analysis_version OR metrics_analyses.model != excluded.model`).bind(
      name,fingerprint,ANALYSIS_VERSION,model,payload,analysis.generatedAt,
      name,snapshot.total,name,snapshot.latest,name,snapshot.interrupted,name,snapshot.profileVersion,name,snapshot.generation).run();
    if (!result.meta.changes) return { available: true, status: 'not_saved', message: 'A saved result already exists, or the data changed during analysis. Reload the saved metrics.' };
    return { available: true, status: 'saved', savedAt: analysis.generatedAt };
  } catch { return { available: true, status: 'not_saved', message: 'Analysis is ready, but saving failed. Download this result before refreshing.' }; }
}
