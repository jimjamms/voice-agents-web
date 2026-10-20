/* Browser recording for the original transcription → chat → TTS flow. */
(() => {
  const formats = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  // Browser microphone levels are normalized (unlike the desktop's int16 RMS).
  const INTERRUPT_BASELINE = .045;
  const INTERRUPT_MULTIPLIER = 2.5;
  const INTERRUPT_TRIGGER_MS = 500;
  class PipelineTransport {
    constructor(options) {
      this.options = options;
      this.pendingPlayback = false; this.unlocking = false; this.audioUnlock = null;
      this.active = false; this.busy = false; this.recording = false; this.connecting = false;
      this.stream = null; this.recorder = null; this.context = null; this.analyser = null;
      this.chunks = []; this.timer = null; this.interval = null; this.audioUrl = null;
      this.request = null; this.generation = 0;
      this.playing = false; this.interruptStartedAt = null;
      this.replyText = ''; this.replyDisplay = null; this.replyWords = []; this.replyFrame = null; this.lastWordCount = -1;
      this.options.playback.addEventListener('ended', () => {
        if (this.unlocking || !this.options.isSelected()) return;
        this.finishReply();
        this.playing = false; this.notify();
        if (this.interruptStartedAt !== null && this.recording) {
          this.interruptStartedAt = null;
          this.voicedMs = Math.max(this.voicedMs, INTERRUPT_TRIGGER_MS);
          this.lastSpeech = performance.now();
          this.status('I hear you…', 'Pause when you finish.');
          return;
        }
        if (this.active) this.resume();
        else this.status('Your turn', 'Tap Start talking for another turn.');
      });
      this.options.playback.addEventListener('play', () => {
        if (this.unlocking || !this.options.isSelected()) return;
        this.pendingPlayback = false; this.playing = true; this.notify();
        if (!this.active) return;
        this.stream?.getAudioTracks().forEach(track => { track.enabled = true; });
        this.status('Playing reply…', 'You can interrupt by speaking. Headphones help prevent echo.');
      });
    }
    beginReply(text) {
      this.stopReplyFrames();
      this.replyText = text; this.replyWords = text.match(/\S+\s*/g) || []; this.lastWordCount = -1;
      this.replyDisplay = this.options.onReplyStart?.(text) || null;
      if (!this.replyDisplay) { this.options.onMessage('assistant', text); return; }
      this.startReplyFrames();
    }
    revealReply(count) {
      if (!this.replyDisplay) return;
      count = Math.min(this.replyWords.length, count);
      if (count !== this.lastWordCount) {
        this.lastWordCount = count; this.replyDisplay(this.replyWords.slice(0, count).join('').trimEnd());
      }
    }
    startReplyFrames() {
      this.stopReplyFrames();
      if (!this.replyDisplay) return;
      if (typeof requestAnimationFrame !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        this.finishReply(); return;
      }
      // Small word groups every 60 ms, independent of speech; long replies catch up in about four seconds.
      const batch = Math.max(2, Math.ceil(this.replyWords.length / 65));
      this.revealReply(batch);
      let startedAt = null;
      const tick = now => {
        this.replyFrame = null;
        if (!this.replyDisplay || !this.options.isSelected()) return;
        if (startedAt === null) startedAt = now;
        this.revealReply(batch * (1 + Math.floor((now - startedAt) / 60)));
        if (this.lastWordCount >= this.replyWords.length) { this.finishReply(); return; }
        this.replyFrame = requestAnimationFrame(tick);
      };
      this.replyFrame = requestAnimationFrame(tick);
    }
    stopReplyFrames() {
      if (this.replyFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.replyFrame);
      this.replyFrame = null;
    }
    finishReply() {
      this.stopReplyFrames(); this.replyDisplay?.(this.replyText);
      this.replyDisplay = null; this.replyText = ''; this.replyWords = [];
    }
    isLocked() { return this.active || this.busy || this.recording || this.connecting || this.playing; }
    notify() { this.options.onState(this); }
    status(message, detail) { this.options.onStatus(message, detail); }
    format() { return formats.find(type => MediaRecorder.isTypeSupported(type)); }
    stopPlayback() {
      this.finishReply();
      this.playing = false; this.pendingPlayback = false; this.interruptStartedAt = null;
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
    unlockAudio() {
      if (this.unlocking || this.isLocked()) return;
      this.unlocking = true;
      const audio = this.options.playback;
      audio.src = 'data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      this.audioUnlock = (async () => {
        try { await audio.play(); } catch {} finally {
          audio.pause(); audio.removeAttribute('src'); this.unlocking = false;
        }
      })();
      return this.audioUnlock;
    }
    async press() {
      if (this.pendingPlayback) {
        try {
          await this.options.playback.play(); this.pendingPlayback = false;
          this.playing = true; this.notify();
        } catch { this.status('Tap the audio player to hear the reply.'); }
        return;
      }
      if (this.playing) {
        this.options.onInterrupt?.();
        this.stopPlayback();
        if (this.active) { this.discardCandidate(); this.resume(); this.beginRecording(this.generation); this.lastSpeech = performance.now(); this.voicedMs = 300; return; }
        await this.startTap(); return;
      }
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
      recorder.addEventListener('dataavailable', event => {
        if (this.recorder === recorder && event.data.size) this.chunks.push(event.data);
      });
      recorder.addEventListener('stop', async () => {
        if (this.recorder !== recorder) return; // A discarded interruption candidate.
        const blob = new Blob(this.chunks, { type: recorder.mimeType }); this.chunks = [];
        if (generation !== this.generation) return;
        if (!this.active) { this.stream?.getTracks().forEach(track => track.stop()); this.stream = null; }
        if (blob.size < 500 || (this.active && this.voicedMs < 300)) {
          this.busy = false;
          if (this.active) this.resume();
          else this.status('That recording was too short. Try again.');
          this.notify(); return;
        }
        this.clipDurationMs = Math.max(0, Math.min(60000, Math.round(performance.now() - this.startedAt)));
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
    discardCandidate() {
      this.interruptStartedAt = null;
      if (this.recorder?.state === 'recording') {
        const recorder = this.recorder;
        this.recorder = null; this.recording = false;
        recorder.stop(); this.notify();
      }
      this.chunks = [];
    }
    measure(generation) {
      if (generation !== this.generation || !this.active || this.busy || !this.analyser) return;
      this.analyser.getFloatTimeDomainData(this.samples);
      let power = 0;
      for (let i = 0; i < this.samples.length; i++) power += this.samples[i] ** 2;
      const rms = Math.sqrt(power / this.samples.length); const now = performance.now();
      if (this.playing) {
        const threshold = Math.max(INTERRUPT_BASELINE, this.ambient * 3 * INTERRUPT_MULTIPLIER);
        if (rms > threshold) {
          if (this.interruptStartedAt === null) {
            this.interruptStartedAt = now;
            this.beginRecording(generation); // Keep the first half-second of speech.
          } else if (now - this.interruptStartedAt >= INTERRUPT_TRIGGER_MS) {
            this.voicedMs = now - this.interruptStartedAt;
            this.lastSpeech = now;
            this.options.onInterrupt?.();
            this.stopPlayback();
            this.status('Reply interrupted — I hear you…', 'Pause when you finish.');
          }
        } else if (this.interruptStartedAt !== null) this.discardCandidate();
        return;
      }
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
    async greet(handoffStep = '') {
      if (this.isLocked()) return;
      const generation = ++this.generation;
      await this.audioUnlock;
      if (generation !== this.generation) return;
      return await this.submit(null, generation, null, true, handoffStep);
    }
    async sendText(text, speakReply = false) {
      text = String(text || '').trim();
      if (!text || text.length > 1600 || this.busy || this.connecting || this.recording || this.active) return false;
      if (!this.options.code()) { this.status('Enter the demo access code first.'); this.options.focusCode(); return false; }
      this.stopPlayback();
      return Boolean(await this.submit(null, ++this.generation, text, speakReply));
    }
    async submit(blob, generation, text = null, speakReply = true, handoffStep = '') {
      speakReply = speakReply && this.options.shouldSpeak?.() !== false;
      this.busy = true; this.notify();
      this.status(blob || text !== null ? 'Preparing your reply…' : 'Preparing your welcome…', !speakReply ? 'Your agent will answer here in text.' : 'Your agent will speak when the reply is ready.');
      this.request = new AbortController();
      const speaker = { name: this.options.speaker(), score: 1 };
      const selectedAgent = this.options.agent();
      const mode = this.options.memoryMode();
      const form = new FormData();
      form.set('agent', selectedAgent);
      form.set('trip_choices', JSON.stringify(this.options.tripChoices?.() || {}));
      form.set('trip_notes', String(this.options.tripNotes?.() || '').slice(0, 6000));
      form.set('planning_round', this.options.planningRound?.() || '');
      form.set('defer_memory', 'true');
      form.set('speaker', speaker.name);
      form.set('memory_mode', mode);
      form.set('memories', JSON.stringify(this.options.memories()));
      form.set('shared_turns', JSON.stringify(mode === 'shared' ? this.options.sharedTurns?.() || [] : []));
      form.set('history', JSON.stringify(this.options.history().slice(-24)));
      form.set('reply_audio', String(speakReply));
      if (text !== null) { form.set('text', text); }
      else if (!blob) { form.set('greeting', 'true'); if (handoffStep) form.set('handoff_step', handoffStep); }
      const extension = blob?.type.includes('mp4') ? 'm4a' : blob?.type.includes('ogg') ? 'ogg' : 'webm';
      if (blob) { form.set('audio', blob, `turn.${extension}`); if (this.clipDurationMs) form.set('speech_duration_ms', String(this.clipDurationMs)); }
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
        this.options.onTurn({ agent: selectedAgent, mode, speaker: speaker.name, ...result, audio: undefined });
        if (generation !== this.generation) return;
        this.options.onMessage('user', result.transcript, speaker);
        this.beginReply(result.reply);
        if (!speakReply || this.options.shouldSpeak?.() === false || !result.audio) {
          this.finishReply(); this.status('Your turn', 'Type a message or tap Start talking.'); return true;
        }
        const bytes = Uint8Array.from(atob(result.audio), char => char.charCodeAt(0));
        this.audioUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType || 'audio/mpeg' }));
        this.options.playback.src = this.audioUrl;
        this.playing = true; this.notify();
        this.status('Playing reply…', this.active ? 'Speak to interrupt; headphones help prevent echo.' : 'Tap Start talking for another turn.');
        try { await this.options.playback.play(); }
        catch {
          this.playing = false; this.pendingPlayback = true; this.notify();
          this.options.playback.hidden = false;
          if (this.active) this.resume();
          this.status('Tap play to hear the reply.', 'Your browser paused automatic playback.');
        }
        return true;
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
