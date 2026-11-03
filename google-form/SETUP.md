# Embedded survey and duplicate-response setup

The Finish panels have equal outer heights on desktop and mobile. Notes and the Google Form scroll independently inside them. Notes remain resizable while planning.

## What this does

- No email registration or participant Google sign-in is added.
- The Worker generates an opaque survey code from the normalized name ID using a private signing key. The same ID gets the same code on every device, including after profile deletion.
- Only that opaque code is prefilled into the Google Form. No name ID, chat, notes, or memory condition is sent as a form answer by the website.
- The first server-accepted response claims the code atomically. Further new responses using that code are removed from Google Forms by a submission trigger. Existing response edits keep their response ID and are accepted.
- Completion is checked on opening Finish and every 15 seconds while it is visible. After confirmation, Finish shows a thank-you message and an Edit your response button, which opens the existing response inside the website.
- Responses are pseudonymous, not strictly anonymous: a host with both the Worker and form data can associate the opaque code with the name ID. Reflect this in the research consent/data handling plan.

## Important limits

This does not disable Google's Submit button before a duplicate is submitted. It keeps one accepted response per code by removing extra responses after submission. Trigger/network delays can leave duplicates visible temporarily. Failed receipt requests are queued and retried every five minutes; they are never treated as proof of success.

A new name ID yields a new code. With no identity verification, this cannot guarantee one participation per human. Users can also copy their form URL. Do not describe this as a strict one-person rule.

Use Google Forms' own Responses tab/CSV after the trigger has completed for accepted survey data. Do not link the form directly to a response Sheet: deleting a Form response does not remove its spreadsheet row. The installer refuses to proceed if a destination Sheet is linked. Unlinking does not delete existing sheet data.

## 1. Copy the updated files

Copy the included docs, worker/src, and worker/migrations files into your existing project, preserving the directories. Keep all your other project files. Retain your own Worker address in docs/config.js.

## 2. Apply the database migration

In PowerShell, open the worker directory and run:

```powershell
npx wrangler d1 migrations apply sage-astra-chat-logs --remote
```

Use the database_name from your wrangler.jsonc if yours differs. This creates survey_receipts without changing existing trips, memory assignments, or answers. Local development also needs the migration with --local.

## 3. Create two different private secrets

Run these separately from worker; enter a different long random secret when each prompt appears:

```powershell
npx wrangler secret put SURVEY_SIGNING_KEY
npx wrangler secret put SURVEY_RECEIPT_KEY
```

Keep SURVEY_SIGNING_KEY stable: changing it gives existing IDs new survey codes. Save SURVEY_RECEIPT_KEY securely; the exact same receipt key must be entered in Apps Script. Never place either key in docs/config.js or the form questions.

## 4. Set up the Google Form

1. Open your form in edit mode. The public viewform link is not the editor.
2. Keep email collection off and Limit to 1 response off for this no-sign-in workflow.
3. If a response Sheet is linked, unlink it. Save/retain any existing data separately; do not delete existing responses.
4. Open the form's Apps Script editor from its menu.
5. Replace the default script with google-form/Code.gs from this package.
6. In Apps Script Project Settings, add these Script Properties:
   - WORKER_URL: your Worker base address, for example https://sage-astra-voice-api.voice-agents-web.workers.dev
   - SURVEY_RECEIPT_KEY: the receipt secret from step 3 (not the signing key).
7. Save and run installSurveyProtection. Authorize it using the form owner's account. Participants do not authorize anything.
8. This creates a required short-answer Survey code question and installs the submit/retry triggers. It prints an entry identifier such as entry.123456789 in the execution log.
9. Leave this Survey code question in place. It will be filled automatically by the website. The code field is visible and editable because Google Forms has no hidden answer fields; changed or unknown codes cannot claim an accepted response.

Do not manually run onSurveySubmitted: it needs a real submission event.

## 5. Configure and deploy the Worker

Add the printed identifier inside the existing vars object of worker/wrangler.jsonc, preserving the other variables:

```json
"SURVEY_ENTRY_ID": "entry.123456789"
```

Replace the example with the value printed by your script. Then run:

```powershell
npx wrangler deploy
```

Survey access stays closed until the migration, secrets, and entry identifier are configured. The participant sees a retry/error message instead of an unchecked form.

## 6. Publish the website

Push the included docs files to GitHub Pages. The existing config.js with your googleFormUrl can remain, although the protected survey URL now comes from the Worker.

## 7. Test before recruitment

Use a test name ID, finish a trip, and submit the survey. Leave Finish open for up to 15 seconds for confirmation. Reopen the same ID on another device: it should show Survey submitted and allow editing the same response. Edits must stay in the embedded form.

To test duplicate removal, before the first submission open that same test ID in a second browser and load Finish. Submit one response from each browser. Verify one accepted response remains in Google Forms after triggers finish. Look at Apps Script Executions for failures. A trigger's deletion of a duplicate is permanent; only perform the duplicate test using test responses.

Existing form responses collected before this installation are not retrospectively deduplicated. Live Cloudflare and Google setup cannot be performed merely by copying this package; complete the steps above.

## Validation performed

Local checks cover stable codes across name-ID capitalization/device requests, simultaneous response claims, idempotent receipt retries, callback authentication, unknown-code rejection, incomplete setup, response-edit access, and preserving unfinished answers during a failed status refresh. A real SQLite check allowed one winner among eight concurrent claims. Apps Script mocks verified accepted replies are kept, rejected duplicates are removed, and unavailable callbacks remain queued. Syntax checks passed.

The legacy 114-test suite has the same 36 failing test names before and after this update; no new failures were introduced. Those existing tests include assumptions about older UI/profile behavior. This is not a claim that the full suite passes. Live Google authorization/triggers, Cloudflare deployment, and visual/mobile rendering still require the setup and manual checks above.
