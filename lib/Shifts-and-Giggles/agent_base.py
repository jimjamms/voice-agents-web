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


TRIP_PLANNING_GUIDANCE = "Help the user plan a trip collaboratively while keeping each agent's distinct goal. Give concise spoken replies focused on the next useful step. Make handoffs purposeful: explain the specific decision or result the other agent can help with, and provide a short summary the user can repeat or copy. Offer a handoff when a stage is complete or the other agent's specialty is needed, not after every reply; do not force the user to switch or withhold a useful answer. Use remembered preferences and confirmed plans when available. Shared memory contains selected facts, not the complete other agent's conversation, and separate memory does not transfer facts between agents. Do not claim to have sent a brief, read the other chat, or automatically switched agents. If the needed details are absent, ask for the user's summary. Distinguish rough cost and travel-time estimates from verified details. You have no live browsing or booking tools: never claim to have checked current prices, schedules, opening hours, availability, entry rules, or completed a booking. Identify what the user should verify before finalizing."


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
- Keep responses conversational and reasonably concise.
- Never use markdown, bullet points, numbered lists, or asterisks.
- Stay in character at all times."""
    if role_instructions:
        prompt += "\n\nTrip-planning role:\n" + role_instructions + "\n\n" + TRIP_PLANNING_GUIDANCE
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
MEMORIES_PATH = "memories.json"  # {speaker_name: [fact, fact, ...]} -- short,
                                   # durable facts an agent has learned about
                                   # each identified speaker, across sessions.
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
# NOTE: this only controls WHICH FILE each agent reads/writes -- it doesn't
# yet decide what's worth sharing or how; that logic (extract_memory,
# _prime_speaker_memory) is unchanged and still applies equally in both
# modes. This is just the on/off plumbing to build that on top of next.
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
        print(f"Memory file: {self.memories_path}")

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

    def remember(self, speaker_name: str, fact: str):
        """Appends a fact to speaker_name's fact list (oldest entries drop
        off past MAX_MEMORIES_PER_SPEAKER) and persists it.

        In "shared" mode, the fact is tagged {"fact": ..., "learned_by":
        self.name} -- the other agent needs to know WHO learned this,
        since they're both reading the same file. In "isolated" mode,
        it's just the plain fact string -- there's no "other agent" to
        attribute it for, since this file is this agent's alone."""
        if not speaker_name or speaker_name == "Unknown" or not fact:
            return
        entries = self.memories.setdefault(speaker_name, [])
        if self.memory_sharing_mode == "shared":
            entries.append({"fact": fact, "learned_by": self.name})
        else:
            entries.append(fact)
        del entries[:-MAX_MEMORIES_PER_SPEAKER]
        self._save_memories()

    def _prime_speaker_memory(self, speaker_name: str):
        """The first time speaker_name talks this session, injects
        what's remembered about them into the running chat history so the
        model can draw on past conversations. Facts learned by a
        DIFFERENT agent (only possible in "shared" mode) are explicitly
        attributed, so the model can reference them honestly instead of
        acting like it personally learned them."""
        if (not self.memory_enabled or speaker_name == "Unknown"
                or speaker_name in self._speakers_primed):
            return
        self._speakers_primed.add(speaker_name)
        entries = self.memories.get(speaker_name, [])
        if not entries:
            return

        lines = []
        any_cross_agent = False
        for entry in entries:
            if isinstance(entry, dict):
                fact = entry["fact"]
                learned_by = entry.get("learned_by")
            else:
                # Plain string: isolated-mode data (no other agent to
                # attribute it to) or legacy data from before attribution
                # existed. Either way, show it with no attribution note.
                fact, learned_by = entry, None

            if learned_by and learned_by != self.name:
                any_cross_agent = True
                lines.append(f"- (learned by {learned_by}, not by you) {fact}")
            else:
                lines.append(f"- {fact}")
        bullet_list = "\n".join(lines)

        note = ""
        if any_cross_agent:
            note = (
                f"\n\nSome of these were learned by a DIFFERENT agent, not "
                f"by you directly -- you may naturally reference them (e.g. "
                f"something you heard about {speaker_name}), but don't "
                f"claim you personally experienced that conversation."
            )
        self.history.append({
            "role": "system",
            "content": f"What you remember about {speaker_name} from "
                       f"previous conversations:\n{bullet_list}{note}",
        })

    def extract_memory(self, speaker_name: str, user_text: str, reply: str):
        """Asks the model whether this turn revealed a short, durable fact
        about speaker_name worth remembering later, and stores it if so."""
        if not self.memory_enabled or speaker_name == "Unknown":
            return
        prompt = (
            f"Below is one turn of a conversation with {speaker_name}.\n"
            f"{speaker_name}: {user_text}\n"
            f"{self.name}: {reply}\n\n"
            f"Is there a short, durable fact about {speaker_name} worth "
            "remembering for future conversations (e.g. plans, "
            "preferences, relationships, important dates)? If yes, reply "
            "with ONLY that fact in one short sentence. If not, reply "
            "with exactly NONE."
        )
        try:
            completion = self.openai_client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
            )
            fact = completion.choices[0].message.content.strip()
        except Exception as e:
            print(f"(Memory extraction failed: {e})")
            return
        if fact and fact.upper() != "NONE":
            self.remember(speaker_name, fact)

    def set_speaker(self, name: str):
        """Makes name the current speaker, creating their (empty) fact
        list if they don't have one yet, and resetting the live
        conversation to just the system prompt. Names match
        case-insensitively, so "nayeli" picks up the existing "Nayeli" entry."""
        for known in self.memories:
            if known.lower() == name.lower():
                name = known
                break
        self.speaker_name = name
        if self.memory_enabled and name not in self.memories:
            self.memories[name] = []
            self._save_memories()
        self.history = [{"role": "system", "content": self.system_prompt}]

    def ask_speaker_name(self):
        """Asks who's talking, by typed name. Safe to skip by just pressing
        Enter, which keeps the current speaker."""
        known = list(self.memories.keys())
        print(f"\nKnown names: {known if known else 'none yet'}")
        name = input(
            f"Type your name, or press Enter to stay as '{self.speaker_name}': "
        ).strip()
        if name:
            self.set_speaker(name)

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
        self.history.append({"role": "user", "content": user_text})
        # Note: gpt-6-astra (like other reasoning models) only supports the
        # default temperature of 1 -- passing any other value is rejected
        # with a 400 error, so we don't set it here.
        completion = self.openai_client.chat.completions.create(
            model=self.model,
            messages=self.history,
        )
        reply = completion.choices[0].message.content.strip()
        self.history.append({"role": "assistant", "content": reply})
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

            self._prime_speaker_memory(speaker_name)
            reply = self.get_response(user_text)
            print(f"{self.name}: {reply}")
            self.extract_memory(speaker_name, user_text, reply)

            finished = self.speak(reply)

            self.log_turn(
                speaker_name, user_text, reply,
                extra={
                    "turn_seconds": round(time.time() - turn_start, 3),
                    "interrupted": not finished,
                },
            )

            if finished:
                return True
            # else: interrupted -- loop back and record immediately,
            # consuming no further prompt from the caller

    # -- Main loop --------------------------------------------------------

    def run(self):
        print(f"\n{self.name} is ready. Personality: {self.traits}")
        print(f"Voice: {self.tts_provider}"
              + (f" ({self.openai_voice})" if self.tts_provider == "openai"
                 else (f"; style: {self.voice_style} (intensity {self.style_degree})"
                       if self.tts_provider == "azure" else "")))

        if self.memory_enabled:
            self.choose_memory_sharing_mode()
            self._setup_memory()

        self.ask_speaker_name()

        print("(Type 'name' to change who's talking, or 'quit' to exit.)")
        while True:
            choice = input("\n[Enter] to talk, 'name', or 'quit': ").strip().lower()

            if choice == "quit":
                break
            if choice == "name":
                self.ask_speaker_name()
                continue

            self.process_one_turn()

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