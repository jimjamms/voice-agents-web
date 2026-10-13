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
})();
