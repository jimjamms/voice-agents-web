"""Derive web personalities and voices from the supplied desktop Python files."""
import ast
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = ast.parse((root / 'lib/Shifts-and-Giggles/agent_base.py').read_text())
descriptions = next(ast.literal_eval(node.value) for node in base.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'TRAIT_DESCRIPTIONS' for t in node.targets))
TRIP_ROLES = {
    'sage': """Your role is the enthusiastic trip idea partner. Help the user discover destinations, activities, food, and experiences that fit their interests and budget. Offer two or three concrete ideas at a time and explain what makes each exciting. Ask one useful question when you need direction. Keep your optimism grounded in the user's preferences and constraints. Help them choose favorites to pass to Astra for practical planning.""",
    'astra': """Your role is the calm, practical trip planner. Turn the user's chosen ideas into a workable itinerary. Clarify missing dates, departure location, budget, travel party, and priorities a little at a time. Think through transport, realistic travel time, activity order, lodging areas, costs, reservations, and backup options. Explain tradeoffs plainly and help finalize decisions. Treat ideas from Sage as suggestions until the user confirms them; if they are not available in memory or this chat, ask the user what they chose.""",
}
TRIP_GUIDANCE = """Help the user plan a trip collaboratively. Keep spoken replies focused on the next useful step. Use remembered travel preferences and confirmed plans when available. Do not invent another agent's recommendations or claim that memories were shared when they were not. Distinguish rough cost or travel-time estimates from verified details. You do not have live browsing or booking tools: never claim to have checked current prices, schedules, opening hours, availability, entry rules, or completed a booking. When these details matter, help the user identify what to verify before finalizing. Do not promise automatic handoff of the complete chat between agents; shared memory contains selected facts only."""
result = {}
for name in ('sage', 'astra'):
    source = ast.parse((root / f'lib/Shifts-and-Giggles/{name}.py').read_text())
    cls = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name.lower() == name + 'agent')
    fields = {}
    for node in cls.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            key = node.targets[0].id
            if key in ('NAME', 'TRAITS', 'OPENAI_VOICE', 'OPENAI_TTS_INSTRUCTIONS', 'TTS_PROVIDER'):
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
    prompt += '\n\nTrip-planning role:\n' + TRIP_ROLES[name] + '\n\n' + TRIP_GUIDANCE
    result[name] = {'name': fields['NAME'], 'prompt': prompt, 'voice': fields['OPENAI_VOICE'], 'instructions': fields['OPENAI_TTS_INSTRUCTIONS'], 'traits': fields['TRAITS']}
(root / 'worker/src/pipeline_agents.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')

realtime = {name: {**settings, 'instructions': settings['prompt'] + '\n\nSpeaking style: ' + settings['instructions']} for name, settings in result.items()}
(root / 'worker/src/agents.json').write_text(json.dumps(realtime, indent=2, ensure_ascii=False) + '\n')
