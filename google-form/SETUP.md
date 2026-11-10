# Shared and separate survey forms

This update builds on the installed embedded survey and duplicate-response protection. It changes no website layout or participant memory assignments.

Your forms:

- Shared: https://docs.google.com/forms/d/e/1FAIpQLSfE3zVMUF7Vhy-ZqAA47HYjv3880pw99WswhVsZphc5hhV3Kw/viewform
- Separate: https://docs.google.com/forms/d/e/1FAIpQLSeyNKhB_Dvb-udkmOxTuuhoBLXynMQgF6pqFry6x6__RzHebg/viewform

The Worker reads the existing memory_assignments row for the normalized name ID. Stored shared IDs get the shared form; stored isolated IDs get the separate form. It does not trust a mode sent by the browser or create new assignments here. The participant-facing website shows no condition label. Use neutral titles/questions in the forms if participants should not learn their condition from the survey itself.

## 1. Copy these changed files

- worker/src/survey.mjs
- worker/migrations/0009_survey_form_routes.sql
- google-form/Code.gs
- google-form/SETUP.md (these instructions)

Keep the other installed website/Worker files. No docs files changed in this update.

## 2. Install Apps Script on BOTH new forms

Do the following once on the shared form, then repeat on the separate form:

1. Open the form's editor, not its public participant link.
2. Keep email collection and Limit to 1 response off for no Google sign-in. Avoid file-upload questions and organization-only restrictions.
3. Keep your linked response spreadsheet. The script supports both linked and unlinked forms and requests spreadsheet permission when needed.
4. In the form editor, choose the three-dot menu > Apps Script.
5. Replace the script with the included Code.gs and save.
6. In Apps Script Project Settings > Script Properties, set:
   - WORKER_URL: the same Worker base URL you already use.
   - SURVEY_RECEIPT_KEY: the same receipt secret already installed in that Worker. Do not use SURVEY_SIGNING_KEY here.
7. Run installSurveyProtection and authorize it as the form owner. Do not deploy it as a web app or manually run onSurveySubmitted.
8. Copy BOTH lines printed in the execution log:
   - Survey form URL: https://docs.google.com/forms/d/e/.../viewform
   - Survey code entry ID: entry.123456789
9. Label your copied values shared or separate so you keep each URL paired with its own entry ID.

The installer creates/reuses the required Survey code question, disables answer editing and Submit another response, and installs submission/retry triggers. Re-running it reuses that question. Do not remove or rename the Survey code question.

The installer also prints the full URL so you can verify that each entry ID belongs to the intended form. The Worker already contains your two supplied full URLs.

## 3. Configure two Worker variables

In worker/wrangler.jsonc, replace the old SURVEY_ENTRY_ID variable with these two entries INSIDE the existing vars object. Preserve PUBLIC_ORIGIN, model settings, and any other existing variables. Replace each entry-ID placeholder with the output from the corresponding form's installer:

```json
"SURVEY_SHARED_ENTRY_ID": "entry.PASTE_SHARED_NUMBER",
"SURVEY_SEPARATE_ENTRY_ID": "entry.PASTE_SEPARATE_NUMBER"
```

The two full form URLs above are already built into survey.mjs. No form URL variable is needed. If you previously set SURVEY_SHARED_FORM_URL or SURVEY_SEPARATE_FORM_URL, remove those overrides or ensure they match the full URLs above. Keep the two existing secrets unchanged: SURVEY_SIGNING_KEY and SURVEY_RECEIPT_KEY. There is no need to generate replacements.

## 4. Apply the database migration

From PowerShell in worker:

```powershell
npx wrangler d1 migrations apply sage-astra-chat-logs --remote
```

Use your database_name if different. This applies 0009_survey_form_routes.sql to add a form_url column. Keep the prior 0008 migration installed. Local development also needs the migrations with --local.

Existing tokens, completed submissions, memory assignments, chats, and memories are retained. The signing-key/name-ID formula is unchanged. An existing ID that already submitted the old survey remains marked submitted; replacing forms does not grant an automatic second submission. Use the individual reset process if you intentionally want someone to participate again.

## 5. Deploy and test

Avoid switching during active participation. Once both forms and the two entry-ID variables are ready, run:

```powershell
npx wrangler deploy
```

No website/GitHub Pages update is required for this particular change; the existing survey.js uses the URL returned by the Worker. Old docs/config.js.googleFormUrl is not used by the protected survey flow.

Test with a known shared ID and a known separate ID using the host's assignment information. Do not change their memory assignments just for testing. Each should open the appropriate form in Finish without an on-page memory-mode label.

Submit test answers. The website checks status every 15 seconds while Finish is visible. Reopen the same ID on another device to verify completion stays locked. A wrong-form or unknown-code submission is rejected by the Worker but retained in Forms and Sheets for host review. Only confirmed extra submissions using an already accepted code are removed. Their matching rows are removed from this form's linked response tab as well. Repeat callbacks for the accepted response are safe. Editing remains disabled.

After verifying the replacement, stop accepting responses on the old form. Review any old form's pending Apps Script executions before retiring its triggers; the old script does not supply the form identity required for new callbacks. Existing accepted responses are not deleted or migrated between Google Forms.

## Boundaries

This keeps one accepted response per existing name ID using an opaque survey code. There is no Google sign-in or email registration. It cannot prevent the same human creating a different name ID. Google accepts a duplicate before Apps Script removes it, so duplicate rows can be visible temporarily; failed callbacks remain queued for five-minute retries.

The code is pseudonymous: the website does not put the name ID or memory mode in form answers, but a host with both systems can link the code to the ID. This is not a claim of unlinkable anonymity.

Only responses associated with the form assigned by the server can claim the code. Invalid/missing configuration does not silently choose a default form. A missing saved assignment asks the participant to load their ID in setup rather than assigning a new condition.

Live Cloudflare deployment, Google authorization/triggers, and both actual forms need the manual checks above. Your supplied full URLs are configured in the Worker. Their live display and submission triggers still need testing on your deployed website.

## Updating an existing installation for linked spreadsheets

1. Replace worker/src/survey.mjs and run npx wrangler deploy from worker. No migration or new variables/secrets are needed for this particular update. Keep migrations 0008 and 0009 installed.
2. Replace the bound Apps Script on BOTH forms with the included Code.gs. Keep the existing Script Properties.
3. Keep the response Sheets linked. Run installSurveyProtection again on each form, and authorize spreadsheet access if Google requests it. No Apps Script deployment is needed.
4. Reuse the same SURVEY_SHARED_ENTRY_ID and SURVEY_SEPARATE_ENTRY_ID if the Survey code questions were not deleted/recreated. The installer prints the identifiers again for verification.
5. Submit a fresh test through the website's Finish stage, not the bare Google Form link. Check the form's Responses tab, its linked Sheet, and the website's completion message.

Only a confirmed duplicate is deleted from Forms and its linked Sheet. Accepted answers stay. Code/form mismatches and unclassified rejections are retained for review, with a review:<response ID> Script Property and an execution-log message. The website cannot confirm an unaccepted submission. Correct the underlying code/form configuration, then manually run retryReviewReceipts in Apps Script to recheck retained responses (up to 25 per run).

Duplicate row deletion matches Survey code plus timestamp only in the linked tab belonging to this form. It protects the accepted response's timestamp, rechecks the candidate row before deleting, and journals the action so retries cannot delete another row. If the row has not arrived yet, cleanup is queued for the five-minute retry. Ambiguous matches (including near-simultaneous timestamps) stay intact for host review; do not interpret such raw rows as additional accepted study responses. Check Executions for these cases. Avoid sorting or renaming the raw response tab's columns while submissions are being processed.

An existing Google confirmation page might show a duplicate briefly before cleanup. This update does not restore responses previously deleted by older scripts and does not retroactively clean old Sheet rows. Review legacy rows separately.

Targeted mocked checks cover linked/unlinked installation, accepted rows remaining intact, correct duplicate-row and Form-response removal, unknown/wrong-form response preservation, callback outages, delayed/ambiguous rows, cross-form tab isolation, and retries after Sheet cleanup. Live Google authorization, native Sheet append timing, and both form triggers still require the manual test above.

## Personal-memory sharing awareness update

After replacing Code.gs, run `installSharingAwarenessQuestions` on BOTH assigned forms. This adds identical neutral awareness, evidence, direction and explicit-source items at the end, reusing their IDs on later runs. The existing Survey code entry IDs, callbacks and linked response Sheets stay in place. The complete wording, interpretation and pilot checks are in `README-personal-memory-update.md` at the archive root. Keep form titles neutral and do not reveal the assigned condition in the questions. Existing questions/responses are not deleted.
