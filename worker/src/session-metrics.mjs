import { opportunityScores } from './opportunity-metrics.mjs';
const words = text => String(text || '').trim().match(/\S+/gu)?.length || 0;
const mode = row => ['shared', 'isolated'].includes(row.memory_sharing_mode) ? row.memory_sharing_mode : 'unknown';
// One research session per Name ID, across agents, devices and time gaps.
export function tagSessions(rows) {
  return rows.map(row => ({ ...row, research_session: String(row.speaker || 'user-session').trim().toLowerCase() }));
}
export function sessionReports(rows, analysis = null, analyzedRows = []) {
  const tagged = tagSessions(rows), groups = new Map();
  for (const row of tagged) {
    if (!groups.has(row.research_session)) groups.set(row.research_session, []);
    groups.get(row.research_session).push(row);
  }
  const sampled = new Set(analyzedRows.map(row => row.turn_id));
  return [...groups].map(([id, entries]) => {
    const conditions = [...new Set(entries.map(mode))];
    const condition = entries.map(mode).reverse().find(value => value !== 'unknown') || 'unknown';
    const turns = entries.filter(t => t.event_type !== 'agent_switch');
    const users = turns.filter(t => t.user_text?.trim());
    const switches = entries.filter(t => t.event_type === 'agent_switch');
    const userWords = users.reduce((n, t) => n + words(t.user_text), 0);
    let estimates = null;
    if (analysis && entries.some(t => sampled.has(t.turn_id))) {
      const sample = turns.filter(t => sampled.has(t.turn_id));
      const ids = new Set(sample.map(t => t.turn_id));
      const findings = key => (analysis[key] || []).filter(v => ids.has(v.turn_id));
      const questions = analysis.question_turn_ids.filter(id => ids.has(id)).length;
      const continuity = findings('continuity').filter(v => v.picked_up !== null);
      const memoryTurns = sample.filter(t => (t.input_mode !== 'greeting' || t.opening_kind === 'generated') && Array.isArray(t.memory_facts));
      const wasted = new Set(findings('wasted').map(v => v.turn_id));
      const recordedWasted = sample.filter(t => wasted.has(t.turn_id) && Number.isFinite(t.speech_duration_ms));
      const outcomes = findings('task_outcomes');
      estimates = { ...opportunityScores(analysis, ids), sampledRecords: entries.filter(t => sampled.has(t.turn_id)).length, userTurns: sample.filter(t => t.user_text?.trim()).length,
        assistantTurns: sample.filter(t => t.agent_reply?.trim()).length,
        reasks: findings('reasks').length, questions, continuityCorrect: continuity.filter(v => v.picked_up).length, continuityAssessed: continuity.length,
        violations: findings('violations').length, crossAgentConflicts: analysis.crossAgentConflictsAssessed ? findings('cross_agent_conflicts').length : null,
        memoriesUsed: findings('memory_use').length, memoriesAvailable: memoryTurns.reduce((n, t) => n + t.memory_facts.length, 0),
        volunteeredFacts: findings('volunteered').length, wastedTurns: wasted.size, wastedWords: sample.filter(t => wasted.has(t.turn_id)).reduce((n, t) => n + words(t.user_text), 0),
        wastedSpeechSeconds: recordedWasted.length ? Math.round(recordedWasted.reduce((n, t) => n + t.speech_duration_ms, 0) / 1000) : null, wastedTurnsWithDuration: recordedWasted.length,
        satisfactionReported: findings('satisfaction').length > 0,
        taskComplete: outcomes.length ? outcomes.at(-1).complete : null };
    }
    return { id, condition, conditions, fingerprint: entries.map(t => `${t.log_id || t.turn_id}:${Boolean(t.interrupted)}:${mode(t)}`).join('|'), turnIds: entries.map(t => t.turn_id), conditionNote: conditions.length > 1 ? 'More than one mode recorded; grouped by the last recorded condition. All records retained.' : '', startedAt: entries[0].timestamp, endedAt: entries.at(-1).timestamp,
      records: entries.length, userTurns: users.length, userWords, wordsPerTurn: users.length ? userWords / users.length : null,
      assistantTurns: turns.filter(t => t.agent_reply?.trim()).length, switches: switches.length, suggestedSwitches: switches.filter(t => t.suggested === true).length,
      analysis: estimates };
  });
}
