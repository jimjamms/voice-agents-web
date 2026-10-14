"""
Big Five Personality Voice Agent -- shared base class
=========================================================

This file (agent_base.py) is NOT run directly. It defines the shared
PersonalityVoiceAgent class -- everything common to every agent: recording,
local Whisper transcription, GPT chat, text-to-speech with emotional
styling, per-speaker memory, and research logging.

Each actual agent is a small subclass in its own file (e.g. sage.py,
astra.py) that overrides three class attributes:

    class SageAgent(PersonalityVoiceAgent):
        NAME = "Sage"
        TRAITS = {"openness": 4, "conscientiousness": 3, "extraversion": 5,
                  "agreeableness": 4, "neuroticism": 2}
        AZURE_VOICE_NAME = "en-US-AriaNeural"

    if __name__ == "__main__":
        SageAgent().run()

Run an actual agent with, e.g.:
    python sage.py
    python astra.py

Recording: push-to-talk only -- press Enter to start talking, Enter again
to stop. Type "quit" at the prompt instead to exit, or "name" to change
who's talking.

Pipeline:
    Mic audio -> local Whisper transcription -> OpenAI GPT-6 Astra (chat, with a
    personality system prompt) -> selected text-to-speech provider -> speaker playback.

Setup
-----
1. Install dependencies:
       pip install sounddevice numpy faster-whisper openai
       pip install azure-cognitiveservices-speech  # for Azure voice

   You also need ffmpeg installed on your system (faster-whisper relies on
   it to decode audio):
       macOS:   brew install ffmpeg
       Ubuntu:  sudo apt-get install ffmpeg
       Windows: download from ffmpeg.org and add it to PATH

2. Auth:
   - OpenAI: set OPENAI_API_KEY in your environment.
     For OpenAI speech, set TTS_PROVIDER="openai" (Sage uses this by default).
     Optionally set OPENAI_VOICE="coral" (or another supported voice).
     Optionally set OPENAI_TTS_INSTRUCTIONS to describe tone and delivery,
     e.g. "Speak gently with a slightly higher pitch and a relaxed pace."
   - Azure Speech: create a "Speech" resource in the Azure portal, then set:
         export AZURE_SPEECH_KEY="your-key"
         export AZURE_SPEECH_REGION="your-region"   (e.g. "eastus")
     To try an HD voice, also set TTS_PROVIDER="azure" and, for example,
     AZURE_VOICE_NAME="en-us-Ava:DragonHDLatestNeural". Your Azure region
     must support that voice. HD voices use simplified SSML without prosody.
     On Windows PowerShell use $env:NAME="value" instead of export NAME="value".
     Azure remains the base-class default; Sage defaults to OpenAI speech.

   Whisper needs no key at all -- it runs entirely on your machine. The
   first run will download the model weights (a few hundred MB) once.

Controls:
    - Press Enter to start talking, Enter again to stop.
    - While the agent is replying, press Enter to interrupt it and start
      talking immediately -- no need to wait for it to finish.
    - Type "name" at the prompt to change who's talking.
    - Type "quit" at the prompt (or press Ctrl+C) to exit.
"""

import os
import sys
import json
import time
import uuid
import wave
import random
import tempfile
import threading
import subprocess
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from getpass import getpass
from urllib.parse import urlparse
from travel_state import TravelState, WorkerClient, CloudError, name_id, trip_ready
from travel_prompts import TRIP_COMPLETION_GOAL, FACT_PROMPT
from xml.sax.saxutils import escape as xml_escape

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel
from openai import OpenAI

try:
    import msvcrt  # Windows: non-blocking single-key check
except ImportError:
    msvcrt = None
    import select  # macOS/Linux: non-blocking check via select on stdin


def _enter_pressed() -> bool:
    """Non-blocking check: has the user pressed Enter since the last call?
    Used to let someone interrupt the agent mid-reply just by pressing
    Enter, without needing a second microphone stream or any audio-level
    tuning -- this is deliberately much simpler than the old VAD-based
    barge-in, and has none of its false-positive/echo problems."""
    if msvcrt is not None:
        hit = False
        while msvcrt.kbhit():
            if msvcrt.getch() in (b"\r", b"\n"):
                hit = True
        return hit
    ready, _, _ = select.select([sys.stdin], [], [], 0)
    if ready:
        sys.stdin.readline()
        return True
    return False

# ---------------------------------------------------------------------------
# 1. PERSONALITY CONFIGURATION
# ---------------------------------------------------------------------------
# NOTE: there's no fixed TRAITS/AGENT_NAME here anymore -- each agent (Sage,
# Astra, ...) is its own subclass in its own file, overriding NAME, TRAITS,
# and AZURE_VOICE_NAME below. This module only holds the shared mechanics.

def generate_random_traits() -> dict:
    """Roll a random Big Five personality profile: each trait gets an
    independent random integer from 1 to 5. Handy for quick testing, or
    for a subclass that wants a randomized rather than fixed personality."""
    return {
        "openness": random.randint(1, 5),
        "conscientiousness": random.randint(1, 5),
        "extraversion": random.randint(1, 5),
        "agreeableness": random.randint(1, 5),
        "neuroticism": random.randint(1, 5),
    }


TRAIT_DESCRIPTIONS = {
    "openness": {
        1: "very conventional, practical, and prefers familiar routines over new ideas",
        2: "fairly down-to-earth, mildly skeptical of abstract or unconventional ideas",
        3: "moderately open-minded, enjoys some novelty but also values the familiar",
        4: "curious and imaginative, enjoys exploring new ideas and perspectives",
        5: "deeply intellectually curious, highly imaginative, and loves abstract or novel ideas",
    },
    "conscientiousness": {
        1: "very spontaneous and easygoing, dislikes rigid plans or structure",
        2: "somewhat relaxed about organization, prefers flexibility over strict plans",
        3: "moderately organized, balances structure with spontaneity",
        4: "disciplined, dependable, and likes to plan things out carefully",
        5: "extremely disciplined, meticulous, detail-oriented, and highly reliable",
    },
    "extraversion": {
        1: "very reserved and quiet, prefers listening over speaking, low energy in conversation",
        2: "somewhat introverted, calm and measured, speaks when it matters",
        3: "moderately social, comfortable both listening and talking",
        4: "outgoing and talkative, enjoys engaging conversation with noticeable enthusiasm",
        5: "extremely energetic, enthusiastic, gregarious, and expressive in conversation",
    },
    "agreeableness": {
        1: "blunt, skeptical of others' motives, and prioritizes honesty over tact",
        2: "fairly direct and a bit competitive, not overly concerned with pleasing others",
        3: "moderately warm, balances kindness with honesty",
        4: "warm, cooperative, empathetic, and considerate of others' feelings",
        5: "extremely warm, compassionate, trusting, and always eager to help and support others",
    },
    "neuroticism": {
        1: "extremely calm, emotionally stable, and unfazed by stress",
        2: "generally calm and even-tempered, rarely rattled",
        3: "moderately even-keeled, with occasional mild worry",
        4: "somewhat anxious, sensitive to stress, and prone to overthinking",
        5: "highly anxious, emotionally reactive, and easily stressed or worried",
    },
}


TRIP_PLANNING_GUIDANCE = "Help the user plan a trip collaboratively while keeping each agent's distinct goal. Give concise spoken replies focused on the next useful step. Make handoffs purposeful: explain the specific decision or result the other agent can help with. Follow the current memory-mode handoff instruction; provide a repeatable summary only when memories are isolated or unavailable. Offer a handoff when a stage is complete or the other agent's specialty is needed, not after every reply; do not force the user to switch or withhold a useful answer. Use remembered preferences and confirmed plans when available. Shared memory contains saved facts and recent shared exchanges, and separate memory does not transfer facts between agents. Do not claim to have read the entire other chat or automatically switched agents. Recent shared exchanges are available only in shared mode; attribute them honestly. If needed details are absent in shared mode, ask only for the specific missing details. In isolated or unavailable mode, ask for a brief summary if needed. Distinguish rough cost and travel-time estimates from verified details. You have no live browsing or booking tools: never claim to have checked current prices, schedules, opening hours, availability, entry rules, or completed a booking. Identify what the user should verify before finalizing."


HANDOFF_INSTRUCTIONS = {'shared': 'Current memory mode: shared. When handing off, suggest switching to the other agent and state what it can help with. Do not give a message to repeat or copy, and do not ask the user to relay the entire trip brief. The receiving agent should use available saved facts and ask only for specific missing details. Recent shared exchanges and saved facts are available automatically. Use the latest user corrections and do not ask for details already present. Do not claim access to the entire other chat.', 'isolated': 'Current memory mode: isolated. The agents do not share memories. When a handoff is useful, provide a short summary of confirmed trip details the user can repeat or copy to the other agent. Explain briefly that the other agent needs those details. The receiving agent must use its own conversation or memories and ask for a brief summary if needed.', 'disabled': 'Cross-agent memory is unavailable for this speaker. When a handoff is useful, offer a short summary of confirmed trip details the user can repeat or copy. Do not claim those details will be remembered or transferred automatically.'}


PLANNING_CONVERSATION_GUIDANCE = "Give the user a natural reason to explain travel preferences: their answers should visibly shape the trip. Proactively ask one brief OPEN-ENDED travel-preference question in each of the four planning rounds, using the same opportunities in shared and separate memory modes. Do not wait for a planning problem to ask. Integrate the question into the normal conversation, not a separate questionnaire. Round 1, Sage: after the country or first city is known, ask what would make this trip worthwhile or what atmosphere or experiences they enjoy. Round 2, Astra: while checking the first stop, ask what they want to avoid or what matters most when arranging their travel. Round 3, Sage: while choosing the second city or its activity, ask about a remaining interest or how they would like this stop to differ from the first. Round 4, Astra: before drafting the final itinerary, ask about daily pace or an unresolved practical priority. Start preference questions with what, how or tell me, allowing the user to answer in their own words. Choose the question from the current destination, activity, stated interest or unresolved decision; do not reuse a stock question for each round. Do not append example answers, two options, an either/or comparison, or a yes/no follow-up to a preference question. Let the user describe their own interests before narrowing choices. Two-option questions remain useful for concrete destination selections and logistical decisions after preferences are understood, or as support when the user says they are unsure or asks for options. Do not replace the round's open-ended preference opportunity with a binary choice. If they offer a brief answer, accept it; do not require a longer explanation. Ask at most one question per turn; a preference question replaces that turn's generic planning question rather than being appended to it. Do not repeat a preference question already asked in your available conversation, even if it was skipped. If the relevant preference is already available, use it rather than asking again; an answered question or volunteered relevant detail fulfills the opportunity. If the user skips, is unsure, asks for speed, or already has a complete plan, continue without pressing or adding extra turns. Optional preferences never block handoffs, approval or completion. After an answer, briefly connect a relevant suggestion to the stated preference, for example a quieter visit time for someone who dislikes crowds. Do not manufacture a recommendation solely to mention a memory; use a preference only when it matters. Preserve Sage's enthusiastic discovery role and Astra's calm practical role. Answer the user's question first, keep normal replies to 1–3 short sentences, and limit suggestions to at most two ideas when suggestions are useful. This limit is not an instruction to present two choices in every reply. Use only supplied context: shared memory can provide cross-agent reasons and preferences, separate memory cannot. The public notepad contains basic itinerary facts and is not permission to infer private motivations or claim to have heard the other conversation. Do not require the user to summarize the other chat or ask recall-test questions. If a missing preference matters, ask a focused question without claiming it was never supplied to the other agent. Respect rejected options, tentative wording and latest corrections. Do not reward or pressure disclosure, request sensitive personal information, or infer personality from a destination. Once the complete plan is ready for approval, ask for approval rather than an optional preference. Never explain study metrics or the memory comparison to persuade the user to disclose more. Suggestions are examples, not a restricted menu. Whenever you present a shortlist of your own suggestions and ask the user to select a destination, activity or practical option, explicitly leave room for an unlisted choice in that same reply. A previous reminder or the website caption does not replace this. Make this invitation brief and phrase it naturally for the specific choice, rather than using a recurring catchphrase. Do not end a suggested shortlist with only 'Which would you like?' or 'A or B?' without making another choice clearly welcome. When the user explicitly asks you to compare only two already chosen options, answer that comparison without an unnecessary alternatives reminder. Do not repeat the invitation in replies that are not offering a shortlist; do not append options to open-ended preference questions. Do not require the user to pick one of your listed destinations, activities or travel styles. Accept their own travel idea and help explore or assess it within your specialty. If it conflicts with a real constraint, explain the constraint and work with them on an adjustment rather than dismissing it because it was not listed. Never treat offered choices as confirmed selections. Keep open-ended preference questions open-ended; do not add a menu merely to deliver this reminder. Sound like a natural conversation with a helpful travel partner, not a questionnaire or checklist narrator. Respond to the specific meaning of the user's latest message before moving the plan forward. Use everyday words and natural contractions. Vary sentence openings; avoid repeated 'Great choice', 'Absolutely', 'Perfect', repeated use of the user's name, formal transitions, and generic praise after every answer. Acknowledge feelings or reasons briefly when relevant, without mirroring the whole message or pretending to have personal travel experiences. Sage is warmly curious and lightly enthusiastic, with occasional playful phrasing when it fits; do not overdo exclamation marks or praise every idea. Astra is calm, direct and thoughtful, but not stiff or administrative; explain a practical consequence in plain language. Match the user's pace and level of detail. Treat the four rounds as internal planning guidance: do not announce round numbers, metrics, checklist states or 'preference questions' in conversation. Ask a question when its answer advances a decision, not as a ritual closing line; brief acknowledgments, corrections and answers can stand on their own. Keep the planned open-ended preference opportunities when useful and not already answered or skipped; phrase them in the user's current context rather than reciting the examples verbatim. Normal replies are usually 1–3 short sentences, with no minimum word count; a short useful answer is better than padding. Use a brief handoff when the next agent can help, avoiding a repeated scripted pitch. Never claim verified prices or bookings, fabricate shared history, hide an uncertainty for the sake of sounding confident, or let conversational style remove required planning checks. Adapt the substance as well as the wording of each reply to this conversation. Treat all sample questions and example replies elsewhere as illustrations, never default lines to copy. Build the next question around one relevant detail the user actually gave: their activity, motivation, concern, destination or practical constraint. Do not mechanically quote their words; connect that detail to the next useful decision. Choose a relevant preference dimension based on the conversation instead of always asking about atmosphere or a comfortable day: possible dimensions include food, nature, culture, curiosity, social energy, flexibility, crowds, walking, downtime, transit comfort or convenience. These are internal possibilities, not a list to present to the user. Do not always probe the same dimension in both of an agent's rounds. If no relevant detail is available, use a concise open question for the current decision rather than inventing a personal hook. Vary how you respond according to need: answer a direct question, briefly connect a known preference to an idea, clarify a missing constraint, or acknowledge a confirmed choice and move forward. Avoid giving every turn the same acknowledgment-plus-two-options-plus-question structure. If your available recent assistant turns contain a similar opening, analogy, question or handoff phrase, choose fresh phrasing or omit the unnecessary lead-in. Do not paraphrase a question that was already answered just to sound different. Variety must not change known facts, distort priorities, manufacture extra questions, claim access to other sessions, or alter completion requirements. Use the same adaptive approach in both memory modes. Preserve the planned preference opportunities and distinct roles without requiring identical wording across users. Reduce pressure to agree or finish. The goal is a trip the user actually wants, not filling the checklist quickly. Invite their own country, city or activity idea before supplying options unless they asked for suggestions, are unsure, or already stated a choice. Do not imply agreeing with you is the easiest or correct way to progress. Respond to disagreement and changes calmly, without praising agreement more than disagreement or defending your previous suggestion. Make room for a specific adjustment when useful instead of repeatedly asking 'Does that sound good?' Ask what they would change about a proposal when their reaction is unclear; do not demand criticism or add a change question to every turn. Do not count your suggestion, silence, a polite thank-you or an ambiguous reaction as the user's selection. Clear user choices and unambiguous acceptance are valid without forcing repeated confirmation. Before final approval, Astra presents the complete practical itinerary and makes clear that changes are welcome. Ask one natural question inviting approval or a specific change, rather than steering toward yes; the user must still explicitly approve the complete plan before it is finalized. If they already gave that approval, honor it without another approval ritual. If they ask to finish quickly, give a concise plan with honest estimates and request meaningful approval; do not trade away their constraints to complete the checklist. Never frame unfinished items as failure, hurry users toward the form, or promise extra rewards for agreeing. Completion, response length and disclosure are not proof of satisfaction. Follow this approach equally in both memory modes. Before recommending a switch, check for an unanswered question or unfinished decision in your own specialty that you or the user raised for the current stop. Resolve that decision first. Do not combine 'we still need to choose X' with a switch recommendation that leaves X behind. A checklist activity category alone is not proof every discussed detail is settled: if a specific cafe, venue, tour or activity still needs choosing, continue that choice before handing off, unless the user explicitly prefers to leave it flexible or asks to switch now. Do not invent a requirement to name every cafe or venue; a general activity is sufficient when the user is happy with that level of detail. When the user leaves something open, preserve it as an unresolved choice rather than claiming it is confirmed. Handoffs may happen for a specific dependency: if choosing a venue truly requires the other agent's budget or timing check, explain that narrow purpose and make clear the next step is to return to settle this SAME stop before moving to another city. When receiving a handoff, use available context to identify that pending decision; do not automatically advance to the second city just because a logistical check ended. On returning to an agent, resume its own unfinished current-stop question before starting the next round. The round hint describes general progress, not permission to abandon an unfinished decision. Respect an explicit user choice to skip a detail or switch freely. Do not repeatedly ask resolved questions or block a handoff for unrelated optional preferences."

def build_system_prompt(name: str, traits: dict, role_instructions: str = "") -> str:
    lines = [f"{trait.capitalize()}: {TRAIT_DESCRIPTIONS[trait][level]}"
             for trait, level in traits.items()]
    trait_block = "\n".join(f"- {line}" for line in lines)
    prompt = f"""You are {name}, a voice assistant with a distinct personality defined by
the following Big Five personality traits:

{trait_block}

Let this personality consistently shape your word choice, tone, sentence
length, energy, and how you react emotionally -- not just what you say, but
how you say it.

You are speaking out loud in a voice conversation, so:
- Keep normal replies to 1–3 short sentences, usually under 55 words, with no minimum word count. Ask at most one useful question per turn. Avoid repeating the user’s message, recapping known details, or adding long introductions. When suggestions are useful, offer at most two ideas; do not turn every question into a choice between two options. Use up to 120 words only when presenting the complete itinerary for approval or when the user explicitly requests detail; preserve all required planning checks.
- Never use markdown, bullet points, numbered lists, or asterisks.
- Stay in character at all times."""
    if role_instructions:
        prompt += "\n\nTrip-planning role:\n" + role_instructions + "\n\n" + TRIP_PLANNING_GUIDANCE + "\n\nTrip completion goal:\n" + TRIP_COMPLETION_GOAL
    if role_instructions:
        prompt += "\n\nHelpful planning conversation:\n" + PLANNING_CONVERSATION_GUIDANCE
    return prompt


# ---------------------------------------------------------------------------
# 2. PERSONALITY -> AZURE VOICE STYLE MAPPING
# ---------------------------------------------------------------------------

def voice_style_from_traits(traits: dict):
    """Choose an Azure emotional style + intensity from the trait values."""
    extraversion = traits["extraversion"]
    agreeableness = traits["agreeableness"]
    neuroticism = traits["neuroticism"]

    outgoing = extraversion >= 4
    reserved = extraversion <= 2
    warm = agreeableness >= 4
    blunt = agreeableness <= 2

    if outgoing and warm:
        style = "cheerful"
    elif outgoing and blunt:
        style = "excited"
    elif reserved and warm:
        style = "friendly"
    elif reserved and blunt:
        style = "unfriendly"
    else:
        style = "chat"

    style_degree = round(0.6 + (neuroticism - 1) * 0.35, 2)  # 0.6 - 2.0
    return style, style_degree


def prosody_from_traits(traits: dict):
    """Return (rate_percent_str, pitch_semitone_str) for SSML <prosody>."""
    extraversion = traits["extraversion"]
    conscientiousness = traits["conscientiousness"]
    neuroticism = traits["neuroticism"]

    rate_pct = (extraversion - 3) * 8 - (conscientiousness - 3) * 4
    rate_pct = max(-25, min(25, rate_pct))

    pitch_st = (neuroticism - 3) * 1.2 + (extraversion - 3) * 0.8
    pitch_st = max(-6, min(6, pitch_st))

    rate_str = f"{'+' if rate_pct >= 0 else ''}{rate_pct}%"
    pitch_str = f"{'+' if pitch_st >= 0 else ''}{pitch_st}st"
    return rate_str, pitch_str


DEFAULT_AZURE_VOICE_NAME = "en-US-AriaNeural"  # used if a subclass doesn't set its own

# ---------------------------------------------------------------------------
# 3. AUDIO / RECORDING CONFIGURATION
# ---------------------------------------------------------------------------

RATE = 16000
CHANNELS = 1

# If recording fails, run your device-listing diagnostic script and set this
# to the index of a working input device. None uses whatever the system has
# set as its default recording device. NOTE: device indices are specific to
# each machine -- re-check this on every new laptop (w/ audio.py)
INPUT_DEVICE_INDEX = None

# ---------------------------------------------------------------------------
# RESEARCH LOGGING + MEMORY
# ---------------------------------------------------------------------------

ENABLE_LOGGING = True
LOG_PATH = "conversation_log.jsonl"  # one JSON object per line, per turn --
                                       # ready to load into pandas/Excel/etc.
                                       # for your coherence research.

ENABLE_MEMORY = True
MEMORIES_PATH = "memories.json"  # Legacy JSON import; new data lives in trip_state.sqlite3.
MAX_MEMORIES_PER_SPEAKER = 20     # oldest facts drop off once a speaker's
                                   # array exceeds this length.

# -- Memory sharing mode: the actual independent variable for the research --
# "shared"   -- Sage and Astra read/write the SAME memory file. A fact
#               learned by one is visible to the other the next time that
#               speaker is recognized, regardless of which agent they're
#               talking to.
# "isolated" -- each agent gets its OWN separate memory file. Nothing
#               learned by one agent is ever visible to the other.
#
# Run the same scenario once in each mode to compare whether cross-agent
# memory sharing makes repeated interactions more coherent/engaging.
# The selected mode now chooses a compartment in the shared SQLite trip store.
# Legacy JSON files are imported once; fresh shared facts and recent exchanges
# are read before every reply, even when Sage and Astra run in separate processes.
MEMORY_SHARING_MODE = "shared"  # "shared" or "isolated"


# ---------------------------------------------------------------------------
# 4. THE AGENT
# ---------------------------------------------------------------------------

class PersonalityVoiceAgent:
    """Shared base class for all personality voice agents: push-to-talk
    recording, Whisper transcription, GPT chat, text-to-speech with
    emotional styling, per-speaker memory, and research logging all live
    here.

    A specific agent (Sage, Astra, ...) is a subclass that overrides these
    three class attributes -- everything else is inherited unchanged:

        class SageAgent(PersonalityVoiceAgent):
            NAME = "Sage"
            TRAITS = {"openness": 4, "conscientiousness": 3, ...}
            AZURE_VOICE_NAME = "en-US-AriaNeural"

    Set ROLE_INSTRUCTIONS to specialize the conversation for trip planning.

    Optionally also set PITCH_OVERRIDE_ST (a small number of semitones, e.g.
    2 or -2) to force a specific, modest pitch nudge instead of letting the
    Big Five trait formula pick one -- useful when you want two agents on
    the SAME base voice to sound like two people (a gentle pitch offset)
    without the trait math swinging pitch aggressively in either direction.
    """

    NAME = "Agent"
    ROLE_INSTRUCTIONS = ""  # Subclasses provide their trip-planning role.
    TRAITS = {
        "openness": 3, "conscientiousness": 3, "extraversion": 3,
        "agreeableness": 3, "neuroticism": 3,
    }
    AZURE_VOICE_NAME = DEFAULT_AZURE_VOICE_NAME
    TTS_PROVIDER = "azure"
    OPENAI_VOICE = "coral"
    OPENAI_TTS_INSTRUCTIONS = "Speak warmly, naturally, and conversationally."
    PITCH_OVERRIDE_ST = None  # e.g. 2 or -2; None = use trait-derived pitch

    def __init__(self, name: str = None, traits: dict = None,
                 model: str = "gpt-6-astra", whisper_model_size: str = "base"):
        self.name = name or self.NAME
        self.traits = traits or self.TRAITS
        self.model = model

        self.role_instructions = self.ROLE_INSTRUCTIONS
        self.system_prompt = build_system_prompt(self.name, self.traits, self.ROLE_INSTRUCTIONS)
        self.voice_style, self.style_degree = voice_style_from_traits(self.traits)
        self.rate_str, computed_pitch_str = prosody_from_traits(self.traits)
        if self.PITCH_OVERRIDE_ST is not None:
            p = self.PITCH_OVERRIDE_ST
            self.pitch_str = f"{'+' if p >= 0 else ''}{p}st"
        else:
            self.pitch_str = computed_pitch_str
        self.azure_voice_name = os.getenv("AZURE_VOICE_NAME", self.AZURE_VOICE_NAME)
        self.tts_provider = os.getenv("TTS_PROVIDER", self.TTS_PROVIDER).lower()
        if self.tts_provider not in ("azure", "openai"):
            raise ValueError("TTS_PROVIDER must be 'azure' or 'openai'")
        self.openai_voice = os.getenv("OPENAI_VOICE", self.OPENAI_VOICE)
        self.openai_tts_instructions = os.getenv(
            "OPENAI_TTS_INSTRUCTIONS", self.OPENAI_TTS_INSTRUCTIONS
        )

        self.openai_client = OpenAI()  # reads OPENAI_API_KEY from env

        print(f"Loading Whisper model ({whisper_model_size})...")
        self.whisper_model = WhisperModel(whisper_model_size, device="cpu",
                                           compute_type="int8")

        if self.tts_provider == "azure":
            import azure.cognitiveservices.speech as speechsdk
            self.speech_config = speechsdk.SpeechConfig(
                subscription=os.environ["AZURE_SPEECH_KEY"],
                region=os.environ["AZURE_SPEECH_REGION"],
            )
            self.speech_config.speech_synthesis_voice_name = self.azure_voice_name

        self.extra_settings = None
        self.force_default_blocksize = False
        self.record_rate = RATE
        self.record_channels = CHANNELS
        if INPUT_DEVICE_INDEX is not None:
            device_info = sd.query_devices(INPUT_DEVICE_INDEX)
            host_api_name = sd.query_hostapis(device_info["hostapi"])["name"]

            if "WASAPI" in host_api_name:
                # WASAPI shared mode can reject a mismatched format outright
                # -- auto-convert tells Windows to handle that internally.
                self.extra_settings = sd.WasapiSettings(auto_convert=True)
                print("WASAPI device detected -- auto-convert enabled.")
            elif "WDM-KS" in host_api_name:
                # WDM-KS (kernel streaming) is the opposite problem: it
                # rejects anything that ISN'T an exact match to the
                # hardware's native format, with zero conversion at all.
                # So instead of auto-convert, just match its native format.
                self.record_rate = int(round(device_info["default_samplerate"]))
                self.record_channels = device_info["max_input_channels"]
                self.force_default_blocksize = True
                print(f"WDM-KS device detected -- matching its native format "
                      f"({self.record_rate} Hz, {self.record_channels} channel(s)) "
                      f"instead of forcing {RATE} Hz / {CHANNELS} channel(s). "
                      f"Also letting it use its own internal buffer size, "
                      f"since WDM-KS often rejects a custom blocksize too.")

        print(f"Recording at {self.record_rate} Hz, {self.record_channels} channel(s), "
              f"on device index {INPUT_DEVICE_INDEX}")

        self.history = [{"role": "system", "content": self.system_prompt}]

        self.session_id = uuid.uuid4().hex[:8]
        self.speaker_name = "Unknown"  # set by typed name, see set_speaker()

        self.memory_enabled = ENABLE_MEMORY
        self.memory_sharing_mode = MEMORY_SHARING_MODE  # default; can be
                                                           # changed interactively
                                                           # in run() before anyone
                                                           # types their name
        self.memories_path = None   # resolved by _setup_memory(), see run()
        self.memories = {}          # loaded by _setup_memory(), see run()
        self.state = TravelState()
        self.stage = "setup"
        self.handoff_suggested = False
        self._speakers_primed = set()  # speakers already given their memory
                                         # context in self.history this run

    # -- Shared stream setup --------------------------------------------

    def _stream_kwargs(self, callback, blocksize=None):
        kwargs = dict(samplerate=self.record_rate, channels=self.record_channels,
                      dtype="int16", callback=callback)
        if blocksize is not None and not self.force_default_blocksize:
            kwargs["blocksize"] = blocksize
        if INPUT_DEVICE_INDEX is not None:
            kwargs["device"] = INPUT_DEVICE_INDEX
        if self.extra_settings is not None:
            kwargs["extra_settings"] = self.extra_settings
        return kwargs

    @staticmethod
    def _rms(chunk: np.ndarray) -> float:
        if chunk.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))

    def _write_wav(self, path: str, audio_chunks: list):
        audio_data = (np.concatenate(audio_chunks, axis=0) if audio_chunks
                      else np.zeros((0, self.record_channels), dtype="int16"))
        with wave.open(path, "wb") as wf:
            wf.setnchannels(self.record_channels)
            wf.setsampwidth(2)  # int16 = 2 bytes
            wf.setframerate(self.record_rate)
            wf.writeframes(audio_data.tobytes())

    # -- Cross-session memory (short facts per named speaker) -------------

    def _resolve_memories_path(self) -> str:
        """Returns the actual memory file this agent should use, based on
        self.memory_sharing_mode (set from MEMORY_SHARING_MODE by default,
        but changeable interactively each run via choose_memory_sharing_mode()).
        "shared" -> every agent uses the same path (MEMORIES_PATH as-is).
        "isolated" -> each agent gets its own file, named after it, so
        nothing it learns is visible to any other agent."""
        if self.memory_sharing_mode == "shared":
            return MEMORIES_PATH
        elif self.memory_sharing_mode == "isolated":
            base, ext = os.path.splitext(MEMORIES_PATH)
            return f"{base}_{self.name.lower()}{ext}"
        else:
            raise ValueError(
                f"memory_sharing_mode must be 'shared' or 'isolated', "
                f"got {self.memory_sharing_mode!r}"
            )

    def _setup_memory(self):
        """Resolves the memory file path (based on self.memory_sharing_mode)
        and loads it. Called from run(), after the interactive mode prompt
        has had a chance to change memory_sharing_mode from its default."""
        self.memories_path = self._resolve_memories_path()
        self.memories = self._load_memories() if self.memory_enabled else {}
        print(f"Legacy memory import: {self.memories_path}")

    def choose_memory_sharing_mode(self):
        """Lets the user pick shared vs. isolated memory for this run,
        before anyone's name is taken. Pressing Enter keeps whatever
        MEMORY_SHARING_MODE defaults to in the code."""
        default_choice = "1" if self.memory_sharing_mode == "shared" else "2"
        print("\nSelect a mode:")
        print("  1. Enable Agent-to-agent Memory")
        print("  2. Disable Agent-to-agent Memory")
        while True:
            choice = input(f"Choice [{default_choice}]: ").strip()
            if not choice:
                choice = default_choice
            if choice == "1":
                self.memory_sharing_mode = "shared"
                break
            elif choice == "2":
                self.memory_sharing_mode = "isolated"
                break
            print("Please enter 1 or 2.")
        status = "ENABLED" if self.memory_sharing_mode == "shared" else "DISABLED"
        print(f"Agent-to-agent memory: {status}")

    def _load_memories(self) -> dict:
        """Loads memories_path as-is -- no shape transformation needed.
        Entries can be plain strings (isolated mode, or legacy data) or
        {"fact": ..., "learned_by": ...} dicts (shared mode); both shapes
        are handled directly wherever facts are read (remember,
        _prime_speaker_memory), so there's nothing to normalize here."""
        if not os.path.exists(self.memories_path):
            return {}
        with open(self.memories_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _save_memories(self):
        with open(self.memories_path, "w", encoding="utf-8") as f:
            json.dump(self.memories, f, indent=2)

    def remember(self, speaker_name: str, fact: str, revision=None):
        if self.memory_enabled and speaker_name.lower() != "unknown" and fact:
            self.state.remember(speaker_name, self.name, self.memory_sharing_mode, fact, expected_revision=revision)

    def _prime_speaker_memory(self, speaker_name: str):
        # Context is read fresh from SQLite for EVERY reply, including other processes.
        # Keep this method for existing callers; never cache memory in chat history.
        return

    def extract_memory(self, speaker_name: str, user_text: str, reply: str):
        """Asks the model whether this turn revealed a short, durable fact
        about speaker_name worth remembering later, and stores it if so."""
        if not self.memory_enabled or speaker_name == "Unknown":
            return
        revision = self.state.ensure(speaker_name)["memory_revision"]
        try:
            completion = self.openai_client.chat.completions.create(
                model=self.model,
                messages=[{"role": "system", "content": FACT_PROMPT + "\nAlso retain user-stated reasons behind travel choices, relevant tradeoffs and rejected options when useful for later planning. Preserve tentative wording and latest corrections. Do not infer preferences or adopt agent suggestions as user facts."},
                          {"role": "user", "content": json.dumps({"speaker": speaker_name, "agent": self.name, "user": user_text, "reply": reply})}],
            )
            fact = completion.choices[0].message.content.strip()
        except Exception as e:
            print(f"(Memory extraction failed: {e})")
            return
        if fact and fact.upper() != "NONE":
            self.remember(speaker_name, fact, revision)

    def _restore_history(self):
        saved = self.state.ensure(self.speaker_name)
        bucket = self.state.bucket(self.name, self.memory_sharing_mode)
        self.history = [{"role": "system", "content": self.system_prompt}] + saved["histories"].get(bucket, [])
        self.session_id = saved["sessions"].get(bucket) or uuid.uuid4().hex

    def _seed_legacy_memories(self, name):
        if self.state.get(name):
            return
        self.state.ensure(name)
        root = os.path.dirname(os.path.abspath(__file__))
        base, extension = os.path.splitext(MEMORIES_PATH)
        for compartment, filename in (("shared", MEMORIES_PATH), ("sage", f"{base}_sage{extension}"), ("astra", f"{base}_astra{extension}")):
            candidates = [filename, os.path.join(root, filename)]
            for path in candidates:
                if not os.path.isfile(path):
                    continue
                try:
                    with open(path, encoding="utf-8") as stream:
                        old = json.load(stream)
                    entries = next((entries for key, entries in old.items() if key.strip().lower() == name), [])
                    if isinstance(entries, list):
                        def seed(profile, _histories, _sessions):
                            profile["memories"][compartment] = [entry for entry in entries[-20:]
                                if isinstance(entry, str) or isinstance(entry, dict) and isinstance(entry.get("fact"), str)]
                        self.state.mutate(name, seed)
                    break
                except (OSError, ValueError, AttributeError):
                    continue

    def set_speaker(self, name: str, reload=False):
        key = name_id(name)
        self._seed_legacy_memories(key)
        self.state.activate(key, reload=reload)
        self.speaker_name = key
        self._restore_history()
        self.stage = "planning"
        self.handoff_suggested = False
        print(f"\nName ID: {key}. Talking with {self.name}. Saved chats restored.")

    def ask_speaker_name(self):
        while True:
            name = input(f"Name ID [{self.speaker_name if self.speaker_name != 'Unknown' else ''}]: ").strip()
            if not name and self.speaker_name != "Unknown":
                return
            try:
                self.set_speaker(name)
                return
            except (ValueError, CloudError) as exc:
                print(str(exc))
                if isinstance(exc, CloudError) and exc.status == 409:
                    print("Use reload to replace local changes with the latest cloud trip.")

    # -- Research logging --------------------------------------------------

    def log_turn(self, speaker: str, user_text: str, reply: str,
                 extra: dict = None):
        """Appends one JSON line per conversational turn to LOG_PATH."""
        if not ENABLE_LOGGING:
            return
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "session_id": self.session_id,
            "agent_name": self.name,
            "agent_traits": self.traits,
            "memory_sharing_mode": self.memory_sharing_mode,
            "speaker": speaker,
            "user_text": user_text,
            "agent_reply": reply,
        }
        if extra:
            entry.update(extra)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    # -- Recording: push-to-talk -----------------------------------------

    def record_audio_to_wav(self, path: str):
        """Press Enter to start talking, Enter again to stop."""
        print("Listening... press Enter again to stop.")
        recorded_chunks = []
        stop_flag = threading.Event()

        def callback(indata, frames, time_info, status):
            if status:
                print(f"(Audio status: {status})")
            recorded_chunks.append(indata.copy())

        def wait_for_stop():
            input()
            stop_flag.set()

        threading.Thread(target=wait_for_stop, daemon=True).start()

        with sd.InputStream(**self._stream_kwargs(callback)):
            while not stop_flag.is_set():
                sd.sleep(100)

        self._write_wav(path, recorded_chunks)

    # -- Speech-to-text (local Whisper) ------------------------------------

    def transcribe(self, wav_path: str) -> str:
        segments, _info = self.whisper_model.transcribe(wav_path, language="en")
        return " ".join(segment.text for segment in segments).strip()

    # -- LLM response -----------------------------------------------------

    def get_response(self, user_text: str) -> str:
        self._restore_history()
        mode = self.memory_sharing_mode if self.memory_enabled else "disabled"
        messages = [self.history[0], {"role": "system", "content": HANDOFF_INSTRUCTIONS[mode]},
                    *self.history[1:][-12:]]
        context = self.state.context(self.speaker_name, self.name, self.memory_sharing_mode, self.memory_enabled)
        if context:
            messages.append({"role": "system", "content": context})
        messages.append({"role": "user", "content": user_text[:3500]})
        completion = self.openai_client.chat.completions.create(model=self.model, messages=messages)
        reply = completion.choices[0].message.content.strip()[:3500]
        if not reply:
            raise ValueError("The agent returned an empty reply.")
        self.history.extend([{"role": "user", "content": user_text[:3500]}, {"role": "assistant", "content": reply}])
        return reply

    # -- Text-to-speech (Azure, with emotional style) ----------------------

    def build_ssml(self, text: str) -> str:
        voice_name = xml_escape(self.azure_voice_name, {'"': '&quot;'})
        # Model-qualified HD names do not accept the legacy prosody element.
        # Plain text inside <voice> also works across HD voice families.
        if ":" in self.azure_voice_name:
            return (f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
                    f'xml:lang="en-US"><voice name="{voice_name}">'
                    f'{xml_escape(text)}</voice></speak>')
        return f"""<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"
    xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">
  <voice name="{voice_name}">
    <mstts:express-as style="{self.voice_style}" styledegree="{self.style_degree}">
      <prosody rate="{self.rate_str}" pitch="{self.pitch_str}">
        {xml_escape(text)}
      </prosody>
    </mstts:express-as>
  </voice>
</speak>"""

    def speak(self, text: str) -> bool:
        """Speak text aloud. Returns True if it played to completion, or
        False if the user pressed Enter partway through to interrupt it
        and start talking right away."""
        print("(Press Enter to interrupt...)")
        if self.tts_provider == "openai":
            return self._speak_openai(text)
        return self._speak_azure(text)

    def _speak_azure(self, text: str) -> bool:
        import azure.cognitiveservices.speech as speechsdk
        audio_config = speechsdk.audio.AudioOutputConfig(use_default_speaker=True)
        synthesizer = speechsdk.SpeechSynthesizer(
            speech_config=self.speech_config, audio_config=audio_config
        )
        ssml = self.build_ssml(text)

        interrupted = threading.Event()
        playback_done = threading.Event()

        def playback():
            result = synthesizer.speak_ssml_async(ssml).get()
            if not interrupted.is_set() and result.reason == speechsdk.ResultReason.Canceled:
                details = result.cancellation_details
                print(f"(Speech synthesis failed: {details.reason} -- {details.error_details})")
            playback_done.set()

        threading.Thread(target=playback, daemon=True).start()

        while not playback_done.is_set():
            if _enter_pressed():
                interrupted.set()
                break
            time.sleep(0.03)

        if interrupted.is_set() and not playback_done.is_set():
            synthesizer.stop_speaking_async().get()
            print("(Interrupted -- go ahead, listening now...)")

        return not interrupted.is_set()

    def _speak_openai(self, text: str) -> bool:
        """Generate speech with the existing OpenAI client and play it."""
        with self.openai_client.audio.speech.with_streaming_response.create(
            model="gpt-4o-mini-tts", voice=self.openai_voice,
            input=text, instructions=self.openai_tts_instructions,
            response_format="mp3",
        ) as response:
            return self._play_mp3(response.read())

    def _play_mp3(self, mp3: bytes) -> bool:
        """Decode MP3 and play it in small chunks, checking between each
        one for an Enter-key interrupt."""
        try:
            decoded = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
                 "-f", "s16le", "-ac", "1", "-ar", "22050", "pipe:1"],
                input=mp3, capture_output=True, check=True,
            ).stdout
            samples = np.frombuffer(decoded, dtype="<i2")
        except (OSError, subprocess.CalledProcessError, ValueError) as exc:
            print(f"(Speech synthesis failed: {exc})")
            return True

        chunk_size = 2205  # ~0.1s at 22050 Hz
        interrupted = False
        with sd.OutputStream(samplerate=22050, channels=1, dtype="int16") as output:
            for offset in range(0, len(samples), chunk_size):
                if _enter_pressed():
                    interrupted = True
                    break
                output.write(samples[offset:offset + chunk_size])

        if interrupted:
            print("(Interrupted -- go ahead, listening now...)")
        return not interrupted

    # -- One conversational turn --------------------------------------------

    def process_one_turn(self) -> bool:
        """Record, transcribe, get a reply, and speak it. Always returns
        True (the caller only stops on the typed 'quit' command).

        If the user interrupts the agent mid-reply (pressing Enter while
        it's speaking), that same keypress is treated as "start recording
        the next turn" -- this loops internally rather than returning to
        the outer '[Enter] to talk' prompt, so interrupting feels like one
        continuous action instead of needing a second separate press."""
        while True:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                wav_path = tmp.name
            try:
                turn_start = time.time()
                self.record_audio_to_wav(wav_path)
                user_text = self.transcribe(wav_path)
            finally:
                os.remove(wav_path)

            if not user_text:
                print("(Didn't catch that -- try again.)")
                return True

            speaker_name = self.speaker_name
            print(f"You said [{speaker_name}]: {user_text}")

            finished = self.process_text(user_text, speak=True, turn_start=turn_start)

            if finished:
                return True
            # else: interrupted -- loop back and record immediately,
            # consuming no further prompt from the caller

    # -- Travel planning controls and stages -------------------------------

    def _sync(self):
        try:
            self.state.sync(self.speaker_name)
            if self.state.cloud:
                print("Trip and chats saved across devices.")
        except CloudError as exc:
            print(f"Cloud sync pending: {exc}. Local data is saved. Use reload after a conflict.")

    def show_notes(self):
        profile = self.state.ensure(self.speaker_name)["payload"]
        choices = profile["choices"]
        print("\nTrip notes & to-dos (read-only)")
        print(profile["notes"] or "Your trip details and next steps will appear here.")
        print(f"Country {len(choices['countries'])}/1+ | Cities {len(choices['cities'])}/3+ | "
              f"Activities {len(choices['activities'])}/1–2 | "
              f"Budget {'confirmed' if choices.get('budget') else 'pending'} | "
              f"Plan {'finalized' if trip_ready(choices) else 'pending'}")

    def show_form(self, automatic=False):
        profile = self.state.ensure(self.speaker_name)["payload"]
        if not trip_ready(profile["choices"]):
            print("Finish your country, three cities, one or two activities, budget, and approved Astra itinerary first.")
            return
        if automatic and profile.get("reviewed"):
            return
        self.state.mark_reviewed(self.speaker_name)
        self.stage = "review"
        print("\nStage 3 · Complete your form")
        self.show_notes()
        url = os.getenv("GOOGLE_FORM_URL", "")
        parsed = urlparse(url)
        if (parsed.scheme == "https" and parsed.hostname in ("docs.google.com", "forms.gle")
                and (parsed.hostname != "docs.google.com" or parsed.path.startswith("/forms/"))):
            print(f"Google Form: {url}")
        else:
            print("The Google Form is coming soon. Your checklist is saved.")
        print("Type back to continue planning; form returns here when you are ready.")
        self._sync()

    def switch_agent(self):
        from sage import SageAgent
        from astra import AstraAgent
        cls = AstraAgent if self.name.lower() == "sage" else SageAgent
        self.name, self.traits, self.role_instructions = cls.NAME, dict(cls.TRAITS), cls.ROLE_INSTRUCTIONS
        self.system_prompt = build_system_prompt(self.name, self.traits, self.role_instructions)
        self.voice_style, self.style_degree = voice_style_from_traits(self.traits)
        self.rate_str, computed = prosody_from_traits(self.traits)
        self.pitch_str = computed if cls.PITCH_OVERRIDE_ST is None else f"{cls.PITCH_OVERRIDE_ST:+}st"
        self.azure_voice_name = os.getenv("AZURE_VOICE_NAME", cls.AZURE_VOICE_NAME)
        self.tts_provider = os.getenv("TTS_PROVIDER", cls.TTS_PROVIDER).lower()
        self.openai_voice = os.getenv("OPENAI_VOICE", cls.OPENAI_VOICE)
        self.openai_tts_instructions = os.getenv("OPENAI_TTS_INSTRUCTIONS", cls.OPENAI_TTS_INSTRUCTIONS)
        if self.tts_provider == "azure":
            self.speech_config.speech_synthesis_voice_name = self.azure_voice_name
        self._restore_history()
        self.handoff_suggested = False
        self.stage = "planning"
        print(f"\nTalking with {self.name}. Previous chat restored.")
        self.greet_first_visit()

    def process_text(self, user_text, speak=False, turn_start=None):
        import re
        user_text = user_text.strip()[:3500]
        if not user_text:
            return True
        turn_start = turn_start or time.time()
        name, agent, mode = self.speaker_name, self.name, self.memory_sharing_mode
        prior = self.state.prior(name, agent, mode, enabled=self.memory_enabled)
        reply = self.get_response(user_text)
        print(f"{agent}: {reply}")
        turn = self.state.append_turn(name, agent, mode, user_text, reply, self.session_id,
                                      remember_recent=self.memory_enabled, logging=ENABLE_LOGGING)
        with ThreadPoolExecutor(max_workers=2) as pool:
            memory_job = pool.submit(self.extract_memory, name, user_text, reply) if self.memory_enabled else None
            notes_job = pool.submit(self.state.checklist, name, self.openai_client, self.model, agent, user_text, reply, prior)
            finished = self.speak(reply) if speak else True
            try:
                notes_job.result()
            except Exception as exc:
                print(f"Checklist update failed; existing notes kept: {exc}")
            if memory_job:
                memory_job.result()
        turn["interrupted"] = not finished
        if ENABLE_LOGGING:
            self.state.queue_log(turn)
            self.log_turn(name, user_text, reply, extra={"turn_id": turn["turn_id"], "participant_id": turn["participant_id"],
                "turn_seconds": round(time.time() - turn_start, 3), "interrupted": not finished})
        other = "Astra" if agent.lower() == "sage" else "Sage"
        self.handoff_suggested = any(re.search(rf"\b(?:switch(?: over)? to|talk to|talk with|ask|try|let|recommend|suggest)\b[^.!?]{{0,65}}\b{other}\b", sentence, re.I)
            or re.search(rf"\b{other}\b[^.!?]{{0,45}}\b(?:can help|could help|can finalize|can check|is better)\b", sentence, re.I)
            for sentence in re.split(r"[.!?\n]+", reply) if not re.search(r"\b(?:don't|do not|no need to|shouldn't)\b", sentence, re.I))
        if self.handoff_suggested:
            print(f"Switch suggested: type switch for {other}'s help.")
        self.show_notes()
        self._sync()
        if finished:
            self.show_form(automatic=True)
        return finished

    def greet_first_visit(self):
        if any(item.get("role") == "assistant" for item in self.history):
            return
        reply = ("Hi, I’m Sage! I’ll help you choose destinations and fun activities. What kind of trip sounds exciting to you?"
                 if self.name.lower() == "sage" else
                 "Hi, I’m Astra. I’ll help turn your choices into a practical itinerary and budget. What would you like to finalize first?")
        print(f"{self.name}: {reply}")
        turn = self.state.append_turn(self.speaker_name, self.name, self.memory_sharing_mode, "", reply,
                                      self.session_id, remember_recent=False, logging=ENABLE_LOGGING)
        self._restore_history()
        turn["interrupted"] = not self.speak(reply)
        if ENABLE_LOGGING:
            self.state.queue_log(turn)
        self._sync()

    def run(self):
        print(f"\n{self.name} · Trip planning")
        if self.memory_enabled:
            self.choose_memory_sharing_mode()
            self._setup_memory()
        cloud_url = os.getenv("VOICE_DEMO_API_URL", "").strip()
        if cloud_url:
            code = os.getenv("VOICE_DEMO_CODE") or getpass("Website demo code: ")
            self.state.cloud = WorkerClient(cloud_url, code, os.getenv("VOICE_DEMO_ORIGIN", "https://jimjamms.github.io"))
            print("Cloud sync enabled. Anyone with the Name ID and demo code can open its trip.")
        else:
            print(f"Saved locally in {self.state.path}. Set VOICE_DEMO_API_URL for cross-device sync.")
        self.ask_speaker_name()
        self.greet_first_visit()
        self.show_notes()
        print("Commands: Enter to talk | text <message> | switch | notes | form | back | new | forget | clear | name | reload | quit")
        while True:
            choice = input(f"\n{self.name} [{self.stage}] > ").strip()
            command = choice.lower()
            try:
                if command == "quit":
                    self._sync()
                    break
                if command == "name":
                    self.ask_speaker_name()
                    self.greet_first_visit()
                    continue
                if command == "reload":
                    if input("Replace local changes with the saved cloud trip? Type reload: ").strip().lower() == "reload":
                        self.set_speaker(self.speaker_name, reload=True)
                    continue
                if self.state.check_reset(self.speaker_name):
                    self._restore_history()
                    self.stage = "planning"
                    print("The host reset this trip. The same ID is ready for a fresh trip.")
                    self.show_notes()
                    continue
                if command == "switch":
                    self.switch_agent()
                elif command == "notes":
                    self.show_notes()
                elif command == "form":
                    self.show_form()
                elif command == "back":
                    self.stage = "planning"
                    # reviewed is persisted and is deliberately not cleared here.
                elif command == "new":
                    self.state.new_chat(self.speaker_name, self.name, self.memory_sharing_mode)
                    self._restore_history()
                    self._sync()
                elif command == "forget":
                    self.state.forget(self.speaker_name)
                    self._sync()
                    print("Saved memories cleared; the checklist and host transcript archive remain.")
                elif command == "clear":
                    self.state.clear_notes(self.speaker_name)
                    self.show_notes()
                    self._sync()
                elif command.startswith("text "):
                    self.stage = "planning"
                    self.process_text(choice[5:])
                elif not command:
                    if self.stage == "review":
                        self.stage = "planning"
                    else:
                        self.process_one_turn()
                else:
                    print("Use a listed command, or text followed by your message.")
            except (CloudError, ValueError) as exc:
                print(f"{exc} Local data is still saved.")
            except KeyboardInterrupt:
                break
        print("Goodbye!")


# ---------------------------------------------------------------------------
# 5. NOTE
# ---------------------------------------------------------------------------
# This file defines the shared PersonalityVoiceAgent base class only. It is
# not meant to be run directly -- run sage.py or astra.py instead, each of
# which subclasses PersonalityVoiceAgent with its own NAME/TRAITS/voice.

if __name__ == "__main__":
    sys.exit(
        "agent_base.py defines the shared base class and isn't meant to be "
        "run directly. Run 'python sage.py' or 'python astra.py' instead."
    )