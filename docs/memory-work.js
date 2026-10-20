/* Durable background extraction. Access codes stay in memory; jobs resume only after profile verification. */
(() => {
  window.createMemoryWorkQueue = options => {
    const scope=()=>String(options.base() || '').replace(/\/$/,'');
    const STORE='sage-astra-memory-work-v1:'+scope();
    let jobs=[];try{const value=JSON.parse(localStorage.getItem(STORE) || '[]');if(Array.isArray(value))jobs=value.filter(j=>j && typeof j.id==='string' && typeof j.name==='string' && ['sage','astra'].includes(j.agent) && ['shared','isolated'].includes(j.mode) && Number.isSafeInteger(j.generation) && j.payload && typeof j.payload.userText==='string' && typeof j.payload.reply==='string' && j.scope===scope()).map(j=>({...j,parked:true}));}catch{}
    const generations=new Map(),epochs=new Map();let timer=null,chain=Promise.resolve();
    const persist=()=>{try{localStorage.setItem(STORE,JSON.stringify(jobs));}catch{options.status?.('Browser storage is unavailable; keep this tab open until saving finishes.');}};
    const epoch=name=>epochs.get(name) || 0;
    const valid=job=>!job.parked && generations.get(job.name)===job.generation && epoch(job.name)===job.epoch && !options.isDeleted?.(job.name);
    const drop=job=>{jobs=jobs.filter(j=>j.id!==job.id || j.epoch!==job.epoch);persist();};
    function invalidate(name){name=name.trim().toLowerCase();epochs.set(name,epoch(name)+1);generations.delete(name);jobs=jobs.filter(j=>j.name!==name);persist();}
    async function run(job){
      if(!valid(job))return 'done';
      for(let attempt=0;attempt<2;attempt++){
        if(!valid(job))return 'done';
        if(!options.code() || !scope())return 'blocked';
        const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),25000);
        try{
          if(!Object.hasOwn(job,'fact')){
            const response=await fetch(`${scope()}/memory`,{method:'POST',headers:{'content-type':'application/json','x-demo-code':options.code()},signal:controller.signal,body:JSON.stringify({...job.payload,generation:job.generation})});
            if(response.status===410){invalidate(job.name);void options.onReset?.(job.name);return 'done';}
            if(!response.ok){if(response.status>=400 && response.status<500 && ![408,429].includes(response.status))return 'blocked';throw new Error('Temporary extraction failure');}
            const result=await response.json();if(result.fact!==null && (typeof result.fact!=='string' || !result.fact.trim() || result.fact.length>600))throw new Error('Invalid extraction response');
            if(!valid(job))return 'done';job.fact=result.fact;persist();
          }
          if(!valid(job))return 'done';
          if(job.fact && options.remember(job.name,job.mode,job.agent,job.fact)===false)throw new Error('Memory save pending');
          return 'done';
        }catch{options.status?.('Saving memories automatically…');}finally{clearTimeout(timeout);}
      }
      return 'retry';
    }
    function flush(){clearTimeout(timer);timer=null;chain=chain.catch(()=>{}).then(async()=>{
      const blocked=new Set();let retry=false;
      for(const job of [...jobs]){
        if(job.parked || blocked.has(job.name))continue;
        if(!valid(job)){drop(job);continue;}
        const result=await run(job);
        if(result==='done')drop(job);else{blocked.add(job.name);if(result==='retry')retry=true;}
      }
      if(retry && jobs.length && !timer){timer=setTimeout(flush,15000);timer?.unref?.();}
    });return chain;}
    window.addEventListener?.('online',flush);
    return {
      flush,invalidate,
      activate(name,generation){name=name.trim().toLowerCase();epochs.set(name,epoch(name)+1);generations.set(name,generation);jobs=jobs.flatMap(j=>j.name!==name?[j]:j.generation===generation?[{...j,epoch:epoch(name),parked:false}]:[]);persist();void flush();},
      enqueue(turn,priorConversation,generation=0){
        const name=turn.speaker.trim().toLowerCase();if(!name || name==='unknown' || options.isDeleted?.(name))return Promise.resolve();
        if(!generations.has(name))generations.set(name,generation);
        const payload={agent:turn.agent,speaker:turn.speaker,userText:String(turn.transcript || '').slice(0,3500),reply:String(turn.reply || '').slice(0,3500),priorConversation};
        jobs.push({id:typeof crypto!=='undefined' && crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`,scope:scope(),name,agent:turn.agent,mode:turn.mode,generation,epoch:epoch(name),parked:false,payload});persist();return flush();
      },
      pendingCount(){return jobs.length;}
    };
  };
})();
