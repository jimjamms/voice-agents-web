/* Keep the mobile composer visible as the software keyboard changes the viewport. */
(() => {
  const viewport = window.visualViewport;
  let frame;
  function fit() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const height = viewport && viewport.scale === 1 ? viewport.height : window.innerHeight;
      if (Number.isFinite(height) && height > 0) {
        document.documentElement.style.setProperty('--mobile-app-height', `${Math.round(height)}px`);
        document.documentElement.dataset.mobileChatCompact = String(height < 600);
      }
    });
  }
  viewport?.addEventListener('resize', fit);
  window.addEventListener('resize', fit);
  window.addEventListener('pageshow', fit);
  fit();
})();
