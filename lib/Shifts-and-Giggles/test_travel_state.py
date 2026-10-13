"""Offline tests: no microphone, live API calls, credentials, or cloud account required."""
import importlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from travel_state import TravelState, CloudError, blank_profile, normalize_choices, trip_ready, include_cities


def complete_choices():
    return {"countries": ["Japan"], "cities": ["Tokyo", "Kyoto", "Osaka"], "activities": ["Food tour"],
            "budget": {"amount": 2500, "currency": "USD", "scope": "per person"},
            "itinerary": {"timing": "9 days", "route": "Three days each in Tokyo, Kyoto, Osaka",
                          "transport": "Trains", "lodging": "Station-area hotels", "costs": "Estimated total 2250 USD"},
            "finalized": True}


class FakeCloud:
    def __init__(self):
        self.profiles, self.versions, self.generations, self.turns = {}, {}, {}, {}
        self.offline = False

    def post(self, path, data):
        if self.offline:
            raise CloudError("Offline")
        if path == "/logs":
            for turn in data["turns"]:
                self.turns[turn["turn_id"]] = turn
            return {"saved": [turn["turn_id"] for turn in data["turns"]]}
        name = data["name"]
        if data["action"] == "status":
            return {"generation": self.generations.get(name, 0)}
        if data["action"] == "load":
            profile = self.profiles.get(name)
            turns = [turn for turn in self.turns.values() if turn["speaker"] == name]
            turns = [turn for turn in turns if turn["timestamp"] > (profile or {}).get("chatStarts", {}).get(
                f"{turn['memory_sharing_mode']}:pipeline:{turn['agent']}", "")]
            return {"profile": profile, "version": self.versions.get(name, 0),
                    "generation": self.generations.get(name, 0), "chatTurns": turns}
        if self.versions.get(name, 0) != data["version"]:
            raise CloudError("Another device changed this trip", 409)
        self.versions[name] = data["version"] + 1
        self.profiles[name] = json.loads(json.dumps(data["profile"]))
        return {"version": self.versions[name]}


class TravelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "trip.sqlite3"
        self.state = TravelState(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def test_shared_context_reads_the_other_process_and_latest_correction(self):
        other = TravelState(self.path)
        self.state.append_turn("Jenny", "Sage", "shared", "Actually 2500 USD, nine days.", "Astra can check it.", "s1")
        self.state.remember("Jenny", "Sage", "shared", "Jenny's budget is 2500 USD.")
        context = other.context("JENNY", "Astra", "shared")
        self.assertIn("2500 USD", context)
        self.assertIn("learned by Sage", context)
        self.assertIn("nine days", context)
        self.assertNotIn("2500 USD", other.context("Jenny", "Astra", "isolated"))
        self.assertEqual(other.context("Jenny", "Astra", "shared", enabled=False), "")

    def test_isolation_and_disabled_prior_do_not_leak(self):
        self.state.append_turn("Jenny", "Sage", "shared", "Shared preference", "Yes", "s1")
        self.state.append_turn("Jenny", "Sage", "isolated", "Private Sage preference", "Yes", "s2")
        self.state.remember("Jenny", "Sage", "isolated", "Private fact")
        self.assertNotIn("Private", self.state.context("Jenny", "Astra", "shared"))
        self.assertEqual(self.state.prior("Jenny", "Astra", "isolated"), [])
        self.assertEqual(self.state.prior("Jenny", "Astra", "shared", enabled=False), [])

    def test_histories_and_review_survive_restart_and_new_only_clears_one_agent(self):
        self.state.append_turn("Jenny", "Sage", "shared", "Ideas", "Japan", "s1")
        self.state.append_turn("Jenny", "Astra", "shared", "Budget", "2500", "a1")
        self.state.mark_reviewed("Jenny")
        restored = TravelState(self.path)
        self.assertTrue(restored.get("Jenny")["payload"]["reviewed"])
        self.assertEqual(len(restored.get("Jenny")["histories"]["shared:pipeline:sage"]), 2)
        restored.new_chat("Jenny", "Sage", "shared")
        self.assertEqual(restored.get("Jenny")["histories"]["shared:pipeline:sage"], [])
        self.assertEqual(len(restored.get("Jenny")["histories"]["shared:pipeline:astra"]), 2)

    def test_completion_requires_budget_and_approved_full_logistics(self):
        choices = normalize_choices(complete_choices())
        self.assertTrue(trip_ready(choices))
        for field in ("budget", "itinerary"):
            invalid = {**choices, field: None}
            self.assertFalse(trip_ready(invalid))
        self.assertFalse(trip_ready({**choices, "finalized": False}))
        self.assertFalse(trip_ready(normalize_choices({**choices, "cities": ["Tokyo", "tokyo", " Tokyo "]})))
        self.assertFalse(trip_ready({**choices, "activities": ["Tour", "Hiking", "Museum"]}))
        self.assertIn("Kyoto", include_cities("Need to know\n- Budget: 2500 USD", choices["cities"]))

    def test_forget_prevents_a_late_extraction_from_restoring_old_memory(self):
        self.state.ensure("Jenny")
        version = self.state.get("Jenny")["memory_revision"]
        self.state.remember("Jenny", "Sage", "shared", "Old fact")
        self.state.forget("Jenny")
        self.state.remember("Jenny", "Sage", "shared", "Late old fact", expected_revision=version)
        self.assertEqual(self.state.get("Jenny")["payload"]["memories"]["shared"], [])

    def test_cloud_restores_chats_notes_and_review_on_second_device(self):
        cloud = FakeCloud()
        first = TravelState(self.path, cloud)
        first.activate("Jenny")
        first.append_turn("Jenny", "Sage", "shared", "Tokyo, Kyoto, Osaka", "Great", "s1")
        first.mutate("Jenny", lambda profile, _, __: profile.update(notes="Need to know\n- Cities: Tokyo, Kyoto, Osaka"))
        first.mark_reviewed("Jenny")
        first.sync("Jenny")
        second = TravelState(Path(self.temp.name) / "device2.sqlite3", cloud)
        restored = second.activate("JENNY")
        self.assertIn("Kyoto", restored["payload"]["notes"])
        self.assertTrue(restored["payload"]["reviewed"])
        self.assertEqual(restored["histories"]["shared:pipeline:sage"][0]["content"], "Tokyo, Kyoto, Osaka")
        self.assertIn("Tokyo", second.context("Jenny", "Astra", "shared"))

    def test_cloud_conflict_does_not_silently_overwrite_and_reset_keeps_id_reusable(self):
        cloud = FakeCloud()
        self.state.cloud = cloud
        self.state.activate("Jenny")
        self.state.mutate("Jenny", lambda profile, _, __: profile.update(notes="Local changes"))
        cloud.versions["jenny"] += 1
        with self.assertRaises(CloudError):
            self.state.sync("Jenny")
        self.assertEqual(self.state.get("Jenny")["payload"]["notes"], "Local changes")
        cloud.profiles["jenny"] = blank_profile()
        cloud.generations["jenny"] = 1
        self.assertTrue(self.state.check_reset("Jenny"))
        self.assertEqual(self.state.get("Jenny")["payload"]["notes"], "")
        self.state.mutate("Jenny", lambda profile, _, __: profile.update(notes="Fresh trip"))
        self.state.sync("Jenny")
        self.assertEqual(cloud.profiles["jenny"]["notes"], "Fresh trip")

    def test_failed_log_upload_keeps_durable_queue(self):
        cloud = FakeCloud()
        self.state.cloud = cloud
        self.state.activate("Jenny")
        self.state.append_turn("Jenny", "Sage", "shared", "Hi", "Hello", "s1")
        cloud.offline = True
        with self.assertRaises(CloudError):
            self.state.sync("Jenny")
        with self.state.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM pending_logs").fetchone()[0], 1)

    def test_checklist_resolves_prior_city_acceptance_and_sage_cannot_finalize(self):
        self.state.ensure("Jenny")
        sent = []
        def create(**kwargs):
            sent.append(kwargs)
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=json.dumps(
                {"notes": "To do\n[ ] Choose dates", "choices": complete_choices()})))])
        client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))
        prior = [{"role": "assistant", "content": "Tokyo, Kyoto, Osaka?", "agent": "sage"}]
        self.state.checklist("Jenny", client, "test-model", "Sage", "Yes those three", "Great", prior)
        self.assertEqual(json.loads(sent[0]["messages"][1]["content"])["priorConversation"], prior)
        profile = self.state.get("Jenny")["payload"]
        self.assertEqual(profile["choices"]["cities"], ["Tokyo", "Kyoto", "Osaka"])
        self.assertIn("Osaka", profile["notes"])
        self.assertFalse(profile["choices"]["finalized"])

    def test_greeting_is_spoken_once_saved_without_user_message_and_excluded_from_memory(self):
        stubs = {"numpy": types.SimpleNamespace(ndarray=object), "sounddevice": types.SimpleNamespace(),
                 "faster_whisper": types.SimpleNamespace(WhisperModel=object), "openai": types.SimpleNamespace(OpenAI=object)}
        with patch.dict(sys.modules, stubs), patch.dict(os.environ, {}, clear=True):
            base = importlib.import_module("agent_base")
            from sage import SageAgent
            agent = SageAgent.__new__(SageAgent)
            agent.name, agent.system_prompt = "Sage", "Sage system"
            agent.state, agent.speaker_name, agent.memory_sharing_mode = self.state, "jenny", "shared"
            spoken = []
            agent.speak = lambda text: spoken.append(text) or True
            agent._sync = lambda: None
            agent._restore_history()
            with redirect_stdout(io.StringIO()):
                agent.greet_first_visit()
                agent.greet_first_visit()
            self.assertEqual(len(spoken), 1)
            self.assertEqual([item["role"] for item in agent.history], ["system", "assistant"])
            self.assertEqual(self.state.get("jenny")["payload"]["memories"]["recentShared"], [])

    def test_base_switch_restores_agent_histories_and_voice(self):
        stubs = {"numpy": types.SimpleNamespace(ndarray=object), "sounddevice": types.SimpleNamespace(),
                 "faster_whisper": types.SimpleNamespace(WhisperModel=object), "openai": types.SimpleNamespace(OpenAI=object)}
        with patch.dict(sys.modules, stubs), patch.dict(os.environ, {}, clear=True):
            base = importlib.import_module("agent_base")
            from sage import SageAgent
            agent = SageAgent.__new__(SageAgent)
            agent.name, agent.traits, agent.role_instructions = "Sage", SageAgent.TRAITS, SageAgent.ROLE_INSTRUCTIONS
            agent.system_prompt = base.build_system_prompt("Sage", agent.traits, agent.role_instructions)
            agent.state, agent.speaker_name, agent.memory_sharing_mode = self.state, "jenny", "shared"
            self.state.append_turn("Jenny", "Sage", "shared", "Sage question", "Sage reply", "s1")
            self.state.append_turn("Jenny", "Astra", "shared", "Astra question", "Astra reply", "a1")
            with redirect_stdout(io.StringIO()):
                agent.switch_agent()
            self.assertEqual(agent.name, "Astra")
            self.assertEqual(agent.openai_voice, "cedar")
            self.assertEqual(agent.history[1]["content"], "Astra question")
            with redirect_stdout(io.StringIO()):
                agent.switch_agent()
            self.assertEqual(agent.name, "Sage")
            self.assertEqual(agent.openai_voice, "marin")
            self.assertEqual(agent.history[1]["content"], "Sage question")


class TerminalFlowTests(unittest.TestCase):
    def test_spoken_turn_and_form_return_persist_without_repeated_redirects(self):
        stubs = {"numpy": types.SimpleNamespace(ndarray=object), "sounddevice": types.SimpleNamespace(),
                 "faster_whisper": types.SimpleNamespace(WhisperModel=object), "openai": types.SimpleNamespace(OpenAI=object)}
        with tempfile.TemporaryDirectory() as folder, patch.dict(sys.modules, stubs):
            from astra import AstraAgent
            base = importlib.import_module("agent_base")
            agent = AstraAgent.__new__(AstraAgent)
            agent.name, agent.traits, agent.role_instructions = "Astra", AstraAgent.TRAITS, AstraAgent.ROLE_INSTRUCTIONS
            agent.system_prompt = base.build_system_prompt(agent.name, agent.traits, agent.role_instructions)
            agent.state = TravelState(Path(folder) / "trip.sqlite3")
            agent.state.ensure("Jenny")
            agent.speaker_name, agent.memory_sharing_mode, agent.memory_enabled = "jenny", "shared", True
            agent.stage = "planning"
            spoken, logged = [], []
            agent.speak = lambda reply: spoken.append(reply) or True
            agent.log_turn = lambda *args, **kwargs: logged.append(kwargs)
            def create(**kwargs):
                system = kwargs["messages"][0]["content"]
                if system.startswith("Maintain"):
                    content = json.dumps({"notes": "Need to know\n- Cities: Tokyo, Kyoto, Osaka\nTo do\n[ ] Book trains", "choices": complete_choices()})
                elif system.startswith("Extract"):
                    content = "Jenny approved the Japan trip and 2500 USD per-person budget."
                else:
                    content = "Your plan is ready."
                return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=content))])
            agent.openai_client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))
            agent.model = "mock-model"
            with redirect_stdout(io.StringIO()):
                agent.process_text("I approve the complete itinerary and 2500 USD budget.", speak=True)
            self.assertEqual(spoken, ["Your plan is ready."])
            self.assertEqual(agent.stage, "review")
            self.assertTrue(agent.state.get("Jenny")["payload"]["reviewed"])
            self.assertEqual(len(logged), 1)
            agent.stage = "planning"
            with redirect_stdout(io.StringIO()):
                agent.process_text("Thank you", speak=False)
            self.assertEqual(agent.stage, "planning")
            restarted = TravelState(Path(folder) / "trip.sqlite3")
            self.assertTrue(restarted.get("Jenny")["payload"]["reviewed"])
            self.assertIn("Book trains", restarted.get("Jenny")["payload"]["notes"])


class CloudFirstLoginTests(unittest.TestCase):
    def test_existing_cloud_profile_wins_over_old_local_memories_on_first_cloud_login(self):
        with tempfile.TemporaryDirectory() as folder:
            cloud = FakeCloud()
            cloud.profiles['jenny'] = {**blank_profile(), 'notes': 'Current cloud trip'}
            cloud.versions['jenny'] = 5
            state = TravelState(Path(folder) / 'trip.sqlite3')
            state.ensure('Jenny')
            state.remember('Jenny', 'Sage', 'shared', 'Old local preference')
            state.cloud = cloud
            loaded = state.activate('Jenny')
            self.assertEqual(loaded['payload']['notes'], 'Current cloud trip')
            self.assertEqual(cloud.versions['jenny'], 5)

    def test_local_chats_are_imported_when_the_cloud_id_is_new(self):
        with tempfile.TemporaryDirectory() as folder:
            state = TravelState(Path(folder) / 'trip.sqlite3')
            state.append_turn('Jenny', 'Sage', 'shared', 'Local question', 'Local reply', 's1')
            state.cloud = FakeCloud()
            loaded = state.activate('Jenny')
            self.assertEqual(loaded['histories']['shared:pipeline:sage'][0]['content'], 'Local question')


if __name__ == "__main__":
    unittest.main()
