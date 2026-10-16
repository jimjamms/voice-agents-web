const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
export const OPPORTUNITY_GUIDANCE = `Also evaluate these opportunities, not just successful uses. Return preference_opportunities [{turn_id,source_turn_id,source_quote,fact,applied:true|false|null,reason}]: an earlier USER preference, motivation, dislike or priority told to the OTHER agent becomes relevant to a later substantive recommendation. Exclude public notepad itinerary facts such as chosen cities, activities, dates, budget or lodging. Do not count information already repeated directly to the receiving agent as cross-agent transfer. applied=true requires a concrete relevant application, not merely a generic compatible suggestion or reciting the fact; false requires clear failure to account for a relevant preference; null when uncertain. Include relevant opportunities in separate mode even if that private preference was unavailable, without claiming the agent should have known it. Return correction_opportunities [{turn_id,source_turn_id,prior_turn_id,source_quote,prior_quote,fact,respected:true|false|null,reason}]: the user explicitly corrected or changed an earlier preference, and a later OTHER-agent recommendation depends on the revised preference. source_turn_id is the correction, prior_turn_id the superseded user fact; both quotes are verbatim substrings of those user messages. Exclude ordinary public-notepad value changes from this preference measure. Do not count a correction repeated directly to the receiving agent as cross-agent carryover. respected=true for concrete use of the revision, false for using the superseded preference, null when ambiguous. Return context_handling [{turn_id,needed_detail,reply_quote,behavior:"clarified"|"provisional"|"unsupported_claim"|"unclear",reason}]: a substantive response needs personal context not established in the receiving agent's available own conversation, current user message, captured memory_facts, public trip facts, or shared exchanges when sharing is enabled. clarified means one relevant missing-detail question; provisional means an honest flexible suggestion or labeled assumption; unsupported_claim means claiming an unsupported personal fact or pretending to recall unavailable information; unclear means insufficient evidence. Do not mark a fact unavailable merely because it is outside this sampled window, and do not count missing details irrelevant to the decision. reply_quote must be an exact substring of the agent reply. For all three arrays, include only opportunities supported by this user's session evidence; no relevant opportunity means an empty array, never an invented failure. Source quotes must be literal, facts must be stated by the user, and source IDs must precede the response. Exclude preset greetings and older unmarked openings. An opening explicitly marked opening_kind=generated can be assessed when it makes a substantive context-dependent suggestion or clarification; a generic hello is not an opportunity. Distinguish actual cross-agent application from lucky agreement. Findings and relevance judgments are estimates needing review, not ground truth.`;

export function validateOpportunities(raw, turns) {
  const map = new Map(turns.map((t, index) => [t.turn_id, { ...t, index }]));
  const result = {};
  for (const key of ['preference_opportunities', 'correction_opportunities', 'context_handling']) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) throw new Error('Invalid opportunity analysis. Please retry.');
    const values = new Map();
    for (const item of (raw[key] || []).slice(0, 300)) {
      const t = map.get(item?.turn_id), source = map.get(item?.source_turn_id), prior = map.get(item?.prior_turn_id);
      if (!t?.agent_reply?.trim() || t.event_type === 'agent_switch' || (t.input_mode === 'greeting' && t.opening_kind !== 'generated')) continue;
      const finding = { turn_id: t.turn_id, agent: t.agent, mode: t.memory_sharing_mode, research_session: t.research_session,
        user_text: t.user_text || '', agent_reply: t.agent_reply, reason: typeof item.reason === 'string' ? item.reason.slice(0, 240) : '' };
      let identity;
      if (key === 'context_handling') {
        if (!['clarified','provisional','unsupported_claim','unclear'].includes(item.behavior) || typeof item.needed_detail !== 'string' || !item.needed_detail.trim() ||
          typeof item.reply_quote !== 'string' || !item.reply_quote.trim() || item.reply_quote.length > 400 || !t.agent_reply.includes(item.reply_quote)) continue;
        Object.assign(finding, { needed_detail: item.needed_detail.trim().slice(0, 300), reply_quote: item.reply_quote, behavior: item.behavior });
        // One contextual decision per response, even if the judge duplicates phrasing.
        identity = t.turn_id;
      } else {
        const field = key === 'preference_opportunities' ? 'applied' : 'respected';
        if (!source?.user_text?.trim() || source.index >= t.index || source.research_session !== t.research_session || source.agent === t.agent ||
          source.memory_sharing_mode !== t.memory_sharing_mode || ![true, false, null].includes(item[field]) || typeof item.fact !== 'string' || !item.fact.trim() ||
          typeof item.source_quote !== 'string' || !item.source_quote.trim() || item.source_quote.length > 400 || !source.user_text.includes(item.source_quote)) continue;
        // Directly repeating the preference to the recipient is not cross-agent transfer.
        const quote = normalize(item.source_quote);
        if (quote.length >= 8 && turns.some((row, index) => index > source.index && index <= t.index && row.agent === t.agent && row.research_session === t.research_session && normalize(row.user_text).includes(quote))) continue;
        if (key === 'correction_opportunities') {
          if (!prior?.user_text?.trim() || prior.index >= source.index || prior.research_session !== t.research_session ||
            typeof item.prior_quote !== 'string' || !item.prior_quote.trim() || item.prior_quote.length > 400 || !prior.user_text.includes(item.prior_quote)) continue;
          Object.assign(finding, { prior_turn_id: prior.turn_id, prior_quote: item.prior_quote, prior_user_text: prior.user_text });
        }
        Object.assign(finding, { source_turn_id: source.turn_id, source_quote: item.source_quote, source_user_text: source.user_text, fact: item.fact.trim().slice(0, 600), [field]: item[field] });
        identity = `${t.turn_id}:${normalize(item.fact)}`;
      }
      values.set(identity, finding);
    }
    result[key] = [...values.values()];
  }
  result.opportunityAssessment = Object.fromEntries(['preference_opportunities','correction_opportunities','context_handling'].map(key => [key, Array.isArray(raw[key])]));
  return result;
}

export function opportunityScores(analysis, ids) {
  const findings = key => (analysis[key] || []).filter(v => ids.has(v.turn_id));
  const scored = (key, field) => {
    if (!analysis.opportunityAssessment?.[key]) return null;
    const all = findings(key), assessed = all.filter(v => v[field] !== null);
    return { opportunities: all.length, assessed: assessed.length, successful: assessed.filter(v => v[field]).length, unclear: all.length - assessed.length };
  };
  const context = analysis.opportunityAssessment?.context_handling ? findings('context_handling') : null;
  return { preferenceApplication: scored('preference_opportunities', 'applied'), correctionCarryover: scored('correction_opportunities', 'respected'),
    contextHandling: context ? { opportunities: context.length, assessed: context.filter(v => v.behavior !== 'unclear').length,
      successful: context.filter(v => ['clarified','provisional'].includes(v.behavior)).length,
      clarified: context.filter(v => v.behavior === 'clarified').length, provisional: context.filter(v => v.behavior === 'provisional').length,
      unsupportedClaims: context.filter(v => v.behavior === 'unsupported_claim').length, unclear: context.filter(v => v.behavior === 'unclear').length } : null };
}
