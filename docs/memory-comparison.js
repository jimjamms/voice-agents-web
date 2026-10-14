(() => {
  const pct = (n, d) => d && typeof n === 'number' ? n / d * 100 : null;
  const perTen = (n, d) => d && typeof n === 'number' ? n / d * 10 : null;
  const measures = [
    ['Words per user turn', 'Counted', s => s.wordsPerTurn, 'number'],
    ['Agent switches per session', 'Counted', s => s.switches, 'number'],
    ['Switches following a suggestion', 'Counted', s => pct(s.suggestedSwitches, s.switches), 'percent'],
    ['Re-ask rate', 'AI estimate · lower is better', s => s.analysis ? pct(s.analysis.reasks, s.analysis.questions) : null, 'percent'],
    ['Handoff continuity', 'AI estimate · higher is better', s => s.analysis ? pct(s.analysis.continuityCorrect, s.analysis.continuityAssessed) : null, 'percent'],
    ['Cross-agent preference conflicts per 10 replies', 'AI estimate · lower is better', s => s.analysis ? perTen(s.analysis.crossAgentConflicts, s.analysis.assistantTurns) : null, 'number'],
    ['Available-memory use', 'AI estimate · higher is better', s => s.analysis ? pct(s.analysis.memoriesUsed, s.analysis.memoriesAvailable) : null, 'percent'],
    ['Volunteered facts per 10 user turns', 'AI estimate', s => s.analysis ? perTen(s.analysis.volunteeredFacts, s.analysis.userTurns) : null, 'number'],
    ['Turns spent re-explaining', 'AI estimate · lower is better', s => s.analysis ? pct(s.analysis.wastedTurns, s.analysis.userTurns) : null, 'percent'],
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
        metrics: measures.map(([label, basis, read, format]) => {
          const values = list.map(read).filter(value => typeof value === 'number' && Number.isFinite(value));
          return { label, basis, format, n: values.length, mean: values.length ? values.reduce((n, v) => n + v, 0) / values.length : null };
        }) };
    }
    return { groups, sessions: [...sessions.values()], definitions: 'Equal-session descriptive means. Missing or unassessable measures stay missing, not zero. All sessions retained. Conditions come from the last recorded mode. Sessions are inferred per browser/device with a 30-minute inactivity gap. These descriptive summaries are not significance tests.' };
  }
  window.MemoryComparison = { build, measures };
})();
