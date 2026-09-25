(() => {
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
  const speakerList = document.querySelector('#speaker-list');
  const enrollSpeaker = document.querySelector('#enroll-speaker');
  const forgetSpeakers = document.querySelector('#forget-speakers');
  let agent = 'sage', engine = 'realtime', handsFree = false, history = [], pc, channel, mic, micTrack, connected = false;
  let pipeline;
  let enrolling = false;
  let connecting = false, recording = false, responseActive = false, sessionTimer, turnTimer;
  let manualStartedAt = 0, connectionId = 0;
  const setStatus = (message, detail) => { status.textContent = message; if (detail) hint.textContent = detail; };
  const addMessage = (role, content, speaker) => {
    const text = String(content || '').trim();
    if (!text) return;
    messages.querySelector('.empty-state')?.remove();
    const item = document.createElement('div'); item.className = `message ${role}`;
    const label = document.createElement('span'); label.className = 'sender';
    label.textContent = role === 'user' ? (speaker?.name && speaker.name !== 'Unknown' ? speaker.name : 'You') : agent === 'sage' ? 'Sage' : 'Astra';
    const body = document.createElement('span'); body.textContent = text;
    item.append(label, body); messages.append(item); messages.scrollTop = messages.scrollHeight;
    history.push({ role, content: text, at: new Date().toISOString(),
      ...(speaker && { speaker: speaker.name, speaker_score: Math.round(speaker.score * 1000) / 1000 }) });
  };
  pipeline = window.createPipelineTransport({
    agent: () => agent, isSelected: () => engine === 'pipeline', isHandsFree: () => handsFree,
    history: () => history, code: () => codeInput.value.trim(),
    focusCode: () => codeInput.focus(), base: () => window.VOICE_DEMO_CONFIG?.apiBaseUrl,
    playback, speakers: window.VoiceSpeakers, onStatus: setStatus, getStatus: () => status.textContent,
    onMessage: addMessage, onState: () => syncControls(),
  });
  function syncControls() {
    const locked = enrolling || (engine === 'pipeline' ? pipeline.isLocked() : connecting || connected);
    realtimeEngine.disabled = pipelineEngine.disabled = locked;
    cards.forEach(card => { card.disabled = locked; });
    if (engine === 'pipeline') {
      tapMode.disabled = handsfreeMode.disabled = locked;
      disconnectButton.hidden = true;
      record.disabled = pipeline.connecting || (pipeline.busy && !pipeline.active);
      if (enrolling) record.disabled = true;
      record.classList.toggle('recording', pipeline.recording || pipeline.active);
      recordLabel.textContent = pipeline.connecting ? 'Opening microphone…' :
        handsFree ? (pipeline.active ? 'Stop hands-free' : 'Start hands-free') :
        pipeline.busy ? 'Thinking…' : pipeline.recording ? 'Stop & send' : 'Start talking';
    }
    enrollSpeaker.disabled = forgetSpeakers.disabled = enrolling || pipeline.isLocked();
  }
  function refreshSpeakers() {
    const names = window.VoiceSpeakers?.names() || [];
    speakerList.textContent = names.length
      ? `Enrolled here: ${names.join(', ')}. Matching is approximate, not secure identification.`
      : 'No voices enrolled. Saved only in this browser; voice matching is approximate.';
  }
  refreshSpeakers();
  enrollSpeaker.addEventListener('click', async () => {
    if (pipeline.isLocked() || enrolling || engine !== 'pipeline') return;
    const name = speakerName.value.trim();
    if (!name || name.toLowerCase() === 'unknown') { setStatus('Enter a speaker name first.'); speakerName.focus(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !pipeline.format()) {
      setStatus('This browser needs a compatible microphone and recording format over HTTPS.'); return;
    }
    enrolling = true; syncControls();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const recorder = new MediaRecorder(stream, { mimeType: pipeline.format() });
      const chunks = [];
      const recording = new Promise((resolve, reject) => {
        recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
        recorder.addEventListener('error', event => reject(event.error || new Error('Voice recording failed.')));
        recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: recorder.mimeType })), { once: true });
      });
      recorder.start();
      setStatus(`Recording ${name}…`, 'Speak continuously for four seconds.');
      await new Promise(resolve => setTimeout(resolve, 4000));
      if (recorder.state === 'recording') recorder.stop();
      const saved = await window.VoiceSpeakers.enroll(name, await recording);
      refreshSpeakers();
      setStatus(`${saved} enrolled`, 'Only the voice fingerprint was saved in this browser.');
    } catch (error) {
      setStatus(error.name === 'NotAllowedError' ? 'Allow microphone access to enroll.' : error.message || 'Could not enroll this voice.');
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      enrolling = false; syncControls();
    }
  });
  forgetSpeakers.addEventListener('click', () => {
    if (pipeline.isLocked() || enrolling) return;
    window.VoiceSpeakers.forget(); refreshSpeakers(); setStatus('Enrolled voices forgotten from this browser.');
  });
  function chooseEngine(next) {
    if (connected || connecting || pipeline.isLocked() || enrolling || engine === next) return;
    reset(); engine = next;
    speakerControls.hidden = next !== 'pipeline';
    if (next === 'realtime') recordLabel.textContent = 'Connect';
    realtimeEngine.classList.toggle('selected', next === 'realtime');
    pipelineEngine.classList.toggle('selected', next === 'pipeline');
    realtimeEngine.setAttribute('aria-pressed', String(next === 'realtime'));
    pipelineEngine.setAttribute('aria-pressed', String(next === 'pipeline'));
    engineDescription.textContent = next === 'realtime' ?
      'Live conversation with natural interruptions.' :
      'Recorded turns with written replies and OpenAI speech. Hands-free supports interruptions.';
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
  function reset() {
    pipeline?.stop(); endSession('Ready when you are'); history = []; messages.replaceChildren();
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.innerHTML = '<div class="tiny-orb" aria-hidden="true"></div><p>It starts with a hello.</p><span>Pick a voice. Take a breath. Say what’s on your mind.</span>';
    messages.append(empty);
  }
  function chooseMode(enabled) {
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
    if (agent !== card.dataset.agent) { agent = card.dataset.agent; reset(); }
    cards.forEach(c => { const selected = c === card; c.classList.toggle('active', selected); c.setAttribute('aria-pressed', String(selected)); c.querySelector('.select-indicator').textContent = selected ? '●' : '○'; });
    title.textContent = `Talking with ${agent === 'sage' ? 'Sage' : 'Astra'}`;
  }));
  document.querySelector('#reset').addEventListener('click', reset);
  disconnectButton.addEventListener('click', () => endSession());
  document.querySelector('#download').addEventListener('click', () => {
    if (!history.length) { setStatus('There’s no conversation to download yet.'); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify({ agent, engine, messages: history }, null, 2)], { type: 'application/json' }));
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
        addMessage('user', event.transcript);
        break;
      case 'response.created':
        responseActive = true; setStatus('Speaking…', 'You can interrupt in hands-free mode.');
        break;
      case 'response.output_audio_transcript.delta': {
        const id = event.item_id || event.response_id || 'reply';
        transcripts.set(id, (transcripts.get(id) || '') + (event.delta || ''));
        break;
      }
      case 'response.output_audio_transcript.done': {
        const id = event.item_id || event.response_id || 'reply';
        addMessage('assistant', event.transcript || transcripts.get(id)); transcripts.delete(id);
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
      micTrack = mic.getAudioTracks()[0]; micTrack.enabled = handsFree;
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
        connecting = false; connected = true; record.disabled = false; syncControls();
        recordLabel.textContent = handsFree ? 'Stop session' : 'Start talking';
        disconnectButton.hidden = false;
        setStatus(handsFree ? 'Listening… just start talking' : 'Connected to your agent', handsFree ? 'Speak naturally. You can interrupt the reply.' : 'Tap Start talking, then Stop & send.');
        sessionTimer = setTimeout(() => endSession('Session ended after 10 minutes. Reconnect to continue.'), 10 * 60 * 1000);
      };
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      const url = `${base.replace(/\/$/, '')}/session?agent=${encodeURIComponent(agent)}&mode=${handsFree ? 'handsfree' : 'tap'}`;
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
      if (responseActive) { send('response.cancel'); send('output_audio_buffer.clear'); responseActive = false; }
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
  window.addEventListener('pagehide', () => { pipeline.stop(); if (connected || connecting) endSession(); });
})();
