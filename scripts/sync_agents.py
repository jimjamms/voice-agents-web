"""Derive web personalities and voices from the supplied desktop Python files."""
import ast
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = ast.parse((root / 'lib/Shifts-and-Giggles/agent_base.py').read_text())
descriptions = next(ast.literal_eval(node.value) for node in base.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'TRAIT_DESCRIPTIONS' for t in node.targets))
guidance = next(ast.literal_eval(node.value) for node in base.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'TRIP_PLANNING_GUIDANCE' for t in node.targets))
handoffs = next(ast.literal_eval(node.value) for node in base.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'HANDOFF_INSTRUCTIONS' for t in node.targets))
WEBSITE_GOAL = """The website planning goal is for the user to confirm at least one country, three cities, and one or two activities total, PLUS a confirmed budget and a finalized practical itinerary. Sage owns destination and activity choices, then hands off to Astra. Astra must confirm a numeric spending limit, currency, and whether it is per person or for the whole trip; establish dates or duration, city order and time allocation, transport between cities and a lodging plan; check an estimated cost breakdown against the budget; and ask the user to explicitly approve the complete itinerary. Estimates must be labeled and actual reservations are not required. Destination choices alone do not complete the trip. If the user changes material trip details after approval, review the revised plan and obtain fresh approval. Help them reach these concrete choices within your own specialty: Sage explores and prioritizes; Astra checks the route and feasibility. If they have chosen fewer than three cities, help choose the remaining cities rather than treating one destination as the final result. Activities are one or two selected activity types or experiences overall, not one or two per city. If they choose more than two, help narrow their priorities. Ask for explicit confirmation of proposed selections, preferably using the actual names, without forcing unnecessary repetition. Never claim that your suggestions are already selected. The website handles progress and the form stage automatically; do not claim to have submitted a form or completed bookings."""
result = {}
for name in ('sage', 'astra'):
    source = ast.parse((root / f'lib/Shifts-and-Giggles/{name}.py').read_text())
    cls = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name.lower() == name + 'agent')
    fields = {}
    for node in cls.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            key = node.targets[0].id
            if key in ('NAME', 'TRAITS', 'OPENAI_VOICE', 'OPENAI_TTS_INSTRUCTIONS', 'TTS_PROVIDER', 'ROLE_INSTRUCTIONS'):
                fields[key] = ast.literal_eval(node.value)
    if fields['TTS_PROVIDER'] != 'openai':
        raise ValueError(f'{name}: web synthesis currently supports OpenAI TTS only')
    trait_block = '\n'.join(f'- {trait.capitalize()}: {descriptions[trait][level]}' for trait, level in fields['TRAITS'].items())
    prompt = f'''You are {fields['NAME']}, a voice assistant with a distinct personality defined by
the following Big Five personality traits:

{trait_block}

Let this personality consistently shape your word choice, tone, sentence
length, energy, and how you react emotionally -- not just what you say, but
how you say it.

You are speaking out loud in a voice conversation, so:
- Keep responses conversational and reasonably concise.
- Never use markdown, bullet points, numbered lists, or asterisks.
- Stay in character at all times.'''
    prompt += '\n\nTrip-planning role:\n' + fields['ROLE_INSTRUCTIONS'] + '\n\n' + guidance + '\n\nWebsite completion goal:\n' + WEBSITE_GOAL
    result[name] = {'name': fields['NAME'], 'prompt': prompt, 'voice': fields['OPENAI_VOICE'], 'instructions': fields['OPENAI_TTS_INSTRUCTIONS'], 'traits': fields['TRAITS'], 'handoff': handoffs}
(root / 'worker/src/pipeline_agents.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')

realtime = {name: {**settings, 'instructions': settings['prompt'] + '\n\nSpeaking style: ' + settings['instructions']} for name, settings in result.items()}
(root / 'worker/src/agents.json').write_text(json.dumps(realtime, indent=2, ensure_ascii=False) + '\n')
