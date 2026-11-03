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
3. If it has a linked response Sheet, unlink it. Google Forms response deletion does not remove corresponding Sheet rows. Unlinking preserves existing Sheet data. Use the Forms Responses tab/CSV after processing for accepted responses.
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

Submit test answers. The website checks status every 15 seconds while Finish is visible. Reopen the same ID on another device to verify completion stays locked. A wrong-form submission using a copied code is rejected by the Worker and removed by that form's script. Repeat callbacks for the accepted response are safe. Normal extra new responses using the same code are also removed. Editing remains disabled.

After verifying the replacement, stop accepting responses on the old form. Review any old form's pending Apps Script executions before retiring its triggers; the old script does not supply the form identity required for new callbacks. Existing accepted responses are not deleted or migrated between Google Forms.

## Boundaries

This keeps one accepted response per existing name ID using an opaque survey code. There is no Google sign-in or email registration. It cannot prevent the same human creating a different name ID. Google accepts a duplicate before Apps Script removes it, so duplicate rows can be visible temporarily; failed callbacks remain queued for five-minute retries.

The code is pseudonymous: the website does not put the name ID or memory mode in form answers, but a host with both systems can link the code to the ID. This is not a claim of unlinkable anonymity.

Only responses associated with the form assigned by the server can claim the code. Invalid/missing configuration does not silently choose a default form. A missing saved assignment asks the participant to load their ID in setup rather than assigning a new condition.

Live Cloudflare deployment, Google authorization/triggers, and both actual forms need the manual checks above. Your supplied full URLs are configured in the Worker. Their live display and submission triggers still need testing on your deployed website.
