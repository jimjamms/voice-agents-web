(() => {
  const switchAgent = document.querySelector('#switch-agent');
  const optionalModes = {
    realtime: window.VOICE_DEMO_CONFIG?.showRealtime === true,
    handsFree: window.VOICE_DEMO_CONFIG?.showHandsFree === true,
  };
  document.querySelector('.engine-row').hidden = !optionalModes.realtime;
  document.querySelector('.mode-row').hidden = !optionalModes.handsFree;
  const cards = [...document.querySelectorAll('[data-agent]')];
  const messages = document.querySelector('#messages');
  const record = document.querySelector('#record');
  const recordLabel = document.querySelector('#record-label');
  const status = document.querySelector('#status');
  const hint = document.querySelector('#hint');
  const playback = document.querySelector('#playback');
  const disconnectButton = document.querySelector('#disconnect');
  const codeInput = document.querySelector('#access-code');
  const title = document.querySelector('#conversation-title');
  const tapMode = document.querySelector('#tap-mode');
  const handsfreeMode = document.querySelector('#handsfree-mode');
  const realtimeEngine = document.querySelector('#realtime-engine');
  const pipelineEngine = document.querySelector('#pipeline-engine');
  const engineDescription = document.querySelector('#engine-description');
  const speakerControls = document.querySelector('#speaker-controls');
  const speakerName = document.querySelector('#speaker-name');
  const memoryMode = document.querySelector('#memory-mode');
  const sharedMemory = document.querySelector('#shared-memory');
  const isolatedMemory = document.querySelector('#isolated-memory');
  const memoryDescription = document.querySelector('#memory-description');
  const memoryStatus = document.querySelector('#memory-status');
  const turns = [];
  const deletedNames = new Set();
  let sessionId = crypto.randomUUID();
  let agent = 'sage', engine = 'pipeline', handsFree = false, history = [], pc, channel, mic, micTrack, connected = false;
  const conversations = new Map();
  const welcomedConversations = new Set();
  const chatStartsByName = new Map();
  const sharedBootstrapNames = new Set();
  const conversationKey = () => JSON.stringify([speakerName.value.trim().toLowerCase() || 'unknown', memoryMode.value, engine, agent]);
  let activeConversationKey = conversationKey();
  let tripCompletionPending = false;
  const tripNotes = window.createTripNotes?.({
    textarea: document.querySelector('#trip-notes'), status: document.querySelector('#notes-status'),
    copy: document.querySelector('#copy-notes'), clear: document.querySelector('#clear-notes'),
    speaker: () => speakerName.value.trim(), base: () => window.VOICE_DEMO_CONFIG?.apiBaseUrl,
    code: () => codeInput.value.trim(),
    onPersist: key => window.onTripProfileChange?.(key),
    onChange: snapshot => {
      window.dispatchEvent(new CustomEvent('trip-notes:updated', { detail: snapshot }));
      if (!snapshot.ready) tripCompletionPending = false;
      else if (snapshot.updated && document.body.dataset.stage === 'planning') {
        tripCompletionPending = true; maybeCompleteTrip();
      }
    },
  });
  const remoteLogger = window.createRemoteLogger?.({ base: () => window.VOICE_DEMO_CONFIG?.apiBaseUrl, code: () => codeInput.value.trim(), status: document.querySelector('#host-log-status') });
  codeInput.addEventListener('change', () => remoteLogger?.flush());
  let pipeline;
  let enrolling = false;
  let connecting = false, recording = false, responseActive = false, sessionTimer, turnTimer;
  let manualStartedAt = 0, connectionId = 0;
  const setStatus = (message, detail) => { status.textContent = message; if (detail) hint.textContent = detail; };
  const renderMessage = (role, content, speaker, allowEmpty = false) => {
    const text = String(content || '').trim();
    if (!text && !allowEmpty) return;
    messages.querySelector('.empty-state')?.remove();
    const item = document.createElement('div'); item.className = `message ${role}`;
    const label = document.createElement('span'); label.className = 'sender';
    label.textContent = role === 'user' ? (speaker?.name && speaker.name !== 'Unknown' ? speaker.name : 'You') : agent === 'sage' ? 'Sage' : 'Astra';
    const body = document.createElement('span'); body.textContent = text;
    item.append(label, body); messages.append(item); messages.scrollTop = messages.scrollHeight;
    return body;
  };
  function highlightHandoff(reply) {
    const other = agent === 'sage' ? 'Astra' : 'Sage';
    const sentences = String(reply || '').split(/[.!?\n]+/);
    const invitation = new RegExp(`\\b(?:switch(?:ing)?(?: back| over)? to|return(?:ing)? to|go(?:ing)? back to|talk(?:ing)? (?:to|with)|speak(?:ing)? (?:to|with)|chat(?:ting)? (?:to|with)|ask|try|let|hand(?:ing)? (?:this |you )?(?:over )?to|recommend|suggest)\\b[^.!?]{0,65}\\b${other}\\b`, 'i');
    const offer = new RegExp(`\\b${other}\\b[^.!?]{0,45}\\b(?:can help|could help|can finalize|can plan|can work|can check|is better|would be better|is best|would help)\\b`, 'i');
    const suggested = sentences.some(sentence =>
      !/\b(?:don't|do not|no need to|shouldn't|should not|needn't)\b/i.test(sentence) &&
      (invitation.test(sentence) || offer.test(sentence)));
    switchAgent.dataset.suggested = String(suggested);
    switchAgent.setAttribute('aria-label', `${suggested ? 'Suggested next: ' : ''}Switch to ${other}`);
  }
  const addMessage = (role, content, speaker) => {
    const text = String(content || '').trim();
    if (!text) return;
    if (role === 'assistant') highlightHandoff(text);
    const body = renderMessage(role, text, speaker);
    history.push({ role, content: text, at: new Date().toISOString(),
      ...(speaker && { speaker: speaker.name, speaker_score: Math.round(speaker.score * 1000) / 1000 }) });
    return body;
  };
  function planningRound() {
    const choices = tripNotes?.snapshot?.(speakerName.value.trim())?.choices || {};
    const first = choices.cities?.[0];
    if (!choices.countries?.length || !first || !choices.cityActivities?.[first]) return 'first-choice';
    if (choices.finalized && choices.cities.length >= 2 && choices.cities.every(city => choices.cityActivities?.[city])) return 'final-plan';
    if (!choices.firstCityReviewed) return 'first-review';
    if (choices.cities.length < 2 || choices.cities.some(city => !choices.cityActivities?.[city])) return 'second-choice';
    return 'final-plan';
  }
  pipeline = window.createPipelineTransport({
    agent: () => agent, isSelected: () => engine === 'pipeline', isHandsFree: () => handsFree,
    history: () => history, code: () => codeInput.value.trim(),
    focusCode: () => codeInput.focus(), base: () => window.VOICE_DEMO_CONFIG?.apiBaseUrl,
    speaker: () => speakerName.value.trim() || 'Unknown', memoryMode: () => memoryMode.value,
    sharedTurns: () => memoryMode.value === 'shared' ? window.AgentMemory.recentShared?.(speakerName.value.trim()) || [] : [],
    memories: () => window.AgentMemory.entries(speakerName.value.trim(), memoryMode.value, agent),
    tripChoices: () => tripNotes?.snapshot?.(speakerName.value.trim())?.choices || {},
    tripNotes: () => tripNotes?.snapshot?.(speakerName.value.trim())?.notes || '',
    planningRound,
    onTurn: saveTurn, onInterrupt: markInterrupted,
    playback, onStatus: setStatus, getStatus: () => status.textContent,
    onReplyStart: reply => {
      const body = addMessage('assistant', reply); body.textContent = '…';
      return text => { body.textContent = text || '…'; messages.scrollTop = messages.scrollHeight; };
    },
    onMessage: addMessage, onState: () => syncControls(),
  });
  const tripCloud = window.createTripCloud?.({
    base: () => window.VOICE_DEMO_CONFIG?.apiBaseUrl, code: () => codeInput.value.trim(),
    status: document.querySelector('#cloud-status'),
    snapshot: name => ({ ...tripNotes.snapshot(name), memories: window.AgentMemory.snapshot(name), chatStarts: chatStartsByName.get(name) || {}, reviewed: window.tripWasReviewed?.(name) === true }),
    apply: (name, profile) => { if (profile.memories.recentShared === undefined && profile.memories.shared?.length) sharedBootstrapNames.add(name); else sharedBootstrapNames.delete(name); chatStartsByName.set(name, profile.chatStarts || {}); window.AgentMemory.restore(name, profile.memories); tripNotes.restore(name, profile); window.dispatchEvent(new CustomEvent('trip-profile:loaded', { detail: { name, reviewed: profile.reviewed === true, generation: profile.generation || 0 } })); },
    chats: restoreChats,
    onDeleted: (name, message) => {
      deletedNames.add(name); remoteLogger?.forget(name);
      for (const key of conversations.keys()) if (JSON.parse(key)[0] === name) conversations.delete(key);
      if (speakerName.value.trim().toLowerCase() !== name) return;
      tripCompletionPending = false; reset();
      document.querySelector('#completed-notes').value = '';
      window.dispatchEvent(new CustomEvent('trip-profile:deleted', { detail: { name, message } }));
    },
  });
  window.restoreTripProfile = async name => { await tripNotes?.queue; await remoteLogger?.flush(); await tripCloud?.load(name); deletedNames.delete(name.trim().toLowerCase()); };
  function maybeCompleteTrip() {
    if (!tripCompletionPending || pipeline?.busy || pipeline?.playing || pipeline?.recording || connecting || recording || responseActive) return;
    tripCompletionPending = false;
    window.dispatchEvent(new Event('trip-goal:complete'));
  }
  function syncControls() {
    document.querySelector('.conversation').dataset.agent = agent;
    document.querySelector('.trip-notepad').dataset.companion = agent;
    const checklist = document.querySelector('.planning-checklist');
    if (checklist) checklist.dataset.companion = agent;
    const locked = enrolling || (engine === 'pipeline' ? pipeline.isLocked() : connecting || connected);
    realtimeEngine.disabled = pipelineEngine.disabled = locked;
    cards.forEach(card => { card.disabled = locked; card.hidden = card.dataset.agent !== agent; card.dataset.speaking = String(card.dataset.agent === agent && (engine === 'pipeline' ? Boolean(pipeline.playing) : responseActive)); });
    document.querySelector('.agent-options').dataset.companion = agent;
    switchAgent.disabled = enrolling || (engine === 'pipeline' && (pipeline.connecting || (pipeline.busy && !pipeline.playing)));
    const switchLabel = `Switch to ${agent === 'sage' ? 'Astra' : 'Sage'}`;
    document.querySelector('#switch-agent-label').textContent = switchLabel;
    switchAgent.setAttribute('aria-label', `${switchAgent.dataset.suggested === 'true' ? 'Suggested next: ' : ''}${switchLabel}`);
    if (engine === 'pipeline') {
      tapMode.disabled = handsfreeMode.disabled = locked;
      disconnectButton.hidden = true;
      record.disabled = pipeline.connecting || (pipeline.busy && !pipeline.active);
      if (enrolling) record.disabled = true;
      record.classList.toggle('recording', pipeline.recording || pipeline.active);
      recordLabel.textContent = pipeline.connecting ? 'Opening microphone…' :
        handsFree ? (pipeline.active ? 'Stop hands-free' : 'Start hands-free') :
        pipeline.playing ? 'Interrupt & talk' : pipeline.pendingPlayback ? 'Hear greeting / reply' : pipeline.busy ? 'Thinking…' : pipeline.recording ? 'Stop & send' : 'Start talking';
    }
    sharedMemory.disabled = isolatedMemory.disabled = locked;
    speakerName.disabled = memoryMode.disabled = document.querySelector('#forget-memory').disabled = locked;
    maybeCompleteTrip();
  }
  function markInterrupted() {
    const last = turns.at(-1); if (last) { last.interrupted = true; remoteLogger?.record(last); }
  }
  function saveTurn(turn) {
    if (deletedNames.has(turn.speaker?.trim().toLowerCase())) return;
    if (turn.greeting) welcomedConversations.add(activeConversationKey);
    const sharedTurns = turn.mode === 'shared' ? window.AgentMemory.recentShared?.(turn.speaker) || [] : [];
    const priorConversation = sharedTurns.length ?
      sharedTurns.slice(-4).flatMap(item => [
        { role: 'user', content: item.transcript, agent: item.agent }, { role: 'assistant', content: item.reply, agent: item.agent },
      ]) : history.slice(-8).map(item => ({ role: item.role, content: item.content, agent: turn.agent }));
    if (!turn.greeting) {
      window.AgentMemory.recordShared?.(turn.speaker, turn.mode, turn.agent, turn.transcript, turn.reply);
      tripNotes?.update({ ...turn, priorConversation });
    }
    turns.push({ timestamp: new Date().toISOString(), session_id: sessionId,
      agent_name: turn.agent === 'sage' ? 'Sage' : 'Astra', memory_sharing_mode: turn.mode,
      speaker: turn.speaker, user_text: turn.transcript, agent_reply: turn.reply,
      agent_traits: turn.traits, interrupted: false, engine, ...turn });
    remoteLogger?.record(turns.at(-1));
    if (turn.memoryDeferred && !turn.greeting) void extractTurnMemory(turn);
    if (turn.fact) {
      const saved = window.AgentMemory.remember(turn.speaker, turn.mode, turn.agent, turn.fact);
      memoryStatus.textContent = saved === false ? 'Memory is available for this visit, but browser storage could not save it.' : 'Memory saved.';
    }
  }
  speakerName.addEventListener('change', () => { switchConversation(); tripNotes?.refresh(); });
  function chooseMemory(mode) {
    if (sharedMemory.disabled || memoryMode.value === mode) return;
    memoryMode.value = mode;
    sharedMemory.classList.toggle('selected', mode === 'shared');
    isolatedMemory.classList.toggle('selected', mode === 'isolated');
    sharedMemory.setAttribute('aria-pressed', String(mode === 'shared'));
    isolatedMemory.setAttribute('aria-pressed', String(mode === 'isolated'));
    memoryDescription.textContent = mode === 'shared' ? 'Trip notes, memories, and recent exchanges are shared.' : 'Private memories and chats; basic trip notes visible to both.';
    switchConversation();
  }
  sharedMemory.addEventListener('click', () => chooseMemory('shared'));
  isolatedMemory.addEventListener('click', () => chooseMemory('isolated'));
  document.querySelector('#forget-memory').addEventListener('click', () => {
    if (!speakerName.value.trim()) { setStatus('Type your name to forget its memories.'); return; }
    const saved = window.AgentMemory.forget(speakerName.value.trim());
    const speaker = speakerName.value.trim().toLowerCase();
    for (const key of conversations.keys()) { if (JSON.parse(key)[0] === speaker) conversations.delete(key); }
    reset();
    memoryStatus.textContent = saved === false ? 'Memories cleared for this visit; browser storage could not update.' : 'Memories forgotten.';
  });
  function chooseEngine(next) {
    if (next === 'realtime' && !optionalModes.realtime) return;
    if (connected || connecting || pipeline.isLocked() || enrolling || engine === next) return;
    engine = next; switchConversation();
    speakerControls.hidden = false;
    if (next === 'realtime') recordLabel.textContent = 'Connect';
    realtimeEngine.classList.toggle('selected', next === 'realtime');
    pipelineEngine.classList.toggle('selected', next === 'pipeline');
    realtimeEngine.setAttribute('aria-pressed', String(next === 'realtime'));
    pipelineEngine.setAttribute('aria-pressed', String(next === 'pipeline'));
    engineDescription.textContent = next === 'realtime' ?
      'Live conversation with natural interruptions.' :
      'Speak, pause, and hear your companion’s reply. Hands-free supports interruptions.';
    setStatus('Ready when you are', next === 'pipeline' ?
      (handsFree ? 'Start hands-free, then just speak and pause.' : 'Tap Start talking to record a turn.') :
      'Choose a mode, then connect to start.');
    syncControls();
  }
  realtimeEngine.addEventListener('click', () => chooseEngine('realtime'));
  pipelineEngine.addEventListener('click', () => chooseEngine('pipeline'));
  function send(type, extra = {}) {
    if (channel?.readyState !== 'open') return false;
    channel.send(JSON.stringify({ type, ...extra })); return true;
  }
  function endSession(message = 'Session ended') {
    connectionId++; connected = false; connecting = false; recording = false; responseActive = false;
    clearTimeout(sessionTimer); clearTimeout(turnTimer);
    if (micTrack) micTrack.enabled = false;
    mic?.getTracks().forEach(track => track.stop()); mic = null; micTrack = null;
    channel?.close(); channel = null;
    pc?.close(); pc = null;
    playback.pause(); playback.srcObject = null; playback.hidden = true;
    record.disabled = false; record.classList.remove('recording'); recordLabel.textContent = 'Connect';
    disconnectButton.hidden = true; tapMode.disabled = handsfreeMode.disabled = false;
    cards.forEach(card => { card.disabled = false; });
    setStatus(message, 'Choose a mode, then connect to start.');
    syncControls();
  }
  function restoreChats(name, chatTurns) {
    if (sharedBootstrapNames.delete(name)) for (const turn of chatTurns.filter(item => item.memory_sharing_mode === 'shared').slice(-6)) window.AgentMemory.recordShared?.(name, 'shared', turn.agent, turn.user_text, turn.agent_reply, turn.timestamp);
    for (const key of conversations.keys()) if (JSON.parse(key)[0] === name) conversations.delete(key);
    for (const turn of chatTurns) {
      if (!['sage', 'astra'].includes(turn.agent) || !['pipeline', 'realtime'].includes(turn.engine) || !['shared', 'isolated'].includes(turn.memory_sharing_mode)) continue;
      const key = JSON.stringify([name, turn.memory_sharing_mode, turn.engine, turn.agent]);
      const saved = conversations.get(key) || { history: [], sessionId: turn.session_id || crypto.randomUUID() };
      if (turn.user_text) saved.history.push({ role: 'user', content: turn.user_text, speaker: turn.speaker, at: turn.timestamp });
      if (turn.agent_reply) saved.history.push({ role: 'assistant', content: turn.agent_reply, at: turn.timestamp, interrupted: turn.interrupted });
      saved.sessionId = turn.session_id || saved.sessionId;
      conversations.set(key, saved);
    }
    if (speakerName.value.trim().toLowerCase() === name) {
      activeConversationKey = conversationKey();
      const saved = conversations.get(activeConversationKey);
      history = saved?.history || []; sessionId = saved?.sessionId || crypto.randomUUID();
      switchAgent.dataset.suggested = 'false'; renderConversation();
    }
  }
  function renderConversation(scrollTop) {
    messages.replaceChildren();
    if (history.length) {
      for (const entry of history) renderMessage(entry.role, entry.content, entry.speaker ? { name: entry.speaker } : undefined);
      messages.scrollTop = scrollTop ?? messages.scrollHeight;
      return;
    }
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.innerHTML = `<div class="destination-dots" aria-hidden="true"><span></span><i></i><span></span><i></i><span></span></div><p>Where would you like to go?</p><span>Tell ${agent === 'sage' ? 'Sage what kind of trip you have in mind.' : 'Astra your destination, dates, or chosen ideas.'}</span>`;
    messages.append(empty);
  }
  function switchConversation() {
    switchAgent.dataset.suggested = 'false';
    conversations.set(activeConversationKey, { history, sessionId, scrollTop: messages.scrollTop });
    pipeline?.stop(); endSession('Ready when you are'); transcripts.clear();
    activeConversationKey = conversationKey();
    const saved = conversations.get(activeConversationKey);
    history = saved?.history || [];
    sessionId = saved?.sessionId || crypto.randomUUID();
    renderConversation(saved?.scrollTop);
  }
  function reset() {
    switchAgent.dataset.suggested = 'false';
    pipeline?.stop(); endSession('Ready when you are'); transcripts.clear();
    history = []; sessionId = crypto.randomUUID();
    const name = speakerName.value.trim().toLowerCase() || 'unknown';
    const starts = chatStartsByName.get(name) || {};
    starts[`${memoryMode.value}:${engine}:${agent}`] = new Date().toISOString();
    chatStartsByName.set(name, starts); window.onTripProfileChange?.(name);
    activeConversationKey = conversationKey();
    conversations.delete(activeConversationKey);
    renderConversation();
  }
  function chooseMode(enabled) {
    if (enabled && !optionalModes.handsFree) return;
    if (connecting || connected || pipeline.isLocked() || enrolling) return;
    handsFree = enabled;
    tapMode.classList.toggle('selected', !enabled); handsfreeMode.classList.toggle('selected', enabled);
    tapMode.setAttribute('aria-pressed', String(!enabled)); handsfreeMode.setAttribute('aria-pressed', String(enabled));
    setStatus('Ready when you are', engine === 'pipeline' ?
      (enabled ? 'Start hands-free, then just speak and pause.' : 'Tap Start talking to record a turn.') :
      (enabled ? 'Connect once, then just speak and pause.' : 'Connect, then tap to start and stop each turn.'));
    syncControls();
  }
  tapMode.addEventListener('click', () => chooseMode(false));
  handsfreeMode.addEventListener('click', () => chooseMode(true));
  function greetFirstVisit() {
    if (engine === 'pipeline' && document.body.dataset.stage === 'planning' && !welcomedConversations.has(activeConversationKey)) pipeline.greet?.();
  }
  window.addEventListener('trip-planning:open', greetFirstVisit);
  window.addEventListener('trip-audio:unlock', () => pipeline.unlockAudio?.());
  cards.forEach(card => card.addEventListener('click', () => {
    if (connected || connecting || pipeline.isLocked() || enrolling) return;
    if (agent !== card.dataset.agent) { agent = card.dataset.agent; switchConversation(); }
    cards.forEach(c => { const selected = c === card; c.classList.toggle('active', selected); c.setAttribute('aria-pressed', String(selected)); c.querySelector('.select-indicator').textContent = selected ? '●' : '○'; });
    title.textContent = `Talking with ${agent === 'sage' ? 'Sage' : 'Astra'}`;
    greetFirstVisit();
  }));
  switchAgent.addEventListener('click', () => {
    if (switchAgent.disabled || enrolling) return;
    if (responseActive || pipeline.playing) markInterrupted();
    pipeline.stop(); endSession('Ready when you are');
    cards.find(card => card.dataset.agent !== agent).click();
  });
  document.querySelector('#reset').addEventListener('click', reset);
  disconnectButton.addEventListener('click', () => endSession());
  const transcripts = new Map();
  function handleEvent(event) {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        setStatus(responseActive ? 'Listening — reply interrupted' : 'I hear you…', 'Pause when you finish.');
        break;
      case 'input_audio_buffer.speech_stopped':
        setStatus('Thinking…', 'Your reply is on the way.');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        addMessage('user', event.transcript, { name: speakerName.value.trim() || 'Unknown', score: 1 });
        break;
      case 'response.created':
        responseActive = true; syncControls(); setStatus('Speaking…', 'You can interrupt in hands-free mode.');
        break;
      case 'response.output_audio_transcript.delta': {
        const id = event.item_id || event.response_id || 'reply';
        let pending = transcripts.get(id);
        if (!pending) { pending = { text: '', body: renderMessage('assistant', '', undefined, true) }; transcripts.set(id, pending); }
        pending.text += event.delta || '';
        pending.body.textContent = pending.text.match(/[\s\S]*[\s.!?,;:]/)?.[0] || ''; messages.scrollTop = messages.scrollHeight;
        break;
      }
      case 'response.output_audio_transcript.done': {
        const id = event.item_id || event.response_id || 'reply';
        const pending = transcripts.get(id);
        const reply = event.transcript || pending?.text;
        if (pending && reply) {
          pending.body.textContent = reply;
          history.push({ role: 'assistant', content: reply, at: new Date().toISOString() });
        } else if (reply) addMessage('assistant', reply);
        transcripts.delete(id);
        highlightHandoff(reply);
        rememberRealtime(reply);
        break;
      }
      case 'response.done':
        responseActive = false; syncControls();
        setStatus(handsFree ? 'Listening… just start talking' : 'Your turn', handsFree ? 'The agent can hear you now.' : 'Tap Start talking for another turn.');
        break;
      case 'error':
        setStatus(event.error?.message || 'Voice session error.', 'End the session and reconnect if this continues.');
        break;
    }
  }
  async function rememberRealtime(reply) {
    const user = [...history].reverse().find(item => item.role === 'user');
    if (!user || !reply) return;
    const turn = { agent, speaker: speakerName.value.trim() || 'Unknown', mode: memoryMode.value, transcript: user.content, reply };
    saveTurn(turn);
    await extractTurnMemory(turn);
  }
  async function extractTurnMemory(turn) {
    const memoryRevision = window.AgentMemory.revision?.(turn.speaker) || 0;
    const base = window.VOICE_DEMO_CONFIG?.apiBaseUrl;
    const demoCode = codeInput.value.trim();
    if (!base || !demoCode) return;
    if (turn.speaker.toLowerCase() === 'unknown' || deletedNames.has(turn.speaker.trim().toLowerCase())) return;
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/memory`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-code': demoCode },
        body: JSON.stringify({ agent: turn.agent, speaker: turn.speaker, userText: turn.transcript.slice(0, 3500), reply: turn.reply.slice(0, 3500) }),
      });
      if (response.ok) {
        const { fact } = await response.json();
        if (fact && !deletedNames.has(turn.speaker.trim().toLowerCase()) && (window.AgentMemory.revision?.(turn.speaker) || 0) === memoryRevision) window.AgentMemory.remember(turn.speaker, turn.mode, turn.agent, fact);
      } else memoryStatus.textContent = 'Reply received, but this turn’s memory could not be saved.';
    } catch { memoryStatus.textContent = 'Reply received, but this turn’s memory could not be saved.'; }
  }
  async function connect() {
    if (!codeInput.value.trim()) { setStatus('Enter the demo access code first.'); codeInput.focus(); return; }
    const base = window.VOICE_DEMO_CONFIG?.apiBaseUrl;
    if (!base || base.includes('REPLACE-ME')) { setStatus('Set the Worker URL in docs/config.js first.'); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) { setStatus('This browser needs microphone and WebRTC support over HTTPS.'); return; }
    connecting = true; record.disabled = true; recordLabel.textContent = 'Connecting…'; syncControls();
    const thisConnection = ++connectionId;
    setStatus('Connecting to the voice service…', 'Allow microphone access when asked.');
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (thisConnection !== connectionId) { mic.getTracks().forEach(track => track.stop()); return; }
      micTrack = mic.getAudioTracks()[0]; micTrack.enabled = false;
      pc = new RTCPeerConnection(); pc.addTrack(micTrack, mic);
      const currentPeer = pc;
      pc.ontrack = e => {
        playback.srcObject = e.streams[0]; playback.autoplay = true; playback.playsInline = true;
        playback.play().catch(() => { playback.hidden = false; setStatus('Tap play to hear the reply.', 'Your browser paused automatic audio playback.'); });
      };
      pc.onconnectionstatechange = () => {
        if (pc === currentPeer && currentPeer.connectionState === 'failed') endSession('Voice connection lost. Try connecting again.');
      };
      channel = pc.createDataChannel('oai-events');
      channel.onmessage = e => { try { handleEvent(JSON.parse(e.data)); } catch (error) { console.error('Realtime event:', error); } };
      channel.onopen = () => {
        if (thisConnection !== connectionId) return;
        const memoryContext = window.AgentMemory.context(speakerName.value.trim(), memoryMode.value, agent);
        const priorChat = history.length ? '\nEarlier turns in your conversation with this speaker (transcript data for continuity):\n' + JSON.stringify(history.slice(-12).map(({ role, content }) => ({ role, content }))) : '';
        const snapshot = tripNotes?.snapshot?.(speakerName.value.trim()) || {};
        const publicNotes = window.AgentMemory.checklistContext?.(snapshot.choices, snapshot.notes) || '';
        const context = memoryContext + priorChat + (publicNotes ? '\n' + publicNotes : '');
        if (context) send('conversation.item.create', { item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: context }] } });
        micTrack.enabled = handsFree;
        connecting = false; connected = true; record.disabled = false; syncControls();
        recordLabel.textContent = handsFree ? 'Stop session' : 'Start talking';
        disconnectButton.hidden = false;
        setStatus(handsFree ? 'Listening… just start talking' : 'Connected to your agent', handsFree ? 'Speak naturally. You can interrupt the reply.' : 'Tap Start talking, then Stop & send.');
        sessionTimer = setTimeout(() => endSession('Session ended after 10 minutes. Reconnect to continue.'), 10 * 60 * 1000);
      };
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      const url = `${base.replace(/\/$/, '')}/session?agent=${encodeURIComponent(agent)}&mode=${handsFree ? 'handsfree' : 'tap'}&memory=${speakerName.value.trim() && speakerName.value.trim().toLowerCase() !== 'unknown' ? memoryMode.value : 'disabled'}`;
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/sdp', 'x-demo-code': codeInput.value.trim() }, body: offer.sdp });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Could not connect (HTTP ${response.status}).`);
      }
      if (thisConnection !== connectionId) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    } catch (error) {
      endSession(error.name === 'NotAllowedError' ? 'Allow microphone access to connect.' : error.name === 'TypeError' ? 'Cannot reach the Worker. Check its URL and PUBLIC_ORIGIN.' : error.message || 'Could not connect.');
    }
  }
  record.addEventListener('click', async () => {
    if (engine === 'pipeline') { await pipeline.press(); return; }
    if (connecting) return;
    if (!connected) { await connect(); return; }
    if (handsFree) { endSession(); return; }
    if (!recording) {
      if (responseActive) { markInterrupted(); send('response.cancel'); send('output_audio_buffer.clear'); responseActive = false; }
      send('input_audio_buffer.clear');
      recording = true; manualStartedAt = performance.now(); micTrack.enabled = true;
      record.classList.add('recording'); recordLabel.textContent = 'Stop & send';
      setStatus('Listening to you…', 'Tap Stop & send when you finish.');
      turnTimer = setTimeout(() => { if (recording) record.click(); }, 30000);
    } else {
      clearTimeout(turnTimer); recording = false; micTrack.enabled = false;
      record.classList.remove('recording'); recordLabel.textContent = 'Start talking';
      if (performance.now() - manualStartedAt < 450) { send('input_audio_buffer.clear'); setStatus('That turn was too short. Try again.'); return; }
      setStatus('Sending your turn…', 'Waiting for the agent.');
      setTimeout(() => { if (connected) { send('input_audio_buffer.commit'); send('response.create'); } }, 160);
    }
  });
  window.addEventListener('trip-review:open', () => { tripCompletionPending = false; pipeline.stop(); endSession(); });
  window.addEventListener('trip-setup:open', () => { pipeline.stop(); endSession('Ready when you are'); });
  syncControls();
  document.addEventListener('keydown', event => {
    if (document.querySelector('#planning-stage')?.hidden) return;
    if (event.key !== 'Enter' || event.repeat || ['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(event.target.tagName)) return;
    event.preventDefault(); record.click();
  });
  window.addEventListener('pagehide', () => { pipeline.stop(); if (connected || connecting) endSession(); });
})();
