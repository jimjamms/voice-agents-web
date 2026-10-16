// Classification describes what prompted a repeated user turn, not why memory failed.
export const REPETITION_GUIDANCE = `For every wasted item (a supported user re-explanation), also return initiation: "handoff_prompted"|"agent_reasked"|"user_initiated"|"unclear", trigger_turn_id:null|string, trigger_quote:null|string. handoff_prompted means an earlier agent explicitly instructed the user to tell, mention, repeat or relay that same information to the OTHER agent. agent_reasked means the receiving agent asked for that same information before the user repeated it. user_initiated means the user repeated it without an identifiable relevant relay instruction or re-question; do not infer this merely because the prompt is outside the sampled window. unclear means insufficient or ambiguous evidence. For either prompted category, identify the actual preceding agent turn and quote a verbatim substring of its reply that prompted this repetition; a suggestion to switch agents alone is not a relay instruction. If both are present, classify the most direct supported prompt and explain the ambiguity if needed. Keep repeated user turns distinct from reasks: reasks are agent question turns, whereas wasted items are user re-explanations. Include prompted repetitions in the total, but never interpret them automatically as spontaneous disengagement, wasted effort or agent forgetting. Ordinary confirmations, legitimate revisions and new details are not re-explanations. All categories are evidence-based estimates, not proof of a causal effect.`;

export function annotateRepetition(findings, raw, turns) {
  const rows = new Map(turns.map((t, index) => [t.turn_id, { ...t, index }]));
  const judgments = new Map((raw || []).map(item => [item?.turn_id, item]));
  return findings.map(item => {
    const judged = judgments.get(item.turn_id), current = rows.get(item.turn_id);
    const trigger = rows.get(judged?.trigger_turn_id), source = rows.get(item.source_turn_id);
    let initiation = 'unclear';
    if (judged?.initiation === 'user_initiated' && !judged.trigger_turn_id && !judged.trigger_quote) initiation = 'user_initiated';
    const validPrompt = trigger && current && source && trigger.index >= source.index && trigger.index < current.index &&
      trigger.research_session === current.research_session && trigger.memory_sharing_mode === current.memory_sharing_mode &&
      typeof judged.trigger_quote === 'string' && judged.trigger_quote.trim() && judged.trigger_quote.length <= 500 && trigger.agent_reply?.includes(judged.trigger_quote);
    if (validPrompt && (judged.initiation === 'handoff_prompted' && trigger.agent !== current.agent || judged.initiation === 'agent_reasked' && trigger.agent === current.agent)) initiation = judged.initiation;
    return { ...item, initiation, ...(['handoff_prompted', 'agent_reasked'].includes(initiation) && {
      trigger_turn_id: trigger.turn_id, trigger_quote: judged.trigger_quote, trigger_agent: trigger.agent, trigger_reply: trigger.agent_reply,
    }) };
  });
}
export function repetitionScores(findings, assessed) {
  if (!assessed) return null;
  const count = key => findings.filter(v => v.initiation === key).length;
  return { total: findings.length, handoffPrompted: count('handoff_prompted'), agentReasked: count('agent_reasked'),
    userInitiated: count('user_initiated'), unclear: findings.filter(v => !['handoff_prompted', 'agent_reasked', 'user_initiated'].includes(v.initiation)).length };
}
