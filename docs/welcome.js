// Show the neutral introduction on every page opening, including refreshes.
(() => {
  const welcome = document.querySelector('#study-welcome');
  if (!welcome) return;
  welcome.addEventListener('close', () => document.querySelector('#speaker-name')?.focus());
  if (!welcome.open) welcome.showModal();
})();
