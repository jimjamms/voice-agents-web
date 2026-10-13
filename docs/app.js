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
  let sessionId = crypto.randomUUID();
  let agent = 'sage', engine = 'pipeline', handsFree = false, history = [], pc, channel, mic, micTrack, connected = false;
  const conversations = new Map();
  const conversationKey = () => JSON.stringify([speakerName.value.trim().toLowerCase() || 'unknown', memoryMode.value, engine, agent]);
  let activeConversationKey = conversationKey();
  const tripNotes = window.createTripNotes?.({
    textarea: document.querySelector('#trip-notes'), status: document.querySelector('#notes-status'),
    copy: document.querySelector('#copy-notes'), clear: document.querySelector('#clear-notes'),
    speaker: () => speakerName.value.trim(), base: () => window.VOICE_DEMO_CONFIG?.apiBaseUrl,
    code: () => codeInput.value.trim(),
  });
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
  const addMessage = (role, content, speaker) => {
    const text = String(content || '').trim();
    if (!text) return;
    const body = renderMessage(role, text, speaker);
    history.push({ role, content: text, at: new Date().toISOString(),
      ...(speaker && { speaker: speaker.name, speaker_score: Math.round(speaker.score * 1000) / 1000 }) });
    return body;
  };
  pipeline = window.createPipelineTransport({
    agent: () => agent, isSelected: () => engine === 'pipeline', isHandsFree: () => handsFree,
    history: () => history, code: () => codeInput.value.trim(),
    focusCode: () => codeInput.focus(), base: () => window.VOICE_DEMO_CONFIG?.apiBaseUrl,
    speaker: () => speakerName.value.trim() || 'Unknown', memoryMode: () => memoryMode.value,
    memories: () => window.AgentMemory.entries(speakerName.value.trim(), memoryMode.value, agent),
    onTurn: saveTurn, onInterrupt: markInterrupted,
    playback, onStatus: setStatus, getStatus: () => status.textContent,
    onReplyStart: reply => {
      const body = addMessage('assistant', reply); body.textContent = '…';
      return text => { body.textContent = text || '…'; messages.scrollTop = messages.scrollHeight; };
    },
    onMessage: addMessage, onState: () => syncControls(),
  });
  function syncControls() {
    document.querySelector('.conversation').dataset.agent = agent;
    const locked = enrolling || (engine === 'pipeline' ? pipeline.isLocked() : connecting || connected);
    realtimeEngine.disabled = pipelineEngine.disabled = locked;
    cards.forEach(card => { card.disabled = locked; card.hidden = card.dataset.agent !== agent; });
    document.querySelector('.agent-options').dataset.companion = agent;
    switchAgent.disabled = enrolling;
    switchAgent.setAttribute('aria-label', `Switch to ${agent === 'sage' ? 'Astra' : 'Sage'}`);
    if (engine === 'pipeline') {
      tapMode.disabled = handsfreeMode.disabled = locked;
      disconnectButton.hidden = true;
      record.disabled = pipeline.connecting || (pipeline.busy && !pipeline.active);
      if (enrolling) record.disabled = true;
      record.classList.toggle('recording', pipeline.recording || pipeline.active);
      recordLabel.textContent = pipeline.connecting ? 'Opening microphone…' :
        handsFree ? (pipeline.active ? 'Stop hands-free' : 'Start hands-free') :
        pipeline.playing ? 'Interrupt & talk' : pipeline.busy ? 'Thinking…' : pipeline.recording ? 'Stop & send' : 'Start talking';
    }
    sharedMemory.disabled = isolatedMemory.disabled = locked;
    speakerName.disabled = memoryMode.disabled = document.querySelector('#forget-memory').disabled = locked;
  }
  function markInterrupted() {
    const last = turns.at(-1); if (last) last.interrupted = true;
  }
  function saveTurn(turn) {
    tripNotes?.update(turn);
    turns.push({ timestamp: new Date().toISOString(), session_id: sessionId,
      agent_name: turn.agent === 'sage' ? 'Sage' : 'Astra', memory_sharing_mode: turn.mode,
      speaker: turn.speaker, user_text: turn.transcript, agent_reply: turn.reply,
      agent_traits: turn.traits, interrupted: false, engine, ...turn });
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
    memoryDescription.textContent = mode === 'shared' ? 'Share saved trip details between agents.' : 'Each agent saves trip details separately.';
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
  function renderConversation(scrollTop) {
    messages.replaceChildren();
    if (history.length) {
      for (const entry of history) renderMessage(entry.role, entry.content, entry.speaker ? { name: entry.speaker } : undefined);
      messages.scrollTop = scrollTop ?? messages.scrollHeight;
      return;
    }
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.innerHTML = `<div class="welcome-avatar" aria-hidden="true"><img src="assets/${agent}-character.png" alt=""></div><div class="destination-dots" aria-hidden="true"><span></span><i></i><span></span><i></i><span></span></div><p>Where would you like to go?</p><span>Tell ${agent === 'sage' ? 'Sage what kind of trip you have in mind.' : 'Astra your destination, dates, or chosen ideas.'}</span>`;
    messages.append(empty);
  }
  function switchConversation() {
    conversations.set(activeConversationKey, { history, sessionId, scrollTop: messages.scrollTop });
    pipeline?.stop(); endSession('Ready when you are'); transcripts.clear();
    activeConversationKey = conversationKey();
    const saved = conversations.get(activeConversationKey);
    history = saved?.history || [];
    sessionId = saved?.sessionId || crypto.randomUUID();
    renderConversation(saved?.scrollTop);
  }
  function reset() {
    pipeline?.stop(); endSession('Ready when you are'); transcripts.clear();
    history = []; sessionId = crypto.randomUUID();
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
  cards.forEach(card => card.addEventListener('click', () => {
    if (connected || connecting || pipeline.isLocked() || enrolling) return;
    if (agent !== card.dataset.agent) { agent = card.dataset.agent; switchConversation(); }
    cards.forEach(c => { const selected = c === card; c.classList.toggle('active', selected); c.setAttribute('aria-pressed', String(selected)); c.querySelector('.select-indicator').textContent = selected ? '●' : '○'; });
    title.textContent = `Talking with ${agent === 'sage' ? 'Sage' : 'Astra'}`;
  }));
  switchAgent.addEventListener('click', () => {
    if (enrolling) return;
    if (responseActive || pipeline.playing) markInterrupted();
    pipeline.stop(); endSession('Ready when you are');
    cards.find(card => card.dataset.agent !== agent).click();
  });
  document.querySelector('#reset').addEventListener('click', reset);
  disconnectButton.addEventListener('click', () => endSession());
  document.querySelector('#download').addEventListener('click', () => {
    if (!history.length) { setStatus('There’s no conversation to download yet.'); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify({ agent, engine, speaker: speakerName.value.trim() || 'Unknown', memory_sharing_mode: memoryMode.value, messages: history, turns }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${agent}-conversation.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
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
        responseActive = true; setStatus('Speaking…', 'You can interrupt in hands-free mode.');
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
        rememberRealtime(reply);
        break;
      }
      case 'response.done':
        responseActive = false;
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
    const generation = sessionId;
    const turn = { agent, speaker: speakerName.value.trim() || 'Unknown', mode: memoryMode.value, transcript: user.content, reply };
    saveTurn(turn);
    if (turn.speaker.toLowerCase() === 'unknown') return;
    try {
      const response = await fetch(`${window.VOICE_DEMO_CONFIG.apiBaseUrl.replace(/\/$/, '')}/memory`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-code': codeInput.value.trim() },
        body: JSON.stringify({ agent: turn.agent, speaker: turn.speaker, userText: turn.transcript.slice(0, 3500), reply: reply.slice(0, 3500) }),
      });
      if (response.ok) {
        const { fact } = await response.json();
        if (fact && sessionId === generation) window.AgentMemory.remember(turn.speaker, turn.mode, turn.agent, fact);
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
        const context = memoryContext + priorChat;
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
  window.addEventListener('trip-setup:open', () => { pipeline.stop(); endSession('Ready when you are'); });
  syncControls();
  document.addEventListener('keydown', event => {
    if (document.querySelector('#planning-stage')?.hidden) return;
    if (event.key !== 'Enter' || event.repeat || ['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(event.target.tagName)) return;
    event.preventDefault(); record.click();
  });
  window.addEventListener('pagehide', () => { pipeline.stop(); if (connected || connecting) endSession(); });
})();
