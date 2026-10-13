(() => {
  const form = document.querySelector('#trip-setup');
  const setup = document.querySelector('#setup-stage');
  const planning = document.querySelector('#planning-stage');
  const review = document.querySelector('#review-stage');
  const name = document.querySelector('#speaker-name');
  const code = document.querySelector('#access-code');
  const title = document.querySelector('#traveler-title');
  const radios = [...form.querySelectorAll('input[name="initial-agent"]')];
  const steps = [document.querySelector('#setup-step'), document.querySelector('#planning-step'), document.querySelector('#review-step')];
  let snapshot = { notes: '', ready: false, choices: { countries: [], cities: [], activities: [] } };
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
    const { countries, cities, activities, budget, itinerary, finalized } = snapshot.choices;
    document.querySelector('#country-count').textContent = `Country ${countries.length}/1+`;
    document.querySelector('#city-count').textContent = `Cities ${cities.length}/3+`;
    document.querySelector('#activity-count').textContent = `Activities ${activities.length}/1–2`;
    document.querySelector('#budget-check').textContent = budget ? 'Budget confirmed' : 'Budget pending';
    document.querySelector('#final-check').textContent = finalized && itinerary ? 'Plan finalized' : 'Plan pending';
    document.querySelector('#trip-goal-hint').textContent = activities.length > 2 ? 'Choose your top one or two activities.' :
      snapshot.ready ? 'Your budget and itinerary are confirmed.' :
      countries.length < 1 || cities.length < 3 || activities.length < 1 ? 'Choose your destinations and activities with Sage.' :
      !budget ? 'Confirm your spending limit and currency with Astra.' : 'Review and approve your complete itinerary with Astra.';
    document.querySelector('#continue-review').hidden = !snapshot.ready;
  }
  function openReview() {
    if (!snapshot.ready || document.body.dataset.stage !== 'planning') return;
    window.dispatchEvent(new Event('trip-review:open'));
    document.querySelector('#completed-notes').value = snapshot.notes;
    document.querySelector('#completed-notepad').dataset.companion = document.querySelector('[data-agent].active')?.dataset.agent || 'sage';
    step('review'); document.querySelector('#review-heading').focus();
  }
  for (const input of [name, code]) input.addEventListener('input', () => input.setCustomValidity(''));
  for (const radio of radios) radio.addEventListener('change', () => { if (radio.checked) form.dataset.companion = radio.value; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); name.value = name.value.trim(); code.value = code.value.trim();
    name.setCustomValidity(name.value ? '' : 'Enter your name.'); code.setCustomValidity(code.value ? '' : 'Enter your demo code.');
    if (!form.reportValidity()) return;
    const start = document.querySelector('#start-planning');
    if (start.disabled) return;
    start.disabled = true;
    const fields = [...form.querySelectorAll('input')];
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
    const selected = radios.find(radio => radio.checked)?.value || 'sage';
    name.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector(`[data-agent="${selected}"]`).click();
    title.textContent = `${name.value}’s trip`; step('planning'); title.focus();
  });
  document.querySelector('#change-setup').addEventListener('click', () => {
    window.dispatchEvent(new Event('trip-setup:open'));
    const current = document.querySelector('[data-agent].active')?.dataset.agent || 'sage';
    for (const radio of radios) radio.checked = radio.value === current;
    form.dataset.companion = current; step('setup'); name.focus();
  });
  window.addEventListener('trip-notes:updated', event => {
    if (event.detail.key !== (name.value.trim().toLowerCase() || 'unknown')) return;
    snapshot = event.detail; refreshGoal();
    if (document.body.dataset.stage === 'review') {
      document.querySelector('#completed-notes').value = snapshot.notes;
      if (!snapshot.ready) { step('planning'); title.focus(); }
    }
  });
  window.addEventListener('trip-goal:complete', openReview);
  document.querySelector('#continue-review').addEventListener('click', openReview);
  document.querySelector('#back-to-planning').addEventListener('click', () => { step('planning'); title.focus(); });
  document.querySelector('#copy-completed-notes').addEventListener('click', async () => {
    const notes = document.querySelector('#completed-notes');
    try { await navigator.clipboard.writeText(notes.value); document.querySelector('#completed-status').textContent = 'Copied.'; }
    catch { notes.focus(); notes.select(); document.querySelector('#completed-status').textContent = 'Select and copy the notes manually.'; }
  });
  const link = document.querySelector('#google-form-link');
  try {
    const url = new URL(window.VOICE_DEMO_CONFIG?.googleFormUrl || '');
    if (url.protocol !== 'https:' || !['docs.google.com', 'forms.gle'].includes(url.hostname) || (url.hostname === 'docs.google.com' && !url.pathname.startsWith('/forms/'))) throw new Error('Not a Google Form');
    link.href = url.href; link.hidden = false;
    document.querySelector('#form-coming-soon').hidden = true; document.querySelector('#form-open-hint').hidden = false;
  } catch { link.hidden = true; }
})();
