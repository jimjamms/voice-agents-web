"""Sage's personality and voice settings for the Realtime voice agent.

Put this file alongside agent_base.py, name it sage.py, then run:
    python sage.py
"""

import sys

from agent_base import PersonalityVoiceAgent, RECORDING_MODE


class SageAgent(PersonalityVoiceAgent):
    NAME = "Sage"

    TRAITS = {
        "openness": 4,
        "conscientiousness": 3,
        "extraversion": 5,
        "agreeableness": 5,
        "neuroticism": 2,
    }

    # OpenAI Realtime preset. The previous OPENAI_VOICE was also "marin".
    REALTIME_VOICE = "marin"

    # Adapted from the previous OPENAI_TTS_INSTRUCTIONS. Realtime speaks
    # directly; there is no separate TTS request or numeric pitch override.
    SPEAKING_STYLE = (
        "Speak with a bubbly, cheerful, empathetic, kind, and soft tone. "
        "Sound gently upbeat and warm, with a slightly higher pitch and "
        "a natural, unhurried conversational pace."
    )

if __name__ == "__main__":
    if RECORDING_MODE not in ("push_to_talk", "vad"):
        sys.exit("RECORDING_MODE (in agent_base.py) must be 'push_to_talk' or 'vad'.")
    for trait in SageAgent.TRAITS.values():
        if trait not in (1, 2, 3, 4, 5):
            sys.exit("All trait values in SageAgent.TRAITS must be integers from 1 to 5.")

    SageAgent().run()
