# Name-ID cloud saving

Replace the supplied project files. Keep your current docs/config.js URL, Worker settings and Cloudflare secrets.

This uses the same LOG_DB D1 database as automatic chat logs. If that binding is not set up yet, complete CHAT_LOG_SETUP.md first. Do not create a second database.

From the worker folder in PowerShell, run:

```powershell
npx.cmd wrangler d1 migrations apply sage-astra-chat-logs --remote
npx.cmd wrangler deploy
```

Push the changed docs files to GitHub and wait for Pages to deploy. Refresh with Ctrl + Shift + R.

## Test across two devices

1. On device A, enter a unique Name ID and your demo code.
2. Talk to the agents, allowing the notepad and memories to update.
3. Wait for the footer to say Trip saved across devices before closing the tab.
4. On device B (or a private browser window), enter the exact same ID and demo code, and start planning.
5. Check that your notes, budget/planning progress and agent memories are restored.

IDs ignore capitalization and leading/trailing spaces. There is no password reset or email verification. Anyone with the ID and demo code can access and change its saved information, so give each tester a distinct ID and avoid sensitive personal information.

Shared memories remain shared; separate Sage and Astra memories remain separate. Clearing notes or forgetting memories saves that change to the cloud. Those actions do not delete the host chat-log archive. Existing local notes and memories are imported only when an ID has no cloud profile; an existing cloud profile takes precedence over a browser copy.

Each session loads once at setup and saves changes automatically. This is not live multi-device collaboration. Concurrent edits use a version check: an older device cannot silently overwrite a newer cloud save. If the footer reports a conflict, return to setup and submit the same ID to reload the latest cloud data. Unuploaded local changes are discarded during that explicit reload. Failed saves retry while the page stays open and when the network reconnects. Keep the page open until the save confirmation; pending changes are not guaranteed after closing it.

The latest 500 saved conversation turns are restored from the host log database when you submit the same Name ID, including after refreshing or on another device. Sage and Astra chats, shared/separate memory modes, and voice modes remain separate. Wait for Chat saved for the host before closing or refreshing; an unfinished recording or unuploaded turn cannot be restored. New chat clears the visible thread for the selected agent/mode and saves that boundary, while keeping the older host archive available. The host can download transcripts as before.

Once you have visited the form page, returning to planning disables subsequent automatic form redirects for that trip. That preference persists locally and in the cloud; use Continue to form to return manually. A host reset clears the preference for the fresh trip.

Profile reads and writes do not call OpenAI. They consume Cloudflare Workers requests and D1 usage. Free-plan limits apply to the whole account, including the existing chat-log database. OpenAI conversation, speech, memory extraction and notepad extraction costs continue separately.
