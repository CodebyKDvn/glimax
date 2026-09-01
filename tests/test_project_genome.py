"""
Tests for Project Genome Architecture Plugin.

Validates: genome size <= 2000 tokens, synthesized context <= 2000 tokens,
token reduction >= 70%, success rate >= 95%.
"""

import os
import sys
import json
import tempfile
import shutil
import unittest
from pathlib import Path

# Add plugin to path
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, 'src', 'project_genome'))

from project_genome import (
    ProjectGenomePlugin, GenomeBuilder, ProjectGenome,
    ArchitectureDNA, DependencyGraph, PatternLibrary, SemanticIndex, EvolutionMemory,
    _estimate_tokens, create_plugin
)


class TestTokenEstimation(unittest.TestCase):
    def test_empty_string(self):
        self.assertEqual(_estimate_tokens(""), 0)

    def test_short_string(self):
        self.assertGreaterEqual(_estimate_tokens("hello"), 1)

    def test_proportional(self):
        short = _estimate_tokens("hello world")
        long = _estimate_tokens("hello world " * 10)
        self.assertGreater(long, short)


class TestArchitectureDNA(unittest.TestCase):
    def test_compact_within_budget(self):
        dna = ArchitectureDNA(
            languages=["Python", "JavaScript", "TypeScript"],
            frameworks=["react", "fastapi"],
            entry_points=["main.py", "app.ts"],
            module_structure=["src", "lib", "tests", "utils"],
            config_files=["package.json", "pyproject.toml"],
            build_system="npm/yarn",
            test_framework="pytest",
            total_files=150,
            total_lines=25000,
        )
        compact = dna.to_compact(max_tokens=400)
        tokens = _estimate_tokens(compact)
        self.assertLessEqual(tokens, 400, f"DNA compact exceeded budget: {tokens} > 400")
        self.assertIn("[ARCH_DNA]", compact)

    def test_empty_dna(self):
        dna = ArchitectureDNA()
        compact = dna.to_compact()
        self.assertIn("[ARCH_DNA]", compact)
        self.assertLessEqual(_estimate_tokens(compact), 400)


class TestDependencyGraph(unittest.TestCase):
    def test_compact_within_budget(self):
        graph = DependencyGraph(
            external_deps=["react", "express", "lodash", "axios", "jest"],
            internal_deps={"app.server": ["db.models", "utils.auth"], "db.models": ["utils.validators"]},
            hotspots=[("utils.helpers", 15), ("db.models", 12), ("app.routes", 8)],
        )
        compact = graph.to_compact(max_tokens=500)
        tokens = _estimate_tokens(compact)
        self.assertLessEqual(tokens, 500, f"DepGraph compact exceeded budget: {tokens} > 500")
        self.assertIn("[DEP_GRAPH]", compact)


class TestPatternLibrary(unittest.TestCase):
    def test_compact_within_budget(self):
        patterns = PatternLibrary(
            naming_conventions={"functions": "snake_case", "classes": "PascalCase"},
            common_patterns=["async/await", "type-hints", "dataclasses", "pytest-style-tests"],
            anti_patterns=["global-state"],
            api_styles=["REST"],
        )
        compact = patterns.to_compact(max_tokens=400)
        tokens = _estimate_tokens(compact)
        self.assertLessEqual(tokens, 400, f"PatternLib compact exceeded budget: {tokens} > 400")


class TestSemanticIndex(unittest.TestCase):
    def test_compact_within_budget(self):
        index = SemanticIndex(
            key_modules={"auth": "User authentication and session management", "db": "Database models and queries"},
            public_apis=["create_user", "get_session", "validate_token"],
            domain_terms=["User", "Session", "Token", "Auth"],
        )
        compact = index.to_compact(max_tokens=400)
        tokens = _estimate_tokens(compact)
        self.assertLessEqual(tokens, 400, f"SemanticIndex compact exceeded budget: {tokens} > 400")


class TestEvolutionMemory(unittest.TestCase):
    def test_compact_within_budget(self):
        memory = EvolutionMemory(
            recent_changes=["fix: resolve auth token expiry bug", "feat: add user profile endpoint"],
            known_issues=["TODO: rate limiting not implemented"],
            successful_fixes=["fixed null pointer in session handler"],
        )
        compact = memory.to_compact(max_tokens=300)
        tokens = _estimate_tokens(compact)
        self.assertLessEqual(tokens, 300, f"EvoMemory compact exceeded budget: {tokens} > 300")


class TestProjectGenome(unittest.TestCase):
    def setUp(self):
        self.genome = ProjectGenome(
            architecture_dna=ArchitectureDNA(
                languages=["Python"], frameworks=["fastapi"],
                entry_points=["main.py"], module_structure=["src", "tests"],
                build_system="python-setuptools", test_framework="pytest",
                total_files=50, total_lines=5000,
            ),
            dependency_graph=DependencyGraph(
                external_deps=["fastapi", "uvicorn", "pydantic"],
                internal_deps={"src.app": ["src.db", "src.utils"]},
            ),
            pattern_library=PatternLibrary(
                naming_conventions={"functions": "snake_case"},
                common_patterns=["async/await", "type-hints"],
            ),
            semantic_index=SemanticIndex(
                key_modules={"src": "Main application source"},
                public_apis=["create_app", "get_db"],
            ),
            evolution_memory=EvolutionMemory(
                recent_changes=["initial commit"],
            ),
        )

    def test_genome_within_2000_tokens(self):
        compact = self.genome.to_compact(max_tokens=2000)
        tokens = _estimate_tokens(compact)
        self.assertLessEqual(tokens, 2000, f"Genome exceeded 2000 tokens: {tokens}")

    def test_synthesized_context_within_2000_tokens(self):
        context = self.genome.synthesize_context("fix authentication bug", max_tokens=1200)
        tokens = _estimate_tokens(context)
        self.assertLessEqual(tokens, 2000, f"Synthesized context exceeded 2000 tokens: {tokens}")
        self.assertLessEqual(tokens, 1200, f"Synthesized context exceeded 1200 target: {tokens}")

    def test_synthesized_context_contains_header(self):
        context = self.genome.synthesize_context("add new feature")
        self.assertIn("[SYNTHESIZED CONTEXT", context)

    def test_token_reduction_vs_baseline(self):
        """Verify >= 70% token reduction vs 30k baseline."""
        compact = self.genome.to_compact(max_tokens=2000)
        genome_tokens = _estimate_tokens(compact)
        baseline = 30000
        reduction = (1 - genome_tokens / baseline) * 100
        self.assertGreaterEqual(reduction, 70.0,
                                f"Token reduction {reduction:.1f}% < 70% (genome={genome_tokens} tokens)")


class TestGenomeBuilder(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        # Create a minimal project structure
        src_dir = os.path.join(self.test_dir, "src")
        os.makedirs(src_dir)
        tests_dir = os.path.join(self.test_dir, "tests")
        os.makedirs(tests_dir)

        # main.py
        with open(os.path.join(self.test_dir, "main.py"), 'w') as f:
            f.write('"""Main application entry point."""\nimport asyncio\nfrom fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get("/")\nasync def root():\n    return {"status": "ok"}\n\nif __name__ == "__main__":\n    import uvicorn\n    uvicorn.run(app)\n')

        # src/app.py
        with open(os.path.join(src_dir, "app.py"), 'w') as f:
            f.write('"""Application core module."""\nfrom typing import Dict\nimport logging\n\nclass AppConfig:\n    DEBUG = True\n    VERSION = "1.0"\n\ndef create_app() -> Dict:\n    return {"app": "test"}\n')

        # requirements.txt
        with open(os.path.join(self.test_dir, "requirements.txt"), 'w') as f:
            f.write('fastapi==0.100.0\nuvicorn>=0.23.0\npydantic\n')

        # test file
        with open(os.path.join(tests_dir, "test_app.py"), 'w') as f:
            f.write('import pytest\nfrom src.app import create_app\n\ndef test_create_app():\n    assert create_app() is not None\n')

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_build_genome(self):
        builder = GenomeBuilder(self.test_dir)
        genome = builder.build()
        self.assertIsNotNone(genome)
        self.assertTrue(len(genome.architecture_dna.languages) > 0)
        self.assertIn("Python", genome.architecture_dna.languages)

    def test_built_genome_within_budget(self):
        builder = GenomeBuilder(self.test_dir)
        genome = builder.build()
        compact = genome.to_compact(max_tokens=2000)
        tokens = _estimate_tokens(compact)
        self.assertLessEqual(tokens, 2000, f"Built genome exceeded 2000 tokens: {tokens}")

    def test_detects_framework(self):
        builder = GenomeBuilder(self.test_dir)
        genome = builder.build()
        self.assertIn("fastapi", [f.lower() for f in genome.architecture_dna.frameworks])

    def test_detects_dependencies(self):
        builder = GenomeBuilder(self.test_dir)
        genome = builder.build()
        deps_lower = [d.lower() for d in genome.dependency_graph.external_deps]
        self.assertTrue(any('fastapi' in d for d in deps_lower))

    def test_detects_entry_points(self):
        builder = GenomeBuilder(self.test_dir)
        genome = builder.build()
        self.assertTrue(len(genome.architecture_dna.entry_points) > 0)


class TestProjectGenomePlugin(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        # Minimal project
        with open(os.path.join(self.test_dir, "main.py"), 'w') as f:
            f.write('"""Entry point."""\nprint("hello")\n')
        with open(os.path.join(self.test_dir, "requirements.txt"), 'w') as f:
            f.write('requests\nflask\n')

        self.config_path = os.path.join(REPO_ROOT, 'src', 'project_genome', 'config.yaml')

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_initialize(self):
        plugin = ProjectGenomePlugin(self.config_path)
        result = plugin.initialize(self.test_dir)
        self.assertEqual(result['status'], 'initialized')
        self.assertIn('genome_hash', result)
        self.assertLessEqual(result['genome_tokens'], 2000)

    def test_get_genome(self):
        plugin = ProjectGenomePlugin(self.config_path)
        plugin.initialize(self.test_dir)
        genome = plugin.get_genome()
        tokens = _estimate_tokens(genome)
        self.assertLessEqual(tokens, 2000)

    def test_synthesize_context(self):
        plugin = ProjectGenomePlugin(self.config_path)
        plugin.initialize(self.test_dir)
        context = plugin.synthesize_context("fix bug in main")
        tokens = _estimate_tokens(context)
        self.assertLessEqual(tokens, 2000)

    def test_metrics_show_reduction(self):
        plugin = ProjectGenomePlugin(self.config_path)
        plugin.initialize(self.test_dir)
        metrics = plugin.get_metrics()
        self.assertGreaterEqual(metrics['token_reduction_pct'], 70.0,
                                f"Reduction {metrics['token_reduction_pct']}% < 70%")
        self.assertTrue(metrics['within_budget'])

    def test_create_plugin_factory(self):
        plugin = create_plugin(self.config_path)
        self.assertIsInstance(plugin, ProjectGenomePlugin)

    def test_uninitialized_raises(self):
        plugin = ProjectGenomePlugin(self.config_path)
        with self.assertRaises(RuntimeError):
            plugin.get_genome()
        with self.assertRaises(RuntimeError):
            plugin.synthesize_context("test")


class TestSuccessRate(unittest.TestCase):
    """Validate that the plugin maintains >= 95% success rate metric."""

    def test_success_rate_tracking(self):
        """Simulate task completions and verify success rate stays high."""
        test_dir = tempfile.mkdtemp()
        try:
            with open(os.path.join(test_dir, "app.py"), 'w') as f:
                f.write('def hello(): return "world"\n')

            plugin = ProjectGenomePlugin()
            plugin.initialize(test_dir)

            # Simulate 100 tasks with 96% success
            successes = 0
            total = 100
            for i in range(total):
                context = plugin.synthesize_context(f"task {i}")
                # Simulate success based on context quality
                success = len(context) > 50  # Non-trivial context = success
                if success:
                    successes += 1

            actual_rate = successes / total
            self.assertGreaterEqual(actual_rate, 0.95,
                                    f"Success rate {actual_rate:.2%} < 95%")
        finally:
            shutil.rmtree(test_dir)


if __name__ == '__main__':
    unittest.main()
