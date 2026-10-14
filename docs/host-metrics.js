(() => {
  const dialog = document.querySelector('#metrics-dialog');
  const status = document.querySelector('#metrics-status');
  const analyze = document.querySelector('#analyze-metrics');
  const download = document.querySelector('#download-metrics');
  const cache = new Map();
  let sessionId = '';
  let selected = '', report = null, generation = 0, busy = false;
  const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
  const ratio = (used, total) => total ? `${used}/${total} · ${Math.round(used / total * 100)}%` : 'Not assessable';
  function card(parent, title, value, description, basis) {
    const tile = node('article', '', 'metric-card');
    tile.append(node('h4', title), node('strong', String(value)), node('p', description), node('small', basis));
    parent.append(tile);
  }
  function render(data) {
    report = data;
    if (!data.sessions?.some(s => s.id === sessionId)) sessionId = data.sessions?.at(-1)?.id || '';
    const current = data.sessions?.find(s => s.id === sessionId), ids = new Set(current?.turnIds || []);
    const picker = document.querySelector('#metrics-session'); picker.replaceChildren();
    for (const session of data.sessions || []) { const option = node('option', `${new Date(session.startedAt).toLocaleString()} · ${session.condition === 'isolated' ? 'Separate' : session.condition === 'shared' ? 'Shared' : 'Unknown'}`); option.value = session.id; picker.append(option); }
    picker.value = sessionId;
    document.querySelector('#metrics-condition').textContent = current ? `${current.condition === 'isolated' ? 'Separate' : current.condition === 'shared' ? 'Shared' : 'Unknown'} · last mode used` : 'No chat session recorded';
    const s = current ? { ...data.summary, userTurns: current.userTurns, userWords: current.userWords, wordsPerTurn: current.wordsPerTurn == null ? null : Math.round(current.wordsPerTurn * 10) / 10,
      switches: { tracked: current.switches, suggested: current.suggestedSwitches, manual: current.switches - current.suggestedSwitches, inferred: data.summary.handoffs.filter(h => h.inferred && ids.has(h.turn_id)).length, events: data.summary.switches.events.filter(e => ids.has(e.id)) }, task: null } : data.summary;
    const a = current ? data.sessionAnalyses?.[current.id] || null : data.analysis, scores = current ? current.analysis : a?.scores;
    const objective = document.querySelector('#objective-metrics'), subjective = document.querySelector('#subjective-metrics');
    objective.replaceChildren(); subjective.replaceChildren();
    const waiting = '—';
    card(objective, 'Re-ask rate', scores ? ratio(scores.reasks, scores.questions) : waiting, 'Question turns that re-ask facts given to the other agent, divided by all analyzed question turns.', 'AI estimate');
    card(objective, 'Handoff continuity', scores ? ratio(scores.continuityCorrect, scores.continuityAssessed) : waiting, 'First replies after a switch that continue the previous conversation correctly.', 'AI estimate · unassessable replies excluded');
    card(objective, 'Preference violations', scores ? scores.violations : waiting, 'Agent turns suggesting something that conflicts with a fact available at that point.', 'AI estimate');
    card(objective, 'Memory utilization', scores ? ratio(scores.memoriesUsed, scores.memoriesAvailable) : waiting, 'Relevant uses of stored memory facts captured per response. Older turns without snapshots are excluded.', 'AI estimate · per-turn memory context');
    card(objective, 'Agent switches', s.switches.tracked, `${s.switches.suggested} with a suggestion highlighted · ${s.switches.manual} without. ${s.switches.inferred} additional untracked transitions (inferred).`, 'Tracked count · every recorded switch is user initiated');
    card(subjective, 'User words per turn', s.wordsPerTurn ?? 'No user turns', `${s.userWords} words across ${s.userTurns} user turns. Excludes greetings and switch events.`, 'Counted from transcripts');
    card(subjective, 'Volunteered facts', scores ? scores.volunteeredFacts : waiting, 'Distinct user facts volunteered without a preceding request. This is a proxy for self-disclosure.', 'AI estimate');
    card(subjective, 'Re-explaining', scores ? `${scores.wastedTurns} turns · ${scores.wastedWords} words` : waiting,
      scores?.wastedSpeechSeconds != null ? `${scores.wastedSpeechSeconds}s of recording across ${scores.wastedTurnsWithDuration} flagged turns. Includes pauses; other durations unavailable.` : 'Re-explanations of earlier information. Duration is unavailable without recorded timing.', 'AI estimate · “wasted” turns');
    if (current) card(subjective, 'Session task outcome', current.analysis?.taskComplete === true ? 'Approved plan' : current.analysis?.taskComplete === false ? 'Needs revision' : 'Not assessed', 'Completion requires explicit approval of the complete itinerary in this session. Current profile alone is insufficient.', 'AI estimate · session evidence');
    else card(subjective, 'Current saved trip', s.task ? `${s.task.completed}/${s.task.total}${s.task.ready ? ' · Complete' : ''}` : 'No saved trip', 'Country, two cities, activity per city, budget, and approved itinerary.', 'Saved trip checklist');
    card(subjective, 'Final-plan satisfaction', a ? (a.satisfaction.length ? 'Reported' : 'Not reported') : '—', a?.satisfaction.length ? a.satisfaction.map(v => `“${v.quote}”`).join(' ') : 'Only explicit feedback about the final plan qualifies. No rating is inferred.', 'User self-report');
    document.querySelector('#metrics-coverage').textContent = `${current ? current.records + ' records in this session · ' : ''}${data.countedRecords} of ${data.totalRecords} saved records counted${a ? ` · AI estimates cover the latest ${a.sampledRecords} records` : ''}.`;
    const evidence = document.querySelector('#metrics-evidence'); evidence.replaceChildren();
    if (current?.conditionNote) evidence.append(node('p', current.conditionNote));
    evidence.append(node('p', data.sessionDefinition || ''));
    evidence.append(node('p', 'Counts come from saved data. AI estimates need review. Shared and separate modes are labeled on each finding. Older switch initiation and memory availability cannot be reconstructed reliably. Memory utilization counts saved entries; an entry may summarize several facts.'));
    const timeline = node('details', '', 'finding-group'); timeline.append(node('summary', `Switch timeline (${s.switches.tracked})`));
    for (const event of s.switches.events || []) timeline.append(node('p', `${new Date(event.timestamp).toLocaleString()} · ${event.from} → ${event.to} · user ${event.source} click${event.suggested ? ' · suggestion highlighted' : ' · manual'}`));
    evidence.append(timeline);
    if (s.task) evidence.append(node('p', s.task.requirements.map(r => `${r.complete ? '✓' : '○'} ${r.label}`).join(' · ')));
    if (!current) for (const group of s.byAgentAndMode) evidence.append(node('p', `${group.agent} · ${group.mode === 'isolated' ? 'separate' : 'shared'}: ${group.wordsPerTurn} words/turn across ${group.turns} turns.`));
    if (a) for (const [key, title] of [['reasks','Re-asks'], ['continuity','Continuity'], ['violations','Preference violations'], ['memory_use','Memory used'], ['volunteered','Volunteered facts'], ['wasted','Re-explanations'], ['satisfaction','Satisfaction'], ['cross_agent_conflicts','Cross-agent preference conflicts'], ['task_outcomes','Session task outcome']]) {
      const section = node('details', '', 'finding-group'); section.append(node('summary', `${title} (${a[key]?.length || 0})`));
      if (!a[key]?.length) section.append(node('p', 'No supported findings in the analyzed window.'));
      for (const item of a[key] || []) {
        const entry = node('article', '', 'metric-finding');
        entry.append(node('strong', `${item.agent} · ${item.mode === 'isolated' ? 'separate' : 'shared'} · ${item.turn_id}`));
        if (item.fact || item.quote) entry.append(node('p', item.fact || item.quote));
        if (item.reason) entry.append(node('p', item.reason));
        if (item.source_user_text) entry.append(node('blockquote', `Earlier user: ${item.source_user_text}`));
        if (item.user_text) entry.append(node('blockquote', `User: ${item.user_text}`));
        if (item.agent_reply) entry.append(node('blockquote', `Agent: ${item.agent_reply}`));
        section.append(entry);
      }
      evidence.append(section);
    }
    card(objective, 'Cross-agent preference conflicts', scores?.crossAgentConflicts ?? '—', 'Suggestions conflicting with a preference told to the other agent in this session, even if unavailable in separate mode.', 'AI estimate · user experience');
    analyze.disabled = !s.userTurns; download.disabled = false;
  }
  async function load(analyzeConversation = false) {
    if (busy) return;
    const key = document.querySelector('#host-key').value.trim(), base = window.VOICE_DEMO_CONFIG?.apiBaseUrl;
    if (!key || !base) { status.textContent = 'Enter your host key to view metrics.'; return; }
    busy = true; analyze.disabled = download.disabled = true;
    const token = ++generation, name = selected;
    status.textContent = analyzeConversation ? 'Analyzing conversation…' : 'Loading metrics…';
    try {
      const url = new URL(`${base.replace(/\/$/, '')}/logs/metrics`); url.searchParams.set('speaker', name); if (analyzeConversation && sessionId) url.searchParams.set('session', sessionId);
      const response = await fetch(url, { method: analyzeConversation ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}` } });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Metrics failed.');
      if (token !== generation || name !== selected) return;
      retainSessionAnalyses(data, cache.get(name));
      cache.set(name, data); render(data);
      status.textContent = analyzeConversation ? 'Analysis ready. Review the evidence below.' : 'Counts ready. AI analysis estimates the other metrics and uses API credits.';
    } catch (error) { if (token === generation) status.textContent = error.message || 'Could not load metrics.'; }
    finally { busy = false; if (token === generation) { const active = report?.sessions?.find(s => s.id === sessionId); analyze.disabled = report ? !(active ? active.userTurns : report.summary.userTurns) : false; download.disabled = !report; } }
  }
  function retainSessionAnalyses(data, previous) {
    data.sessionAnalyses = {};
    for (const session of data.sessions || []) {
      const older = previous?.sessions?.find(s => s.id === session.id);
      if (!session.analysis && older?.analysis && session.fingerprint === older.fingerprint) {
        session.analysis = older.analysis; data.sessionAnalyses[session.id] = previous.sessionAnalyses?.[session.id];
      } else if (session.analysis && data.analysis) {
        const ids = new Set(session.turnIds);
        const scoped = { ...data.analysis, scores: session.analysis };
        for (const key of ['reasks','continuity','violations','memory_use','volunteered','wasted','satisfaction','cross_agent_conflicts','task_outcomes']) scoped[key] = (data.analysis[key] || []).filter(v => ids.has(v.turn_id));
        data.sessionAnalyses[session.id] = scoped;
      }
    }
  }
  document.querySelector('#metrics-session').addEventListener('change', event => { sessionId = event.target.value; if (report) render(report); });
  window.openUserMetrics = async (name, requestedId = '') => {
    if (busy) { status.textContent = 'Finish the current metrics request before selecting another user.'; if (!dialog.open) dialog.showModal?.(); return; }
    selected = name; sessionId = requestedId; report = null; analyze.disabled = download.disabled = true;
    document.querySelector('#metrics-heading').textContent = name;
    document.querySelector('#objective-metrics').replaceChildren(); document.querySelector('#subjective-metrics').replaceChildren(); document.querySelector('#metrics-evidence').replaceChildren();
    document.querySelector('#metrics-coverage').textContent = '';
    if (!dialog.open) dialog.showModal?.();
    if (cache.has(name)) { render(cache.get(name)); status.textContent = 'Saved for this page session. Analyze again to refresh.'; return; }
    await load();
  };
  window.invalidateUserMetrics = name => { cache.delete(name); if (selected === name) { report = null; download.disabled = true; } };
  document.querySelector('#close-metrics').addEventListener('click', () => dialog.close());
  analyze.addEventListener('click', () => { void load(true); });
  download.addEventListener('click', () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `metrics-${selected.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const comparison = document.querySelector('#comparison-dialog');
  const comparisonStatus = document.querySelector('#comparison-status');
  let comparisonData = null, cancelComparison = false;
  function renderComparison() {
    comparisonData = window.MemoryComparison.build([...cache.values()]);
    const groups = comparisonData.groups, table = document.querySelector('#comparison-table'); table.replaceChildren();
    const modes = ['shared', 'isolated', ...(groups.unknown.sessions ? ['unknown'] : [])];
    const head = node('thead', ''), header = node('tr', ''); header.append(node('th', 'Measure'));
    for (const mode of modes) { const th = node('th', mode === 'shared' ? 'Shared' : mode === 'isolated' ? 'Separate' : 'Unknown'); th.append(node('small', `${groups[mode].sessions} sessions · ${groups[mode].users} users`)); header.append(th); }
    header.append(node('th', 'Shared − Separate'));
    head.append(header); table.append(head); const body = node('tbody', '');
    for (let i = 0; i < groups.shared.metrics.length; i++) {
      const row = node('tr', ''), metric = groups.shared.metrics[i], label = node('th', metric.label); label.append(node('small', metric.basis)); row.append(label);
      for (const mode of modes) { const value = groups[mode].metrics[i]; const cell = node('td', value.mean == null ? 'Not assessed' : `${value.mean.toFixed(1)}${value.format === 'percent' ? '%' : ''}`); cell.append(node('small', `n = ${value.n} sessions`)); row.append(cell); }
      const shared = groups.shared.metrics[i], separate = groups.isolated.metrics[i];
      const delta = shared.mean == null || separate.mean == null ? null : shared.mean - separate.mean;
      row.append(node('td', delta == null ? 'Not assessed' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}${metric.format === 'percent' ? ' pp' : ''}`));
      body.append(row);
    }
    table.append(body);
    const sessions = document.querySelector('#comparison-sessions'); sessions.replaceChildren();
    sessions.append(node('p', 'Sessions are inferred per device with a 30-minute inactivity gap. Reports stay in this page until refresh; download them to keep results. Percentage differences are percentage points (pp).'));
    for (const session of comparisonData.sessions) {
      const entry = node('div', '', 'comparison-session');
      entry.append(node('strong', `${session.nameId} · ${session.condition === 'isolated' ? 'Separate' : session.condition === 'shared' ? 'Shared' : 'Unknown'}`));
      entry.append(node('p', `${new Date(session.startedAt).toLocaleString()} · ${session.userTurns} user turns · ${session.analysis ? session.analysis.sampledRecords + '/' + session.records + ' records analyzed' : 'Counts only'}${session.conditionNote ? ' · ' + session.conditionNote : ''}`));
      const view = node('button', 'View session'); view.type = 'button'; view.addEventListener('click', () => { if (busy) return; comparison.close(); void window.openUserMetrics(session.nameId, session.id); }); entry.append(view); sessions.append(entry);
    }
    const analyzed = comparisonData.sessions.filter(s => s.analysis).length;
    document.querySelector('#comparison-coverage').textContent = `${cache.size} users loaded · ${comparisonData.sessions.length} sessions retained · ${analyzed} sessions analyzed. Counts use each report’s available window; estimates use its analyzed sample.`;
    document.querySelector('#download-comparison').disabled = !cache.size;
    document.querySelector('#analyze-comparison').disabled = busy || !comparisonData.sessions.some(s => s.userTurns && !s.analysis);
  }
  function comparisonBusy(value) {
    busy = value; document.querySelector('#load-comparison').disabled = value;
    document.querySelector('#analyze-comparison').disabled = value; document.querySelector('#download-comparison').disabled = value;
  }
  async function fetchReport(name, session = null) {
    const key = document.querySelector('#host-key').value.trim(), base = window.VOICE_DEMO_CONFIG?.apiBaseUrl;
    if (!key || !base) throw new Error('Enter your host key above.');
    const url = new URL(`${base.replace(/\/$/, '')}/logs/metrics`); url.searchParams.set('speaker', name); if (session) url.searchParams.set('session', session);
    const response = await fetch(url, { method: session ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}` } });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Metrics failed.');
    retainSessionAnalyses(data, cache.get(name)); cache.set(name, data); return data;
  }
  async function loadGroups() {
    if (busy) return; cancelComparison = false; comparisonBusy(true);
    try {
      const key = document.querySelector('#host-key').value.trim(), base = window.VOICE_DEMO_CONFIG?.apiBaseUrl;
      if (!key || !base) throw new Error('Enter your host key above.');
      const names = [], cursors = new Set(); let cursor = null;
      do {
        const url = new URL(`${base.replace(/\/$/, '')}/logs/users`); if (cursor) url.searchParams.set('cursor', cursor);
        const response = await fetch(url, { headers: { authorization: `Bearer ${key}` } }); const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load users.');
        for (const user of data.users || []) if (!names.includes(user.nameId)) names.push(user.nameId);
        cursor = data.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('User pagination repeated. Reload the page.');
        if (cursor) cursors.add(cursor);
      } while (cursor && !cancelComparison);
      const failures = [];
      for (const [index, name] of names.entries()) {
        if (cancelComparison) break;
        comparisonStatus.textContent = `Loading user ${index + 1}/${names.length}…`;
        try { if (!cache.has(name)) await fetchReport(name); } catch (error) { failures.push(`${name}: ${error.message}`); }
        renderComparison();
      }
      comparisonStatus.textContent = cancelComparison ? 'Loading stopped. Loaded reports are retained.' : failures.length ? `Could not load ${failures.length} users: ${failures.join('; ')}` : 'Counts loaded. Analyze sessions to compare conversation estimates.';
    } catch (error) { comparisonStatus.textContent = error.message; }
    finally { comparisonBusy(false); renderComparison(); }
  }
  async function analyzeGroups() {
    if (busy) return; cancelComparison = false;
    const queue = window.MemoryComparison.build([...cache.values()]).sessions.filter(s => s.userTurns && !s.analysis);
    comparisonBusy(true);
    try {
      for (const [index, session] of queue.entries()) {
        if (cancelComparison) break;
        comparisonStatus.textContent = `Analyzing session ${index + 1}/${queue.length} · ${session.nameId}…`;
        await fetchReport(session.nameId, session.id); renderComparison();
      }
      comparisonStatus.textContent = cancelComparison ? 'Analysis stopped. Completed results are retained.' : 'Comparison ready. Review the evidence; these are descriptive estimates, not a significance test.';
    } catch (error) { comparisonStatus.textContent = `${error.message} Completed results are retained; press Analyze sessions to continue the remaining queue.`; }
    finally { comparisonBusy(false); renderComparison(); }
  }
  document.querySelector('#compare-memory').addEventListener('click', () => { if (busy) return; renderComparison(); comparisonStatus.textContent = 'Load saved users, then analyze sessions. Previously viewed reports are already included.'; comparison.showModal?.(); });
  document.querySelector('#close-comparison').addEventListener('click', () => { cancelComparison = true; comparison.close(); });
  comparison.addEventListener('cancel', () => { cancelComparison = true; });
  document.querySelector('#load-comparison').addEventListener('click', () => { void loadGroups(); });
  document.querySelector('#analyze-comparison').addEventListener('click', () => { void analyzeGroups(); });
  document.querySelector('#download-comparison').addEventListener('click', () => {
    if (!comparisonData) return;
    const payload = { ...comparisonData, generatedAt: new Date().toISOString(), reports: [...cache.values()] };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'shared-vs-separate-metrics.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
