# Automatic chat logs

The website sends completed text turns to your Cloudflare Worker. A D1 database stores them. The host export page downloads JSON without asking testers to send files. Audio is not stored in these logs. The setup screen tells testers their transcripts are saved for the host.

## Enable storage once

Copy the supplied files into your project. Keep your current `docs/config.js` Worker URL and existing secrets.

From the `worker` folder:

```powershell
npx.cmd wrangler d1 create sage-astra-chat-logs
```

Copy the returned database ID. Add the following property to your EXISTING `worker/wrangler.jsonc`, preserving the other properties. Replace `PASTE_DATABASE_ID` with the actual ID. If Wrangler already added a D1 binding, change its binding name to `LOG_DB` instead of adding another entry.

```json
"d1_databases": [
  {
    "binding": "LOG_DB",
    "database_name": "sage-astra-chat-logs",
    "database_id": "PASTE_DATABASE_ID"
  }
]
```

Remember the comma between this property and neighboring properties in the JSON configuration.

Create the tables and configure the private export key:

```powershell
npx.cmd wrangler d1 migrations apply sage-astra-chat-logs --remote
npx.cmd wrangler secret put LOG_ADMIN_KEY
npx.cmd wrangler deploy
```

For `LOG_ADMIN_KEY`, enter a long random password different from the demo code. Keep it private. Never put it into config.js, GitHub, a URL, or give it to testers. This key lets its holder export all transcripts.

Commit and push the changed website files to GitHub Pages. Open a new test conversation and check the footer says `Chat saved for the host.` after a completed turn. Until D1 is configured, uploads remain pending; the ordinary conversation can still work.

## Download logs

Open `host-logs.html` on your published site, for example `https://YOURNAME.github.io/YOUR-REPOSITORY/host-logs.html`.

Enter the private host key. Enter a tester's name to filter their turns, or leave it blank for everyone. Click Download JSON. The page fetches all matching pages, then downloads one JSON file. Names match case-insensitively; two people using the same name both appear in that name filter. `participant_id` distinguishes browser instances and `session_id` distinguishes conversation sessions. Keys are sent in an authorization header and cleared from the input afterward, not saved in browser storage.

## What is recorded

Each turn includes a timestamp, participant ID, session ID, speaker name, agent name and Big Five traits, voice mode, shared/separate memory mode, user transcript, generated reply, and interruption flag. Recorded mode stores the complete generated reply even if speech is interrupted. Realtime stores the transcript received from the service. Files contain a `turns` array; group by participant or session for analysis.

Uploads run separately from speech. A local outbox retries temporary failures, and turn IDs prevent retry duplicates. An interrupted turn updates its existing row instead of adding another. Logs that never reach the Worker cannot be exported; pending data can be lost if a tester clears browser storage or closes a browser that blocks local storage before upload succeeds. Have a successful end-to-end test before sharing the website.

Copying this code does not create the database or deploy it. Complete the commands above in the Cloudflare account hosting your Worker. These changes do not configure the future Google Form or automatically submit logs to that form.

The normal demo access code allows uploading only. Exporting requires the separate host key. Logs remain in D1 until you remove them; clearing the user's local notes or memories does not delete the host transcript archive.

Cloudflare documentation: https://developers.cloudflare.com/d1/get-started/ and https://developers.cloudflare.com/workers/wrangler/commands/d1/
