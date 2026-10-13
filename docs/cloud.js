/* Name-ID cloud profiles. The demo code is still required; IDs are not verified accounts. */
(() => {
  window.createTripCloud = options => {
    let active = null, timer, pending = null, queue = Promise.resolve(), conflict = false;
    const status = text => { options.status.textContent = text; };
    async function request(body, credentials) {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(`${credentials.base.replace(/\/$/, '')}/profile`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-code': credentials.code },
          body: JSON.stringify(body), signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) { const error = new Error(data.error || 'Could not sync your trip.'); error.conflict = response.status === 409; throw error; }
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
          status('Trip saved across devices.');
        } catch (error) {
          if (!pending) pending = job;
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
    window.onTripProfileChange = changed;
    window.addEventListener('online', flush);
    window.addEventListener('pagehide', () => { if (pending) status('Cloud save pending. Reopen this tab to retry.'); });
    return {
      flush,
      async load(name) {
        await flush();
        if (pending && !conflict) throw new Error('Your previous trip has not saved yet. Reconnect and try again before changing devices or IDs.');
        const id = name.trim().toLowerCase(), credentials = { base: options.base(), code: options.code() };
        if (!credentials.base || !credentials.code) throw new Error('Enter your demo code and check the Worker address.');
        const result = await request({ action: 'load', name: id }, credentials);
        // Do not replace newer cloud data with a browser's stale local copy.
        active = { name: id, version: result.version, ...credentials }; conflict = false; pending = null;
        if (result.profile) { options.apply(id, result.profile); status('Saved trip loaded.'); }
        else { changed(id); await flush(); if (pending) throw new Error('Could not create your cloud trip. Try again.'); }
      },
    };
  };
})();
