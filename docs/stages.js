(() => {
  const form = document.querySelector('#trip-setup');
  const setup = document.querySelector('#setup-stage');
  const planning = document.querySelector('#planning-stage');
  const name = document.querySelector('#speaker-name');
  const code = document.querySelector('#access-code');
  const title = document.querySelector('#traveler-title');
  const radios = [...form.querySelectorAll('input[name="initial-agent"]')];
  const setupStep = document.querySelector('#setup-step');
  const planningStep = document.querySelector('#planning-step');
  function step(next) {
    const ready = next === 'planning';
    setup.hidden = ready; planning.hidden = !ready; document.body.dataset.stage = next;
    setupStep.classList.toggle('active', !ready); planningStep.classList.toggle('active', ready);
    (ready ? planningStep : setupStep).setAttribute('aria-current', 'step');
    (ready ? setupStep : planningStep).removeAttribute('aria-current');
  }
  for (const input of [name, code]) input.addEventListener('input', () => input.setCustomValidity(''));
  for (const radio of radios) radio.addEventListener('change', () => { if (radio.checked) form.dataset.companion = radio.value; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    name.value = name.value.trim(); code.value = code.value.trim();
    name.setCustomValidity(name.value ? '' : 'Enter your name.');
    code.setCustomValidity(code.value ? '' : 'Enter your demo code.');
    if (!form.reportValidity()) return;
    const selected = radios.find(radio => radio.checked)?.value || 'sage';
    name.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector(`[data-agent="${selected}"]`).click();
    title.textContent = `${name.value}’s trip`;
    step('planning'); title.focus();
  });
  document.querySelector('#change-setup').addEventListener('click', () => {
    window.dispatchEvent(new Event('trip-setup:open'));
    const current = document.querySelector('[data-agent].active')?.dataset.agent || 'sage';
    for (const radio of radios) radio.checked = radio.value === current;
    form.dataset.companion = current; step('setup'); name.focus();
  });
})();
