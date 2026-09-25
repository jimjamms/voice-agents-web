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
  let agent = 'sage', handsFree = false, history = [], pc, channel, mic, micTrack, connected = false;
  let connecting = false, recording = false, responseActive = false, sessionTimer, turnTimer;
  let manualStartedAt = 0, connectionId = 0;
  const setStatus = (message, detail) => { status.textContent = message; if (detail) hint.textContent = detail; };
  const addMessage = (role, content) => {
    const text = String(content || '').trim();
    if (!text) return;
    messages.querySelector('.empty-state')?.remove();
    const item = document.createElement('div'); item.className = `message ${role}`;
    const label = document.createElement('span'); label.className = 'sender'; label.textContent = role === 'user' ? 'You' : agent === 'sage' ? 'Sage' : 'Astra';
    const body = document.createElement('span'); body.textContent = text;
    item.append(label, body); messages.append(item); messages.scrollTop = messages.scrollHeight;
    history.push({ role, content: text, at: new Date().toISOString() });
  };
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
  }
  function reset() {
    endSession('Ready when you are'); history = []; messages.replaceChildren();
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.innerHTML = '<div class="tiny-orb" aria-hidden="true"></div><p>It starts with a hello.</p><span>Pick a voice. Take a breath. Say what’s on your mind.</span>';
    messages.append(empty);
  }
  function chooseMode(enabled) {
    if (connecting || connected) return;
    handsFree = enabled;
    tapMode.classList.toggle('selected', !enabled); handsfreeMode.classList.toggle('selected', enabled);
    tapMode.setAttribute('aria-pressed', String(!enabled)); handsfreeMode.setAttribute('aria-pressed', String(enabled));
    setStatus('Ready when you are', enabled ? 'Connect once, then just speak and pause.' : 'Connect, then tap to start and stop each turn.');
  }
  tapMode.addEventListener('click', () => chooseMode(false));
  handsfreeMode.addEventListener('click', () => chooseMode(true));
  cards.forEach(card => card.addEventListener('click', () => {
    if (connected || connecting) return;
    if (agent !== card.dataset.agent) { agent = card.dataset.agent; reset(); }
    cards.forEach(c => { const selected = c === card; c.classList.toggle('active', selected); c.setAttribute('aria-pressed', String(selected)); c.querySelector('.select-indicator').textContent = selected ? '●' : '○'; });
    title.textContent = `Talking with ${agent === 'sage' ? 'Sage' : 'Astra'}`;
  }));
  document.querySelector('#reset').addEventListener('click', reset);
  disconnectButton.addEventListener('click', () => endSession());
  document.querySelector('#download').addEventListener('click', () => {
    if (!history.length) { setStatus('There’s no conversation to download yet.'); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify({ agent, messages: history }, null, 2)], { type: 'application/json' }));
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
    connecting = true; record.disabled = true; recordLabel.textContent = 'Connecting…';
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
        connecting = false; connected = true; record.disabled = false;
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
  window.addEventListener('pagehide', () => { if (connected || connecting) endSession(); });
})();
