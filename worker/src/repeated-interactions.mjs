const speaker = t => String(t.speaker || 'user-session').trim().toLowerCase();
// An interaction return needs a user message after changing agents. Reloads,
// same-agent messages and switch-only bouncing are not new return interactions.
export function repeatedInteractions(rows) {
  const streams = new Map(), returns = [];
  for (const row of rows) {
    const key = JSON.stringify([speaker(row), row.participant_id || 'legacy', row.engine || 'legacy', row.memory_sharing_mode || 'unknown']);
    let state = streams.get(key);
    if (!state) { state = { agent: row.agent, seen: new Set(), episode: { confirmed: false } }; streams.set(key, state); }
    if (row.event_type === 'agent_switch' || row.agent !== state.agent) {
      state.agent = row.agent;
      state.episode = { confirmed: false, returning: state.seen.has(row.agent), switchId: row.event_type === 'agent_switch' ? row.turn_id : null, firstReplyId: null };
    }
    if (row.event_type === 'agent_switch') continue;
    const episode = state.episode;
    if (!episode.firstReplyId && row.agent_reply?.trim()) episode.firstReplyId = row.turn_id;
    if (!row.user_text?.trim() || episode.confirmed) continue;
    episode.confirmed = true;
    if (episode.returning && state.lastUserAgent !== row.agent) returns.push({ agent: row.agent, mode: row.memory_sharing_mode, research_session: speaker(row),
      first_reply_turn_id: episode.firstReplyId || null, first_user_turn_id: row.turn_id, switch_id: episode.switchId });
    state.seen.add(row.agent); state.lastUserAgent = row.agent;
  }
  const userTurns = rows.filter(t => t.event_type !== 'agent_switch' && t.user_text?.trim());
  return { returns: returns.length, byAgent: Object.fromEntries(['sage', 'astra'].map(agent => [agent, returns.filter(t => t.agent === agent).length])),
    userTurnsByAgent: Object.fromEntries(['sage', 'astra'].map(agent => [agent, userTurns.filter(t => t.agent === agent).length])),
    bothAgentsUsed: ['sage', 'astra'].every(agent => userTurns.some(t => t.agent === agent)),
    bothAgentsRevisited: ['sage', 'astra'].every(agent => returns.some(t => t.agent === agent)), visits: returns,
    definition: 'A return is a user message after a substantive user exchange with the other agent and changing back to an agent previously addressed in the observed same-browser/engine/mode stream. Automatic openings, switch-only clicks and same-agent refreshes do not count. Counts describe behavior, not enjoyment, and can miss returns outside the saved window or across devices.' };
}
export const RETURN_GUIDANCE = `Also return return_continuity [{turn_id,source_turn_id:null|string,reply_quote,picked_up:true|false|null,reason}] for the first agent reply in each supplied repeated_interactions.visits return. This is a return to an agent previously addressed, not first contact. Judge whether it resumes a relevant unfinished decision or builds on available prior progress and user details rather than restarting, repeating an answered question or contradicting known choices. Consider own-agent history and context actually available in that memory mode; do not penalize a relevant clarification solely because the other agent's private preference is unavailable in Separate mode. In Separate mode cite the receiving agent’s own earlier progress to assess return coherence; a fact told only to the other agent cannot establish a failure to remember it. If only such a private cross-agent source is available, use null. A generic compatible greeting alone is insufficient evidence of success. Cite a relevant earlier source turn and a verbatim reply_quote from the first reply; use null when the earlier context is missing or ambiguous. Never infer engagement, enjoyment or satisfaction from length, disclosure or more switches. These are reviewable coherence estimates, not proof that one condition is better.`;
export function validateReturnContinuity(raw, turns, summary) {
  if (raw !== undefined && !Array.isArray(raw)) throw new Error('Invalid return continuity analysis.');
  const map = new Map(turns.map((t, index) => [t.turn_id, { ...t, index }]));
  const visits = new Set(summary.visits.map(v => v.first_reply_turn_id).filter(Boolean));
  const result = new Map();
  for (const item of (raw || []).slice(0, 300)) {
    const t = map.get(item?.turn_id), source = map.get(item?.source_turn_id);
    if (!t || !visits.has(t.turn_id) || ![true, false, null].includes(item.picked_up) ||
      typeof item.reply_quote !== 'string' || !item.reply_quote.trim() || item.reply_quote.length > 500 || !t.agent_reply?.includes(item.reply_quote)) continue;
    const prior = source && source.index < t.index && speaker(source) === speaker(t) && source.memory_sharing_mode === t.memory_sharing_mode &&
      (source.agent === t.agent || t.memory_sharing_mode === 'shared');
    // Without an earlier cited context, retain uncertainty rather than a success/failure.
    result.set(t.turn_id, { turn_id: t.turn_id, agent: t.agent, mode: t.memory_sharing_mode, research_session: speaker(t),
      picked_up: prior ? item.picked_up : null, ...(prior && { source_turn_id: source.turn_id, source_user_text: source.user_text || '', prior_reply: source.agent_reply || '' }),
      reply_quote: item.reply_quote, agent_reply: t.agent_reply, user_text: t.user_text || '', reason: String(item.reason || '').slice(0, 240) });
  }
  return { returnContinuityAssessed: Array.isArray(raw), return_continuity: [...result.values()] };
}
export function returnScores(findings, visits, assessed) {
  if (!assessed) return null;
  const ids = new Set(visits.visits.map(v => v.first_reply_turn_id).filter(Boolean));
  const judged = findings.filter(v => ids.has(v.turn_id) && v.picked_up !== null);
  return { opportunities: visits.returns, assessed: judged.length, correct: judged.filter(v => v.picked_up === true).length,
    failed: judged.filter(v => v.picked_up === false).length, unclear: visits.returns - judged.length };
}
