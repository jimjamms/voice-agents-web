Sage and Astra follow-up and source-visibility update (v8)

Apply this patch on top of sage-astra-personal-followups-update.zip.
Copy the included docs/, worker/, lib/ and verification/ files into the matching
paths of your project. These are changed files, not a full standalone repository.
Deploy the Worker and the website using your existing deployment process.
The new worker/src/response-policy.mjs must be included in the Worker bundle.
Reload the website after deployment. Reconnect any existing realtime sessions
so they receive the new instructions. This package has not been deployed.

What changed

1. Sage asks what appeals about a new travel preference or choice when its reason
   is missing. This includes a short place/activity answer to her previous question.
   Astra asks why a suggestion was rejected or changed when no reason was supplied.
   The obsolete per-round interview quotas have been removed. The prompts were
   shortened by removing a large repetitive planning-guidance section and replacing
   it with a consolidated policy while retaining personality, role, completion goals,
   spoken length, task boundaries, public-note rules and travel limitations.

2. Text and recorded-voice pipeline replies use a small internal JSON contract.
   Statements and the single follow-up question are generated separately. The Worker
   replaces a missing why with one question for the clear choice/rejection patterns
   covered by its detector. It removes extra question sentences and rejects common
   stacked-question wording. JSON is never displayed or spoken. Unusual phrasing
   still depends on the model interpreting the instructions correctly.

3. When applying another agent's relevant personal fact to a concrete planning
   decision, the model selects its evidence ID and an exact sentence showing the
   application. The Worker checks the supplied evidence and inserts its actual source.
   It does not let the model invent the source ID or paraphrase the evidence into an
   unsupported new fact. The model still judges relevance and whether a fact was
   already learned directly or superseded. This is a provenance check, not proof that
   every recommendation follows logically from the selected memory.

   A rendered example for Astra is
   Sage mentioned that you prefer quiet cafes. I'd choose a cafe on a quieter side street.

   The same mechanism lets Sage acknowledge personal facts learned by Astra. Source
   mentions are no longer blocked simply because a different fact was attributed in
   the previous reply. Irrelevant memories and public itinerary notes do not justify
   source mentions.

4. Explicit recent USER disclosures from shared exchanges can supply evidence before
   background typed-memory extraction finishes. Unaccepted assistant suggestions,
   question-bearing raw transcripts and bare public itinerary details are excluded
   from this immediate fallback. Shared exchanges are not available in Separate mode.

5. The realtime instructions, browser memory context and desktop role definitions
   use the same strengthened behavior rules. Native realtime speech does not pass
   through the pipeline JSON renderer, so its behavior is instruction-based rather
   than mechanically checked. Voices and personality values are unchanged.

6. Explained choices, answers to a why question, refusals, requests to move on,
   sensitive causes, routine logistics and completed approval should not trigger
   another why. Companion disclosures alone do not trigger a why. Users can decline
   explanations and continue. Neither condition requires personal disclosure.

Forms, condition assignment, public-notepad visibility, memory storage schemas,
cloud synchronization and survey routing are unchanged by this update.

Validation

30 local automated tests passed using mocked model/API replies. Includes both agents,
source directions, Shared/Separate modes, immediate switch openings, delayed extraction,
why fallbacks, question limits, privacy, durable saves and existing form behavior.
JavaScript, Python and JSON syntax checks passed. There was no live model conversation,
browser deployment or native realtime speech test; perform those checks after deployment.

Run tests with Node 24 or compatible newer Node
node --experimental-vm-modules --test verification/*.test.mjs

Suggested live checks

- Tell Sage "I prefer quiet places" without explaining why. Expect one why question.
- Give the reason, then continue. Expect the reason to shape her next idea without
  repeating the same why question.
- Tell Astra "No museums on day 2" without a reason. Expect one brief why question.
- In Shared mode tell one agent "I prefer quiet cafes because crowds tire me out",
  then ask the other for a cafe recommendation. Expect a relevant adaptation and a
  source mention. Repeat with the agents reversed.
- Repeat in Separate mode with a fresh assigned participant. The receiving agent
  should not claim that personal fact or cite the other agent's private conversation.
- Check why declines, requests to proceed, and final approval do not add another
  personal interview. Check spoken and typed replies separately.
