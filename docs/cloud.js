/* Name-ID cloud profiles. The demo code is still required; IDs are not verified accounts. */
(() => {
  window.createTripCloud = options => {
    let active = null, timer, pending = null, queue = Promise.resolve(), conflict = false;
    const deletedNames = new Set();
    let checking = false;
    const status = text => { options.status.textContent = text; };
    function clearDeleted(name, message) {
      if (active?.name === name) { active = null; pending = null; conflict = true; clearTimeout(timer); }
      if (!deletedNames.has(name)) {
        deletedNames.add(name);
        options.apply(name, { notes: '', choices: { countries: [], cities: [], activities: [], budget: null, itinerary: null, finalized: false }, memories: { shared: [], sage: [], astra: [] } });
        options.onDeleted?.(name, message);
      }
      status(message);
    }
    async function request(body, credentials) {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(`${credentials.base.replace(/\/$/, '')}/${body.action === 'status' ? 'profile-status' : 'profile'}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-code': credentials.code },
          body: JSON.stringify(body), signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) { const error = new Error(data.error || 'Could not sync your trip.'); error.conflict = response.status === 409 || response.status === 410; error.deleted = response.status === 410; if (error.deleted) clearDeleted(body.name, error.message); throw error; }
        return data;
      } finally { clearTimeout(timeout); }
    }
    function flush() {
      clearTimeout(timer);
      queue = queue.catch(() => {}).then(async () => {
        if (!pending || conflict) return;
        const job = pending; pending = null;
        status('Saving your trip…');
        try {
          const result = await request({ action: 'save', name: job.name, version: job.version, profile: job.profile }, job);
          if (active?.name === job.name) active.version = result.version;
          if (pending?.name === job.name) pending.version = result.version;
          if (active?.name === job.name) status('Trip saved across devices.');
        } catch (error) {
          if (!pending && !error.deleted) pending = job;
          conflict = error.conflict === true;
          status(conflict ? error.message : 'Cloud save pending. Keep this tab open; reconnect to retry.');
          if (!conflict) { clearTimeout(timer); timer = setTimeout(flush, 15000); }
        }
      });
      return queue;
    }
    function changed(name) {
      if (!active || active.name !== name.trim().toLowerCase() || conflict) return;
      pending = { ...active, profile: JSON.parse(JSON.stringify(options.snapshot(active.name))) };
      status('Cloud save pending…'); clearTimeout(timer); timer = setTimeout(flush, 700);
    }
    async function checkDeletion() {
      if (!active || checking) return;
      checking = true; const current = active;
      try {
        const result = await request({ action: 'status', name: current.name }, current);
        if (active === current && Number.isSafeInteger(result.generation) && result.generation !== current.generation) {
          clearDeleted(current.name, 'The host cleared this trip. Enter the same name ID to start again.');
        }
      }
      catch { /* Network failures never erase local trip data. */ }
      finally { checking = false; }
    }
    window.setInterval?.(checkDeletion, 15000);
    window.addEventListener('focus', checkDeletion);
    window.addEventListener('online', checkDeletion);
    window.onTripProfileChange = changed;
    window.addEventListener('online', flush);
    window.addEventListener('pagehide', () => { if (pending) status('Cloud save pending. Reopen this tab to retry.'); });
    return {
      flush, checkDeletion,
      async load(name) {
        await flush();
        if (pending && !conflict) throw new Error('Your previous trip has not saved yet. Reconnect and try again before changing devices or IDs.');
        const id = name.trim().toLowerCase(), credentials = { base: options.base(), code: options.code() };
        if (!credentials.base || !credentials.code) throw new Error('Enter your demo code and check the Worker address.');
        const result = await request({ action: 'load', name: id }, credentials);
        if (!['shared', 'isolated'].includes(result.memoryMode)) throw new Error('Apply the memory assignment update to the Worker, then try again.');
        options.assignMemory?.(id, result.memoryMode);
        // Do not replace newer cloud data with a browser's stale local copy.
        active = { name: id, version: result.version, generation: result.generation || 0, ...credentials }; conflict = false; pending = null; deletedNames.delete(id);
        if (result.profile) { options.apply(id, { ...result.profile, generation: result.generation || 0 }); options.chats?.(id, result.chatTurns || []); status('Saved trip and chats loaded.'); }
        else { options.chats?.(id, result.chatTurns || []); changed(id); await flush(); if (pending) throw new Error('Could not create your cloud trip. Try again.'); }
      },
    };
  };
})();
