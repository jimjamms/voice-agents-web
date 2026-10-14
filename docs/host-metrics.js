(() => {
  const dialog = document.querySelector('#metrics-dialog');
  const status = document.querySelector('#metrics-status');
  const analyze = document.querySelector('#analyze-metrics');
  const download = document.querySelector('#download-metrics');
  const cache = new Map();
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
    const s = data.summary, a = data.analysis, scores = a?.scores;
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
    card(subjective, 'Task outcome', s.task ? `${s.task.completed}/${s.task.total}${s.task.ready ? ' · Complete' : ''}` : 'No saved trip', 'Country, two cities, activity per city, budget, and approved itinerary.', 'Saved trip checklist');
    card(subjective, 'Final-plan satisfaction', a ? (a.satisfaction.length ? 'Reported' : 'Not reported') : '—', a?.satisfaction.length ? a.satisfaction.map(v => `“${v.quote}”`).join(' ') : 'Only explicit feedback about the final plan qualifies. No rating is inferred.', 'User self-report');
    document.querySelector('#metrics-coverage').textContent = `${data.countedRecords} of ${data.totalRecords} saved records counted${a ? ` · AI estimates cover the latest ${a.sampledRecords} records` : ''}.`;
    const evidence = document.querySelector('#metrics-evidence'); evidence.replaceChildren();
    evidence.append(node('p', 'Counts come from saved data. AI estimates need review. Shared and separate modes are labeled on each finding. Older switch initiation and memory availability cannot be reconstructed reliably. Memory utilization counts saved entries; an entry may summarize several facts.'));
    const timeline = node('details', '', 'finding-group'); timeline.append(node('summary', `Switch timeline (${s.switches.tracked})`));
    for (const event of s.switches.events || []) timeline.append(node('p', `${new Date(event.timestamp).toLocaleString()} · ${event.from} → ${event.to} · user ${event.source} click${event.suggested ? ' · suggestion highlighted' : ' · manual'}`));
    evidence.append(timeline);
    if (s.task) evidence.append(node('p', s.task.requirements.map(r => `${r.complete ? '✓' : '○'} ${r.label}`).join(' · ')));
    for (const group of s.byAgentAndMode) evidence.append(node('p', `${group.agent} · ${group.mode === 'isolated' ? 'separate' : 'shared'}: ${group.wordsPerTurn} words/turn across ${group.turns} turns.`));
    if (a) for (const [key, title] of [['reasks','Re-asks'], ['continuity','Continuity'], ['violations','Preference violations'], ['memory_use','Memory used'], ['volunteered','Volunteered facts'], ['wasted','Re-explanations'], ['satisfaction','Satisfaction']]) {
      const section = node('details', '', 'finding-group'); section.append(node('summary', `${title} (${a[key].length})`));
      if (!a[key].length) section.append(node('p', 'No supported findings in the analyzed window.'));
      for (const item of a[key]) {
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
      const url = new URL(`${base.replace(/\/$/, '')}/logs/metrics`); url.searchParams.set('speaker', name);
      const response = await fetch(url, { method: analyzeConversation ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}` } });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Metrics failed.');
      if (token !== generation || name !== selected) return;
      cache.set(name, data); render(data);
      status.textContent = analyzeConversation ? 'Analysis ready. Review the evidence below.' : 'Counts ready. AI analysis estimates the other metrics and uses API credits.';
    } catch (error) { if (token === generation) status.textContent = error.message || 'Could not load metrics.'; }
    finally { busy = false; if (token === generation) { analyze.disabled = report ? !report.summary.userTurns : false; download.disabled = !report; } }
  }
  window.openUserMetrics = async name => {
    if (busy) { status.textContent = 'Finish the current metrics request before selecting another user.'; if (!dialog.open) dialog.showModal?.(); return; }
    selected = name; report = null; analyze.disabled = download.disabled = true;
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
})();
