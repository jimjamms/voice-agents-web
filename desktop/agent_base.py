"""
Big Five Personality Voice Agent -- shared base class
=========================================================

This file (agent_base.py) is NOT run directly. It defines the shared
PersonalityVoiceAgent class -- everything common to every agent: recording,
local Whisper transcription, GPT chat, Azure TTS with emotional styling,
speaker ID, and research logging.

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

Recording modes:
    "push_to_talk" -- press Enter to start talking, Enter again to stop.
    "vad"           -- fully hands-free and CONTINUOUS. The agent listens
                        all the time and automatically detects when you
                        start and stop speaking (voice activity
                        detection). There is no button to press, and no
                        Enter key needed between turns -- as soon as it
                        finishes replying it starts listening again.
    "vad" mode also supports BARGE-IN: if you start talking while the
    agent is still speaking, it immediately stops itself and starts
    listening to you, just like a real conversation. (Best with
    headphones/earbuds -- see the ENABLE_BARGE_IN note below.)

Pipeline:
    Mic audio -> local Whisper transcription -> OpenAI GPT-6 Astra (chat, with a
    personality system prompt) -> selected text-to-speech provider -> speaker playback.

Setup
-----
1. Install dependencies:
       pip install sounddevice numpy librosa faster-whisper openai
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
    - push_to_talk mode: press Enter to start talking, Enter again to stop.
      Type "mode" at that prompt to switch to hands-free on the fly.
    - vad mode: fully continuous -- just start talking whenever you're
      ready. No Enter key needed at all, before or between turns. Say
      "quit" (or press Ctrl+C) to exit.
"""

import os
import sys
import json
import time
import uuid
import wave
import queue
import random
import tempfile
import threading
import subprocess
from collections import deque
from datetime import datetime, timezone
from xml.sax.saxutils import escape as xml_escape

import numpy as np
import librosa
import sounddevice as sd
from faster_whisper import WhisperModel
from openai import OpenAI

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


def build_system_prompt(name: str, traits: dict) -> str:
    lines = [f"{trait.capitalize()}: {TRAIT_DESCRIPTIONS[trait][level]}"
             for trait, level in traits.items()]
    trait_block = "\n".join(f"- {line}" for line in lines)
    return f"""You are {name}, a voice assistant with a distinct personality defined by
the following Big Five personality traits:

{trait_block}

Let this personality consistently shape your word choice, tone, sentence
length, energy, and how you react emotionally -- not just what you say, but
how you say it.

You are speaking out loud in a voice conversation, so:
- Keep responses conversational and reasonably concise.
- Never use markdown, bullet points, numbered lists, or asterisks.
- Stay in character at all times."""


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
INPUT_DEVICE_INDEX = 9

# "push_to_talk": press Enter to start/stop each turn.
# "vad": fully hands-free and continuous -- no Enter key at all.
RECORDING_MODE = "push_to_talk"

# Words that end the conversation when spoken in "vad" mode (since there's
# no keyboard prompt to type "quit" into anymore).
VOICE_QUIT_PHRASES = {"quit", "exit", "stop listening", "goodbye", "good bye"}

# -- VAD tuning (only used in "vad" mode) ------------------------------------
VAD_CHUNK_SECONDS = 0.1        # how often we check the audio level
VAD_CALIBRATION_SECONDS = 1.0  # how long to measure ambient noise at startup
VAD_ENERGY_MULTIPLIER = 3.0    # speech threshold = ambient noise * this
VAD_MIN_THRESHOLD = 80.0       # floor, in case a room is dead silent
VAD_SILENCE_SECONDS = 1.2      # trailing silence required to end a turn
VAD_PRE_ROLL_SECONDS = 0.3     # audio kept from just before speech is detected
VAD_MAX_RECORD_SECONDS = 30    # safety cap so a stuck stream can't run forever

# -- Barge-in / interruption tuning (only used in "vad" mode) ---------------
# Lets you cut the agent off mid-reply just by talking, instead of waiting
# for it to finish. NOTE: without an echo-cancelling mic/headset, the mic
# can pick up the agent's own voice from the speakers and "hear itself" as
# an interruption. Using headphones/earbuds makes this far more reliable.
ENABLE_BARGE_IN = True

# The actual interrupt threshold is:
#     max(INTERRUPT_BASELINE, ambient_noise * INTERRUPT_ENERGY_MULTIPLIER)
#
# INTERRUPT_BASELINE is a hard floor in raw RMS units -- nothing quieter than
# this can EVER register as an interruption, no matter how quiet the room's
# ambient calibration came out. This is what stops small/random noises from
# triggering it. If you're still getting false interruptions, raise this
# number first (try doubling it); if real speech isn't being detected,
# lower it.
INTERRUPT_BASELINE = 600.0

INTERRUPT_ENERGY_MULTIPLIER = 2.5   # extra margin above the normal speech
                                     # threshold, to resist speaker bleed-through
INTERRUPT_TRIGGER_SECONDS = 0.5     # how much continuous "speech" is needed
                                     # before we treat it as a real interruption
                                     # (filters out clicks/pops/coughs)

# ---------------------------------------------------------------------------
# SPEAKER IDENTIFICATION + RESEARCH LOGGING
# ---------------------------------------------------------------------------
# This is a lightweight, heuristic voice fingerprint (MFCC statistics +
# cosine similarity) -- NOT deep-learning-grade speaker recognition. It's
# meant to distinguish a small number of known participants' voices, not
# to be robust against a large or adversarial set of speakers.

ENABLE_SPEAKER_ID = True
VOICEPRINTS_PATH = "voiceprints.json"
N_MFCC = 20                    # number of MFCC coefficients extracted
MFCC_SR = 16000                # audio is resampled to this rate before
                                # extracting features, so voiceprints compare
                                # fairly regardless of the mic's native rate
MIN_AUDIO_SECONDS_FOR_ID = 0.4 # utterances shorter than this aren't reliable
                                # enough to fingerprint -- treated as Unknown
SPEAKER_MATCH_THRESHOLD = 0.90 # cosine similarity needed to count as a match.
                                # Lower this if real matches keep coming back
                                # "Unknown"; raise it if different people are
                                # being confused for each other.
ENROLL_DURATION_SECONDS = 4.0  # length of the voice sample recorded when
                                # enrolling a new speaker

ENABLE_LOGGING = True
LOG_PATH = "conversation_log.jsonl"  # one JSON object per line, per turn --
                                       # ready to load into pandas/Excel/etc.
                                       # for your coherence research.


# ---------------------------------------------------------------------------
# 4. THE AGENT
# ---------------------------------------------------------------------------

class PersonalityVoiceAgent:
    """Shared base class for all personality voice agents: recording,
    Whisper transcription, GPT chat, Azure TTS with emotional styling,
    speaker ID, and research logging all live here.

    A specific agent (Sage, Astra, ...) is a subclass that overrides these
    three class attributes -- everything else is inherited unchanged:

        class SageAgent(PersonalityVoiceAgent):
            NAME = "Sage"
            TRAITS = {"openness": 4, "conscientiousness": 3, ...}
            AZURE_VOICE_NAME = "en-US-AriaNeural"

    Optionally also set PITCH_OVERRIDE_ST (a small number of semitones, e.g.
    2 or -2) to force a specific, modest pitch nudge instead of letting the
    Big Five trait formula pick one -- useful when you want two agents on
    the SAME base voice to sound like two people (a gentle pitch offset)
    without the trait math swinging pitch aggressively in either direction.
    """

    NAME = "Agent"
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
        self.mode = RECORDING_MODE

        self.system_prompt = build_system_prompt(self.name, self.traits)
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

        self.silence_threshold = None  # set by calibrate_ambient_noise()
        self._interrupt_threshold_logged = False
        self.history = [{"role": "system", "content": self.system_prompt}]

        self.session_id = uuid.uuid4().hex[:8]
        self.speaker_id_enabled = ENABLE_SPEAKER_ID
        self.voiceprints = self._load_voiceprints() if self.speaker_id_enabled else {}

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

    # -- Speaker identification (lightweight MFCC + cosine similarity) -----

    @staticmethod
    def _load_voiceprints() -> dict:
        if os.path.exists(VOICEPRINTS_PATH):
            with open(VOICEPRINTS_PATH, "r", encoding="utf-8") as f:
                raw = json.load(f)
            return {name: np.array(vec, dtype=np.float64) for name, vec in raw.items()}
        return {}

    def _save_voiceprints(self):
        raw = {name: vec.tolist() for name, vec in self.voiceprints.items()}
        with open(VOICEPRINTS_PATH, "w", encoding="utf-8") as f:
            json.dump(raw, f, indent=2)

    @staticmethod
    def extract_voice_features(wav_path: str):
        """Returns a normalized MFCC-statistics feature vector for the
        given WAV file, or None if there wasn't enough audio to trust."""
        y, _sr = librosa.load(wav_path, sr=MFCC_SR, mono=True)
        if y.size < MFCC_SR * MIN_AUDIO_SECONDS_FOR_ID:
            return None
        mfcc = librosa.feature.mfcc(y=y, sr=MFCC_SR, n_mfcc=N_MFCC)
        feature = np.concatenate([mfcc.mean(axis=1), mfcc.std(axis=1)])
        norm = np.linalg.norm(feature)
        if norm > 0:
            feature = feature / norm
        return feature

    def identify_speaker(self, features):
        """Compares a feature vector against all enrolled voiceprints.
        Returns (name, similarity) -- name is "Unknown" if nothing enrolled
        clears SPEAKER_MATCH_THRESHOLD, or if features is None."""
        if features is None or not self.voiceprints:
            return "Unknown", 0.0

        best_name, best_score = "Unknown", -1.0
        for name, voiceprint in self.voiceprints.items():
            score = float(np.dot(features, voiceprint))  # both are unit vectors
            if score > best_score:
                best_name, best_score = name, score

        if best_score >= SPEAKER_MATCH_THRESHOLD:
            return best_name, best_score
        return "Unknown", best_score

    def record_fixed_duration(self, path: str, duration: float):
        """Records exactly `duration` seconds, no VAD/Enter-key involved --
        used for voice enrollment."""
        recorded_chunks = []

        def callback(indata, frames_count, time_info, status):
            recorded_chunks.append(indata.copy())

        with sd.InputStream(**self._stream_kwargs(callback)):
            sd.sleep(int(duration * 1000))

        self._write_wav(path, recorded_chunks)

    def enroll_speaker_interactive(self, name: str = None):
        """Records a short sample and saves it as a named voiceprint."""
        if name is None:
            name = input("Enter a name for this voice (blank to cancel): ").strip()
        if not name:
            print("Cancelled -- no name given.")
            return

        print(f"Okay {name}, talk continuously for the next "
              f"{ENROLL_DURATION_SECONDS:.0f} seconds so I can learn your voice...")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            wav_path = tmp.name
        try:
            self.record_fixed_duration(wav_path, ENROLL_DURATION_SECONDS)
            features = self.extract_voice_features(wav_path)
        finally:
            os.remove(wav_path)

        if features is None:
            print("(Didn't catch enough audio -- try enrolling again.)")
            return

        self.voiceprints[name] = features
        self._save_voiceprints()
        print(f"Voice enrolled for '{name}'. Enrolled voices: {list(self.voiceprints.keys())}")

    def maybe_enroll_speakers(self):
        """Lets you enroll any number of voices before a session starts.
        Safe to skip entirely by just pressing Enter."""
        if not self.speaker_id_enabled:
            return
        existing = list(self.voiceprints.keys())
        print(f"\nEnrolled voices: {existing if existing else 'none yet'}")
        while True:
            name = input(
                "Type a name to enroll a new voice, or press Enter to continue: "
            ).strip()
            if not name:
                break
            self.enroll_speaker_interactive(name)

    # -- Research logging --------------------------------------------------

    def log_turn(self, speaker: str, speaker_score: float, user_text: str,
                 reply: str, extra: dict = None):
        """Appends one JSON line per conversational turn to LOG_PATH."""
        if not ENABLE_LOGGING:
            return
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "session_id": self.session_id,
            "agent_name": self.name,
            "agent_traits": self.traits,
            "speaker": speaker,
            "speaker_confidence": round(speaker_score, 3),
            "user_text": user_text,
            "agent_reply": reply,
        }
        if extra:
            entry.update(extra)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    # -- Recording: push-to-talk -----------------------------------------

    def record_push_to_talk(self, path: str):
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

    # -- Recording: automatic voice activity detection ---------------------

    def calibrate_ambient_noise(self):
        """Measures the room's background noise level once at startup so
        the VAD threshold adapts to wherever you actually are."""
        print(f"Calibrating microphone for background noise "
              f"({VAD_CALIBRATION_SECONDS:.0f}s, please stay quiet)...")
        frames = []

        def callback(indata, frames_count, time_info, status):
            frames.append(indata.copy())

        blocksize = int(self.record_rate * VAD_CHUNK_SECONDS)
        with sd.InputStream(**self._stream_kwargs(callback, blocksize=blocksize)):
            sd.sleep(int(VAD_CALIBRATION_SECONDS * 1000))

        ambient_rms = self._rms(np.concatenate(frames, axis=0)) if frames else VAD_MIN_THRESHOLD
        self.silence_threshold = max(ambient_rms * VAD_ENERGY_MULTIPLIER, VAD_MIN_THRESHOLD)
        print(f"Ambient noise level: {ambient_rms:.1f} -> "
              f"speech threshold set to {self.silence_threshold:.1f}")

    def record_vad(self, path: str):
        """Hands-free recording: starts automatically when speech is
        detected, stops automatically after a beat of silence."""
        if self.silence_threshold is None:
            self.calibrate_ambient_noise()

        print("Listening... just start talking (stops automatically when you pause).")

        blocksize = int(self.record_rate * VAD_CHUNK_SECONDS)
        chunk_queue = queue.Queue()

        def callback(indata, frames_count, time_info, status):
            if status:
                print(f"(Audio status: {status})")
            chunk_queue.put(indata.copy())

        # Pre-roll/silence/max-duration are tracked in actual seconds of
        # audio received, not a count of chunks -- chunk size can vary
        # (e.g. WDM-KS devices ignore our requested blocksize and choose
        # their own), so counting chunks would silently give the wrong
        # timing on those devices.
        pre_buffer = deque()
        pre_buffer_seconds = 0.0
        speech_chunks = []
        state = "waiting"  # "waiting" -> "recording" -> done
        silence_seconds = 0.0
        total_seconds = 0.0

        with sd.InputStream(**self._stream_kwargs(callback, blocksize=blocksize)):
            while True:
                chunk = chunk_queue.get()
                chunk_seconds = chunk.shape[0] / self.record_rate
                total_seconds += chunk_seconds
                is_speech = self._rms(chunk) > self.silence_threshold

                if state == "waiting":
                    pre_buffer.append(chunk)
                    pre_buffer_seconds += chunk_seconds
                    while pre_buffer_seconds > VAD_PRE_ROLL_SECONDS and len(pre_buffer) > 1:
                        dropped = pre_buffer.popleft()
                        pre_buffer_seconds -= dropped.shape[0] / self.record_rate
                    if is_speech:
                        state = "recording"
                        speech_chunks.extend(pre_buffer)
                        speech_chunks.append(chunk)
                        silence_seconds = 0.0
                else:  # state == "recording"
                    speech_chunks.append(chunk)
                    if is_speech:
                        silence_seconds = 0.0
                    else:
                        silence_seconds += chunk_seconds
                        if silence_seconds >= VAD_SILENCE_SECONDS:
                            break

                if total_seconds >= VAD_MAX_RECORD_SECONDS:
                    break

        self._write_wav(path, speech_chunks)

    def record_audio_to_wav(self, path: str):
        if self.mode == "vad":
            self.record_vad(path)
        else:
            self.record_push_to_talk(path)

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
        False if it was cut off early because the user started talking
        (barge-in -- only possible in "vad" mode with ENABLE_BARGE_IN)."""
        if self.tts_provider == "openai":
            return self._speak_openai(text)
        import azure.cognitiveservices.speech as speechsdk
        if self.mode == "vad" and ENABLE_BARGE_IN:
            return self._speak_interruptible(text)

        audio_config = speechsdk.audio.AudioOutputConfig(use_default_speaker=True)
        synthesizer = speechsdk.SpeechSynthesizer(
            speech_config=self.speech_config, audio_config=audio_config
        )
        ssml = self.build_ssml(text)
        result = synthesizer.speak_ssml_async(ssml).get()

        if result.reason == speechsdk.ResultReason.Canceled:
            details = result.cancellation_details
            print(f"(Speech synthesis failed: {details.reason} -- {details.error_details})")
        return True

    def _speak_interruptible(self, text: str) -> bool:
        """Play back TTS audio while a second mic stream watches for the
        user starting to talk. If sustained speech is detected, playback
        is stopped immediately and this returns False."""
        import azure.cognitiveservices.speech as speechsdk
        audio_config = speechsdk.audio.AudioOutputConfig(use_default_speaker=True)
        synthesizer = speechsdk.SpeechSynthesizer(
            speech_config=self.speech_config, audio_config=audio_config
        )
        ssml = self.build_ssml(text)

        interrupted = threading.Event()
        stop_monitor = threading.Event()
        playback_done = threading.Event()

        threshold = max(
            INTERRUPT_BASELINE,
            (self.silence_threshold or VAD_MIN_THRESHOLD) * INTERRUPT_ENERGY_MULTIPLIER,
        )
        if not self._interrupt_threshold_logged:
            print(f"(Barge-in threshold: {threshold:.1f} "
                  f"[baseline={INTERRUPT_BASELINE:.1f}, "
                  f"ambient*mult={((self.silence_threshold or VAD_MIN_THRESHOLD) * INTERRUPT_ENERGY_MULTIPLIER):.1f}])")
            self._interrupt_threshold_logged = True
        blocksize = int(self.record_rate * VAD_CHUNK_SECONDS)

        def monitor():
            consecutive_speech_seconds = 0.0

            def callback(indata, frames_count, time_info, status):
                nonlocal consecutive_speech_seconds
                if stop_monitor.is_set():
                    return
                chunk_seconds = indata.shape[0] / self.record_rate
                if self._rms(indata) > threshold:
                    consecutive_speech_seconds += chunk_seconds
                    if consecutive_speech_seconds >= INTERRUPT_TRIGGER_SECONDS:
                        interrupted.set()
                        stop_monitor.set()
                else:
                    consecutive_speech_seconds = 0.0

            try:
                with sd.InputStream(**self._stream_kwargs(callback, blocksize=blocksize)):
                    while not stop_monitor.is_set():
                        sd.sleep(30)
            except Exception as e:
                print(f"(Interrupt monitor error: {e})")

        def playback():
            result = synthesizer.speak_ssml_async(ssml).get()
            if (not interrupted.is_set()
                    and result.reason == speechsdk.ResultReason.Canceled):
                details = result.cancellation_details
                print(f"(Speech synthesis failed: {details.reason} -- {details.error_details})")
            playback_done.set()

        monitor_thread = threading.Thread(target=monitor, daemon=True)
        playback_thread = threading.Thread(target=playback, daemon=True)
        monitor_thread.start()
        playback_thread.start()

        while not playback_done.is_set() and not interrupted.is_set():
            time.sleep(0.03)

        if interrupted.is_set() and not playback_done.is_set():
            print("(Heard you -- stopping to listen...)")
            synthesizer.stop_speaking_async().get()

        stop_monitor.set()
        monitor_thread.join(timeout=2)
        playback_thread.join(timeout=2)

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
        """Decode MP3 and play it, with optional interruption in VAD mode."""
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

        interrupted = threading.Event()
        stop_monitor = threading.Event()
        barge_in = self.mode == "vad" and ENABLE_BARGE_IN
        if barge_in:
            threshold = max(INTERRUPT_BASELINE,
                            (self.silence_threshold or VAD_MIN_THRESHOLD)
                            * INTERRUPT_ENERGY_MULTIPLIER)

            def monitor():
                consecutive = 0.0

                def callback(indata, frames_count, time_info, status):
                    nonlocal consecutive
                    if self._rms(indata) > threshold:
                        consecutive += len(indata) / self.record_rate
                        if consecutive >= INTERRUPT_TRIGGER_SECONDS:
                            interrupted.set()
                    else:
                        consecutive = 0.0

                try:
                    with sd.InputStream(**self._stream_kwargs(
                            callback, blocksize=int(self.record_rate * VAD_CHUNK_SECONDS))):
                        stop_monitor.wait()
                except Exception as exc:
                    print(f"(Interrupt monitor error: {exc})")

            monitor_thread = threading.Thread(target=monitor, daemon=True)
            monitor_thread.start()
        try:
            with sd.OutputStream(samplerate=22050, channels=1, dtype="int16") as output:
                for offset in range(0, len(samples), 2205):
                    if interrupted.is_set():
                        print("(Heard you -- stopping to listen...)")
                        break
                    output.write(samples[offset:offset + 2205])
        finally:
            stop_monitor.set()
            if barge_in:
                monitor_thread.join(timeout=2)
        return not interrupted.is_set()

    # -- One conversational turn (shared by both modes) ---------------------

    def process_one_turn(self) -> bool:
        """Record, transcribe, get a reply, and speak it.

        Returns False if the user asked to end the conversation (only
        relevant in "vad" mode, where there's no keyboard prompt to type
        "quit" into -- you just say it instead). Returns True otherwise,
        including on a turn where nothing understandable was heard, so the
        caller can just keep looping.
        """
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            wav_path = tmp.name
        try:
            turn_start = time.time()
            self.record_audio_to_wav(wav_path)

            speaker_name, speaker_score = "Unknown", 0.0
            if self.speaker_id_enabled:
                features = self.extract_voice_features(wav_path)
                speaker_name, speaker_score = self.identify_speaker(features)

            user_text = self.transcribe(wav_path)
        finally:
            os.remove(wav_path)

        if not user_text:
            print("(Didn't catch that -- try again.)")
            return True

        if self.speaker_id_enabled:
            print(f"You said [{speaker_name}, {speaker_score:.2f}]: {user_text}")
        else:
            print(f"You said: {user_text}")

        normalized = user_text.strip().lower().strip(".!?")
        if self.mode == "vad" and normalized in VOICE_QUIT_PHRASES:
            return False

        reply = self.get_response(user_text)
        print(f"{self.name}: {reply}")

        # In push_to_talk mode the mic isn't reopened until we loop back
        # around, so there's no risk of hearing/transcribing itself. In
        # "vad" mode with ENABLE_BARGE_IN, speak() runs its own monitoring
        # stream and returns False early if you start talking over it --
        # in that case we just fall straight back into listening below.
        finished = self.speak(reply)
        if not finished:
            print("(Go ahead, I'm listening.)")

        self.log_turn(
            speaker_name, speaker_score, user_text, reply,
            extra={
                "recording_mode": self.mode,
                "turn_seconds": round(time.time() - turn_start, 3),
                "barge_in": not finished,
            },
        )
        return True

    # -- Main loop --------------------------------------------------------

    def run(self):
        print(f"\n{self.name} is ready. Personality: {self.traits}")
        print(f"Voice: {self.tts_provider}"
              + (f" ({self.openai_voice})" if self.tts_provider == "openai"
                 else (f"; style: {self.voice_style} (intensity {self.style_degree})"
                       if self.tts_provider == "azure" else "")))
        print(f"Recording mode: {self.mode}")

        self.maybe_enroll_speakers()

        if self.mode == "vad":
            self._run_hands_free()
        else:
            self._run_push_to_talk()

    def _run_hands_free(self):
        """Fully continuous loop: no Enter key needed, ever. Just talk."""
        print("Hands-free mode -- just start talking whenever you're ready.")
        print(f"Say one of {sorted(VOICE_QUIT_PHRASES)} or press Ctrl+C to exit.\n")
        self.calibrate_ambient_noise()
        try:
            while self.process_one_turn():
                pass
        except KeyboardInterrupt:
            print()
        print("Goodbye!")

    def _run_push_to_talk(self):
        print("(Type 'mode' to switch to hands-free, 'enroll' to add a voice, "
              "or 'quit' to exit.)")
        while True:
            choice = input(
                "\n[Enter] to talk, 'mode' to switch, 'enroll', or 'quit': "
            ).strip().lower()

            if choice == "quit":
                break
            if choice == "mode":
                self.mode = "vad"
                print("Switched to: vad (hands-free, continuous)")
                self._run_hands_free()
                return  # _run_hands_free only exits via quit-phrase/Ctrl+C
            if choice == "enroll":
                self.enroll_speaker_interactive()
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
