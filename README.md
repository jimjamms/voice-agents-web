# Sage & Astra — browser voice demo

This project uses the **three Python files supplied by the owner**. The browser demo takes a recorded turn, transcribes it, gets a chat response using the agent's original Big Five prompt, and speaks it using that agent's original OpenAI voice and delivery instructions. `scripts/sync_agents.py` extracts these settings from the Python files into `worker/src/agents.json`. Run it whenever you change the Python personality or voice settings.

| Agent | Chat personality | OpenAI voice |
| --- | --- | --- |
| Sage | Bubbly, cheerful, empathetic and kind | `marin` |
| Astra | Mellow, grounded, thoughtful and serious | `cedar` |

The terminal files use local faster-whisper and a typed speaker name. Browsers on GitHub Pages cannot run that Python code; this demo uses the hosted `whisper-1` transcription API, and its conversation history stays in the current tab. Desktop Azure options remain in `lib/Shifts-and-Giggles/`, while the browser uses each agent's default OpenAI TTS. Talk by tapping Start talking, then Stop & send (or wait 30 seconds). The generated voice is AI generated.

## What you need

- A GitHub account and repository, an OpenAI API key with API billing available, and a Cloudflare account with Workers available.
- A private **demo access code** you can give testers. The code reduces unwanted use, but a shared code can be passed around. Keep a budget cap on the OpenAI account and monitor usage. The backend rate limits requests per IP.
- A browser that supports microphone access and MediaRecorder on HTTPS. Use an up-to-date Safari/Chrome/Firefox on the tester's device.

## Deploy the private API

1. Edit `worker/wrangler.jsonc`: set `PUBLIC_ORIGIN` to your Pages site's **origin** (for example `https://YOURNAME.github.io`, without a repo path). Set `PIPELINE_CHAT_MODEL` to the chat model available to your API account. The supplied configuration retains your `gpt-6-astra` setting. Realtime uses the separate `REALTIME_MODEL` setting.
2. In `worker/`, run `npm install`, then `npx wrangler login`, then `npx wrangler deploy`. Save the resulting `https://...workers.dev` address.
3. From `worker/`, run `npx wrangler secret put OPENAI_API_KEY` and enter your key when prompted. Run `npx wrangler secret put DEMO_ACCESS_CODE` and enter a long, random code to share privately with testers. **Never commit keys, `.dev.vars`, or the access code.**
4. Edit `docs/config.js` to set `apiBaseUrl` to the Worker address. This address is public and safe to commit.

The Worker allows requests from the exact Pages origin, requires the demo access code, limits requests, caps audio size, and holds the OpenAI key on the server. An access code is a basic control for a small demo, not per-person authentication. For a large public release, add account sign-in and per-user quotas before sharing broadly.

## Publish the site on GitHub Pages

1. Create a GitHub repository and upload **the contents of this folder** at the repository root (so `docs/index.html` is in `/docs`). Or use `git init`, `git add .`, `git commit -m "Add voice demo"`, add your remote and push to `main`.
2. In the repository, go to **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, branch `main`, folder `/docs`, then Save.
3. Visit `https://YOURNAME.github.io/REPOSITORY/`, enter the demo code, allow the microphone and try a conversation with each agent.

GitHub Pages only serves the static browser files. The Cloudflare Worker handles API calls and keeps the key private. Both sites must use HTTPS for microphone permissions. If you use a custom Pages domain, update `PUBLIC_ORIGIN` to that domain and redeploy the Worker.

## Verify and customize

From the project root:

```sh
python3 scripts/sync_agents.py
node --test tests/*.test.mjs
node --check docs/app.js
```

The desktop app still runs with its own dependencies and environment settings described in `lib/Shifts-and-Giggles/agent_base.py`; execute `lib/Shifts-and-Giggles/sage.py` or `lib/Shifts-and-Giggles/astra.py` after installing those requirements. Web requests incur OpenAI transcription, chat and speech API usage. This package does not contain API keys or a live backend.

## Apply this update to your existing website

1. Replace `docs/`, `worker/src/`, `scripts/sync_agents.py`, and `tests/` in your GitHub repository with the versions in this archive. Update the Python files in `lib/Shifts-and-Giggles/` from this archive too. If that folder is a Git submodule, update the original Shifts-and-Giggles repository and then its submodule commit instead of committing Python files to the parent repository.
2. Keep your existing `docs/config.js` Worker URL, Worker origin/model settings, and secrets. This update preserves the supplied configuration.
3. Run `python3 scripts/sync_agents.py` and `node --test tests/*.test.mjs` from the project root.
4. From `worker/`, run `npm ci` and `npx wrangler deploy`.
5. Commit and push the changed website files to GitHub. Wait for Pages to rebuild, then refresh the website.

## Terminal behavior on the website

Classic pipeline is the default. Type your name before talking, or leave it blank to stay Unknown and skip memory. Names match case-insensitively. Select enabled agent-to-agent memory to let Sage and Astra share facts with attribution, or disabled to give each agent separate facts. The two modes keep separate stores. Each speaker has at most 20 facts per store. Switch agents after a reply ends, then use the same name to recall facts. New conversation clears chat history while retaining memories. Forget my memories removes this name's facts from both modes and agents.

Memories persist in local browser storage on this website origin. They do not sync between devices or with the terminal's memories.json. Stored facts are sent to the Worker and OpenAI for the selected speaker. Browser storage being blocked prevents persistence after leaving. This is a demo with typed names, not authenticated user accounts.

Tap Start talking, then Stop & send. During a reply, tap Interrupt & talk, or press Enter while focus is outside a form control, to cut off the reply and start recording immediately. Hands-free remains an optional browser feature. Voice enrollment is no longer part of the active interface.

Realtime receives the same personality and saved memory context at connection time. Completed transcript replies trigger best-effort fact extraction through `/memory`; partial or interrupted Realtime transcripts can differ from what was heard. Classic pipeline uses the complete generated text, matching the terminal approach. Realtime audio uses its own model rather than the pipeline chat model.

Download conversation includes messages and turn records with speaker, memory mode, agent, and interruption status. Turn records remain in this tab across New conversation and agent changes, with a separate session ID after each reset. Pipeline records include Big Five traits.

Both worker/src/agents.json (Realtime) and worker/src/pipeline_agents.json (Classic pipeline) are generated by sync_agents.py. Regenerate both after editing agent personality, voice, or TTS instructions. Other changes to Python methods still require a corresponding JavaScript implementation.

## Verify memory sharing

Use the same typed name with Sage and tell it a durable fact, such as your favorite hobby. Wait for Memory saved. Start a new conversation with Astra and ask what it knows about you. In shared mode, Astra can reference facts learned by Sage with attribution. Repeat using a fresh name in isolated mode; Astra should not have Sage's facts. Reload with the same name to check persistence. Forget memories and confirm recall is cleared.
