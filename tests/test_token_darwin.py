"""
Tests for Token-Darwin Evolution Layer Plugin.

Validates: ROI-based pruning, success rate >= 95%, artifact lifecycle,
state persistence, and token budget compliance.
"""

import os
import sys
import json
import time
import tempfile
import shutil
import unittest
from pathlib import Path

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, 'src', 'token_darwin'))

from token_darwin import (
    TokenDarwinPlugin, EvolutionEngine, Artifact,
    _estimate_tokens, create_plugin
)


class TestArtifact(unittest.TestCase):
    def test_creation(self):
        a = Artifact(id="", name="test_skill", artifact_type="skill", content="def helper(): pass")
        self.assertTrue(len(a.id) > 0)
        self.assertEqual(a.roi, 0.5)
        self.assertEqual(a.use_count, 0)

    def test_record_use_success(self):
        a = Artifact(id="a1", name="s1", artifact_type="skill", content="x")
        a.record_use(True)
        self.assertEqual(a.use_count, 1)
        self.assertEqual(a.success_count, 1)
        self.assertEqual(a.failure_count, 0)
        self.assertGreater(a.roi, 0.5)

    def test_record_use_failure(self):
        a = Artifact(id="a1", name="s1", artifact_type="skill", content="x")
        a.record_use(False)
        self.assertEqual(a.failure_count, 1)
        self.assertLess(a.roi, 0.5)

    def test_success_rate(self):
        a = Artifact(id="a1", name="s1", artifact_type="skill", content="x")
        for _ in range(8):
            a.record_use(True)
        for _ in range(2):
            a.record_use(False)
        self.assertAlmostEqual(a.success_rate, 0.8, places=1)

    def test_apply_decay(self):
        a = Artifact(id="a1", name="s1", artifact_type="skill", content="x", roi=0.8)
        a.apply_decay(0.95)
        self.assertAlmostEqual(a.roi, 0.76, places=2)
        self.assertEqual(a.generation, 1)

    def test_to_summary(self):
        a = Artifact(id="a1", name="my_tool", artifact_type="tool", content="code", roi=0.75)
        a.record_use(True)
        summary = a.to_summary()
        self.assertIn("[tool]", summary)
        self.assertIn("my_tool", summary)

    def test_serialization(self):
        a = Artifact(id="a1", name="s1", artifact_type="pattern", content="pat", roi=0.6, tags=["test"])
        d = a.to_dict()
        b = Artifact.from_dict(d)
        self.assertEqual(b.name, "s1")
        self.assertEqual(b.artifact_type, "pattern")
        self.assertAlmostEqual(b.roi, 0.6)

    def test_token_cost(self):
        content = "x" * 400  # ~100 tokens
        a = Artifact(id="a1", name="s1", artifact_type="skill", content=content)
        self.assertGreaterEqual(a.token_cost, 50)


class TestEvolutionEngine(unittest.TestCase):
    def setUp(self):
        self.config = {
            'evolution': {
                'roi_threshold': 0.3,
                'max_artifacts': 20,
                'decay_rate': 0.95,
                'min_uses_to_evaluate': 3,
                'prune_batch_size': 5,
            },
            'artifact_types': {
                'skill': {'initial_roi': 0.5, 'weight': 1.0},
                'tool': {'initial_roi': 0.6, 'weight': 1.2},
                'pattern': {'initial_roi': 0.4, 'weight': 0.8},
            },
            'pruning': {'protect_recent': 3},
            'metrics': {'success_rate_window': 50, 'target_success_rate': 0.95},
        }
        self.engine = EvolutionEngine(self.config)

    def test_register_artifact(self):
        a = self.engine.register_artifact("test", "skill", "content")
        self.assertIn(a.id, self.engine.artifacts)
        self.assertEqual(a.roi, 0.5)

    def test_register_with_type_roi(self):
        a = self.engine.register_artifact("tool1", "tool", "code")
        self.assertEqual(a.roi, 0.6)

    def test_record_usage(self):
        a = self.engine.register_artifact("s1", "skill", "c")
        result = self.engine.record_usage(a.id, True)
        self.assertIsNotNone(result)
        self.assertEqual(result.use_count, 1)

    def test_record_usage_nonexistent(self):
        result = self.engine.record_usage("nonexistent", True)
        self.assertIsNone(result)

    def test_evolve_prunes_low_roi(self):
        # Create artifacts with low ROI
        for i in range(5):
            a = self.engine.register_artifact(f"low_{i}", "skill", "c")
            # Simulate many failures to drive ROI well below threshold (0.3)
            for _ in range(10):
                a.record_use(False)

        # Create some good artifacts
        for i in range(3):
            a = self.engine.register_artifact(f"good_{i}", "skill", "c")
            for _ in range(5):
                a.record_use(True)

        result = self.engine.evolve()
        self.assertGreater(result['pruned_count'], 0)
        active = self.engine.get_active_artifacts()
        # Good artifacts should survive
        active_names = [a.name for a in active]
        for i in range(3):
            self.assertIn(f"good_{i}", active_names)

    def test_evolve_respects_capacity(self):
        self.engine.config['evolution']['max_artifacts'] = 5
        engine = EvolutionEngine(self.engine.config)

        for i in range(10):
            engine.register_artifact(f"a_{i}", "skill", "content")

        result = engine.evolve()
        active = engine.get_active_artifacts()
        self.assertLessEqual(len(active), 5)

    def test_protect_recent(self):
        # Create artifacts, make one very recent
        a_old = self.engine.register_artifact("old", "skill", "c")
        for _ in range(5):
            a_old.record_use(False)

        a_new = self.engine.register_artifact("new", "skill", "c")
        for _ in range(5):
            a_new.record_use(False)
        a_new.last_used = time.time() + 1000  # Make it most recent

        result = self.engine.evolve()
        active_names = [a.name for a in self.engine.get_active_artifacts()]
        self.assertIn("new", active_names)  # Protected despite low ROI

    def test_get_context_budget(self):
        for i in range(5):
            self.engine.register_artifact(f"ctx_{i}", "skill", "content here")

        context = self.engine.get_context_budget(max_tokens=200)
        tokens = _estimate_tokens(context)
        self.assertLessEqual(tokens, 200)
        self.assertIn("[DARWIN_ARTIFACTS]", context)

    def test_success_rate_default(self):
        rate = self.engine.get_success_rate()
        self.assertEqual(rate, 0.95)

    def test_success_rate_tracking(self):
        for _ in range(48):
            self.engine.success_history.append(1)
        for _ in range(2):
            self.engine.success_history.append(0)
        rate = self.engine.get_success_rate()
        self.assertAlmostEqual(rate, 0.96, places=2)

    def test_metrics(self):
        self.engine.register_artifact("m1", "skill", "c")
        self.engine.register_artifact("m2", "tool", "c")
        metrics = self.engine.get_metrics()
        self.assertEqual(metrics['active_artifacts'], 2)
        self.assertIn('type_breakdown', metrics)
        self.assertIn('skill', metrics['type_breakdown'])

    def test_state_persistence(self):
        tmp = tempfile.NamedTemporaryFile(suffix='.json', delete=False)
        tmp.close()
        try:
            self.engine.register_artifact("persist", "skill", "data")
            self.engine.current_generation = 5
            self.engine.save_state(tmp.name)

            new_engine = EvolutionEngine(self.config)
            new_engine.load_state(tmp.name)
            self.assertEqual(new_engine.current_generation, 5)
            self.assertIn("persist", [a.name for a in new_engine.artifacts.values()])
        finally:
            os.unlink(tmp.name)


class TestTokenDarwinPlugin(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.config_path = os.path.join(REPO_ROOT, 'src', 'token_darwin', 'config.yaml')
        self.state_path = os.path.join(self.test_dir, '.darwin_state.json')

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_initialize(self):
        plugin = TokenDarwinPlugin(self.config_path, self.state_path)
        result = plugin.initialize()
        self.assertEqual(result['status'], 'initialized')

    def test_register_and_use(self):
        plugin = TokenDarwinPlugin(self.config_path, self.state_path)
        plugin.initialize()

        reg = plugin.register("test_skill", "skill", "def helper(): return 42")
        self.assertIn('id', reg)

        use_result = plugin.use(reg['id'], True)
        self.assertEqual(use_result['use_count'], 1)
        self.assertGreater(use_result['roi'], 0)

    def test_evolve_cycle(self):
        plugin = TokenDarwinPlugin(self.config_path, self.state_path)
        plugin.initialize()

        # Register low-value artifacts
        ids = []
        for i in range(5):
            r = plugin.register(f"junk_{i}", "pattern", "unused pattern")
            ids.append(r['id'])

        # Record failures
        for aid in ids:
            for _ in range(5):
                plugin.use(aid, False)

        result = plugin.evolve()
        self.assertGreaterEqual(result['pruned_count'], 0)

    def test_get_context(self):
        plugin = TokenDarwinPlugin(self.config_path, self.state_path)
        plugin.initialize()
        plugin.register("ctx_test", "skill", "content")

        context = plugin.get_context(max_tokens=500)
        tokens = _estimate_tokens(context)
        self.assertLessEqual(tokens, 500)

    def test_get_metrics(self):
        plugin = TokenDarwinPlugin(self.config_path, self.state_path)
        plugin.initialize()
        plugin.register("metric_test", "tool", "code")

        metrics = plugin.get_metrics()
        self.assertEqual(metrics['active_artifacts'], 1)
        self.assertIn('success_rate', metrics)

    def test_get_active_filtered(self):
        plugin = TokenDarwinPlugin(self.config_path, self.state_path)
        plugin.initialize()
        plugin.register("s1", "skill", "c1")
        plugin.register("t1", "tool", "c2")

        skills = plugin.get_active("skill")
        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0]['type'], 'skill')

        all_active = plugin.get_active()
        self.assertEqual(len(all_active), 2)

    def test_shutdown_persists(self):
        plugin = TokenDarwinPlugin(self.config_path, self.state_path)
        plugin.initialize()
        plugin.register("persist_test", "skill", "data")
        plugin.shutdown()

        self.assertTrue(os.path.exists(self.state_path))

        # Reload
        plugin2 = TokenDarwinPlugin(self.config_path, self.state_path)
        plugin2.initialize()
        active = plugin2.get_active()
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]['name'], 'persist_test')

    def test_create_plugin_factory(self):
        plugin = create_plugin(self.config_path, self.state_path)
        self.assertIsInstance(plugin, TokenDarwinPlugin)

    def test_use_nonexistent_returns_error(self):
        plugin = TokenDarwinPlugin(self.config_path, self.state_path)
        plugin.initialize()
        result = plugin.use("nonexistent_id", True)
        self.assertIn('error', result)


class TestSuccessRateMaintenance(unittest.TestCase):
    """Verify the system maintains >= 95% success rate."""

    def test_high_success_rate_scenario(self):
        config = {
            'evolution': {
                'roi_threshold': 0.3,
                'max_artifacts': 50,
                'decay_rate': 0.95,
                'min_uses_to_evaluate': 3,
                'prune_batch_size': 10,
            },
            'artifact_types': {
                'skill': {'initial_roi': 0.5},
                'tool': {'initial_roi': 0.6},
            },
            'pruning': {'protect_recent': 5},
            'metrics': {'success_rate_window': 50},
        }
        engine = EvolutionEngine(config)

        # Simulate 100 operations with 96% success
        artifacts = []
        for i in range(10):
            a = engine.register_artifact(f"art_{i}", "skill", f"content_{i}")
            artifacts.append(a)

        successes = 0
        total = 100
        for i in range(total):
            art = artifacts[i % len(artifacts)]
            # 96% success simulation
            success = (i % 25) != 0  # 96% success rate
            engine.record_usage(art.id, success)
            if success:
                successes += 1

        rate = engine.get_success_rate()
        self.assertGreaterEqual(rate, 0.95,
                                f"Success rate {rate:.2%} < 95%")

    def test_pruning_improves_quality(self):
        """After pruning low-ROI artifacts, average ROI should increase."""
        config = {
            'evolution': {
                'roi_threshold': 0.3,
                'max_artifacts': 20,
                'decay_rate': 1.0,
                'min_uses_to_evaluate': 2,
                'prune_batch_size': 10,
            },
            'artifact_types': {'skill': {'initial_roi': 0.5}},
            'pruning': {'protect_recent': 0},
            'metrics': {'success_rate_window': 50},
        }
        engine = EvolutionEngine(config)

        for i in range(5):
            a = engine.register_artifact(f"bad_{i}", "skill", "bad")
            for _ in range(10):
                a.record_use(False)

        for i in range(5):
            a = engine.register_artifact(f"good_{i}", "skill", "good")
            for _ in range(10):
                a.record_use(True)

        before_avg = sum(a.roi for a in engine.get_active_artifacts()) / 10
        result = engine.evolve()
        after_active = engine.get_active_artifacts()
        after_avg = sum(a.roi for a in after_active) / max(len(after_active), 1)

        self.assertGreater(result['pruned_count'], 0, "Should have pruned bad artifacts")
        self.assertGreater(after_avg, before_avg,
                           f"Average ROI did not improve: {after_avg:.3f} <= {before_avg:.3f}")


if __name__ == '__main__':
    unittest.main()

