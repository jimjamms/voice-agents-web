# Download terminal-agent memories from the host page

Deploy the included Worker changes and push the host page files. No database migration or new Python dependency is required.

## Enable terminal cloud sync

Use the latest terminal agent files from the previous updates. From your Shifts-and-Giggles folder, set these in the same PowerShell window before running the agents:

```powershell
$env:VOICE_DEMO_API_URL = "YOUR_WORKER_URL"
$env:VOICE_DEMO_ORIGIN = "YOUR_WEBSITE_ORIGIN"
.\.venv312\Scripts\python.exe travel_agents.py
```

Use the Worker URL in docs/config.js for YOUR_WORKER_URL. Use the PUBLIC_ORIGIN in your deployed Worker configuration for YOUR_WEBSITE_ORIGIN. Enter the website demo code when the terminal asks, then use a Name ID. Keep your OPENAI_API_KEY configured as before. The private LOG_ADMIN_KEY is used only on the host page, not in terminal agents.

The terminal prints “Trip and chats saved across devices.” after a successful sync. If it prints “Cloud sync pending,” its changes remain local until sync succeeds. The current first-login policy uses the existing cloud profile if this Name ID already exists online; a new cloud ID can import its local data. An offline trip_state.sqlite3 file cannot be read by the host website.

## Download

On host-logs.html, enter your private host key. Enter a Name ID in the export filter, or leave it blank for all synced users, then click Download memories. You can also load Saved users and click Memories on a user’s row. Re-enter the host key after loading the list because it is cleared after each host action.

The JSON contains the current saved snapshot per Name ID: shared memories, Sage-only memories, Astra-only memories, and recent shared exchanges in recentShared. Separate memories remain labeled in their own compartments. Trip notes and full chat logs are not included; use Download chat logs for the latter. Terminal and website data share the same cloud Name ID profile, so the export reflects the latest successfully synced profile rather than a separate terminal-only archive.

These are JSON snapshots for inspection or backup, not a replacement SQLite database and not a drop-in legacy memories.json import. This update does not change the terminal’s existing cloud synchronization behavior.
