export const ANALYSIS_VERSION = 'memory-metrics-return-coherence-v4';
export async function analysisFingerprint(records, profilePayload, totalRecords, model) {
  const input = JSON.stringify({ version: ANALYSIS_VERSION, model, totalRecords, profilePayload,
    records: records.map(r => [r.id, r.payload, Boolean(r.interrupted)]) });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function readAnalysis(db, name, fingerprint, model) {
  let row;
  try { row = await db.prepare('SELECT data_fingerprint, analysis_version, model, payload, created_at FROM metrics_analyses WHERE name_id = ?').bind(name).first(); }
  catch { return { available: false, status: 'unavailable', message: 'Saved analysis storage is unavailable. Apply migration 0005_metrics_analyses.sql before analyzing.' }; }
  if (!row) return { available: true, status: 'none' };
  try {
    const analysis = JSON.parse(row.payload);
    if (!analysis || !Array.isArray(analysis.analyzedTurnIds) || !analysis.scores || !analysis.opportunityAssessment) throw new Error();
    const { savedReport, ...result } = analysis;
    return { available: true, status: 'saved', savedAt: row.created_at, analysis: result, savedReport }; 
  } catch { return { available: true, status: 'none', message: 'The saved result could not be read. Analyze again to replace it.' }; }
}
export async function saveAnalysis(db, name, fingerprint, model, analysis, snapshot) {
  const payload = JSON.stringify(analysis);
  if (payload.length > 1_500_000) return { available: true, status: 'not_saved', message: 'Analysis is ready but too large to save. Download it to keep this result.' };
  try {
    // Check the snapshot atomically: deletion or new messages during analysis must
    // not recreate removed evidence or mark an outdated result as current.
    const result = await db.prepare(`INSERT INTO metrics_analyses(name_id,data_fingerprint,analysis_version,model,payload,created_at)
      SELECT ?,?,?,?,?,? WHERE
      (SELECT COUNT(*) FROM chat_turns WHERE speaker_lower = ?) = ? AND
      COALESCE((SELECT MAX(id) FROM chat_turns WHERE speaker_lower = ?),0) = ? AND
      COALESCE((SELECT SUM(interrupted) FROM chat_turns WHERE speaker_lower = ?),0) = ? AND
      COALESCE((SELECT version FROM trip_profiles WHERE name_id = ?),0) = ? AND
      COALESCE((SELECT generation FROM deleted_name_ids WHERE name_id = ?),0) = ?
      ON CONFLICT(name_id) DO UPDATE SET data_fingerprint=excluded.data_fingerprint,analysis_version=excluded.analysis_version,
      model=excluded.model,payload=excluded.payload,created_at=excluded.created_at`).bind(
      name, fingerprint, ANALYSIS_VERSION, model, payload, analysis.generatedAt,
      name, snapshot.total, name, snapshot.latest, name, snapshot.interrupted, name, snapshot.profileVersion, name, snapshot.generation).run();
    if (!result.meta.changes) return { available: true, status: 'not_saved', message: 'Saved data changed during analysis. This result was not stored; reload metrics for the latest records.' };
    return { available: true, status: 'saved', savedAt: analysis.generatedAt };
  } catch { return { available: true, status: 'not_saved', message: 'Analysis is ready, but saving failed. Download this result before refreshing.' }; }
}
