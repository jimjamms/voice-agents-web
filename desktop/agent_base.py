"""
Realtime Personality Voice Agent -- shared base class (OpenAI Realtime API)
=============================================================================

This is the "Option A" rewrite of the original agent_base.py. Instead of a
chained pipeline (local Whisper -> GPT chat -> Azure TTS), this connects
directly to OpenAI's Realtime API (model: gpt-realtime-2.1) -- one
audio-native model that listens and speaks over a single WebSocket
connection. Turn-taking and hands-free VAD are handled server-side;
the local echo gate keeps voice interruption available during playback.
There's no local silence-threshold calibration or
interrupt-monitor thread to maintain.

WHAT'S GONE vs. the old pipeline (and why):
    - Local Whisper transcription    -> the Realtime model consumes your
      mic audio directly; there's no separate STT step for generating a
      reply. (Whisper-based speaker ID below is unaffected -- see next
      section -- that's a separate, local-only use of raw audio.)
    - Azure Speech + SSML rate/pitch math (prosody_from_traits,
      PITCH_OVERRIDE_ST) -> Realtime uses a named voice with no numeric
      rate/pitch parameter. You can choose a voice at startup and describe
      delivery in *words* inside the instructions text (see delivery_style_from_traits
      below) -- the model follows this fairly well but it is not an
      exact, reproducible dial the way the old semitone math was.
    - Custom VAD_* constants / calibrate_ambient_noise / the barge-in
      RMS-monitor thread -> replaced by the API's built-in server_vad
      turn detection, which also handles interruption
      (interrupt_response: true) on its own.

SPEAKER ID + RESEARCH LOGGING -- REINSTATED:
    These are independent of the Realtime model itself: the API responds
    to whoever is speaking but has no notion of who that is, so speaker
    identification has to keep being your own local code, running on the
    same raw mic audio you're also streaming out. Concretely:
      - Every mic frame captured during an utterance (push-to-talk: while
        you're "recording"; hands-free: between the server's
        input_audio_buffer.speech_started/.speech_stopped events) is
        buffered separately from what's sent to the API.
      - When the utterance ends, that buffer is fingerprinted with the
        same lightweight MFCC + cosine-similarity approach as before
        (extract_voice_features / identify_speaker) and compared against
        voiceprints.json.
      - Each full conversational turn (once the model's spoken reply
        finishes, or is interrupted) is appended as one JSON line to
        conversation_log.jsonl, same shape as before, with a "barge_in"
        flag set when the user talked over the agent.
    One fidelity note: the user's transcript now comes from the Realtime
    API's own input-audio transcription rather than local Whisper, and its
    arrival isn't strictly ordered relative to other events, so on rare
    turns user_text may still be empty when a line is logged.

WHAT'S STILL YOURS TO CONTROL:
    - The Big Five personality text -- same idea as before, still fully
      in charge of word choice, tone, how warm/blunt/anxious it acts.
    - Which named voice an agent uses (REALTIME_VOICE or the startup prompt)
      -- this is how two agents can sound like different people.

Each actual agent (e.g. sage.py) is a small subclass overriding:
    NAME, TRAITS, REALTIME_VOICE

Run with:
    python sage.py

Setup
-----
    pip install sounddevice numpy librosa websockets
    export OPENAI_API_KEY="your-key"

Azure is no longer used anywhere in this file.

Controls:
    - At startup, type a voice name or press Enter for the agent's default.
      OpenAI's API will report an error if it does not support that name.
    - push_to_talk mode: press Enter to start talking, Enter again to
      stop. Type "mode" to switch to hands-free, "enroll" to add a voice,
      or "quit" to exit.
    - vad mode (hands-free): server-side VAD. Just start talking, including
      while Sage speaks. Press Ctrl+C to exit (there's no reliable local
      quit-phrase detection in this version -- see NOTE below).

NOTE on session.update field names: the Realtime API's session/audio
config shape has moved around during its beta -> GA migration. The
`audio.input.transcription` block below (used both for the console's
"You said: ..." output and for the user_text logged per turn) is a
best-effort guess at the current field name. If you see an `error` event
printed mentioning an unknown field, check the current Realtime sessions
reference and adjust that one block -- everything else (session.update's
instructions/voice, input_audio_buffer.append, response.output_audio.delta,
server_vad) is the stable core of the API and shouldn't need changes.
"""

import os
import sys
import json
import time
import uuid
import wave
import base64
import asyncio
import tempfile
import threading
from datetime import datetime, timezone
from collections import deque

import numpy as np
import librosa
import sounddevice as sd
import websockets

# ---------------------------------------------------------------------------
# 1. PERSONALITY CONFIGURATION
# ---------------------------------------------------------------------------

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


def delivery_style_from_traits(traits: dict) -> str:
    """Qualitative (word-based) delivery guidance -- the closest available
    replacement for the old prosody_from_traits() SSML rate/pitch numbers.
    Realtime voices have no rate/pitch parameter to set directly, so this
    gets folded into the instructions text as plain-English direction
    instead. It's steerable, not exact."""
    extraversion = traits["extraversion"]
    neuroticism = traits["neuroticism"]
    conscientiousness = traits["conscientiousness"]

    if extraversion >= 4:
        pace = "Speak at a noticeably brisk, energetic pace."
    elif extraversion <= 2:
        pace = "Speak slowly and measuredly, with unhurried pauses."
    else:
        pace = "Speak at a natural, moderate pace."

    if neuroticism >= 4:
        tone = "Let a little nervous energy or hesitation show in your delivery."
    elif neuroticism <= 2:
        tone = "Keep your delivery calm, even, and steady, no matter the topic."
    else:
        tone = "Keep your delivery generally even, with occasional light emotion."

    if conscientiousness >= 4:
        precision = "Speak clearly and deliberately, like someone who chooses words with care."
    else:
        precision = "Feel free to speak a little loosely and spontaneously."

    return " ".join([pace, tone, precision])


def build_instructions(name: str, traits: dict) -> str:
    lines = [f"{trait.capitalize()}: {TRAIT_DESCRIPTIONS[trait][level]}"
             for trait, level in traits.items()]
    trait_block = "\n".join(f"- {line}" for line in lines)
    delivery = delivery_style_from_traits(traits)
    return f"""You are {name}, a voice assistant with a distinct personality defined by
the following Big Five personality traits:

{trait_block}

Delivery: {delivery}

Let this personality consistently shape your word choice, tone, sentence
length, energy, and how you react emotionally -- not just what you say, but
how you say it.

You are speaking out loud in a live voice conversation, so:
- Keep responses conversational and reasonably concise.
- Never use markdown, bullet points, numbered lists, or asterisks.
- Stay in character at all times."""


# ---------------------------------------------------------------------------
# 2. REALTIME / AUDIO CONFIGURATION
# ---------------------------------------------------------------------------

REALTIME_MODEL = "gpt-realtime-2.1"

SAMPLE_RATE = 24000   # Realtime API's default PCM16 rate for input+output
CHANNELS = 1

# "push_to_talk": press Enter to start/stop each turn (manual commit).
# "vad": fully hands-free -- server-side turn detection (server_vad).
RECORDING_MODE = "vad"

INPUT_DEVICE_INDEX = None   # None = system default input device
OUTPUT_DEVICE_INDEX = None  # None = system default output device

# Playback is written to the speaker in pieces this many milliseconds
# long, rather than one big blocking write per received audio chunk, so
# a barge-in can cut playback off within roughly this long instead of
# waiting for whatever chunk was already in flight to finish.
PLAYBACK_PIECE_MS = 20

# Allow hands-free microphone input while Sage speaks so you can interrupt her.
ALLOW_VOICE_BARGE_IN = True

# The console transcript (response.output_audio_transcript.delta) arrives
# over the network well ahead of when the corresponding audio actually
# plays -- text can dump onto the screen seconds before you hear it. This
# throttles printing to a steady, typewriter-style pace instead, so the
# words show up roughly as fast as she's actually saying them. There's no
# official word-level timing from the API, so this is a fixed rate, not a
# true sync -- raise it if the text visibly lags behind her voice, lower
# it if it visibly gets ahead.
TRANSCRIPT_REVEAL_CHARS_PER_SECOND = 15.0
TRANSCRIPT_REVEAL_TICK_SECONDS = 0.05

VOICE_QUIT_PHRASES = {"quit", "exit", "stop listening", "goodbye", "good bye"}

SERVER_VAD_CONFIG = {
    "type": "server_vad",
    "threshold": 0.8,
    "prefix_padding_ms": 300,
    "silence_duration_ms": 600,
    "create_response": True,
    "interrupt_response": True,
}

# -- Echo gate (local, client-side) -----------------------------------------
# Compare microphone input with recent speaker audio at possible delays.
# Also require enough volume and several consecutive frames before sending
# an interruption. This helps with echo but headphones are still the most
# reliable way to prevent speaker audio reaching the mic.
ENABLE_ECHO_GATE = True

# Required mic RMS, as a fraction of recent output peak RMS,
# before a chunk counts as real speech rather than bleed-through. Raise
# this if the agent is still hearing itself; lower it if genuine barge-in
# attempts are getting swallowed while the agent talks.
ECHO_GATE_RMS_MULTIPLIER = 2.0

# Minimum microphone RMS during playback; rejects quiet room noise.
ECHO_GATE_MIN_FLOOR = 300.0
ECHO_MATCH_THRESHOLD = 0.42  # normalized playback/mic waveform match
BARGE_IN_CONFIRM_FRAMES = 3   # typically about 60 ms of mic input

# How long after the last output chunk was written we keep treating echo
# as a possibility -- covers room reverb and audio-driver buffering lag
# after the agent's speech has technically "ended".
ECHO_GATE_DECAY_SECONDS = 0.65

# Prints every gate decision (mic_rms vs. the required threshold) to the
# console. Turn this on to see real numbers for your hardware instead of
# guessing at ECHO_GATE_RMS_MULTIPLIER blind -- then turn it back off.
DEBUG_ECHO_GATE = False

# -- Echo calibration ---------------------------------------------------
# Comparing the agent's raw digital output volume against your mic's raw
# input volume (ECHO_GATE_RMS_MULTIPLIER) is a guess -- those are two
# unrelated measurement domains, and there's no reason a fixed constant
# picked ahead of time is anywhere near correct for your specific
# speaker volume, mic gain, and distance. Calibration measures the
# ACTUAL ratio on your hardware once at startup: she says a short test
# phrase, nothing is forwarded to the API while she does, and we record
# how loud the mic hears her vs. how loud she's being told to play,
# frame by frame. ECHO_GATE_RMS_MULTIPLIER is only the fallback if this
# is disabled or fails to collect enough signal.
ECHO_CALIBRATION_ENABLED = ALLOW_VOICE_BARGE_IN
ECHO_CALIBRATION_PHRASE = ("Please say exactly the following and nothing else: "
                            "testing one two three, testing one two three.")
ECHO_CALIBRATION_SAFETY_MARGIN = 1.4  # headroom above the measured ratio
ECHO_CALIBRATION_TIMEOUT_SECONDS = 15

# ---------------------------------------------------------------------------
# SPEAKER IDENTIFICATION + RESEARCH LOGGING
# ---------------------------------------------------------------------------
# Same lightweight, heuristic voice fingerprint as the original pipeline
# (MFCC statistics + cosine similarity) -- NOT deep-learning-grade speaker
# recognition. Meant to distinguish a small number of known participants,
# not to be robust against a large or adversarial set of speakers.

ENABLE_SPEAKER_ID = True
VOICEPRINTS_PATH = "voiceprints.json"
N_MFCC = 20                    # number of MFCC coefficients extracted
MFCC_SR = 16000                # audio is resampled to this rate before
                                # extracting features, independent of
                                # SAMPLE_RATE above
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


# ---------------------------------------------------------------------------
# 3. THE AGENT
# ---------------------------------------------------------------------------

class PersonalityVoiceAgent:
    """Shared base class. A subclass can override NAME, TRAITS,
    REALTIME_VOICE, and SPEAKING_STYLE. Older subclasses can instead use
    OPENAI_VOICE and OPENAI_TTS_INSTRUCTIONS."""

    NAME = "Agent"
    TRAITS = {
        "openness": 3, "conscientiousness": 3, "extraversion": 3,
        "agreeableness": 3, "neuroticism": 3,
    }
    REALTIME_VOICE = "alloy"
    # Compatibility with Sage classes from the previous OpenAI TTS pipeline.
    # Realtime uses session instructions instead of a separate TTS request.
    OPENAI_VOICE = None
    OPENAI_TTS_INSTRUCTIONS = "Speak warmly, naturally, and conversationally."
    SPEAKING_STYLE = None  # None uses OPENAI_TTS_INSTRUCTIONS for older agents

    def __init__(self, name: str = None, traits: dict = None, voice: str = None):
        self.name = name or self.NAME
        self.traits = traits or self.TRAITS
        self.voice = (voice or os.getenv("OPENAI_VOICE") or self.OPENAI_VOICE
                      or self.REALTIME_VOICE)
        self.instructions = build_instructions(self.name, self.traits)
        style = (self.SPEAKING_STYLE if self.SPEAKING_STYLE is not None
                 else self.OPENAI_TTS_INSTRUCTIONS)
        self.speaking_style = os.getenv("OPENAI_TTS_INSTRUCTIONS", style).strip()
        if self.speaking_style:
            self.instructions += "\n\nSpeaking style: " + self.speaking_style
        self.mode = RECORDING_MODE
        self.api_key = os.environ["OPENAI_API_KEY"]

        self._ws = None
        self._mic_queue: asyncio.Queue = None
        self._play_queue: asyncio.Queue = None
        self._loop = None
        self._recording = False   # only meaningful in push_to_talk mode
        self._response_active = False
        self._stop_flag = False

        # -- speaker ID + logging state --
        self.session_id = uuid.uuid4().hex[:8]
        self.speaker_id_enabled = ENABLE_SPEAKER_ID
        self.voiceprints = self._load_voiceprints() if self.speaker_id_enabled else {}
        self._utterance_lock = threading.Lock()
        self._utterance_chunks = []      # list of int16 ndarrays, current utterance
        self._turn_start_time = None
        self._current_user_text = ""
        self._current_reply_text = ""
        self._current_speaker_name = "Unknown"
        self._current_speaker_score = 0.0

        # -- echo gate state --
        self._output_rms = 0.0
        self._output_rms_last_time = 0.0
        self._playback_active = False
        self._recent_output_levels = deque(maxlen=50)
        self._recent_output_audio = deque(maxlen=50)
        self._barge_in_frames = []
        self._echo_ratio = None   # set by _calibrate_echo(); falls back to
                                   # ECHO_GATE_RMS_MULTIPLIER if calibration
                                   # is disabled or fails
        self._calibrating = False
        self._calibration_samples = []
        self._calibration_done_event = None
        self._calibration_item_ids = []

        # -- immediate-stop-on-interrupt state --
        self._interrupt_flag = threading.Event()

        # -- typewriter-paced transcript state --
        self._transcript_buffer = ""  # received but not yet printed text

    # -- session setup -------------------------------------------------

    async def _connect(self):
        url = f"wss://api.openai.com/v1/realtime?model={REALTIME_MODEL}"
        headers = {"Authorization": f"Bearer {self.api_key}"}
        self._ws = await websockets.connect(url, additional_headers=headers, max_size=None)
        await self._apply_turn_detection(initial=True)

    async def _apply_turn_detection(self, initial: bool = False):
        turn_detection = SERVER_VAD_CONFIG if self.mode == "vad" else None
        session = {
            "type": "realtime",
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                    "turn_detection": turn_detection,
                    # Best-effort: enables "You said: ..." console output
                    # and the user_text field in the JSONL log. See the
                    # NOTE at the top of this file if this errors.
                    "transcription": {"model": "whisper-1"},
                },
                "output": {
                    "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                    "voice": self.voice,
                },
            },
        }
        if initial:
            session["instructions"] = self.instructions
        await self._send({"type": "session.update", "session": session})

    async def _send(self, event: dict):
        await self._ws.send(json.dumps(event))

    # -- mic capture -> server, and -> speaker-ID buffer -----------------

    @staticmethod
    def _rms(samples: np.ndarray) -> float:
        if samples.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))

    def _recent_output_peak(self) -> float:
        """Account for speaker-to-mic delay and quiet pieces between words."""
        cutoff = time.monotonic() - ECHO_GATE_DECAY_SECONDS
        return max((level for moment, level in tuple(self._recent_output_levels)
                    if moment >= cutoff), default=0.0)

    def _playback_similarity(self, indata: np.ndarray) -> float:
        """Find Sage's waveform at any recent speaker-to-microphone delay."""
        cutoff = time.monotonic() - ECHO_GATE_DECAY_SECONDS
        pieces = [samples for moment, samples in tuple(self._recent_output_audio)
                  if moment >= cutoff]
        mic = indata.reshape(-1).astype(np.float64)
        if not pieces or len(mic) < 2:
            return 0.0
        reference = np.concatenate(pieces).astype(np.float64)
        if reference.size < mic.size:
            return 0.0
        mic -= mic.mean()
        mic_energy = np.dot(mic, mic)
        if mic_energy < 1.0:
            return 0.0
        # FFT correlation tests every possible delay without a Python loop.
        size = 1 << (len(reference) + len(mic) - 2).bit_length()
        products = np.fft.rfft(reference, size) * np.fft.rfft(mic[::-1], size)
        matches = np.fft.irfft(products, size)[len(mic)-1:len(reference)]
        squares = np.concatenate(([0.0], np.cumsum(reference * reference)))
        energies = squares[len(mic):] - squares[:-len(mic)]
        return float(np.max(np.abs(matches) /
                            np.sqrt(np.maximum(energies * mic_energy, 1.0))))

    def _forward_mic(self, chunk: np.ndarray):
        self._loop.call_soon_threadsafe(self._mic_queue.put_nowait, bytes(chunk))
        if self.speaker_id_enabled:
            with self._utterance_lock:
                self._utterance_chunks.append(chunk.copy())

    def _mic_callback(self, indata, frames, time_info, status):
        if self._stop_flag or self._loop is None:
            return

        if self._calibrating:
            # Measure the real mic/output relationship; never forward
            # this to the server -- it's not part of the conversation.
            mic_rms = self._rms(indata)
            output_peak = self._recent_output_peak()
            if output_peak > 0:
                self._calibration_samples.append((mic_rms, output_peak))
            return

        should_capture = self.mode == "vad" or self._recording
        if not should_capture:
            return

        if ENABLE_ECHO_GATE and ALLOW_VOICE_BARGE_IN and self.mode == "vad":
            output_peak = self._recent_output_peak()
            during_playback = (self._response_active or self._playback_active or
                               not self._play_queue.empty() or output_peak > 0)
            if during_playback:
                mic_rms = self._rms(indata)
                multiplier = (self._echo_ratio if self._echo_ratio is not None
                              else ECHO_GATE_RMS_MULTIPLIER)
                required = max(ECHO_GATE_MIN_FLOOR, output_peak * multiplier)
                similarity = (self._playback_similarity(indata)
                              if mic_rms >= ECHO_GATE_MIN_FLOOR else 0.0)
                # With no playback reference yet, wait for audio before
                # accepting a barge-in. A single loud echo frame should
                # never reach server VAD and cancel Sage's response.
                blocked = (output_peak == 0 or mic_rms < required or
                           similarity >= ECHO_MATCH_THRESHOLD)
                if DEBUG_ECHO_GATE:
                    print(f"[echo-gate] mic={mic_rms:.0f} "
                          f"speaker_peak={output_peak:.0f} "
                          f"required={required:.0f} match={similarity:.2f} "
                          f"-> {'BLOCKED' if blocked else 'passed'}")
                if blocked:
                    self._barge_in_frames.clear()
                    return
                if len(self._barge_in_frames) < BARGE_IN_CONFIRM_FRAMES - 1:
                    self._barge_in_frames.append(indata.copy())
                    return
                for held in self._barge_in_frames:
                    self._forward_mic(held)
                self._barge_in_frames.clear()
                self._forward_mic(indata)
                return
        self._barge_in_frames.clear()
        self._forward_mic(indata)

    async def _mic_sender(self):
        while not self._stop_flag:
            chunk = await self._mic_queue.get()
            try:
                await self._send({
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(chunk).decode("ascii"),
                })
            except websockets.exceptions.ConnectionClosed:
                break

    # -- server audio -> speaker -------------------------------------------------

    async def _player(self):
        loop = asyncio.get_running_loop()
        stream = sd.RawOutputStream(samplerate=SAMPLE_RATE, channels=CHANNELS,
                                     dtype="int16", device=OUTPUT_DEVICE_INDEX)
        stream.start()
        # Write in small pieces rather than handing over a whole
        # response.output_audio.delta chunk (which can be several hundred
        # ms) in one blocking call. Without this, a barge-in only drops
        # audio still sitting in the queue -- whatever had already been
        # passed to stream.write() keeps playing to the end, since there
        # was no chance to check for an interrupt partway through a single
        # write. Checking between ~20ms pieces makes a "stop talking"
        # actually near-immediate instead of "finish this chunk first".
        bytes_per_frame = 2 * CHANNELS  # int16 = 2 bytes/sample
        piece_bytes = int(SAMPLE_RATE * PLAYBACK_PIECE_MS / 1000) * bytes_per_frame
        try:
            while not self._stop_flag:
                chunk = await self._play_queue.get()
                if chunk is None:
                    continue  # sentinel, nothing to play
                self._playback_active = True
                offset = 0
                try:
                    while offset < len(chunk):
                        if self._interrupt_flag.is_set():
                            self._interrupt_flag.clear()
                            break
                        piece = chunk[offset:offset + piece_bytes]
                        self._output_rms = self._rms(np.frombuffer(piece, dtype=np.int16))
                        self._recent_output_levels.append((time.monotonic(), self._output_rms))
                        self._recent_output_audio.append((time.monotonic(),
                                                          np.frombuffer(piece, dtype=np.int16).copy()))
                        await loop.run_in_executor(None, stream.write, piece)
                        self._output_rms_last_time = time.monotonic()
                        offset += piece_bytes
                finally:
                    self._playback_active = False
                    self._interrupt_flag.clear()
        finally:
            stream.stop()
            stream.close()

    def _clear_playback(self):
        """Barge-in cutoff: stop the audio currently mid-playback (not
        just what's still queued) as close to immediately as possible.
        The server already cancelled its own response
        (interrupt_response: true); this makes local playback actually
        stop instead of finishing out whatever chunk was already handed
        to the sound device."""
        # Only signal the player if a chunk is actually being written.
        # A stale flag would otherwise cut off the first chunk of the next reply.
        if self._playback_active:
            self._interrupt_flag.set()
        else:
            self._interrupt_flag.clear()
        try:
            while True:
                self._play_queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        self._output_rms = 0.0
        self._output_rms_last_time = time.monotonic()

    async def _transcript_printer(self):
        """Reveals self._transcript_buffer at a steady pace instead of
        printing it the instant it arrives -- the transcript event and
        the corresponding audio don't arrive in lockstep, so printing
        immediately makes text show up well before you hear it."""
        chars_per_tick = max(1, round(TRANSCRIPT_REVEAL_CHARS_PER_SECOND
                                       * TRANSCRIPT_REVEAL_TICK_SECONDS))
        while not self._stop_flag:
            if self._transcript_buffer:
                piece = self._transcript_buffer[:chars_per_tick]
                self._transcript_buffer = self._transcript_buffer[chars_per_tick:]
                print(piece, end="", flush=True)
            await asyncio.sleep(TRANSCRIPT_REVEAL_TICK_SECONDS)

    # -- speaker identification (lightweight MFCC + cosine similarity) -----

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
    def _write_wav(path: str, audio_chunks: list):
        audio_data = (np.concatenate(audio_chunks, axis=0) if audio_chunks
                      else np.zeros((0, CHANNELS), dtype="int16"))
        with wave.open(path, "wb") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(2)  # int16 = 2 bytes
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(audio_data.tobytes())

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

    def _identify_from_chunks(self, chunks: list):
        """Blocking: writes chunks to a temp WAV and runs the MFCC
        pipeline. Call via asyncio.to_thread from the event loop."""
        if not chunks:
            return "Unknown", 0.0
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            wav_path = tmp.name
        try:
            self._write_wav(wav_path, chunks)
            features = self.extract_voice_features(wav_path)
        finally:
            os.remove(wav_path)
        return self.identify_speaker(features)

    def record_fixed_duration(self, path: str, duration: float):
        """Records exactly `duration` seconds, no VAD/Enter-key involved --
        used for voice enrollment."""
        recorded_chunks = []

        def callback(indata, frames_count, time_info, status):
            recorded_chunks.append(indata.copy())

        with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS, dtype="int16",
                             device=INPUT_DEVICE_INDEX, callback=callback):
            sd.sleep(int(duration * 1000))

        self._write_wav(path, recorded_chunks)

    def enroll_speaker_interactive(self, name: str = None):
        """Records a short sample and saves it as a named voiceprint.
        Blocking (uses input() and a synchronous mic recording) -- call
        via asyncio.to_thread if invoked mid-session."""
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
        Safe to skip entirely by just pressing Enter. Synchronous -- call
        before asyncio.run(), same as the original pipeline did."""
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

    # -- per-utterance speaker ID lifecycle ---------------------------------

    def _start_utterance(self):
        with self._utterance_lock:
            self._utterance_chunks = []
        self._turn_start_time = time.time()
        self._current_user_text = ""
        self._current_reply_text = ""
        self._current_speaker_name, self._current_speaker_score = "Unknown", 0.0

    async def _finish_utterance_and_identify(self):
        if not self.speaker_id_enabled:
            return
        with self._utterance_lock:
            chunks = list(self._utterance_chunks)
        name, score = await asyncio.to_thread(self._identify_from_chunks, chunks)
        self._current_speaker_name, self._current_speaker_score = name, score
        print(f"(Speaker: {name}, {score:.2f})")

    # -- research logging --------------------------------------------------

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

    def _log_current_turn(self, interrupted: bool):
        turn_seconds = (round(time.time() - self._turn_start_time, 3)
                         if self._turn_start_time else None)
        self.log_turn(
            self._current_speaker_name, self._current_speaker_score,
            self._current_user_text, self._current_reply_text,
            extra={
                "recording_mode": self.mode,
                "turn_seconds": turn_seconds,
                "barge_in": interrupted,
            },
        )

    # -- events from the server -------------------------------------------------

    async def _receiver(self):
        async for raw in self._ws:
            event = json.loads(raw)
            etype = event.get("type")

            if etype == "response.output_audio.delta":
                await self._play_queue.put(base64.b64decode(event["delta"]))

            elif etype == "response.output_audio_transcript.delta":
                delta = event.get("delta", "")
                self._current_reply_text += delta
                # Buffered, not printed immediately -- see
                # _transcript_printer for the actual pacing.
                self._transcript_buffer += delta

            elif etype == "response.created":
                self._response_active = True
                self._current_reply_text = ""
                self._transcript_buffer = ""
                print(f"\n{self.name}: ", end="", flush=True)

            elif etype == "response.done":
                # Flush whatever hasn't been typed out yet -- the audio's
                # already finished, so there's no reason to keep trickling
                # text out after she's stopped talking.
                if self._transcript_buffer:
                    print(self._transcript_buffer, end="", flush=True)
                    self._transcript_buffer = ""
                print()
                if self._calibrating:
                    resp = event.get("response", {})
                    for item in resp.get("output", []):
                        item_id = item.get("id")
                        if item_id:
                            self._calibration_item_ids.append(item_id)
                    if self._calibration_done_event is not None:
                        self._calibration_done_event.set()
                elif self._response_active:
                    # Normal completion -- if it had been interrupted, this
                    # turn was already logged from speech_started below,
                    # and _response_active would already be False.
                    self._log_current_turn(interrupted=False)
                self._response_active = False

            elif etype == "conversation.item.created":
                if self._calibrating:
                    item = event.get("item", {})
                    if item.get("id"):
                        self._calibration_item_ids.append(item["id"])

            elif etype == "input_audio_buffer.speech_started":
                # The server can finish a response before its queued audio
                # has finished playing locally. Stop the speaker in either case.
                if (self._response_active or self._playback_active or
                        not self._play_queue.empty()):
                    print("\n(Heard you -- stopping to listen...)")
                    self._clear_playback()
                    self._transcript_buffer = ""
                    if self._response_active:
                        self._log_current_turn(interrupted=True)
                    self._response_active = False
                if self.mode == "vad":
                    self._start_utterance()

            elif etype == "input_audio_buffer.speech_stopped":
                if self.mode == "vad":
                    await self._finish_utterance_and_identify()

            elif etype == "conversation.item.input_audio_transcription.completed":
                transcript = event.get("transcript", "")
                self._current_user_text = transcript
                if self.speaker_id_enabled:
                    print(f"You said [{self._current_speaker_name}, "
                          f"{self._current_speaker_score:.2f}]: {transcript}")
                else:
                    print(f"You said: {transcript}")

            elif etype == "error":
                print(f"\n(Realtime API error: {event.get('error')})")

    # -- push-to-talk turn -------------------------------------------------

    # -- echo calibration ---------------------------------------------------

    async def _calibrate_echo(self):
        """Measures the real mic/output volume relationship on this
        hardware once at startup, so the echo gate's threshold is based
        on an actual measurement instead of a guessed constant. Nothing
        recorded here is forwarded to the API or logged as a real turn;
        the calibration exchange is deleted from conversation history
        afterward so it doesn't pollute the model's context or the
        research log."""
        if not ECHO_CALIBRATION_ENABLED:
            return

        print("\nCalibrating echo gate -- she'll say a short test phrase, "
              "please stay quiet for a moment...")
        self._calibration_samples = []
        self._calibration_item_ids = []
        self._calibrating = True
        self._calibration_done_event = asyncio.Event()

        await self._send({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": ECHO_CALIBRATION_PHRASE}],
            },
        })
        await self._send({"type": "response.create"})

        try:
            await asyncio.wait_for(self._calibration_done_event.wait(),
                                    timeout=ECHO_CALIBRATION_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            print("(Echo calibration timed out -- using the default multiplier.)")

        self._calibrating = False
        self._output_rms = 0.0
        self._output_rms_last_time = 0.0

        # Clean up: remove the calibration exchange from conversation
        # history so it doesn't show up as a fake turn later.
        for item_id in self._calibration_item_ids:
            await self._send({"type": "conversation.item.delete", "item_id": item_id})

        # Only trust pairs where she was actually audible, to avoid
        # near-silence samples skewing the ratio.
        usable = [(m, o) for m, o in self._calibration_samples
                  if o >= ECHO_GATE_MIN_FLOOR and m > 0]
        if len(usable) < 5:
            print("(Not enough signal to calibrate the echo gate -- "
                  f"using the default multiplier ({ECHO_GATE_RMS_MULTIPLIER}).)")
            self._echo_ratio = None
            return

        ratios = sorted(m / o for m, o in usable)
        measured_ratio = ratios[int(0.9 * (len(ratios) - 1))]
        self._echo_ratio = measured_ratio * ECHO_CALIBRATION_SAFETY_MARGIN
        print(f"Echo calibration done -- measured ratio {measured_ratio:.3f} "
              f"({len(usable)} samples), using {self._echo_ratio:.3f} "
              f"with safety margin.\n")

    async def _do_ptt_turn(self):
        await asyncio.to_thread(input, "\n[Enter] to start talking...")
        self._recording = True
        self._start_utterance()
        await asyncio.to_thread(input, "Recording -- [Enter] again to stop...")
        self._recording = False
        await self._finish_utterance_and_identify()
        await self._send({"type": "input_audio_buffer.commit"})
        await self._send({"type": "response.create"})

    # -- main loop -------------------------------------------------

    async def _run_async(self):
        self._loop = asyncio.get_running_loop()
        self._mic_queue = asyncio.Queue()
        self._play_queue = asyncio.Queue()

        await self._connect()

        mode_desc = "hands-free (server VAD)" if self.mode == "vad" else "push-to-talk"
        print(f"\n{self.name} is ready. Voice: {self.voice}. Mode: {mode_desc}")
        print(f"Personality:\n{self.instructions}\n")

        with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS, dtype="int16",
                             device=INPUT_DEVICE_INDEX, callback=self._mic_callback):
            receiver_task = asyncio.create_task(self._receiver())
            sender_task = asyncio.create_task(self._mic_sender())
            player_task = asyncio.create_task(self._player())
            printer_task = asyncio.create_task(self._transcript_printer())

            await self._calibrate_echo()

            try:
                if self.mode == "vad":
                    print("Hands-free -- just start talking whenever you're ready.")
                    print("Press Ctrl+C to exit.\n")
                    while True:
                        await asyncio.sleep(0.5)
                else:
                    print("(Type 'mode' + Enter to switch to hands-free, "
                          "'enroll' to add a voice, or 'quit' to exit.)")
                    while True:
                        choice = await asyncio.to_thread(
                            input, "\n['Enter' to talk, 'mode', 'enroll', or 'quit']: "
                        )
                        choice = choice.strip().lower()
                        if choice == "quit":
                            break
                        if choice == "enroll":
                            await asyncio.to_thread(self.enroll_speaker_interactive)
                            continue
                        if choice == "mode":
                            self.mode = "vad"
                            await self._apply_turn_detection()
                            print("Switched to hands-free (vad). Ctrl+C to exit.")
                            while True:
                                await asyncio.sleep(0.5)
                        await self._do_ptt_turn()
            except KeyboardInterrupt:
                print()
            finally:
                self._stop_flag = True
                for t in (receiver_task, sender_task, player_task, printer_task):
                    t.cancel()
                await self._ws.close()

        print("Goodbye!")

    def run(self):
        for trait in self.traits.values():
            if trait not in (1, 2, 3, 4, 5):
                sys.exit("All TRAITS values must be integers from 1 to 5.")
        if RECORDING_MODE not in ("push_to_talk", "vad"):
            sys.exit("RECORDING_MODE must be 'push_to_talk' or 'vad'.")

        try:
            chosen_voice = input(f"Voice for {self.name} [{self.voice}]: ").strip()
        except EOFError:
            chosen_voice = ""
        if chosen_voice:
            self.voice = chosen_voice

        self.maybe_enroll_speakers()

        try:
            asyncio.run(self._run_async())
        except KeyboardInterrupt:
            print("\nGoodbye!")


# ---------------------------------------------------------------------------
# 4. NOTE
# ---------------------------------------------------------------------------
# This file defines the shared base class only. Run 'python sage.py' (or
# another agent subclass) instead of this file directly.

if __name__ == "__main__":
    sys.exit(
        "agent_base.py defines the shared base class and isn't meant to be "
        "run directly. Run 'python sage.py' instead."
    )
