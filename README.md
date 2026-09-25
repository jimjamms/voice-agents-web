# Sage & Astra — browser voice demo

This project uses the **three Python files supplied by the owner**. Byte-for-byte copies are in `desktop/`. The browser demo takes a recorded turn, transcribes it, gets a chat response using the agent's original Big Five prompt, and speaks it using that agent's original OpenAI voice and delivery instructions. `scripts/sync_agents.py` extracts these settings from the Python files into `worker/src/agents.json`. Run it whenever you change the Python personality or voice settings.

| Agent | Chat personality | OpenAI voice |
| --- | --- | --- |
| Sage | Bubbly, cheerful, empathetic and kind | `marin` |
| Astra | Mellow, grounded, thoughtful and serious | `cedar` |

The desktop files use local faster-whisper and local MFCC speaker recognition. Browsers on GitHub Pages cannot run that Python code; this demo uses the hosted `whisper-1` transcription API, and its conversation history stays in the current tab. Desktop Azure options remain in `desktop/`, while the browser uses each agent's default OpenAI TTS. Talk by tapping Start talking, then Stop & send (or wait 30 seconds). The generated voice is AI generated.

## What you need

- A GitHub account and repository, an OpenAI API key with API billing available, and a Cloudflare account with Workers available.
- A private **demo access code** you can give testers. The code reduces unwanted use, but a shared code can be passed around. Keep a budget cap on the OpenAI account and monitor usage. The backend rate limits requests per IP.
- A browser that supports microphone access and MediaRecorder on HTTPS. Use an up-to-date Safari/Chrome/Firefox on the tester's device.

## Deploy the private API

1. Edit `worker/wrangler.jsonc`: set `PUBLIC_ORIGIN` to your Pages site's **origin** (for example `https://YOURNAME.github.io`, without a repo path). Set `CHAT_MODEL` if you want another OpenAI Chat Completions model. The default is `gpt-4.1-mini`; the supplied desktop file uses `gpt-6-astra`, which is not a documented public API model. The personalities and voices are unchanged.
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

The desktop app still runs with its own dependencies and environment settings described in `desktop/agent_base.py`; execute `desktop/sage.py` or `desktop/astra.py` after installing those requirements. Web requests incur OpenAI transcription, chat and speech API usage. This package does not contain API keys or a live backend.
