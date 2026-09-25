/* Browser recording for the original transcription → chat → TTS flow. */
(() => {
  const formats = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  class PipelineTransport {
    constructor(options) {
      this.options = options;
      this.active = false; this.busy = false; this.recording = false; this.connecting = false;
      this.stream = null; this.recorder = null; this.context = null; this.analyser = null;
      this.chunks = []; this.timer = null; this.interval = null; this.audioUrl = null;
      this.request = null; this.generation = 0;
      this.options.playback.addEventListener('ended', () => {
        if (!this.options.isSelected()) return;
        if (this.active) this.resume();
        else this.status('Your turn', 'Tap Start talking for another turn.');
      });
    }
    isLocked() { return this.active || this.busy || this.recording || this.connecting; }
    notify() { this.options.onState(this); }
    status(message, detail) { this.options.onStatus(message, detail); }
    format() { return formats.find(type => MediaRecorder.isTypeSupported(type)); }
    stopPlayback() {
      const audio = this.options.playback;
      audio.pause(); audio.removeAttribute('src'); audio.hidden = true;
      if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
      this.audioUrl = null;
    }
    stop() {
      this.generation++; this.active = false; this.busy = false; this.recording = false; this.connecting = false;
      clearTimeout(this.timer); clearInterval(this.interval);
      this.request?.abort(); this.request = null;
      if (this.recorder?.state === 'recording') this.recorder.stop();
      this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
      const context = this.context; this.context = null;
      if (context) context.close().catch(() => {});
      this.analyser = null; this.stopPlayback();
      this.notify();
    }
    async press() {
      if (this.active) { await this.stop(); this.status('Hands-free stopped', 'Start it again when you’re ready.'); return; }
      if (this.busy || this.connecting) return;
      if (this.recording) { this.finishRecording(); return; }
      if (!this.options.code()) { this.status('Enter the demo access code first.'); this.options.focusCode(); return; }
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !this.format()) {
        this.status('This browser needs a compatible microphone and recording format over HTTPS.'); return;
      }
      this.stopPlayback();
      if (this.options.isHandsFree()) await this.startHandsFree();
      else await this.startTap();
    }
    async startTap() {
      const generation = ++this.generation; this.connecting = true; this.notify();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
        this.stream = stream; this.connecting = false;
        this.beginRecording(generation);
        this.status('Listening to you…', 'Tap Stop & send, or wait 30 seconds.');
        this.timer = setTimeout(() => this.finishRecording(), 30000);
      } catch (error) {
        this.connecting = false; this.notify();
        this.status(error.name === 'NotAllowedError' ? 'Allow microphone access to start talking.' : 'Microphone unavailable.');
      }
    }
    beginRecording(generation) {
      this.chunks = [];
      const recorder = new MediaRecorder(this.stream, { mimeType: this.format() });
      this.recorder = recorder;
      recorder.addEventListener('dataavailable', event => { if (event.data.size) this.chunks.push(event.data); });
      recorder.addEventListener('stop', async () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType }); this.chunks = [];
        if (generation !== this.generation) return;
        if (!this.active) { this.stream?.getTracks().forEach(track => track.stop()); this.stream = null; }
        if (blob.size < 500 || (this.active && this.voicedMs < 300)) {
          this.busy = false;
          if (this.active) this.resume();
          else this.status('That recording was too short. Try again.');
          this.notify(); return;
        }
        await this.submit(blob, generation);
      }, { once: true });
      recorder.start(); this.recording = true; this.startedAt = performance.now();
      this.notify();
    }
    finishRecording() {
      if (!this.recording || this.recorder?.state !== 'recording') return;
      clearTimeout(this.timer); this.recording = false; this.busy = true;
      if (this.active) {
        this.stream?.getAudioTracks().forEach(track => { track.enabled = false; });
      }
      this.recorder.stop(); this.notify();
      this.status('Sending your turn…', 'Transcribing, thinking, then speaking.');
    }
    async startHandsFree() {
      if (!window.AudioContext && !window.webkitAudioContext) {
        this.status('Hands-free mode needs Web Audio support in this browser.'); return;
      }
      this.active = true; const generation = ++this.generation; this.notify();
      this.status('Opening microphone…');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
        this.stream = stream;
        this.context = new (window.AudioContext || window.webkitAudioContext)();
        await this.context.resume();
        if (generation !== this.generation) return;
        const source = this.context.createMediaStreamSource(stream);
        this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 2048;
        source.connect(this.analyser); this.samples = new Float32Array(this.analyser.fftSize);
        this.interval = setInterval(() => this.measure(generation), 60);
        this.resume();
      } catch (error) {
        await this.stop();
        this.status(error.name === 'NotAllowedError' ? 'Allow microphone access to start listening.' : 'Microphone unavailable.');
      }
    }
    resume() {
      if (!this.active || !this.stream) return;
      this.stream.getAudioTracks().forEach(track => { track.enabled = true; });
      this.waitingAt = performance.now(); this.ambient = .004; this.voicedMs = 0;
      this.status('Listening… just start talking', 'Pause for 1.2 seconds to send your turn.');
    }
    measure(generation) {
      if (generation !== this.generation || !this.active || this.busy || !this.analyser) return;
      this.analyser.getFloatTimeDomainData(this.samples);
      let power = 0;
      for (let i = 0; i < this.samples.length; i++) power += this.samples[i] ** 2;
      const rms = Math.sqrt(power / this.samples.length); const now = performance.now();
      if (!this.recording && now - this.waitingAt < 500) { this.ambient = Math.max(.002, this.ambient * .9 + rms * .1); return; }
      const speech = rms > Math.max(.018, this.ambient * 3);
      if (speech) {
        if (!this.recording) {
          this.beginRecording(generation);
          this.status('I hear you…', 'Pause when you finish.');
        }
        this.voicedMs += 60; this.lastSpeech = now;
      } else if (this.recording) {
        if (now - this.lastSpeech >= 1200) {
          if (this.voicedMs < 300) {
            this.recorder.stop(); this.recording = false; this.notify();
          } else this.finishRecording();
        }
      } else this.ambient = Math.max(.002, this.ambient * .97 + rms * .03);
      if (this.recording && now - this.startedAt >= 30000) this.finishRecording();
    }
    async submit(blob, generation) {
      this.busy = true; this.notify();
      this.request = new AbortController();
      const form = new FormData();
      form.set('agent', this.options.agent());
      form.set('history', JSON.stringify(this.options.history().slice(-12)));
      const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      form.set('audio', blob, `turn.${extension}`);
      let shouldResume = false;
      try {
        const base = this.options.base();
        if (!base || base.includes('REPLACE-ME')) throw new Error('Set the Worker URL in docs/config.js first.');
        const response = await fetch(`${base.replace(/\/$/, '')}/turn`, {
          method: 'POST', headers: { 'x-demo-code': this.options.code() },
          body: form, signal: this.request.signal,
        });
        const result = await response.json();
        if (generation !== this.generation) return;
        if (!response.ok) throw new Error(result.error || `Could not complete turn (HTTP ${response.status}).`);
        this.options.onMessage('user', result.transcript);
        this.options.onMessage('assistant', result.reply);
        const bytes = Uint8Array.from(atob(result.audio), char => char.charCodeAt(0));
        this.audioUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType || 'audio/mpeg' }));
        this.options.playback.src = this.audioUrl;
        this.status('Playing reply…', this.active ? 'Listening resumes after the reply.' : 'Tap Start talking for another turn.');
        try { await this.options.playback.play(); }
        catch { this.options.playback.hidden = false; this.status('Tap play to hear the reply.', 'Your browser paused automatic playback.'); }
      } catch (error) {
        if (generation !== this.generation) return;
        this.status(error.name === 'TypeError' ? 'Cannot reach the Worker. Check its URL and PUBLIC_ORIGIN.' : error.message || 'Voice request failed.', 'Check your connection and try again.');
        if (this.active) shouldResume = true;
      } finally {
        if (generation === this.generation) {
          this.busy = false; this.request = null; this.notify();
          if (shouldResume) {
            const failure = this.options.getStatus();
            await this.stop(); this.status(failure, 'Check the connection, then start hands-free again.');
          }
        }
      }
    }
  }
  window.createPipelineTransport = options => new PipelineTransport(options);
})();
