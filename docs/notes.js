/* User-visible itinerary notes; these are never injected into either agent's chat. */
(() => {
  const STORE = 'sage-astra-trip-notes-v1';
  class TripNotes {
    constructor(options) {
      this.options = options; this.queue = Promise.resolve(); this.revisions = new Map(); this.epochs = new Map();
      try { this.saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { this.saved = {}; }
      if (!this.saved || typeof this.saved !== 'object' || Array.isArray(this.saved)) this.saved = {};
      options.textarea.addEventListener('input', () => {
        const key = this.key(); this.bump(key);
        this.saved[key] = options.textarea.value; this.persist(key);
      });
      options.clear.addEventListener('click', () => {
        const key = this.key(); this.bump(key); this.epochs.set(key, (this.epochs.get(key) || 0) + 1);
        this.saved[key] = ''; options.textarea.value = ''; this.persist(key);
      });
      options.copy.addEventListener('click', async () => {
        if (!options.textarea.value) { this.status('No trip notes yet.'); return; }
        try { await navigator.clipboard.writeText(options.textarea.value); this.status('Copied.'); }
        catch { options.textarea.focus(); options.textarea.select(); this.status('Select and copy the notes manually.'); }
      });
      this.refresh();
    }
    key(speaker = this.options.speaker()) { return speaker.trim().toLowerCase() || 'unknown'; }
    text(key) { return typeof this.saved[key] === 'string' ? this.saved[key].slice(0, 6000) : ''; }
    bump(key) { this.revisions.set(key, (this.revisions.get(key) || 0) + 1); }
    status(text, key = this.key()) { if (key === this.key()) this.options.status.textContent = text; }
    persist(key) {
      try { localStorage.setItem(STORE, JSON.stringify(this.saved)); this.status('Saved in this browser.', key); }
      catch { this.status('Saved for this visit; browser storage is unavailable.', key); }
    }
    refresh() { this.options.textarea.value = this.text(this.key()); this.status('Only the important trip details. You can edit them.'); }
    update(turn) {
      const key = this.key(turn.speaker || 'Unknown'); const epoch = this.epochs.get(key) || 0;
      const base = this.options.base(); const code = this.options.code();
      if (!base || base.includes('REPLACE-ME') || !code) return Promise.resolve();
      this.queue = this.queue.catch(() => {}).then(async () => {
        if ((this.epochs.get(key) || 0) !== epoch) return;
        const revision = this.revisions.get(key) || 0;
        this.status('Updating trip notes…', key);
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 60000);
        try {
          const response = await fetch(`${base.replace(/\/$/, '')}/notes`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-code': code }, signal: controller.signal,
            body: JSON.stringify({ agent: turn.agent, userText: String(turn.transcript || '').slice(0, 3500), reply: String(turn.reply || '').slice(0, 3500), notes: this.text(key) }),
          });
          const result = await response.json();
          if (!response.ok || typeof result.notes !== 'string' || result.notes.length > 6000) throw new Error('Notes failed');
          if ((this.epochs.get(key) || 0) !== epoch || (this.revisions.get(key) || 0) !== revision) {
            this.status('Your edits were kept. Auto-update skipped this turn.', key); return;
          }
          this.saved[key] = result.notes; this.bump(key); this.persist(key);
          if (key === this.key()) this.options.textarea.value = result.notes;
        } catch { this.status('Could not auto-update. You can still edit your notes.', key); }
        finally { clearTimeout(timer); }
      });
      return this.queue;
    }
  }
  window.createTripNotes = options => new TripNotes(options);
})();
