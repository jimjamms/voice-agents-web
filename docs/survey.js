/* Survey completion comes from a signed server receipt, never iframe load events. */
(() => {
  const frame = document.querySelector('#google-form-embed');
  const status = document.querySelector('#survey-status');
  const retry = document.querySelector('#survey-retry');
  const edit = document.querySelector('#survey-edit');
  const unavailable = document.querySelector('#form-coming-soon');
  let timer, controller, activeName = '', serial = 0, editUrl = '', editing = false;
  const isOpen = () => document.body.dataset.stage === 'review';
  function stop() { clearTimeout(timer); controller?.abort(); serial++; }
  async function check() {
    if (!isOpen() || document.hidden) return;
    clearTimeout(timer); controller?.abort(); controller = new AbortController();
    const current = ++serial;
    const name = document.querySelector('#speaker-name').value.trim().toLowerCase();
    if (name !== activeName) { activeName=name; frame.removeAttribute('src'); frame.hidden=true; editing=false; }
    retry.hidden=true; unavailable.hidden=true;
    if (!frame.hasAttribute('src')) status.textContent='Checking your survey…';
    const timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const config=window.VOICE_DEMO_CONFIG || {};
      const response=await fetch(`${(config.apiBaseUrl || '').replace(/\/$/,'')}/survey/access`, {
        method:'POST',headers:{'content-type':'application/json','x-demo-code':document.querySelector('#access-code').value.trim()},
        body:JSON.stringify({name}),signal:controller.signal
      });
      const data=await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not check survey access.');
      if (current !== serial || !isOpen()) return;
      editUrl=data.editUrl || '';edit.hidden=!data.submitted || !editUrl;
      if (data.submitted) {
        status.textContent=editing?'Edit your existing response below.':'Your survey is submitted. Thank you!';
        if (!editing) { frame.hidden=true; frame.removeAttribute('src'); }
      } else {
        edit.hidden=true;status.textContent='Complete the survey below. Your survey code is filled in automatically; please leave it unchanged.';
        if (!frame.hasAttribute('src')) frame.src=data.url;
        frame.hidden=false;
      }
      timer=setTimeout(check,15000);
    } catch(error) {
      if(current!==serial || !isOpen()) return;
      status.textContent=error.name==='AbortError'?'The survey check timed out. Please try again.':error.message;
      retry.hidden=false;
      // Preserve in-progress answers when a background status check fails.
      // A form is never initially opened without a successful access check.
      if (frame.hasAttribute('src')) status.textContent='Could not refresh survey status. You can continue your open survey or try again.';
      else frame.hidden=true;
    } finally { clearTimeout(timeout); }
  }
  retry.addEventListener('click',check);
  edit.addEventListener('click',()=>{if(editUrl){editing=true;frame.src=editUrl;frame.hidden=false;status.textContent='Edit your existing response below.';}});
  window.addEventListener('survey:open',check);
  window.addEventListener('survey:close',()=>{stop();editing=false;frame.hidden=true;frame.removeAttribute('src');});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(isOpen())check();});
  if(isOpen())check();
})();
