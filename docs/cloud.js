/* Recover unsent profiles without persisting access codes or replacing newer remote edits. */
(() => {
  window.createTripCloud = options => {
    const STORE = 'sage-astra-cloud-work-v1';
    let journal = {};
    try { journal = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch {}
    if (!journal || typeof journal !== 'object' || Array.isArray(journal)) journal = {};
    let active = null, timer, pending = null, queue = Promise.resolve(), conflict = false, checking = false;
    const deletedNames = new Set();
    const status = text => { options.status.textContent = text; };
    const keyFor = (base, name) => JSON.stringify([base.replace(/\/$/, ''), name]);
    const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(journal)); } catch {} };
    const clone = value => JSON.parse(JSON.stringify(value));
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
    function comparable(profile) {
      const p = profile || {}, c = p.choices || {}, m = p.memories || {};
      return canonical({ notes: p.notes || '', choices: { countries:c.countries || [], cities:c.cities || [], activities:c.activities || [], cityActivities:c.cityActivities || {}, budget:c.budget || null, itinerary:c.itinerary || null, firstCityReviewed:c.firstCityReviewed || null, finalized:c.finalized === true, ...(c.approvalSource && {approvalSource:c.approvalSource}) },
        memories: { shared:(m.shared || []).map(v => ({fact:typeof v === 'string' ? v : v.fact,learned_by:v.learned_by === 'Astra' ? 'Astra' : 'Sage'})), sage:(m.sage || []).map(v => typeof v === 'string' ? v : v.fact), astra:(m.astra || []).map(v => typeof v === 'string' ? v : v.fact), recentShared:m.recentShared || [] }, chatStarts:p.chatStarts || {}, reviewed:p.reviewed === true, notesWorkId:p.notesWorkId || '' });
    }
    const equal = (a,b) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
    function clearDeleted(name, message, generation) {
      const base = active?.base || options.base(); delete journal[keyFor(base, name)]; persist();
      const nextGeneration = Number.isSafeInteger(generation) ? generation : (active?.generation || 0) + 1;
      if (active?.name === name) { active = null; pending = null; conflict = true; clearTimeout(timer); }
      if (!deletedNames.has(name)) {
        deletedNames.add(name);
        options.apply(name, { notes: '', choices: { countries: [], cities: [], activities: [], budget: null, itinerary: null, finalized: false }, memories: { shared: [], sage: [], astra: [] }, generation: nextGeneration });
        options.onDeleted?.(name, message);
      }
      status(message);
    }
    async function request(body, credentials) {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(`${credentials.base.replace(/\/$/, '')}/${body.action === 'status' ? 'profile-status' : 'profile'}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-code': credentials.code }, body: JSON.stringify(body), signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) { const error = new Error(data.error || 'Could not sync your trip.'); error.conflict = response.status === 409 || response.status === 410; error.deleted = response.status === 410; if (error.deleted) clearDeleted(body.name, error.message, data.generation); throw error; }
        return data;
      } finally { clearTimeout(timeout); }
    }
    async function recover(name, credentials, remote) {
      const key = keyFor(credentials.base,name), saved = journal[key];
      if (!saved) return { remote };
      if (saved.generation !== (remote.generation || 0)) { delete journal[key]; persist(); return { remote }; }
      if (equal(remote.profile,saved.profile)) { delete journal[key]; persist(); return { remote }; }
      const acknowledged = saved.sent && remote.version === saved.sent.version + 1 && equal(remote.profile,saved.sent.profile);
      if (remote.version !== saved.version && !acknowledged) return { remote, conflict: true };
      saved.version = remote.version; saved.sent = {version:remote.version,profile:clone(saved.profile)}; persist();
      const result = await request({action:'save',name,version:remote.version,generation:saved.generation,profile:saved.profile},credentials);
      const profile = saved.profile;
      if (journal[key] && journal[key] !== saved && journal[key].generation === saved.generation) {
        journal[key].version=result.version;delete journal[key].sent;delete journal[key].uncertain;persist();
        return recover(name,credentials,{...remote,profile,version:result.version});
      }
      delete journal[key]; persist();
      return { remote: {...remote,profile,version:result.version} };
    }
    function finishRecovery(job, remote) {
      if (!active || active.name !== job.name || active.generation !== job.generation) return;
      active.version=remote.version;
      const key=keyFor(job.base,job.name);
      if(pending?.name===job.name && !equal(pending.profile,remote.profile)) {
        pending.version=remote.version;journal[key]={version:remote.version,generation:job.generation,profile:clone(pending.profile)};persist();
        timer=setTimeout(flush,0);timer?.unref?.();
      } else pending=null;
      status('');
    }
    function flush() {
      clearTimeout(timer);
      queue = queue.catch(() => {}).then(async () => {
        if (!pending || conflict) return;
        const job = pending; pending = null; const key = keyFor(job.base,job.name);
        const current = journal[key];
        if (!current || current.generation !== job.generation) return;
        if (current.uncertain) {
          try {
            const loaded=await request({action:'load',name:job.name},job);
            if ((loaded.generation || 0)!==job.generation) {clearDeleted(job.name,'The host cleared this trip. Enter the same name ID to start again.',loaded.generation);return;}
            const recovery=await recover(job.name,job,loaded);
            if (!recovery.conflict) {finishRecovery(job,recovery.remote);return;}
            pending=job;conflict=true;status('This trip changed on another device. Pending local changes are retained safely.');return;
          } catch(error) {
            if(error.deleted)return;pending=job;timer=setTimeout(flush,15000);timer?.unref?.();return;
          }
        }
        current.sent = {version:job.version,profile:clone(job.profile)}; persist();
        status('Saving your trip…');
        try {
          const result = await request({action:'save',name:job.name,version:job.version,generation:job.generation,profile:job.profile},job);
          if (!active || active.name !== job.name || active.generation !== job.generation) return;
          active.version = result.version;
          if (pending?.name === job.name) {
            pending.version = result.version;
            journal[key] = {version:result.version,generation:job.generation,profile:clone(pending.profile)};
          } else delete journal[key];
          persist(); status('');
        } catch (error) {
          if (error.deleted || !active || active.name !== job.name || active.generation !== job.generation) return;
          if (!pending) pending = job;
          if(journal[key]) {journal[key].uncertain=true;persist();}
          if (error.conflict) {
            try {
              const loaded = await request({action:'load',name:job.name},job);
              if ((loaded.generation || 0) !== job.generation) { clearDeleted(job.name,'The host cleared this trip. Enter the same name ID to start again.',loaded.generation); return; }
              const recovered = await recover(job.name,job,loaded);
              if (!recovered.conflict) { finishRecovery(job,recovered.remote); return; }
            } catch (recoveryError) { if (recoveryError.deleted) return; }
          }
          conflict = error.conflict === true;
          status(conflict ? error.message : 'Cloud save pending. It will resume automatically when connected.');
          if (!conflict) { timer = setTimeout(flush,15000); timer?.unref?.(); }
        }
      });
      return queue;
    }
    function changed(name) {
      if (!active || active.name !== name.trim().toLowerCase() || conflict) return;
      pending = {...active,profile:clone(options.snapshot(active.name))};
      const key=keyFor(active.base,active.name), sent=journal[key]?.sent;
      journal[key]={version:active.version,generation:active.generation,profile:clone(pending.profile),...(sent && {sent}),...(journal[key]?.uncertain && {uncertain:true})};persist();
      status('Cloud save pending…');clearTimeout(timer);timer=setTimeout(flush,700);timer?.unref?.();
    }
    async function checkDeletion() {
      if (!active || checking) return; checking=true; const current=active;
      try { const result=await request({action:'status',name:current.name},current);
        if (active===current && Number.isSafeInteger(result.generation) && result.generation!==current.generation) clearDeleted(current.name,'The host cleared this trip. Enter the same name ID to start again.',result.generation);
      } catch {} finally { checking=false; }
    }
    window.setInterval?.(checkDeletion,15000);
    window.addEventListener('focus',checkDeletion);window.addEventListener('online',checkDeletion);
    window.onTripProfileChange=changed;window.addEventListener('online',flush);
    window.addEventListener('pagehide',()=>{if(pending)persist();});
    return {flush,checkDeletion,async load(name) {
      await flush();
      const id=name.trim().toLowerCase(),credentials={base:options.base(),code:options.code()};
      if(!credentials.base || !credentials.code)throw new Error('Enter your demo code and check the Worker address.');
      let result=await request({action:'load',name:id},credentials);
      if(!['shared','isolated'].includes(result.memoryMode))throw new Error('Apply the memory assignment update to the Worker, then try again.');
      const recovery=await recover(id,credentials,result);result=recovery.remote;
      active={name:id,version:result.version,generation:result.generation || 0,...credentials};pending=null;conflict=Boolean(recovery.conflict);deletedNames.delete(id);
      options.assignMemory?.(id,result.memoryMode);
      if(result.profile){options.apply(id,{...result.profile,generation:result.generation || 0});options.chats?.(id,result.chatTurns || []);status(conflict ? 'This trip changed on another device. The latest saved trip is loaded; pending local changes are retained safely.' : '');}
      else{options.chats?.(id,result.chatTurns || []);changed(id);await flush();if(pending)throw new Error('Could not create your cloud trip. Try again.');}
    }};
  };
})();
