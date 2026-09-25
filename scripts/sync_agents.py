"""Derive web personalities and voices from the supplied desktop Python files."""
import ast
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = ast.parse((root / 'desktop/agent_base.py').read_text())
descriptions = next(ast.literal_eval(node.value) for node in base.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'TRAIT_DESCRIPTIONS' for t in node.targets))
result = {}
for name in ('sage', 'astra'):
    source = ast.parse((root / f'desktop/{name}.py').read_text())
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
    result[name] = {'name': fields['NAME'], 'prompt': prompt, 'voice': fields['OPENAI_VOICE'], 'instructions': fields['OPENAI_TTS_INSTRUCTIONS']}
(root / 'worker/src/agents.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
