# Sage and Astra: personal follow-ups and sharing awareness

This is an update package for your existing website and Worker, not a complete replacement repository. It builds on the saved memory-assignment, public-notepad, durable-memory, mobile-UI, and two-form survey updates. It preserves the saved Shared/Separate assignment for each name ID, the shared public itinerary, the agents' personalities/voices, and the existing survey receipt/duplicate protection.

## What changes

- Sage asks one optional, open-ended why follow-up when a newly stated travel preference has no reason yet. Example: "What is it about quiet places that appeals to you?"
- Astra asks one brief, open-ended why follow-up when the user rejects or changes a suggestion without explaining why. Example: "No museums on day 2, got it. What made you want to skip them?"
- Both prompts limit the ENTIRE reply to one question, including logistics, approval and handoff questions. They skip reasons already supplied, accept declined questions, and never require personal disclosure to finish. They do not ask for diagnoses, income, trauma or intimate details.
- Both agents' background extractor saves personal facts as well as itinerary details. New records contain `fact`, `type`, `reason` (null when unstated), and the actual `learned_by` agent. Types are preference, constraint, past_experience, travel_companion, avoidance and trip_detail. Explicit personal facts volunteered during Astra's planning are captured too.
- Shared mode makes those records available in both directions. Separate mode keeps them in each agent's own bucket. Type/reason/source survive durable background retries, profile saves, reloads and cloud recovery. Existing plain-text memories remain readable; old reasons are not invented.
- A relevant, explicitly sourced OTHER-agent personal memory permits an occasional short source mention, in either direction. Example: "Sage mentioned you prefer quieter places, so I'd put that visit earlier." Source mentions are not required every turn or switch and are prohibited for public itinerary facts, unsupported facts, and facts already told directly to the receiving agent. They never announce the condition label.

The existing deferred extraction path is retained: facts can take a moment to finish saving after a turn. This update does not add new blocking model calls before each answer.

## 1. Copy the changed website and Worker files

Copy the `docs/` files and `worker/src/` files from this archive into their matching folders in your existing repository. In particular, include the NEW `worker/src/personal-memory.mjs` alongside the updated memory, profile and pipeline modules. Do not replace your repository with this partial package.

Keep your current `docs/config.js`, `docs/index.html`, `worker/wrangler.jsonc`, secrets, database bindings, public origin and model settings. No new environment variables, secrets or database migrations are required. The existing profile JSON column holds the new metadata. No old profiles or accepted survey responses are deleted.

Commit/push the changed `docs` files to update GitHub Pages. From your existing `worker` directory deploy the Worker:

```powershell
npx wrangler deploy
```

Deploy the Worker and website together while participants are not actively using the old version. Reload or hard-refresh the website afterward. New and old response shapes remain compatible during rollout, but the updated browser files are needed to retain the richer fields.

The two optional `lib/Shifts-and-Giggles/sage.py` and `astra.py` files keep the desktop role wording aligned for later prompt syncing. The website runs the Worker JSON prompts directly; changing only Python will not update the website. Desktop memory persistence itself has not been converted to the website's new typed format in this update.

## 2. Add the same awareness check to BOTH Google Forms

Replace the bound Apps Script with `google-form/Code.gs` in each of your existing assigned forms. Keep Script Properties, Survey code item, prefill entry IDs, response Sheets and existing triggers.

Run `installSharingAwarenessQuestions` once as the form owner on EACH form. It reuses its saved item IDs, so re-running does not duplicate the new questions. It adds the same neutral questions after the existing experience items and leaves Survey code first. For a new installation, `installSurveyProtection` also calls this installer before installing receipt triggers.

The questions are:

1. **Did either agent use personal information you had told only the other agent?** Required: Yes / No / Not sure. The help text distinguishes personal reasons/preferences/experiences/needs from public itinerary notes.
2. **What, if anything, made you think the agents shared personal information?** Optional written evidence. It asks participants not to repeat sensitive details.
3. **Where did you notice this, if anywhere?** Optional: Astra used something I told Sage / Sage used something I told Astra / Both directions / I did not notice this / Not sure.
4. **Did an agent say it learned something about you from the other agent?** Optional: Yes / No / Not sure.

Written evidence comes before the explicit-source question so it is not suggested by that later wording. The questions do not prefill the condition or the expected answer. Keep form titles neutral too. If you already added a separate awareness question with different wording, review it manually to avoid asking the same construct twice; the installer does not delete your existing questions or answers.

Do not delete/recreate Survey code. Its prefill entry IDs and the two existing form routes are unchanged. The current receipt callbacks, linked-Sheet duplicate cleanup and edit restrictions remain intact. Adding items through the Form automatically adds their response columns to its linked Sheet.

## 3. Pilot checks before collecting the revised study data

Use fresh pilot name IDs and inspect their saved assignments in the existing host view. Do not change a participant's assignment to test a desired answer.

- Tell Sage a preference without a reason, such as "I prefer quiet places." Expect one relevant optional question, with no second logistics question stacked onto it. Give the reason in the first message instead and check that Sage does not ask it again. Decline once and check that planning continues.
- Tell Astra why you want to remove an activity, or volunteer a practical need or companion. Check the host memory export/profile for the correct source, type and stated reason. A rejection with no explanation should prompt at most one brief why question, not an invented reason.
- In Shared, return to the other agent and make a related choice. Check concrete application in BOTH directions, not merely repetition or a source phrase. Source mentions should be occasional and truthful.
- In Separate, the other agent can use the public itinerary but must not know a private reason it was never told. Neither agent should announce the assigned mode.
- Complete both routed forms through the website. Check that the same four questions appear, the survey code remains filled in, the new answers reach the linked Sheet, and repeat submissions remain protected.

The primary awareness answer measures perceived sharing, not proof of successful transfer. The direction item supports checking Sage's use of Astra-learned details as well as the reverse. The written evidence and explicit-source item help distinguish noticing actual use from simply remembering a "Sage mentioned..." cue. Explicit source cues intentionally make sharing more noticeable; analyze them alongside the existing conversation-based opportunity/use metrics rather than treating the awareness answer alone as evidence that an agent applied a memory correctly. Keep an instrument/version note when comparing sessions collected before and after this change.

## Verification

Run from your repository root with Node 24:

```powershell
node --experimental-vm-modules --test verification/personal-memory.test.mjs
```

Fourteen mocked/component tests pass, covering both agents' structured extraction, legacy records, retry behavior, independent buckets, truthful source eligibility, public-note boundaries, profile metadata, deletion invalidation, durable queues, pipeline prompt/response integration, saved mode checks, idempotent identical Form items and cloud recovery of metadata-only edits. JavaScript/JSON/Python syntax checks also pass.

Tests do not call OpenAI or Google, and no live Cloudflare or GitHub deployment was performed. The test loader has fixtures for unchanged dependencies omitted by older patch archives; your installed repository uses its real dependencies. Live model phrasing, the one-question prompt behavior, Google authorization, and both native Sheet/trigger flows still need the pilot above. Prompts guide model behavior; these tests do not prove every future model reply will comply.
