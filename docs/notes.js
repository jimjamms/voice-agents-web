/* User-visible itinerary notes; only their basic itinerary facts are shared as public checklist context. */
(() => {
  // Render read-only notes as text nodes so headings can be styled safely.
  function renderTripNotes(textarea, text) {
    const changed = Boolean(textarea.value) && textarea.value !== text;
    textarea.value = text;
    const view = textarea.nextElementSibling;
    if (!view?.classList?.contains('notes-content')) return;
    view.replaceChildren();
    if (!text.trim()) {
      const placeholder = document.createElement('span'); placeholder.className = 'notes-placeholder';
      placeholder.textContent = textarea.placeholder || 'Your completed trip details will appear here.';
      view.append(placeholder); return;
    }
    for (const line of text.split('\n')) {
      const row = document.createElement('div'); row.className = 'note-line';
      const heading = line.trim().replace(/^#{1,3}\s+/, '').replace(/^\*\*(.*?)\*\*:?$/, '$1').replace(/:$/, '');
      if (/^(Need to know|To do|Still undecided|Itinerary|Budget|Trip overview|Travel details)$/i.test(heading)) {
        const strong = document.createElement('strong'); strong.textContent = heading;
        row.classList.add('note-heading'); row.append(strong);
      } else {
        const label = line.match(/^(\s*(?:[-•]\s*)?[^:]{1,60}:)(.*)$/);
        if (label) {
          const strong = document.createElement('strong'); strong.textContent = label[1];
          const rest = document.createElement('span'); rest.textContent = label[2];
          row.append(strong, rest);
        } else row.textContent = line || '\u00a0';
      }
      view.append(row);
    }
    if (changed && text.trim() && view.getClientRects?.().length && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      view.animate?.([{ boxShadow: 'inset 0 0 0 0 transparent' }, { boxShadow: 'inset 0 0 0 2px var(--note-accent, #476e53)' }, { boxShadow: 'inset 0 0 0 0 transparent' }], { duration: 500, easing: 'ease-out' });
    }
  }
  function selectTripNotes(textarea) {
    const view = textarea.nextElementSibling;
    if (view?.classList?.contains('notes-content')) {
      view.focus(); const range = document.createRange(); range.selectNodeContents(view);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    } else { textarea.focus(); textarea.select(); }
  }
  window.renderTripNotes = renderTripNotes;
  window.selectTripNotes = selectTripNotes;
  const STORE = 'sage-astra-trip-notes-v1';
  class TripNotes {
    constructor(options) {
      this.options = options; this.queue = Promise.resolve(); this.revisions = new Map(); this.epochs = new Map();
      try { this.saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { this.saved = {}; }
      if (!this.saved || typeof this.saved !== 'object' || Array.isArray(this.saved)) this.saved = {};
      options.textarea.readOnly = true;
      options.clear.addEventListener('click', () => {
        const key = this.key(); this.bump(key); this.epochs.set(key, (this.epochs.get(key) || 0) + 1);
        this.saved[key] = { notes: '', choices: { countries: [], cities: [], activities: [] } }; renderTripNotes(options.textarea, ''); this.persist(key); this.publish(false);
      });
      options.copy.addEventListener('click', async () => {
        if (!options.textarea.value) { this.status('No trip notes yet.'); return; }
        try { await navigator.clipboard.writeText(options.textarea.value); this.status('Copied.'); }
        catch { selectTripNotes(options.textarea); this.status('Select and copy the notes manually.'); }
      });
      this.refresh();
    }
    key(speaker = this.options.speaker()) { return speaker.trim().toLowerCase() || 'unknown'; }
    text(key) {
      const value = this.saved[key];
      return (typeof value === 'string' ? value : typeof value?.notes === 'string' ? value.notes : '').slice(0, 6000).replace(/\n*(Need to know|To do|Still undecided)\s*:?\n/g, '\n\n$1\n').trim();
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
      result.cityActivities = {};
      for (const city of result.cities) {
        const key = Object.keys(value.cityActivities || {}).find(item => item.trim().toLowerCase() === city.toLowerCase());
        const activity = value.cityActivities?.[key];
        if (typeof activity === 'string' && activity.trim()) result.cityActivities[city] = activity.trim();
      }
      const budget = value.budget;
      result.budget = budget && typeof budget.amount === 'number' && Number.isFinite(budget.amount) && budget.amount > 0 &&
        typeof budget.currency === 'string' && budget.currency.trim() && ['per person', 'whole trip'].includes(budget.scope) ? budget : null;
      result.itinerary = value.itinerary && ['timing', 'route', 'transport', 'lodging', 'costs'].every(
        field => typeof value.itinerary[field] === 'string' && value.itinerary[field].trim()) ? value.itinerary : null;
      result.firstCityReviewed = typeof value.firstCityReviewed === 'string' ?
        result.cities.find(city => city.toLowerCase() === value.firstCityReviewed.trim().toLowerCase() && result.cityActivities[city]) || null : null;
      result.finalized = value.finalized === true;
      return result;
    }
    publish(updated) {
      const choices = this.choices();
      this.options.onChange?.({ key: this.key(), notes: this.text(this.key()), choices, updated,
        ready: choices.countries.length >= 1 && choices.cities.length >= 2 && choices.cities.every(city => choices.cityActivities[city]) && Boolean(choices.budget) && Boolean(choices.itinerary) && choices.finalized });
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
    refresh() { renderTripNotes(this.options.textarea, this.text(this.key())); this.status('Your trip details and next steps, updated as you plan.'); this.publish(false); }
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
            body: JSON.stringify({ agent: turn.agent, userText: String(turn.transcript || '').slice(0, 3500), reply: String(turn.reply || '').slice(0, 3500), priorConversation: (turn.priorConversation || []).slice(-8).map(item => ({ role: item.role, content: String(item.content || '').slice(0, 3500), agent: item.agent })), notes: this.text(key), choices: this.choices(key) }),
          });
          const result = await response.json();
          if (!response.ok || typeof result.notes !== 'string' || result.notes.length > 6000) throw new Error('Notes failed');
          if ((this.epochs.get(key) || 0) !== epoch || (this.revisions.get(key) || 0) !== revision) {
            this.status('Your edits were kept. Auto-update skipped this turn.', key); return;
          }
          this.saved[key] = { notes: result.notes, choices: result.choices || { countries: [], cities: [], activities: [] } }; this.bump(key); this.persist(key);
          if (key === this.key()) { renderTripNotes(this.options.textarea, this.text(key)); this.publish(true); }
        } catch { this.status('Could not auto-update. Your saved notes are unchanged.', key); }
        finally { clearTimeout(timer); }
      });
      return this.queue;
    }
  }
  window.createTripNotes = options => new TripNotes(options);
})();
