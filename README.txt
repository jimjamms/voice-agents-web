Sage and Astra natural follow-up update (v9)

Apply on top of sage-astra-why-and-sharing-update-v8.zip. Copy the included
files into the same paths in your repository. This ZIP contains only changes
since v8, not a complete project.

What changed

- Follow-ups refer to the actual choice instead of falling back to the same
  generic "What drew you to that choice?" line.
- Natural model wording such as "How come quieter cafes appeal to you?" is
  preserved instead of rejected by the previous narrow wording check.
- After a recognized motivation question, the pipeline leaves the next two
  replies for applying the answer or planning, rather than asking another why.
  Normal practical questions remain possible. Shared-mode pacing also considers
  recent supplied exchanges with the other agent; Separate mode uses own history.
- If the available history shows that a preference was already followed by a
  why question, overlapping preference wording does not trigger another probe,
  even if the user never supplied an explanation. This matching is heuristic,
  not a complete semantic equivalence check.
- Exact repeated questions in recent own-agent history are suppressed. A useful
  observation, answer or suggestion can stand alone without a question.
- Persona and round prompts discourage repeated acknowledgments, automatic
  questioning of every minor selection, and synonymous rewordings of the same
  why. They tell agents to use the reason in a concrete trip decision instead.
- Direct user questions do not force the pipeline to ask why back at the user.
- Shared-memory source validation, visible relevant source mentions, memory
  storage, personality values, voices and survey behavior are preserved.

Examples of intended wording (model wording can vary)

User to Sage: I prefer quiet places.
Sage: A tucked-away garden could fit. What do you enjoy about a quieter setting?

User: Crowds wear me out.
Sage: We could visit the garden early, before the busiest part of the day.

User to Astra: No museums on day 2.
Astra: We can take them out. What puts you off museums?

User: I get bored indoors.
Astra: An outdoor market and a riverside walk would keep that day mostly outside.

Deployment

1. Copy the included files into their matching repository paths.
2. From the repository root, commit and push the changes.
3. From the worker directory, run npx wrangler deploy.
4. Refresh the website and reconnect existing voice sessions.

The text/recorded-voice pipeline checks pacing and question repetition in code.
Native realtime speech receives the revised prompt instructions, but its spoken
output does not pass through that renderer. Realtime compliance is model-dependent.

Validation

39 local automated tests passed using mocked API/model replies. Includes natural
wording preservation, pacing, repeat suppression, topic-specific fallbacks, direct
questions, both source directions, both memory conditions, delayed extraction,
existing memory persistence and survey behavior. JavaScript, JSON and Python
syntax checks passed. No deployment or live model/voice conversation was performed.

Tests, with Node 24 or a compatible newer Node
node --experimental-vm-modules --test verification/*.test.mjs

Live checks after deployment

Give a meaningful preference without a reason, answer the follow-up, and keep
planning. Expect one contextual follow-up followed by practical use of the answer,
not another why immediately. Revisit the same preference later and check that it
does not start a second interview. Check both agents and both typed and voice modes.
Confirm that relevant source mentions still occur in Shared mode and that private
cross-agent facts remain unavailable in Separate mode.
