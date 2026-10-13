/* User-visible itinerary notes; these are never injected into either agent's chat. */
(() => {
  const STORE = 'sage-astra-trip-notes-v1';
  class TripNotes {
    constructor(options) {
      this.options = options; this.queue = Promise.resolve(); this.revisions = new Map(); this.epochs = new Map();
      try { this.saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { this.saved = {}; }
      if (!this.saved || typeof this.saved !== 'object' || Array.isArray(this.saved)) this.saved = {};
      options.textarea.readOnly = true;
      options.clear.addEventListener('click', () => {
        const key = this.key(); this.bump(key); this.epochs.set(key, (this.epochs.get(key) || 0) + 1);
        this.saved[key] = { notes: '', choices: { countries: [], cities: [], activities: [] } }; options.textarea.value = ''; this.persist(key); this.publish(false);
      });
      options.copy.addEventListener('click', async () => {
        if (!options.textarea.value) { this.status('No trip notes yet.'); return; }
        try { await navigator.clipboard.writeText(options.textarea.value); this.status('Copied.'); }
        catch { options.textarea.focus(); options.textarea.select(); this.status('Select and copy the notes manually.'); }
      });
      this.refresh();
    }
    key(speaker = this.options.speaker()) { return speaker.trim().toLowerCase() || 'unknown'; }
    text(key) {
      const value = this.saved[key];
      return (typeof value === 'string' ? value : typeof value?.notes === 'string' ? value.notes : '').slice(0, 6000);
    }
    choices(key = this.key()) {
      const value = this.saved[key]?.choices || {};
      const result = {};
      for (const field of ['countries', 'cities', 'activities']) {
        const seen = new Set();
        result[field] = (Array.isArray(value[field]) ? value[field] : []).filter(item => {
          if (typeof item !== 'string' || !item.trim()) return false;
          const id = item.trim().toLowerCase(); if (seen.has(id)) return false; seen.add(id); return true;
        }).map(item => item.trim());
      }
      const budget = value.budget;
      result.budget = budget && typeof budget.amount === 'number' && Number.isFinite(budget.amount) && budget.amount > 0 &&
        typeof budget.currency === 'string' && budget.currency.trim() && ['per person', 'whole trip'].includes(budget.scope) ? budget : null;
      result.itinerary = value.itinerary && ['timing', 'route', 'transport', 'lodging', 'costs'].every(
        field => typeof value.itinerary[field] === 'string' && value.itinerary[field].trim()) ? value.itinerary : null;
      result.finalized = value.finalized === true;
      return result;
    }
    publish(updated) {
      const choices = this.choices();
      this.options.onChange?.({ key: this.key(), notes: this.text(this.key()), choices, updated,
        ready: choices.countries.length >= 1 && choices.cities.length >= 3 && choices.activities.length >= 1 && choices.activities.length <= 2 && Boolean(choices.budget) && Boolean(choices.itinerary) && choices.finalized });
    }
    snapshot(speaker) { const key = this.key(speaker); return { notes: this.text(key), choices: this.choices(key) }; }
    restore(speaker, profile) {
      const key = this.key(speaker); this.bump(key); this.epochs.set(key, (this.epochs.get(key) || 0) + 1);
      this.saved[key] = { notes: profile.notes, choices: profile.choices };
      try { localStorage.setItem(STORE, JSON.stringify(this.saved)); } catch {}
      if (key === this.key()) this.refresh();
    }
    bump(key) { this.revisions.set(key, (this.revisions.get(key) || 0) + 1); }
    status(text, key = this.key()) { if (key === this.key()) this.options.status.textContent = text; }
    persist(key) {
      this.options.onPersist?.(key);
      try { localStorage.setItem(STORE, JSON.stringify(this.saved)); this.status('Saved in this browser.', key); }
      catch { this.status('Saved for this visit; browser storage is unavailable.', key); }
    }
    refresh() { this.options.textarea.value = this.text(this.key()); this.status('Your trip details and next steps, updated as you plan.'); this.publish(false); }
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
            body: JSON.stringify({ agent: turn.agent, userText: String(turn.transcript || '').slice(0, 3500), reply: String(turn.reply || '').slice(0, 3500), notes: this.text(key), choices: this.choices(key) }),
          });
          const result = await response.json();
          if (!response.ok || typeof result.notes !== 'string' || result.notes.length > 6000) throw new Error('Notes failed');
          if ((this.epochs.get(key) || 0) !== epoch || (this.revisions.get(key) || 0) !== revision) {
            this.status('Your edits were kept. Auto-update skipped this turn.', key); return;
          }
          this.saved[key] = { notes: result.notes, choices: result.choices || { countries: [], cities: [], activities: [] } }; this.bump(key); this.persist(key);
          if (key === this.key()) { this.options.textarea.value = result.notes; this.publish(true); }
        } catch { this.status('Could not auto-update. Your saved notes are unchanged.', key); }
        finally { clearTimeout(timer); }
      });
      return this.queue;
    }
  }
  window.createTripNotes = options => new TripNotes(options);
})();
