(() => {
  const form=document.querySelector('#log-export'),button=document.querySelector('#export-logs'),status=document.querySelector('#export-status');
  const userForm = document.querySelector('#user-list-form'), userButton = document.querySelector('#load-users');
  const userRows = document.querySelector('#users-rows'), userStatus = document.querySelector('#users-status'), moreUsers = document.querySelector('#users-more');
  const deleteStatus = document.querySelector('#delete-status');
  let users = [], nextUser = null, userSearch = '', userTotal = 0, deleting = false, rowDeleteButtons = [];

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
    finally {setHostBusy(false);document.querySelector('#host-key').value='';}
  });
  async function deleteUser(name) {
    if (deleting || button.disabled || userButton.disabled) return;
    const keyInput = document.querySelector('#host-key'), key = keyInput.value.trim(), base = window.VOICE_DEMO_CONFIG?.apiBaseUrl;
    const trip = document.querySelector('#delete-trip').checked, logs = document.querySelector('#delete-logs').checked;
    if (!key || !base) { deleteStatus.textContent = 'Enter your private host key above to delete data.'; keyInput.focus(); return; }
    if (!trip && !logs) { deleteStatus.textContent = 'Select the data to delete above the list.'; return; }
    const scope = [trip && 'memories and trip notes', logs && 'chat logs'].filter(Boolean).join(' and ');
    if (!window.confirm(`Permanently delete ${scope} for "${name}"? The saved data cannot be recovered. This ID can be reused for a fresh trip.`)) return;
    deleting = true; setHostBusy(true); deleteStatus.textContent = `Deleting data for ${name}…`;
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/logs/delete`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ name, confirm: name, trip, logs }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not delete data.');
      deleteStatus.textContent = `Deleted ${data.profilesDeleted} saved trip profile(s) and ${data.turnsDeleted} chat turn(s) for ${name}. This Name ID can be reused.`;
      const listed = users.find(user => user.nameId === name);
      if (listed) {
        if (trip) { listed.tripStatus = 'Trip reset'; listed.lastSaved = new Date().toISOString(); }
        if (logs) listed.chatTurns = 0;
        if (logs && listed.tripStatus === 'Logs only') { users = users.filter(user => user !== listed); userTotal--; }
        renderUsers(); userStatus.textContent = 'User list updated. Reset Name IDs remain reusable.';
      }
    } catch (error) { deleteStatus.textContent = error.message || 'Could not delete data.'; }
    finally { deleting = false; setHostBusy(false); keyInput.value = ''; }
  }
  function setHostBusy(busy) {
    button.disabled = userButton.disabled = moreUsers.disabled = busy;
    rowDeleteButtons.forEach(control => { control.disabled = busy; });
  }
  function renderUsers() {
    userRows.replaceChildren(); rowDeleteButtons = [];
    if (!users.length) {
      const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5;
      cell.textContent = 'No saved users match this search.'; row.append(cell); userRows.append(row); return;
    }
    for (const user of users) {
      const row = document.createElement('tr');
      const date = user.lastSaved ? new Date(user.lastSaved) : null;
      const values = [user.nameId, user.chatTurns, date && Number.isFinite(date.getTime()) ? date.toLocaleString() : '—', user.tripStatus];
      values.forEach((value, index) => {
        const cell = document.createElement('td');
        if (!index) {
          cell.className = 'user-id';
          const wrap = document.createElement('div'), name = document.createElement('span'), remove = document.createElement('button');
          wrap.className = 'user-name-actions'; name.className = 'user-name'; name.textContent = String(value);
          remove.type = 'button'; remove.className = 'user-delete-button'; remove.textContent = 'Delete';
          remove.disabled = deleting; remove.setAttribute('aria-label', `Delete selected data for ${user.nameId}`);
          remove.addEventListener('click', () => { void deleteUser(user.nameId); }); rowDeleteButtons.push(remove);
          wrap.append(name, remove); cell.append(wrap);
        } else cell.textContent = String(value);
        row.append(cell);
      });
      const actions = document.createElement('td'), use = document.createElement('button');
      use.type = 'button'; use.className = 'user-use'; use.textContent = 'Use ID'; use.setAttribute('aria-label', `Use ${user.nameId} for export`);
      use.addEventListener('click', () => {
        document.querySelector('#log-speaker').value = user.nameId;
        userStatus.textContent = `Selected ${user.nameId}. The export name filter is filled.`;
      });
      actions.append(use); row.append(actions); userRows.append(row);
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
      nextUser = data.nextCursor; userTotal = data.total; userSearch = query;
      renderUsers(); moreUsers.hidden = !nextUser;
      userStatus.textContent = `${users.length} of ${userTotal} users shown.${nextUser ? ' Re-enter your host key to load more.' : ''}`;
    } catch (error) { userStatus.textContent = error.message || 'Could not load users.'; }
    finally { setHostBusy(false); keyInput.value = ''; }
  }
  userForm.addEventListener('submit', event => { event.preventDefault(); void loadUsers(); });
  moreUsers.addEventListener('click', () => { if (nextUser) void loadUsers(true); });
})();
