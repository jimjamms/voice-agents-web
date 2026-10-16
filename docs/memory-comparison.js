(() => {
  const pct = (n, d) => d && typeof n === 'number' ? n / d * 100 : null;
  const perTen = (n, d) => d && typeof n === 'number' ? n / d * 10 : null;
  const measures = [
    ['Words per user turn', 'Counted', s => s.wordsPerTurn, 'number'],
    ['Agent switches per session', 'Counted', s => s.switches, 'number'],
    ['Switches following a suggestion', 'Counted', s => pct(s.suggestedSwitches, s.switches), 'percent'],
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
    return { groups, sessions: [...sessions.values()], definitions: 'Equal-session descriptive means. Missing or unassessable measures stay missing, not zero. All sessions retained. Conditions come from the last recorded mode. Each Name ID is one session across all agents, devices and time gaps. These descriptive summaries are not significance tests.' };
  }
  const needsAnalysis = session => !session.analysis || !session.analysis.preferenceApplication || !session.analysis.correctionCarryover || !session.analysis.contextHandling;
  window.MemoryComparison = { build, measures, needsAnalysis };
})();
