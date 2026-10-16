(() => {
  const pct = (n, d) => d && typeof n === 'number' ? n / d * 100 : null;
  const perTen = (n, d) => d && typeof n === 'number' ? n / d * 10 : null;
  const measures = [
    ['Words per user turn', 'Counted', s => s.wordsPerTurn, 'number'],
    ['Agent switches per session', 'Counted', s => s.switches, 'number'],
    ['Switches following a suggestion', 'Counted', s => pct(s.suggestedSwitches, s.switches), 'percent'],
    ['Continued returns per session', 'Counted · user interaction after switching back, not enjoyment', s => s.repeatedInteractions?.returns, 'number'],
    ['Coherence on returning', 'AI estimate · assessed returns only', s => s.analysis?.returnContinuity ? pct(s.analysis.returnContinuity.correct, s.analysis.returnContinuity.assessed) : null, 'percent'],
    ['Failed coherence on returning', 'AI estimate · assessed returns only', s => s.analysis?.returnContinuity ? pct(s.analysis.returnContinuity.failed, s.analysis.returnContinuity.assessed) : null, 'percent'],
    ['Re-ask rate', 'AI estimate', s => s.analysis ? pct(s.analysis.reasks, s.analysis.questions) : null, 'percent'],
    ['Handoff continuity', 'AI estimate', s => s.analysis ? pct(s.analysis.continuityCorrect, s.analysis.continuityAssessed) : null, 'percent'],
    ['Failed handoffs', 'AI estimate · assessed handoffs only', s => s.analysis ? pct(s.analysis.continuityAssessed - s.analysis.continuityCorrect, s.analysis.continuityAssessed) : null, 'percent'],
    ['Cross-agent preference conflicts per 10 replies', 'AI estimate', s => s.analysis ? perTen(s.analysis.crossAgentConflicts, s.analysis.assistantTurns) : null, 'number'],
    ['Cross-agent preference application', 'AI estimate · relevant preference opportunities', s => s.analysis?.preferenceApplication ? pct(s.analysis.preferenceApplication.successful, s.analysis.preferenceApplication.assessed) : null, 'percent', 'preferenceApplication'],
    ['Correction carryover', 'AI estimate · relevant correction opportunities', s => s.analysis?.correctionCarryover ? pct(s.analysis.correctionCarryover.successful, s.analysis.correctionCarryover.assessed) : null, 'percent', 'correctionCarryover'],
    ['Missing-context handling', 'AI estimate · relevant missing-context opportunities', s => s.analysis?.contextHandling ? pct(s.analysis.contextHandling.successful, s.analysis.contextHandling.assessed) : null, 'percent', 'contextHandling'],
    ['Missed preference application', 'AI estimate · assessed opportunities only', s => s.analysis?.preferenceApplication ? pct(s.analysis.preferenceApplication.assessed - s.analysis.preferenceApplication.successful, s.analysis.preferenceApplication.assessed) : null, 'percent', 'preferenceApplication'],
    ['Superseded preference use', 'AI estimate · assessed opportunities only', s => s.analysis?.correctionCarryover ? pct(s.analysis.correctionCarryover.assessed - s.analysis.correctionCarryover.successful, s.analysis.correctionCarryover.assessed) : null, 'percent', 'correctionCarryover'],
    ['Unsupported personal claims', 'AI estimate · assessed opportunities only', s => s.analysis?.contextHandling ? pct(s.analysis.contextHandling.assessed - s.analysis.contextHandling.successful, s.analysis.contextHandling.assessed) : null, 'percent', 'contextHandling'],
    ['Saved-entry use', 'AI estimate · captured saved entries only', s => s.analysis ? pct(s.analysis.memoriesUsed, s.analysis.memoriesAvailable) : null, 'percent'],
    ['Volunteered facts per 10 user turns', 'AI estimate', s => s.analysis ? perTen(s.analysis.volunteeredFacts, s.analysis.userTurns) : null, 'number'],
    ['Turns spent re-explaining', 'AI estimate', s => s.analysis ? pct(s.analysis.wastedTurns, s.analysis.userTurns) : null, 'percent'],
    ['Handoff-prompted repetitions per 10 user turns', 'AI estimate · repeated user turns, not agent question counts', s => s.analysis?.repetition ? perTen(s.analysis.repetition.handoffPrompted, s.analysis.userTurns) : null, 'number'],
    ['Repetitions after agent re-asks per 10 user turns', 'AI estimate · repeated user turns, not agent question counts', s => s.analysis?.repetition ? perTen(s.analysis.repetition.agentReasked, s.analysis.userTurns) : null, 'number'],
    ['User-initiated repetitions per 10 user turns', 'AI estimate · repeated user turns, not agent question counts', s => s.analysis?.repetition ? perTen(s.analysis.repetition.userInitiated, s.analysis.userTurns) : null, 'number'],
    ['Unclear repetition origins per 10 user turns', 'AI estimate · repeated user turns, not agent question counts', s => s.analysis?.repetition ? perTen(s.analysis.repetition.unclear, s.analysis.userTurns) : null, 'number'],
    ['Final-plan feedback reported', 'AI estimate · reporting rate, not satisfaction score', s => s.analysis ? s.analysis.satisfactionReported ? 100 : 0 : null, 'percent'],
    ['Approved full plan', 'AI estimate · assessable session outcomes', s => s.analysis?.taskComplete == null ? null : s.analysis.taskComplete ? 100 : 0, 'percent'],
  ];
  // Each session contributes one value; longer conversations do not dominate.
  function build(reports) {
    const sessions = new Map();
    for (const report of reports) for (const session of report.sessions || []) sessions.set(`${report.nameId}:${session.id}`, { ...session, nameId: report.nameId });
    const groups = {};
    for (const condition of ['shared', 'isolated', 'unknown']) {
      const list = [...sessions.values()].filter(s => s.condition === condition);
      groups[condition] = { sessions: list.length, users: new Set(list.map(s => s.nameId)).size, analyzed: list.filter(s => s.analysis).length,
        metrics: measures.map(([label, basis, read, format, opportunityKey]) => {
          const values = list.map(read).filter(value => typeof value === 'number' && Number.isFinite(value));
          return { label, basis, format, ...(opportunityKey ? { opportunities: list.reduce((n,s) => n + (s.analysis?.[opportunityKey]?.opportunities || 0), 0), assessedOpportunities: list.reduce((n,s) => n + (s.analysis?.[opportunityKey]?.assessed || 0), 0) } : {}), n: values.length, mean: values.length ? values.reduce((n, v) => n + v, 0) / values.length : null };
        }) };
    }
    return { groups, sessions: [...sessions.values()], definitions: 'Equal-session descriptive means. Missing or unassessable measures stay missing, not zero. All sessions retained. Conditions come from the last recorded mode. Each Name ID is one session across all agents, devices and time gaps. These descriptive summaries are not significance tests. Return counts and words are behavioral indicators, not direct evidence of enjoyment or engagement; compare them with participant questionnaire feedback.' };
  }
  const needsAnalysis = session => !session.analysis || !session.analysis.preferenceApplication || !session.analysis.correctionCarryover || !session.analysis.contextHandling;
  window.MemoryComparison = { build, measures, needsAnalysis };
})();
