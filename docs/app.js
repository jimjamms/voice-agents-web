(() => {
  const cards = [...document.querySelectorAll('[data-agent]')];
  const messages = document.querySelector('#messages');
  const record = document.querySelector('#record');
  const recordLabel = document.querySelector('#record-label');
  const status = document.querySelector('#status');
  const hint = document.querySelector('#hint');
  const playback = document.querySelector('#playback');
  const codeInput = document.querySelector('#access-code');
  const title = document.querySelector('#conversation-title');
  const tapMode = document.querySelector('#tap-mode');
  const handsfreeMode = document.querySelector('#handsfree-mode');
  let agent = 'sage', history = [], recorder, stream, chunks = [], timeout, busy = false, audioUrl;
  let handsFree = false, active = false, listening = false, meterTimer, audioContext, analyser, samples;
  let startedAt = 0, lastSpeech = 0, voicedMs = 0, ambient = .004, recorderStartedAt = 0, session = 0;
  const formats = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  const setStatus = (message, detail) => { status.textContent = message; if (detail) hint.textContent = detail; };
  const append = (role, content) => {
    messages.querySelector('.empty-state')?.remove();
    const item = document.createElement('div'); item.className = `message ${role}`;
    const label = document.createElement('span'); label.className = 'sender'; label.textContent = role === 'user' ? 'You' : agent === 'sage' ? 'Sage' : 'Astra';
    const text = document.createElement('span'); text.textContent = content;
    item.append(label, text); messages.append(item); messages.scrollTop = messages.scrollHeight;
  };
  const stopAudio = () => { playback.pause(); playback.removeAttribute('src'); playback.hidden = true; if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = null; };
  const reset = () => {
    history = []; stopAudio(); messages.replaceChildren();
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.innerHTML = '<div class="tiny-orb" aria-hidden="true"></div><p>It starts with a hello.</p><span>Pick a voice. Take a breath. Say what’s on your mind.</span>';
    messages.append(empty); setStatus('Ready when you are', handsFree ? 'Start hands-free, then just speak and pause.' : 'Tap once to record. Tap again to send.');
  };
  const setMode = enabled => {
    if (active || busy || recorder?.state === 'recording') return;
    handsFree = enabled;
    tapMode.classList.toggle('selected', !enabled); handsfreeMode.classList.toggle('selected', enabled);
    tapMode.setAttribute('aria-pressed', String(!enabled)); handsfreeMode.setAttribute('aria-pressed', String(enabled));
    recordLabel.textContent = enabled ? 'Start hands-free' : 'Start talking';
    setStatus('Ready when you are', enabled ? 'Automatically sends after 1.2 seconds of silence.' : 'Tap once to record. Tap again to send.');
  };
  tapMode.addEventListener('click', () => setMode(false));
  handsfreeMode.addEventListener('click', () => setMode(true));
  cards.forEach(card => card.addEventListener('click', () => {
    if (active || busy || recorder?.state === 'recording') return;
    if (agent !== card.dataset.agent) { agent = card.dataset.agent; reset(); }
    cards.forEach(c => { const selected = c === card; c.classList.toggle('active', selected); c.setAttribute('aria-pressed', String(selected)); c.querySelector('.select-indicator').textContent = selected ? '●' : '○'; });
    title.textContent = `Talking with ${agent === 'sage' ? 'Sage' : 'Astra'}`;
  }));
  document.querySelector('#reset').addEventListener('click', () => { if (!active && !busy && recorder?.state !== 'recording') reset(); });
  document.querySelector('#download').addEventListener('click', () => {
    if (!history.length) { setStatus('There’s no conversation to download yet.'); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify({ agent, messages: history }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${agent}-conversation.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const setRecording = isRecording => { record.classList.toggle('recording', isRecording); recordLabel.textContent = isRecording ? 'Stop & send' : 'Start talking'; };
  async function submit(blob, currentSession = null) {
    busy = true; record.disabled = !active;
    setStatus('Finding your words…', 'Transcribing, thinking, then speaking.');
    const form = new FormData(); form.append('agent', agent); form.append('history', JSON.stringify(history));
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('wav') ? 'wav' : 'webm';
    form.append('audio', blob, `turn.${ext}`);
    let succeeded = false;
    try {
      const base = window.VOICE_DEMO_CONFIG?.apiBaseUrl;
      if (!base || base.includes('REPLACE-ME')) throw new Error('The demo server has not been configured yet.');
      const response = await fetch(`${base.replace(/\/$/, '')}/turn`, { method: 'POST', headers: { 'x-demo-code': codeInput.value.trim() }, body: form });
      const data = await response.json();
      if (currentSession !== null && (!active || session !== currentSession)) return false;
      if (!response.ok) throw new Error(data.error || 'Could not complete this turn.');
      append('user', data.transcript); append('assistant', data.reply);
      history.push({ role: 'user', content: data.transcript }, { role: 'assistant', content: data.reply });
      history = history.slice(-12);
      stopAudio();
      const binary = atob(data.audio); const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      audioUrl = URL.createObjectURL(new Blob([bytes], { type: data.mimeType || 'audio/mpeg' }));
      playback.src = audioUrl;
      setStatus('Playing reply…', handsFree && active ? 'Listening resumes after the reply.' : 'Tap Start talking when you’re ready.');
      try { await playback.play(); succeeded = true; }
      catch { playback.hidden = false; setStatus('Tap play to hear the reply.', 'Your browser paused automatic audio playback.'); succeeded = true; }
    } catch (error) {
      if (currentSession === null || (active && session === currentSession))
        setStatus(error.name === 'TypeError' && error.message === 'Failed to fetch' ? 'Could not reach the voice server. Check its URL and PUBLIC_ORIGIN.' : error.message || 'Something went wrong.', 'Try again after checking the connection.');
    } finally { busy = false; record.disabled = false; }
    return succeeded;
  }
  function stopHandsFree() {
    active = false; listening = false; session++;
    clearInterval(meterTimer); meterTimer = null;
    clearTimeout(timeout); timeout = null;
    if (recorder?.state === 'recording') recorder.stop();
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    if (audioContext) audioContext.close().catch(() => {});
    audioContext = null; analyser = null;
    stopAudio();
    record.classList.remove('recording'); recordLabel.textContent = 'Start hands-free';
    tapMode.disabled = handsfreeMode.disabled = false;
    setStatus('Hands-free stopped', 'Start hands-free to listen again.');
  }
  function listenAgain() {
    if (!active || !stream) return;
    stream.getAudioTracks().forEach(track => { track.enabled = true; });
    startedAt = performance.now(); ambient = .004; listening = true;
    setStatus('Listening… just start talking', 'Pause for 1.2 seconds to send your turn.');
  }
  playback.addEventListener('ended', () => {
    if (active) listenAgain();
    else setStatus('Your turn', 'Tap Start talking when you’re ready.');
  });
  function finishVoiceTurn() {
    if (!active || !listening || recorder?.state !== 'recording') return;
    listening = false;
    stream?.getAudioTracks().forEach(track => { track.enabled = false; });
    recorder.stop();
  }
  function measure() {
    if (!active || !listening || !analyser) return;
    analyser.getFloatTimeDomainData(samples);
    let power = 0;
    for (let i = 0; i < samples.length; i++) power += samples[i] * samples[i];
    const rms = Math.sqrt(power / samples.length);
    const now = performance.now();
    if (now - startedAt < 500) { ambient = Math.max(.002, ambient * .9 + rms * .1); return; }
    const speech = rms > Math.max(.018, ambient * 3);
    if (speech) {
      if (!recorder || recorder.state !== 'recording') {
        chunks = []; voicedMs = 0; recorderStartedAt = now;
        recorder = new MediaRecorder(stream, { mimeType: formats.find(f => MediaRecorder.isTypeSupported(f)) });
        const mimeType = recorder.mimeType;
        const thisSession = session;
        recorder.addEventListener('dataavailable', e => { if (e.data.size) chunks.push(e.data); });
        recorder.addEventListener('stop', async () => {
          const blob = new Blob(chunks, { type: mimeType }); chunks = [];
          if (!active || thisSession !== session) return;
          if (voicedMs < 300 || blob.size < 500) { listenAgain(); return; }
          setStatus('Sending your recording…');
          const ok = await submit(blob, thisSession);
          if (!active || thisSession !== session) return;
          if (!ok) {
            const failure = status.textContent;
            stopHandsFree(); setStatus(failure, 'Check your connection, then start hands-free again.');
          }
        }, { once: true });
        recorder.start(); setStatus('I hear you…', 'Pause for 1.2 seconds when you finish.');
      }
      voicedMs += 60; lastSpeech = now;
    } else if (recorder?.state === 'recording') {
      if (now - lastSpeech >= 1200) finishVoiceTurn();
    } else {
      ambient = Math.max(.002, ambient * .97 + rms * .03);
    }
    if (recorder?.state === 'recording' && now - recorderStartedAt >= 30000) finishVoiceTurn();
  }
  async function startHandsFree() {
    active = true; const thisSession = ++session;
    record.classList.add('recording'); recordLabel.textContent = 'Stop hands-free';
    tapMode.disabled = handsfreeMode.disabled = true;
    setStatus('Opening microphone…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!active || thisSession !== session) { stream.getTracks().forEach(track => track.stop()); stream = null; return; }
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser(); analyser.fftSize = 2048; source.connect(analyser);
      samples = new Float32Array(analyser.fftSize);
      startedAt = performance.now(); ambient = .004; listening = true;
      meterTimer = setInterval(measure, 60);
      setStatus('Listening… just start talking', 'Pause for 1.2 seconds to send your turn.');
    } catch (error) {
      stopHandsFree();
      setStatus(error.name === 'NotAllowedError' ? 'Allow microphone access to start talking.' : error.message || 'Microphone unavailable.');
    }
  }
  record.addEventListener('click', async () => {
    if (handsFree && active) { stopHandsFree(); return; }
    if (recorder?.state === 'recording') { clearTimeout(timeout); recorder.stop(); setRecording(false); setStatus('Sending your recording…'); return; }
    if (busy) return;
    if (!codeInput.value.trim()) { setStatus('Enter the demo access code first.'); codeInput.focus(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setStatus('This browser cannot record audio. Try an updated browser over HTTPS.'); return; }
    if (!formats.some(f => MediaRecorder.isTypeSupported(f))) { setStatus('This browser does not support a compatible recording format.'); return; }
    stopAudio();
    if (handsFree) {
      if (!window.AudioContext && !window.webkitAudioContext) { setStatus('Hands-free listening is not available in this browser.'); return; }
      await startHandsFree(); return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = []; const mimeType = formats.find(f => MediaRecorder.isTypeSupported(f));
      recorder = new MediaRecorder(stream, { mimeType });
      recorder.addEventListener('dataavailable', e => { if (e.data.size) chunks.push(e.data); });
      recorder.addEventListener('stop', () => {
        stream?.getTracks().forEach(track => track.stop()); stream = null;
        const blob = new Blob(chunks, { type: mimeType }); chunks = [];
        if (blob.size < 500) { setStatus('That recording was too short. Try again.'); return; }
        submit(blob);
      }, { once: true });
      recorder.start(); setRecording(true); setStatus('Listening to you…', 'Tap Stop & send, or wait 30 seconds.');
      timeout = setTimeout(() => { if (recorder?.state === 'recording') record.click(); }, 30000);
    } catch (error) { stream?.getTracks().forEach(track => track.stop()); setStatus(error.name === 'NotAllowedError' ? 'Allow microphone access to start talking.' : error.message || 'Microphone unavailable.'); }
  });
  window.addEventListener('pagehide', () => { if (active) stopHandsFree(); });
})();
