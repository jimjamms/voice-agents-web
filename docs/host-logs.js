(() => {
  const form=document.querySelector('#log-export'),button=document.querySelector('#export-logs'),status=document.querySelector('#export-status');
  const userForm = document.querySelector('#user-list-form'), userButton = document.querySelector('#load-users');
  const userRows = document.querySelector('#users-rows'), userStatus = document.querySelector('#users-status'), moreUsers = document.querySelector('#users-more');
  const memoryButton = document.querySelector('#export-memories');
  const deleteStatus = document.querySelector('#delete-status');
  document.querySelector('#host-key').value = '';
  window.addEventListener?.('pageshow', event => { if (!event.persisted) document.querySelector('#host-key').value = ''; });
  let users = [], nextUser = null, userSearch = '', userTotal = 0, deleting = false, rowActionButtons = [];

  form.addEventListener('submit',async event=>{
    event.preventDefault(); if(button.disabled)return;
    const base=window.VOICE_DEMO_CONFIG?.apiBaseUrl,key=document.querySelector('#host-key').value.trim(),speaker=document.querySelector('#log-speaker').value.trim();
    if(!base||!key){status.textContent='Enter your private host key and check the Worker URL.';return;}
    setHostBusy(true);
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
    finally {setHostBusy(false);}
  });
  async function downloadMemories(speaker = '') {
    if (button.disabled || memoryButton.disabled || deleting) return;
    const keyInput = document.querySelector('#host-key'), key = keyInput.value.trim(), base = window.VOICE_DEMO_CONFIG?.apiBaseUrl;
    if (!key || !base) { status.textContent = 'Enter your private host key above to download memories.'; keyInput.focus(); return; }
    setHostBusy(true);
    try {
      const profiles = [], cursors = new Set(); let cursor = '', size = 0;
      for (let page = 0; page < 100; page++) {
        status.textContent = `Downloading memories… ${profiles.length} users collected.`;
        const url = new URL(`${base.replace(/\/$/, '')}/memories/export`);
        if (speaker) url.searchParams.set('speaker', speaker);
        if (cursor) url.searchParams.set('cursor', cursor);
        const response = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Memory export failed.');
        if (!Array.isArray(data.profiles)) throw new Error('Invalid memory export.');
        size += JSON.stringify(data.profiles).length;
        if (size > 25_000_000) throw new Error('Memory export is too large. Choose one Name ID to download.');
        profiles.push(...data.profiles);
        if (data.nextCursor === null) break;
        if (typeof data.nextCursor !== 'string' || !data.nextCursor || cursors.has(data.nextCursor) || page === 99) throw new Error('Memory export is too large. Choose one Name ID to download.');
        cursors.add(data.nextCursor); cursor = data.nextCursor;
      }
      if (!profiles.length) { status.textContent = 'No synced memory profile found. Terminal agents must have cloud sync enabled before their local memories appear here.'; return; }
      const payload = { schema_version: 1, exported_at: new Date().toISOString(), name_id_filter: speaker || null, source: 'Synced Name ID profiles', profiles };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const link = document.createElement('a'), url = URL.createObjectURL(blob);
      const suffix = speaker ? speaker.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) : 'all-users';
      link.href = url; link.download = `agent-memories-${suffix}-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = `Downloaded memories for ${profiles.length} user(s), with shared, Sage, and Astra memories kept separate.`;
    } catch (error) { status.textContent = error.message || 'Could not download memories.'; }
    finally { setHostBusy(false); }
  }
  memoryButton.addEventListener('click', () => { void downloadMemories(document.querySelector('#log-speaker').value.trim()); });
  async function deleteUser(name, removeId = false) {
    if (deleting || button.disabled || userButton.disabled) return;
    const keyInput = document.querySelector('#host-key'), key = keyInput.value.trim(), base = window.VOICE_DEMO_CONFIG?.apiBaseUrl;
    const trip = removeId || document.querySelector('#delete-trip').checked, logs = removeId || document.querySelector('#delete-logs').checked;
    if (!key || !base) { deleteStatus.textContent = 'Enter your private host key above to delete data.'; keyInput.focus(); return; }
    if (!trip && !logs) { deleteStatus.textContent = 'Select the data to delete above the list.'; return; }
    const scope = [trip && 'memories and trip notes', logs && 'chat logs'].filter(Boolean).join(' and ');
    if (!window.confirm(`Permanently ${removeId ? "delete this Name ID and all saved data" : "delete " + scope} for "${name}"? The saved data cannot be recovered. This ID can be reused for a fresh trip.`)) return;
    deleting = true; setHostBusy(true); deleteStatus.textContent = `Deleting data for ${name}…`;
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/logs/delete`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ name, confirm: name, trip, logs, ...(removeId ? { remove_id: true } : {}) }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not delete data.');
      deleteStatus.textContent = `Deleted ${data.profilesDeleted} saved trip profile(s) and ${data.turnsDeleted} log record(s) for ${name}. This Name ID can be reused.`;
      const listed = users.find(user => user.nameId === name);
      if (listed) {
        if (trip) { listed.tripStatus = 'Trip reset'; listed.lastSaved = new Date().toISOString(); }
        if (logs) { listed.chatTurns = 0; listed.trackedSwitches = 0; }
        if (trip) listed.progress = { completed: 0, ready: false };
        window.invalidateUserMetrics?.(name);
        if (removeId || (logs && listed.tripStatus === 'Logs only')) { users = users.filter(user => user !== listed); userTotal--; }
        renderUsers(); userStatus.textContent = 'User list updated. Reset Name IDs remain reusable.';
      }
    } catch (error) { deleteStatus.textContent = error.message || 'Could not delete data.'; }
    finally { deleting = false; setHostBusy(false); }
  }
  function setHostBusy(busy) {
    button.disabled = memoryButton.disabled = userButton.disabled = moreUsers.disabled = busy;
    rowActionButtons.forEach(control => { control.disabled = busy; });
  }
  function renderUsers() {
    userRows.replaceChildren(); rowActionButtons = [];
    if (!users.length) {
      const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5;
      cell.textContent = 'No saved users match this search.'; row.append(cell); userRows.append(row); return;
    }
    for (const user of users) {
      const row = document.createElement('tr');
      const values = [user.nameId, user.chatTurns, `${user.trackedSwitches || 0} tracked`, user.progress ? `${user.progress.completed}/5${user.progress.ready ? ' · Complete' : ''}` : user.tripStatus];
      values.forEach((value, index) => {
        const cell = document.createElement('td');
        cell.setAttribute('data-label', ['Name ID', 'Turns', 'Switches', 'Trip'][index]);
        if (!index) {
          cell.className = 'user-id';
          const wrap = document.createElement('div'), name = document.createElement('span'), remove = document.createElement('button');
          wrap.className = 'user-name-actions'; name.className = 'user-name'; name.textContent = String(value);
          remove.type = 'button'; remove.className = 'user-delete-button'; remove.textContent = 'Clear data';
          remove.disabled = deleting; remove.setAttribute('aria-label', `Delete selected data for ${user.nameId}`);
          remove.addEventListener('click', () => { void deleteUser(user.nameId); }); rowActionButtons.push(remove);
          const deleteId = document.createElement('button');
          deleteId.type = 'button'; deleteId.className = 'user-delete-button'; deleteId.textContent = 'Delete ID';
          deleteId.disabled = deleting; deleteId.setAttribute('aria-label', `Delete Name ID and all saved data for ${user.nameId}`);
          deleteId.addEventListener('click', () => { void deleteUser(user.nameId, true); }); rowActionButtons.push(deleteId);
          wrap.append(name, remove, deleteId); cell.append(wrap);
        } else cell.textContent = String(value);
        row.append(cell);
      });
      const actions = document.createElement('td'), use = document.createElement('button');
      use.type = 'button'; use.className = 'user-use'; use.textContent = 'Use ID'; use.setAttribute('aria-label', `Use ${user.nameId} for export`);
      use.addEventListener('click', () => {
        document.querySelector('#log-speaker').value = user.nameId;
        userStatus.textContent = `Selected ${user.nameId}. The export name filter is filled.`;
      });
      const memory = document.createElement('button'); memory.type = 'button'; memory.className = 'user-use'; memory.textContent = 'Memories';
      memory.setAttribute('aria-label', `Download memories for ${user.nameId}`);
      memory.addEventListener('click', () => { void downloadMemories(user.nameId); });
      const metrics = document.createElement('button'); metrics.type = 'button'; metrics.className = 'user-use'; metrics.textContent = 'Metrics';
      metrics.setAttribute('aria-label', `View metrics for ${user.nameId}`);
      metrics.addEventListener('click', () => { void window.openUserMetrics?.(user.nameId); });
      rowActionButtons.push(use, memory, metrics);
      actions.setAttribute('data-label', 'Actions');
      actions.className = 'user-downloads'; actions.append(use, memory, metrics); row.append(actions); userRows.append(row);
    }
  }
  async function loadUsers(append = false) {
    if (userButton.disabled || button.disabled || deleting) return;
    const keyInput = document.querySelector('#host-key'), key = keyInput.value.trim(), base = window.VOICE_DEMO_CONFIG?.apiBaseUrl;
    if (!key || !base) { userStatus.textContent = 'Enter your private host key above to load users.'; keyInput.focus(); return; }
    const query = append ? userSearch : document.querySelector('#user-search').value.trim();
    setHostBusy(true);
    userStatus.textContent = 'Loading users…';
    try {
      const url = new URL(`${base.replace(/\/$/, '')}/logs/users`);
      if (query) url.searchParams.set('q', query);
      if (append && nextUser) url.searchParams.set('cursor', nextUser);
      const response = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load users.');
      if (!Array.isArray(data.users)) throw new Error('Invalid user list.');
      users = append ? [...users, ...data.users.filter(user => !users.some(old => old.nameId === user.nameId))] : data.users;
      data.users.forEach(user => window.invalidateUserMetrics?.(user.nameId));
      nextUser = data.nextCursor; userTotal = data.total; userSearch = query;
      renderUsers(); moreUsers.hidden = !nextUser;
      userStatus.textContent = `${users.length} of ${userTotal} users`;
    } catch (error) { userStatus.textContent = error.message || 'Could not load users.'; }
    finally { setHostBusy(false); }
  }
  userForm.addEventListener('submit', event => { event.preventDefault(); void loadUsers(); });
  moreUsers.addEventListener('click', () => { if (nextUser) void loadUsers(true); });
})();
