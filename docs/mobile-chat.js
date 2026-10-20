/* Fit the mobile chat to the visible viewport without scrolling the document. */
(() => {
  const viewport = window.visualViewport;
  const mobile = window.matchMedia('(max-width:850px)');
  const root = document.documentElement;
  let frame, focusTimer;
  function fit() {
    const active = mobile.matches && document.body.dataset.stage === 'planning';
    root.dataset.mobileChatActive = String(active);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const unzoomed = viewport && viewport.scale === 1;
      const height = unzoomed ? viewport.height : window.innerHeight;
      const offset = active && unzoomed ? Math.max(0, viewport.offsetTop || 0) : 0;
      if (Number.isFinite(height) && height > 0) {
        root.style.setProperty('--mobile-app-height', `${Math.round(height)}px`);
        root.style.setProperty('--mobile-viewport-top', `${Math.round(offset)}px`);
        root.dataset.mobileChatCompact = String(height < 600);
      }
    });
  }
  // Safari may pan the visual viewport as well as shrinking it for the keyboard.
  viewport?.addEventListener('resize', fit);
  viewport?.addEventListener('scroll', fit);
  window.addEventListener('resize', fit);
  window.addEventListener('pageshow', fit);
  mobile.addEventListener('change', fit);
  new MutationObserver(fit).observe(document.body, { attributes: true, attributeFilter: ['data-stage'] });
  document.addEventListener('focusin', event => {
    if (event.target.id !== 'chat-text' || !mobile.matches || document.body.dataset.stage !== 'planning') return;
    fit(); clearTimeout(focusTimer); focusTimer = setTimeout(fit, 350);
  });
  document.addEventListener('focusout', event => {
    if (event.target.id !== 'chat-text') return;
    fit(); clearTimeout(focusTimer); focusTimer = setTimeout(fit, 350);
  });
  fit();
})();
