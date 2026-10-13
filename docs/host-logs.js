(() => {
  const form=document.querySelector('#log-export'),button=document.querySelector('#export-logs'),status=document.querySelector('#export-status');
  form.addEventListener('submit',async event=>{
    event.preventDefault(); if(button.disabled)return;
    const base=window.VOICE_DEMO_CONFIG?.apiBaseUrl,key=document.querySelector('#host-key').value.trim(),speaker=document.querySelector('#log-speaker').value.trim();
    if(!base||!key){status.textContent='Enter your private host key and check the Worker URL.';return;}
    button.disabled=true;
    try {
      const turns=[];let cursor=0;
      for(let page=0;page<100;page++){
        status.textContent=`Downloading… ${turns.length} turns collected.`;
        const url=new URL(`${base.replace(/\/$/,'')}/logs/export`);url.searchParams.set('cursor',cursor);
        if(speaker)url.searchParams.set('speaker',speaker);
        const response=await fetch(url,{headers:{authorization:`Bearer ${key}`}});const data=await response.json();
        if(!response.ok)throw new Error(data.error||'Export failed.');
        turns.push(...data.turns);
        if(data.nextCursor===null)break;
        if(!Number.isSafeInteger(data.nextCursor)||data.nextCursor<=cursor||page===99)throw new Error('Export is too large. Filter by tester name.');
        cursor=data.nextCursor;
      }
      const blob=new Blob([JSON.stringify({exported_at:new Date().toISOString(),speaker_filter:speaker||null,turns},null,2)],{type:'application/json'});
      const link=document.createElement('a'),url=URL.createObjectURL(blob);link.href=url;link.download=`chat-logs-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      status.textContent=`Downloaded ${turns.length} turns.`;
    } catch(error){status.textContent=error.message||'Could not download logs.';}
    finally {button.disabled=false;document.querySelector('#host-key').value='';}
  });
  const deleteForm = document.querySelector('#user-delete'), deleteButton = document.querySelector('#delete-user'), deleteStatus = document.querySelector('#delete-status');
  deleteForm.addEventListener('submit', async event => {
    event.preventDefault(); if (deleteButton.disabled || button.disabled) return;
    const keyInput = document.querySelector('#host-key'), key = keyInput.value.trim(), base = window.VOICE_DEMO_CONFIG?.apiBaseUrl;
    const name = document.querySelector('#delete-name').value.trim(), confirm = document.querySelector('#delete-confirm').value.trim();
    const trip = document.querySelector('#delete-trip').checked, logs = document.querySelector('#delete-logs').checked;
    if (!key || !base) { deleteStatus.textContent = 'Enter your private host key above and check the Worker address.'; keyInput.focus(); return; }
    if (!name || name !== confirm) { deleteStatus.textContent = 'Type the same name ID in both fields.'; return; }
    if (!trip && !logs) { deleteStatus.textContent = 'Select the data to delete.'; return; }
    const scope = [trip && 'memories and trip notes', logs && 'chat logs'].filter(Boolean).join(' and ');
    if (!window.confirm(`Permanently delete ${scope} for "${name}"? This cannot be undone.`)) return;
    deleteButton.disabled = button.disabled = true; deleteStatus.textContent = 'Deleting…';
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/logs/delete`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ name, confirm, trip, logs }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not delete data.');
      deleteStatus.textContent = `Deleted ${data.profilesDeleted} saved trip profile(s) and ${data.turnsDeleted} chat turn(s) for ${name}.`;
      document.querySelector('#delete-confirm').value = '';
    } catch (error) { deleteStatus.textContent = error.message || 'Could not delete data.'; }
    finally { deleteButton.disabled = button.disabled = false; keyInput.value = ''; }
  });
})();
