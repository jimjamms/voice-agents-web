(() => {
  const form = document.querySelector('#trip-setup');
  const setup = document.querySelector('#setup-stage');
  const planning = document.querySelector('#planning-stage');
  const review = document.querySelector('#review-stage');
  const name = document.querySelector('#speaker-name');
  const code = document.querySelector('#access-code');
  const title = document.querySelector('#traveler-title');
  const steps = [document.querySelector('#setup-step'), document.querySelector('#planning-step'), document.querySelector('#review-step')];
  const REVIEW_STORE = 'sage-astra-reviewed-trips-v1';
  let storedReviews = {};
  try { storedReviews = JSON.parse(localStorage.getItem(REVIEW_STORE) || '{}'); } catch {}
  if (!storedReviews || typeof storedReviews !== 'object' || Array.isArray(storedReviews)) storedReviews = {};
  const reviewedTrips = new Set(Object.keys(storedReviews).filter(key => storedReviews[key]?.reviewed === true));
  const reviewGenerations = new Map(Object.entries(storedReviews).map(([key, value]) => [key, value.generation || 0]));
  const persistReviews = () => {
    const values = {};
    for (const [key, generation] of reviewGenerations) values[key] = { generation, reviewed: reviewedTrips.has(key) };
    try { localStorage.setItem(REVIEW_STORE, JSON.stringify(values)); } catch {}
  };
  window.tripWasReviewed = id => reviewedTrips.has(id.trim().toLowerCase());
  const tripKey = () => name.value.trim().toLowerCase() || 'unknown';
  let snapshot = { notes: '', ready: false, choices: { countries: [], cities: [], activities: [] } };
  function renderCompletedNotes(text) {
    const textarea = document.querySelector('#completed-notes');
    if (window.renderTripNotes) window.renderTripNotes(textarea, text);
    else textarea.value = text;
  }
  function step(next) {
    setup.hidden = next !== 'setup'; planning.hidden = next !== 'planning'; review.hidden = next !== 'review';
    document.body.dataset.stage = next;
    for (let i = 0; i < steps.length; i++) {
      const active = ['setup', 'planning', 'review'][i] === next;
      steps[i].classList.toggle('active', active);
      if (active) steps[i].setAttribute('aria-current', 'step'); else steps[i].removeAttribute('aria-current');
    }
  }
  function refreshGoal() {
    document.body.dataset.planReady = String(snapshot.ready);
    document.querySelector('#mobile-details-view').textContent = snapshot.ready ? 'Your completed plan ✓' : 'Checklist & notes';
    const { countries, cities, cityActivities = {}, firstCityReviewed, budget, itinerary, finalized } = snapshot.choices;
    const covered = cities.filter(city => cityActivities[city]).length;
    const requirements = [
      ['country-count', countries.length >= 1, `Choose 1 country (${countries.length}/1)`],
      ['city-count', cities.length >= 2, `Choose 2 cities (${cities.length}/2)`],
      ['activity-count', cities.length >= 2 && covered === cities.length, `1 activity per city (${covered}/${Math.max(2, cities.length)} cities)`],
      ['budget-check', Boolean(budget), budget ? 'Budget confirmed' : 'Confirm your budget'],
      ['final-check', Boolean(finalized && itinerary), finalized && itinerary ? 'Itinerary approved' : 'Approve itinerary with Astra'],
    ];
    for (const [id, done, label] of requirements) {
      const item = document.querySelector(`#${id}`);
      const newlyComplete = done && item.dataset.complete === 'false';
      item.textContent = `${done ? '✓' : '○'} ${label}`;
      item.dataset.complete = String(done);
      if (newlyComplete && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        item.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }], { duration: 320, easing: 'ease-out' });
      }
    }
    document.querySelector('#goal-progress').textContent = `${requirements.filter(([, done]) => done).length} of 5 complete`;
    const completeCount = requirements.filter(([, done]) => done).length;
    const mobileSummary = document.querySelector('#mobile-goal-summary');
    if (mobileSummary) {
      mobileSummary.dataset.ready = String(snapshot.ready);
      document.querySelector('#mobile-goal-count').textContent = `${completeCount}/5`;
      document.querySelector('#mobile-goal-progress').value = completeCount;
      mobileSummary.setAttribute('aria-label', snapshot.ready ? 'View your completed trip checklist' : `Open trip checklist, ${completeCount} of 5 complete`);
      const next = requirements.find(([, done]) => !done);
      document.querySelector('#mobile-goal-next').textContent = snapshot.ready ? 'Your trip is ready to finish.' : `Next: ${next ? next[2] : 'review your itinerary with Astra'}`;
      document.querySelector('#mobile-goal-caption').textContent = snapshot.ready ? 'Tap to view your checklist and continue.' : 'Build a trip that works for you. Your choices can change. Tap to view progress.';
    }

    document.querySelector('#trip-goal-hint').textContent = snapshot.ready ? 'Your trip is ready. Make changes or continue to the form.' :
      countries.length < 1 || cities.length < 1 ? 'Sage: choose your country, first city, and an activity.' :
      !cityActivities[cities[0]] ? `Sage: choose an activity in ${cities[0]}.` :
      !firstCityReviewed ? 'Astra: review your first stop, timing, and budget.' :
      cities.length < 2 ? 'Back to Sage: choose your second city and its activity.' :
      covered < cities.length ? `Sage: choose an activity in ${cities.filter(city => !cityActivities[city]).join(', ')}.` :
      !budget ? 'Astra: confirm your budget, currency, and who it covers.' : 'Astra: review your itinerary, request changes or approve it.';
    document.querySelector('#continue-review').hidden = !snapshot.ready;
    document.querySelector('#plan-ready-notice').hidden = !snapshot.ready;
  }
  if (typeof ResizeObserver === 'function') {
    const completionObserver = new ResizeObserver(entries => {
      const height = entries[0]?.target.getBoundingClientRect().height;
      if (height > 0) document.body.style.setProperty('--completion-bar-height', `${Math.ceil(height)}px`);
    });
    completionObserver.observe(document.querySelector('#plan-ready-notice'));
  }
  function openReview() {
    if (!snapshot.ready || document.body.dataset.stage !== 'planning') return;
    window.dispatchEvent(new Event('trip-review:open'));
    renderCompletedNotes(snapshot.notes);
    document.querySelector('#completed-notepad').dataset.companion = document.querySelector('[data-agent].active')?.dataset.agent || 'sage';
    reviewedTrips.add(tripKey());
    if (!reviewGenerations.has(tripKey())) reviewGenerations.set(tripKey(), 0);
    persistReviews(); window.onTripProfileChange?.(tripKey());
    step('review'); document.querySelector('#review-heading').focus();
  }
  for (const input of [name, code]) input.addEventListener('input', () => input.setCustomValidity(''));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    window.dispatchEvent(new Event('trip-audio:unlock'));
    name.value = name.value.trim(); code.value = code.value.trim();
    name.setCustomValidity(name.value ? '' : 'Enter your name.'); code.setCustomValidity(code.value ? '' : 'Enter your demo code.');
    if (!form.reportValidity()) return;
    const start = document.querySelector('#start-planning');
    if (start.disabled) return;
    start.disabled = true;
    const fields = [...form.querySelectorAll('input')].filter(field => !field.disabled);
    fields.forEach(field => { field.disabled = true; });
    const loginStatus = document.querySelector('#profile-login-status');
    try {
      if (window.restoreTripProfile) {
        loginStatus.textContent = 'Loading your saved trip…';
        // Activate the local name before applying its cloud notes.
        name.dispatchEvent(new Event('change', { bubbles: true }));
        await window.restoreTripProfile(name.value);
        loginStatus.textContent = '';
      }
    } catch (error) { loginStatus.textContent = error.message; return; }
    finally { start.disabled = false; fields.forEach(field => { field.disabled = false; }); }
    name.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-agent="sage"]').click();
    title.textContent = `${name.value}’s trip`; step('planning'); title.focus();
    window.dispatchEvent(new Event('trip-planning:open'));
  });
  document.querySelector('#change-setup').addEventListener('click', () => {
    window.dispatchEvent(new Event('trip-setup:open'));
    form.dataset.companion = 'sage'; step('setup'); name.focus();
  });
  window.addEventListener('trip-notes:updated', event => {
    if (event.detail.key !== (name.value.trim().toLowerCase() || 'unknown')) return;
    snapshot = event.detail; refreshGoal();
    if (document.body.dataset.stage === 'review') {
      renderCompletedNotes(snapshot.notes);
      if (!snapshot.ready) { step('planning'); title.focus(); }
    }
  });
  window.addEventListener('trip-profile:loaded', event => {
    const { name: key, generation, reviewed } = event.detail;
    if ((reviewGenerations.get(key) || 0) !== generation) reviewedTrips.delete(key);
    if (reviewed) reviewedTrips.add(key);
    reviewGenerations.set(key, generation); persistReviews();
  });
  window.addEventListener('trip-profile:deleted', event => {
    if (name.value.trim().toLowerCase() !== event.detail.name) return;
    reviewedTrips.delete(event.detail.name); reviewGenerations.delete(event.detail.name); persistReviews();
    document.querySelector('#profile-login-status').textContent = event.detail.message;
    renderCompletedNotes('');
    step('setup'); name.focus();
  });
  // Finish opens only through an explicit Continue button click.
  document.querySelector('#continue-review').addEventListener('click', openReview);
  document.querySelector('#back-to-planning').addEventListener('click', () => { step('planning'); title.focus(); });
  document.querySelector('#copy-completed-notes').addEventListener('click', async () => {
    const notes = document.querySelector('#completed-notes');
    try { await navigator.clipboard.writeText(notes.value); document.querySelector('#completed-status').textContent = 'Copied.'; }
    catch { if (window.selectTripNotes) window.selectTripNotes(notes); else { notes.focus(); notes.select(); } document.querySelector('#completed-status').textContent = 'Select and copy the notes manually.'; }
  });
  const link = document.querySelector('#google-form-link');
  try {
    const url = new URL(window.VOICE_DEMO_CONFIG?.googleFormUrl || '');
    if (url.protocol !== 'https:' || !['docs.google.com', 'forms.gle'].includes(url.hostname) || (url.hostname === 'docs.google.com' && !url.pathname.startsWith('/forms/'))) throw new Error('Not a Google Form');
    link.href = url.href; link.hidden = false;
    document.querySelector('#form-coming-soon').hidden = true; document.querySelector('#form-open-hint').hidden = false;
  } catch { link.hidden = true; }
})();
