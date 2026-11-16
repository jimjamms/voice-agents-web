Sage and Astra personal planning and fact application update (v10)

Apply this patch on top of sage-astra-natural-followups-v9.zip. It contains only
files changed since v9, not the complete repository. Copy the files into matching
paths. Include the NEW worker/src/personal-planning.mjs module in the Worker build.

What was missing

Earlier versions supplied facts and encouraged personalization, but this did not
prove that the model consistently used them. The final response contract highlighted
verified cross-agent facts while own-source facts depended more on earlier context.
Astra's strongest why rule activated mainly when the user rejected a suggestion.
Ordinary budget, timing and lodging exchanges could therefore remain impersonal.

Changes

1. The final response contract now includes a compact list of known personal facts
   for BOTH agents, including own disclosures and allowed shared disclosures, with
   stored reasons and source labels. Only user statements and typed personal records
   are candidates; assistant suggestions and public itinerary items are not personal
   facts. Current statements are placed first. The model must resolve conflicts using
   newer corrections and its allowed conversation history.

2. Both agents receive explicit instructions to apply relevant facts to concrete
   recommendations: a visit time, walking distance, activity near the hotel, daily
   pacing, transit connections, lodging or spending priority. They should explain
   a useful fit briefly rather than merely repeat the fact or promise to remember.
   Quietness does not imply slow pacing, a medical need or other unstated traits.
   Irrelevant personal facts should not be forced into direct factual answers.

3. Astra can proactively ask an open-ended practical preference question during
   ordinary planning, without waiting for rejection. Opportunities include an early
   comfortable-day question when a city is known, or an unanswered personal priority
   in the current lodging, transport or spending discussion. Numeric budget amounts
   do not establish spending priorities. These are opportunities tied to the trip,
   not a mandatory multi-topic interview.

4. The pipeline replaces a closed or unrelated question at a selected opportunity
   with one open-ended question. It preserves contextual open-ended wording that fits
   the topic. It still asks at most one question; a rejection why takes priority over
   an additional discovery question. Direct requests, declines, completed approval,
   sensitive causes and requests to proceed are not discovery opportunities.

5. Open-ended practical preference questions participate in the same pacing pause
   as why questions. The next replies can use the answer and advance planning. A
   topic already answered or asked is skipped according to the available records
   and heuristic matching. Brief or unanswered replies do not trigger repeated probes.

6. Memory extraction explicitly interprets short answers to one clear personal
   planning question. For example, food after asking what to prioritize in the budget
   can become a food-spending priority; its reason remains unknown unless supplied.

Examples of intended behavior, not fixed scripts

Astra asks: What does a comfortable day of sightseeing look like for you?
User: One main activity and time to wander.
Astra can then suggest one scheduled morning visit with a flexible afternoon.

Astra asks: What would you most want to make room for in the trip budget?
User: Food, because trying local dishes is the main reason I travel.
Astra can then preserve room for meals when comparing transport and lodging costs.
Sage can use that fact for discovery only if it is available in the current memory
mode. Existing verified cross-agent source mentions remain enabled when relevant.

Scope and limits

The strengthened fact-application rule is model guidance, not a semantic proof that
all suggestions satisfy every preference. No live-model adequacy claim is made.
Question selection, known-topic detection and pacing use text heuristics; unusual
phrasing can still depend on the model. Native realtime speech receives the same
role and curiosity guidance, but does not pass through the pipeline renderer.

Voices, personality values, condition assignment, public-notepad rules, profile
storage, survey questions and survey routing are unchanged. No deployment occurred.

Validation

55 local automated tests passed with mocked API/model replies. They cover proactive
Astra questions, contextual wording, topic reuse and pacing, numeric budgets versus
personal spending priorities, own-source facts and reasons for both agents, source
attribution in both directions, Shared/Separate isolation, short-answer extraction
instructions, and the earlier memory and form behavior. JavaScript, JSON and Python
syntax checks passed. No live conversation or browser speech test was performed.

Run tests with Node 24 or compatible newer Node
node --experimental-vm-modules --test verification/*.test.mjs

Deploy

Copy the included paths into your repository, commit and git push. From worker/,
run npx wrangler deploy. Refresh the website and reconnect existing voice sessions.

Live checks after deployment

- Open Astra after choosing a city. Expect a useful open-ended practical preference
  question when that dimension is unknown and no personal question was just asked.
- Give a preference and reason. Check the next relevant arrangement actually changes
  to fit it, rather than simply saying it will be remembered.
- Check a budget number can be followed by a question about spending priorities,
  without asking the cause of financial circumstances.
- Ask a direct practical question or decline an explanation. Check that Astra answers
  or continues rather than forcing another personal question.
- Share a useful fact with each agent and check the other uses it when relevant in
  Shared mode. Repeat with a fresh Separate participant and check private facts stay
  unavailable. Public trip notes should still prevent repeated itinerary questions.
