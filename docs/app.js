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
  let agent = 'sage', history = [], recorder, stream, chunks = [], timeout, busy = false, audioUrl;
  const formats = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  const setStatus = (message, detail) => { status.textContent = message; if (detail) hint.textContent = detail; };
  const append = (role, content) => {
    messages.querySelector('.empty-state')?.remove();
    const item = document.createElement('div'); item.className = `message ${role}`;
    const label = document.createElement('span'); label.className = 'sender'; label.textContent = role === 'user' ? 'You' : agent === 'sage' ? 'Sage' : 'Astra';
    const text = document.createElement('span'); text.textContent = content;
    item.append(label, text); messages.append(item); messages.scrollTop = messages.scrollHeight;
  };
  const stopAudio = () => { playback.pause(); playback.removeAttribute('src'); if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = null; };
  const reset = () => { history = []; stopAudio(); messages.replaceChildren(); const empty = document.createElement('div'); empty.className = 'empty-state'; empty.innerHTML = '<div class="tiny-orb" aria-hidden="true"></div><p>It starts with a hello.</p><span>Pick a voice. Take a breath. Say what’s on your mind.</span>'; messages.append(empty); setStatus('Ready when you are', 'Tap once to record. Tap again to send.'); };
  cards.forEach(card => card.addEventListener('click', () => {
    if (busy || recorder?.state === 'recording') return;
    if (agent !== card.dataset.agent) { agent = card.dataset.agent; reset(); }
    cards.forEach(c => { const selected = c === card; c.classList.toggle('active', selected); c.setAttribute('aria-pressed', String(selected)); c.querySelector('.select-indicator').textContent = selected ? '●' : '○'; });
    title.textContent = `Talking with ${agent === 'sage' ? 'Sage' : 'Astra'}`;
  }));
  document.querySelector('#reset').addEventListener('click', () => { if (!busy && recorder?.state !== 'recording') reset(); });
  document.querySelector('#download').addEventListener('click', () => {
    if (!history.length) { setStatus('There’s no conversation to download yet.'); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify({ agent, messages: history }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${agent}-conversation.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const setRecording = active => { record.classList.toggle('recording', active); recordLabel.textContent = active ? 'Stop & send' : 'Start talking'; };
  async function submit(blob) {
    busy = true; record.disabled = true; setStatus('Finding your words…', 'Transcribing, thinking, then speaking.');
    const form = new FormData(); form.append('agent', agent); form.append('history', JSON.stringify(history));
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    form.append('audio', blob, `turn.${ext}`);
    try {
      const base = window.VOICE_DEMO_CONFIG?.apiBaseUrl;
      if (!base || base.includes('REPLACE-ME')) throw new Error('The demo server has not been configured yet.');
      const response = await fetch(`${base.replace(/\/$/, '')}/turn`, { method: 'POST', headers: { 'x-demo-code': codeInput.value.trim() }, body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not complete this turn.');
      append('user', data.transcript); append('assistant', data.reply);
      history.push({ role: 'user', content: data.transcript }, { role: 'assistant', content: data.reply });
      history = history.slice(-12);
      stopAudio();
      const binary = atob(data.audio); const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      audioUrl = URL.createObjectURL(new Blob([bytes], { type: data.mimeType || 'audio/mpeg' }));
      playback.src = audioUrl;
      setStatus('Playing reply…', 'Tap Start talking when you’re ready.');
      await playback.play();
    } catch (error) { setStatus(error.message || 'Something went wrong. Please try again.', 'Your microphone is ready for another turn.'); }
    finally { busy = false; record.disabled = false; }
  }
  playback.addEventListener('ended', () => setStatus('Your turn', 'Tap Start talking when you’re ready.'));
  record.addEventListener('click', async () => {
    if (recorder?.state === 'recording') { clearTimeout(timeout); recorder.stop(); setRecording(false); setStatus('Sending your recording…'); return; }
    if (busy) return;
    if (!codeInput.value.trim()) { setStatus('Enter the demo access code first.'); codeInput.focus(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setStatus('This browser cannot record audio. Try an updated browser over HTTPS.'); return; }
    try {
      stopAudio();
      const mimeType = formats.find(f => MediaRecorder.isTypeSupported(f));
      if (!mimeType) throw new Error('This browser does not support a compatible recording format.');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = []; recorder = new MediaRecorder(stream, { mimeType });
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
})();
