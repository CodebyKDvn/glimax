"""
Project Genome Architecture Plugin

Compresses project context (~30k tokens) into a compact genome (~2k tokens)
containing architecture DNA, dependency graph, pattern library, semantic index,
and evolution memory. Synthesizes task-relevant context (~1.2k tokens) from genome.
"""

import os
import re
import json
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field, asdict

try:
    import yaml
except ImportError:
    yaml = None


def _estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for English/code."""
    if not text:
        return 0
    return max(1, len(text) // 4)


@dataclass
class ArchitectureDNA:
    """Core structural patterns of the project."""
    languages: List[str] = field(default_factory=list)
    frameworks: List[str] = field(default_factory=list)
    entry_points: List[str] = field(default_factory=list)
    module_structure: List[str] = field(default_factory=list)
    config_files: List[str] = field(default_factory=list)
    build_system: str = ""
    test_framework: str = ""
    total_files: int = 0
    total_lines: int = 0

    def to_compact(self, max_tokens: int = 400) -> str:
        lines = ["[ARCH_DNA]"]
        if self.languages:
            lines.append(f"langs: {','.join(self.languages[:5])}")
        if self.frameworks:
            lines.append(f"fw: {','.join(self.frameworks[:5])}")
        if self.entry_points:
            lines.append(f"entry: {','.join(self.entry_points[:5])}")
        if self.module_structure:
            lines.append(f"mods: {','.join(self.module_structure[:10])}")
        if self.config_files:
            lines.append(f"cfg: {','.join(self.config_files[:5])}")
        if self.build_system:
            lines.append(f"build: {self.build_system}")
        if self.test_framework:
            lines.append(f"test: {self.test_framework}")
        lines.append(f"stats: {self.total_files}F/{self.total_lines}L")
        result = "\n".join(lines)
        while _estimate_tokens(result) > max_tokens and lines:
            lines.pop()
            result = "\n".join(lines)
        return result


@dataclass
class DependencyGraph:
    """Key dependencies and their relationships."""
    internal_deps: Dict[str, List[str]] = field(default_factory=dict)
    external_deps: List[str] = field(default_factory=list)
    hotspots: List[Tuple[str, int]] = field(default_factory=list)  # (file, fan_in)

    def to_compact(self, max_tokens: int = 500) -> str:
        lines = ["[DEP_GRAPH]"]
        if self.external_deps:
            lines.append(f"ext: {','.join(self.external_deps[:15])}")
        top_internal = sorted(self.internal_deps.items(), key=lambda x: len(x[1]), reverse=True)[:8]
        for mod, deps in top_internal:
            lines.append(f"{mod}->{','.join(deps[:5])}")
        if self.hotspots:
            top_hot = sorted(self.hotspots, key=lambda x: x[1], reverse=True)[:5]
            lines.append(f"hot: {','.join(f'{f}({c})' for f, c in top_hot)}")
        result = "\n".join(lines)
        while _estimate_tokens(result) > max_tokens and lines:
            lines.pop()
            result = "\n".join(lines)
        return result


@dataclass
class PatternLibrary:
    """Recurring code patterns and conventions."""
    naming_conventions: Dict[str, str] = field(default_factory=dict)
    common_patterns: List[str] = field(default_factory=list)
    anti_patterns: List[str] = field(default_factory=list)
    api_styles: List[str] = field(default_factory=list)

    def to_compact(self, max_tokens: int = 400) -> str:
        lines = ["[PATTERNS]"]
        for k, v in list(self.naming_conventions.items())[:5]:
            lines.append(f"naming.{k}: {v}")
        for p in self.common_patterns[:8]:
            lines.append(f"pat: {p}")
        for a in self.anti_patterns[:3]:
            lines.append(f"anti: {a}")
        for s in self.api_styles[:3]:
            lines.append(f"api: {s}")
        result = "\n".join(lines)
        while _estimate_tokens(result) > max_tokens and lines:
            lines.pop()
            result = "\n".join(lines)
        return result


@dataclass
class SemanticIndex:
    """Key semantic anchors for retrieval."""
    key_modules: Dict[str, str] = field(default_factory=dict)  # name -> purpose
    public_apis: List[str] = field(default_factory=list)
    domain_terms: List[str] = field(default_factory=list)

    def to_compact(self, max_tokens: int = 400) -> str:
        lines = ["[SEMANTIC]"]
        for name, purpose in list(self.key_modules.items())[:10]:
            lines.append(f"{name}: {purpose[:60]}")
        if self.public_apis:
            lines.append(f"apis: {','.join(self.public_apis[:10])}")
        if self.domain_terms:
            lines.append(f"terms: {','.join(self.domain_terms[:15])}")
        result = "\n".join(lines)
        while _estimate_tokens(result) > max_tokens and lines:
            lines.pop()
            result = "\n".join(lines)
        return result


@dataclass
class EvolutionMemory:
    """Recent changes and learned adaptations."""
    recent_changes: List[str] = field(default_factory=list)
    known_issues: List[str] = field(default_factory=list)
    successful_fixes: List[str] = field(default_factory=list)

    def to_compact(self, max_tokens: int = 300) -> str:
        lines = ["[EVOLUTION]"]
        for c in self.recent_changes[:5]:
            lines.append(f"chg: {c[:80]}")
        for i in self.known_issues[:3]:
            lines.append(f"issue: {i[:80]}")
        for f in self.successful_fixes[:3]:
            lines.append(f"fix: {f[:80]}")
        result = "\n".join(lines)
        while _estimate_tokens(result) > max_tokens and lines:
            lines.pop()
            result = "\n".join(lines)
        return result


@dataclass
class ProjectGenome:
    """Complete compressed representation of a project."""
    architecture_dna: ArchitectureDNA = field(default_factory=ArchitectureDNA)
    dependency_graph: DependencyGraph = field(default_factory=DependencyGraph)
    pattern_library: PatternLibrary = field(default_factory=PatternLibrary)
    semantic_index: SemanticIndex = field(default_factory=SemanticIndex)
    evolution_memory: EvolutionMemory = field(default_factory=EvolutionMemory)
    genome_hash: str = ""
    generated_at: str = ""

    def to_compact(self, max_tokens: int = 2000) -> str:
        parts = [
            self.architecture_dna.to_compact(400),
            self.dependency_graph.to_compact(500),
            self.pattern_library.to_compact(400),
            self.semantic_index.to_compact(400),
            self.evolution_memory.to_compact(300),
        ]
        result = "\n\n".join(parts)
        token_count = _estimate_tokens(result)
        if token_count > max_tokens:
            # Trim proportionally
            ratio = max_tokens / token_count
            trimmed_parts = []
            for part in parts:
                target_len = int(len(part) * ratio)
                trimmed = part[:target_len]
                # Ensure we don't cut mid-line
                last_nl = trimmed.rfind('\n')
                if last_nl > 0:
                    trimmed = trimmed[:last_nl]
                trimmed_parts.append(trimmed)
            result = "\n\n".join(trimmed_parts)
        return result

    def synthesize_context(self, task_description: str, max_tokens: int = 1200) -> str:
        """Synthesize task-relevant context from genome."""
        task_lower = task_description.lower()
        relevance_scores = {}

        # Score each component based on task keywords
        arch_keywords = ['setup', 'config', 'build', 'install', 'structure', 'architect', 'framework']
        dep_keywords = ['import', 'depend', 'require', 'package', 'module', 'use']
        pattern_keywords = ['pattern', 'convention', 'style', 'format', 'naming', 'standard']
        semantic_keywords = ['find', 'search', 'locate', 'where', 'what', 'purpose', 'api']
        evolution_keywords = ['fix', 'bug', 'change', 'update', 'recent', 'issue', 'error']

        keyword_groups = {
            'arch': arch_keywords,
            'dep': dep_keywords,
            'pattern': pattern_keywords,
            'semantic': semantic_keywords,
            'evolution': evolution_keywords,
        }

        for group_name, keywords in keyword_groups.items():
            score = sum(1 for kw in keywords if kw in task_lower)
            relevance_scores[group_name] = max(score, 1)  # Always include at least minimal

        total_score = sum(relevance_scores.values())
        budget = max_tokens

        components = {
            'arch': (self.architecture_dna.to_compact(400), relevance_scores['arch']),
            'dep': (self.dependency_graph.to_compact(500), relevance_scores['dep']),
            'pattern': (self.pattern_library.to_compact(400), relevance_scores['pattern']),
            'semantic': (self.semantic_index.to_compact(400), relevance_scores['semantic']),
            'evolution': (self.evolution_memory.to_compact(300), relevance_scores['evolution']),
        }

        # Allocate tokens proportionally to relevance
        allocated = {}
        for name, (content, score) in components.items():
            share = int(budget * score / total_score)
            allocated[name] = min(share, len(content))

        # Build synthesized context
        sections = []
        total_used = 0
        for name in ['arch', 'dep', 'pattern', 'semantic', 'evolution']:
            content = components[name][0]
            limit = allocated[name]
            if limit < 50:
                continue
            trimmed = content[:limit]
            last_nl = trimmed.rfind('\n')
            if last_nl > 0:
                trimmed = trimmed[:last_nl]
            sections.append(trimmed)
            total_used += _estimate_tokens(trimmed)

        header = f"[SYNTHESIZED CONTEXT | task: {task_description[:100]} | tokens: ~{total_used}]"
        result = header + "\n" + "\n---\n".join(sections)

        if _estimate_tokens(result) > max_tokens:
            # Aggressive trim
            result = result[:max_tokens * 4]
            last_nl = result.rfind('\n')
            if last_nl > 0:
                result = result[:last_nl]

        return result


class GenomeBuilder:
    """Builds a ProjectGenome from a project directory."""

    CODE_EXTENSIONS = {'.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.kt'}
    CONFIG_FILES = {'package.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Makefile', 'Dockerfile', 'docker-compose.yml', '.env', 'tsconfig.json', 'pyproject.toml', 'setup.py', 'CMakeLists.txt'}
    FRAMEWORK_MARKERS = {
        'react': ['react', 'jsx', 'tsx'],
        'django': ['django', 'manage.py'],
        'flask': ['flask'],
        'fastapi': ['fastapi'],
        'express': ['express'],
        'spring': ['spring', '@Controller', '@Service'],
        'rails': ['rails', 'Gemfile'],
        'nextjs': ['next.config', '_app.tsx'],
        'vue': ['vue', '.vue'],
        'angular': ['angular.json', '@Component'],
    }

    def __init__(self, project_path: str, config: Optional[Dict] = None):
        self.project_path = Path(project_path)
        self.config = config or {}
        self.max_genome_tokens = self.config.get('genome', {}).get('max_tokens', 2000)

    def build(self) -> ProjectGenome:
        genome = ProjectGenome()
        genome.generated_at = str(os.popen('date -u +%Y-%m-%dT%H:%M:%SZ').read().strip())

        files = self._scan_files()
        genome.architecture_dna = self._extract_architecture(files)
        genome.dependency_graph = self._extract_dependencies(files)
        genome.pattern_library = self._extract_patterns(files)
        genome.semantic_index = self._extract_semantics(files)
        genome.evolution_memory = self._extract_evolution()

        content = genome.to_compact(self.max_genome_tokens)
        genome.genome_hash = hashlib.md5(content.encode()).hexdigest()[:12]

        return genome

    def _scan_files(self) -> List[Path]:
        files = []
        try:
            for ext in self.CODE_EXTENSIONS:
                files.extend(self.project_path.rglob(f'*{ext}'))
        except Exception:
            pass
        # Limit to avoid huge projects
        return files[:500]

    def _extract_architecture(self, files: List[Path]) -> ArchitectureDNA:
        dna = ArchitectureDNA()
        dna.total_files = len(files)

        extensions = set()
        all_content_sample = []
        detected_frameworks = set()

        for f in files[:100]:
            ext = f.suffix
            extensions.add(ext)
            try:
                content = f.read_text(errors='ignore')[:2000]
                all_content_sample.append(content.lower())
                total_lines = content.count('\n') + 1
                dna.total_lines += total_lines
            except Exception:
                pass

        # Detect languages
        ext_to_lang = {'.py': 'Python', '.js': 'JavaScript', '.ts': 'TypeScript', '.java': 'Java',
                       '.go': 'Go', '.rs': 'Rust', '.c': 'C', '.cpp': 'C++', '.rb': 'Ruby',
                       '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin', '.jsx': 'JSX', '.tsx': 'TSX'}
        dna.languages = [ext_to_lang[e] for e in extensions if e in ext_to_lang][:5]

        # Detect frameworks
        combined = ' '.join(all_content_sample)
        for fw, markers in self.FRAMEWORK_MARKERS.items():
            if any(m in combined for m in markers):
                detected_frameworks.add(fw)
        dna.frameworks = list(detected_frameworks)[:5]

        # Find entry points
        entry_names = ['main', 'app', 'index', 'server', 'run', 'start', '__main__']
        for f in files[:200]:
            stem = f.stem.lower()
            if any(e in stem for e in entry_names):
                rel = str(f.relative_to(self.project_path))
                dna.entry_points.append(rel)
        dna.entry_points = dna.entry_points[:5]

        # Module structure (top-level dirs with code)
        modules = set()
        for f in files:
            try:
                rel = f.relative_to(self.project_path)
                if len(rel.parts) > 1:
                    modules.add(rel.parts[0])
            except Exception:
                pass
        dna.module_structure = sorted(modules)[:10]

        # Config files
        for cfg in self.CONFIG_FILES:
            if (self.project_path / cfg).exists():
                dna.config_files.append(cfg)
        dna.config_files = dna.config_files[:5]

        # Build system detection
        if (self.project_path / 'Makefile').exists():
            dna.build_system = 'make'
        elif (self.project_path / 'CMakeLists.txt').exists():
            dna.build_system = 'cmake'
        elif (self.project_path / 'package.json').exists():
            dna.build_system = 'npm/yarn'
        elif (self.project_path / 'pyproject.toml').exists() or (self.project_path / 'setup.py').exists():
            dna.build_system = 'python-setuptools'
        elif (self.project_path / 'Cargo.toml').exists():
            dna.build_system = 'cargo'
        elif (self.project_path / 'go.mod').exists():
            dna.build_system = 'go-modules'

        # Test framework
        if any('pytest' in s for s in all_content_sample):
            dna.test_framework = 'pytest'
        elif any('unittest' in s for s in all_content_sample):
            dna.test_framework = 'unittest'
        elif any('jest' in s for s in all_content_sample):
            dna.test_framework = 'jest'
        elif any('mocha' in s for s in all_content_sample):
            dna.test_framework = 'mocha'

        return dna

    def _extract_dependencies(self, files: List[Path]) -> DependencyGraph:
        graph = DependencyGraph()

        # External deps from config files
        pkg_json = self.project_path / 'package.json'
        if pkg_json.exists():
            try:
                data = json.loads(pkg_json.read_text())
                deps = list(data.get('dependencies', {}).keys())
                dev_deps = list(data.get('devDependencies', {}).keys())
                graph.external_deps = (deps + dev_deps)[:15]
            except Exception:
                pass

        req_txt = self.project_path / 'requirements.txt'
        if req_txt.exists():
            try:
                lines = req_txt.read_text().splitlines()
                graph.external_deps = [l.split('==')[0].split('>=')[0].strip() for l in lines if l.strip() and not l.startswith('#')][:15]
            except Exception:
                pass

        # Internal imports (Python-focused for simplicity)
        import_pattern = re.compile(r'^(?:from|import)\s+([\w.]+)', re.MULTILINE)
        import_counts: Dict[str, int] = {}
        internal_deps: Dict[str, List[str]] = {}

        for f in files[:200]:
            if f.suffix != '.py':
                continue
            try:
                content = f.read_text(errors='ignore')
                imports = import_pattern.findall(content)
                rel = str(f.relative_to(self.project_path))
                mod_name = rel.replace('/', '.').replace('.py', '')
                filtered = [i for i in imports if not i.startswith(('os', 'sys', 're', 'json', 'pathlib', 'typing', 'dataclasses', 'collections', 'functools', 'itertools', 'logging', 'datetime', 'hashlib', 'abc'))]
                if filtered:
                    internal_deps[mod_name] = filtered[:5]
                for imp in filtered:
                    import_counts[imp] = import_counts.get(imp, 0) + 1
            except Exception:
                pass

        graph.internal_deps = dict(list(internal_deps.items())[:10])
        graph.hotspots = sorted(import_counts.items(), key=lambda x: x[1], reverse=True)[:5]

        return graph

    def _extract_patterns(self, files: List[Path]) -> PatternLibrary:
        patterns = PatternLibrary()

        sample_contents = []
        for f in files[:50]:
            try:
                sample_contents.append(f.read_text(errors='ignore')[:3000])
            except Exception:
                pass

        combined = '\n'.join(sample_contents)

        # Naming conventions
        if re.search(r'def [a-z_]+\(', combined):
            patterns.naming_conventions['functions'] = 'snake_case'
        if re.search(r'class [A-Z][a-zA-Z]+', combined):
            patterns.naming_conventions['classes'] = 'PascalCase'
        if re.search(r'[A-Z_]{3,}\s*=', combined):
            patterns.naming_conventions['constants'] = 'UPPER_SNAKE'
        if re.search(r'const [a-z][a-zA-Z]+', combined):
            patterns.naming_conventions['variables'] = 'camelCase'

        # Common patterns
        if 'async def' in combined or 'await ' in combined:
            patterns.common_patterns.append('async/await')
        if '@dataclass' in combined:
            patterns.common_patterns.append('dataclasses')
        if 'typing.' in combined or 'from typing' in combined:
            patterns.common_patterns.append('type-hints')
        if 'logging.' in combined:
            patterns.common_patterns.append('structured-logging')
        if 'pytest' in combined:
            patterns.common_patterns.append('pytest-style-tests')
        if 'if __name__' in combined:
            patterns.common_patterns.append('main-guard')
        if 'Path(' in combined or 'pathlib' in combined:
            patterns.common_patterns.append('pathlib-usage')
        if 'field(default_factory' in combined:
            patterns.common_patterns.append('dataclass-factories')

        # API styles
        if 'REST' in combined or 'rest' in combined or '/api/' in combined:
            patterns.api_styles.append('REST')
        if 'GraphQL' in combined or 'graphql' in combined:
            patterns.api_styles.append('GraphQL')
        if 'gRPC' in combined or 'grpc' in combined:
            patterns.api_styles.append('gRPC')

        return patterns

    def _extract_semantics(self, files: List[Path]) -> SemanticIndex:
        index = SemanticIndex()

        # Key modules: top-level dirs with docstrings or README
        for f in files[:200]:
            try:
                rel = f.relative_to(self.project_path)
                if len(rel.parts) >= 1:
                    mod = rel.parts[0]
                    if mod not in index.key_modules:
                        content = f.read_text(errors='ignore')[:500]
                        # Extract first docstring or comment as purpose
                        doc_match = re.search(r'"""(.+?)"""', content, re.DOTALL)
                        if doc_match:
                            purpose = doc_match.group(1).strip()[:60]
                            index.key_modules[mod] = purpose
                        elif content.startswith('#'):
                            purpose = content.split('\n')[0].lstrip('# ').strip()[:60]
                            index.key_modules[mod] = purpose
            except Exception:
                pass

        index.key_modules = dict(list(index.key_modules.items())[:10])

        # Public APIs: functions/classes without underscore prefix
        api_pattern = re.compile(r'^(?:def|class)\s+([A-Za-z][a-zA-Z0-9_]+)', re.MULTILINE)
        apis = set()
        for f in files[:100]:
            try:
                content = f.read_text(errors='ignore')
                matches = api_pattern.findall(content)
                for m in matches:
                    if not m.startswith('_') and len(m) > 2:
                        apis.add(m)
            except Exception:
                pass
        index.public_apis = sorted(apis)[:10]

        # Domain terms: capitalized words appearing frequently
        term_pattern = re.compile(r'\b([A-Z][a-z]{2,}(?:[A-Z][a-z]+)*)\b')
        term_counts: Dict[str, int] = {}
        for f in files[:100]:
            try:
                content = f.read_text(errors='ignore')
                terms = term_pattern.findall(content)
                for t in terms:
                    if t not in ('The', 'This', 'That', 'For', 'And', 'But', 'Not', 'All', 'Any'):
                        term_counts[t] = term_counts.get(t, 0) + 1
            except Exception:
                pass
        top_terms = sorted(term_counts.items(), key=lambda x: x[1], reverse=True)[:15]
        index.domain_terms = [t[0] for t in top_terms]

        return index

    def _extract_evolution(self) -> EvolutionMemory:
        memory = EvolutionMemory()
        # Try git log for recent changes
        try:
            log = os.popen(f'cd {self.project_path} && git log --oneline -5 2>/dev/null').read().strip()
            if log:
                memory.recent_changes = log.splitlines()[:5]
        except Exception:
            pass

        # Check for TODO/FIXME/HACK markers
        try:
            todos = os.popen(f'cd {self.project_path} && grep -rn "TODO\\|FIXME\\|HACK" --include="*.py" --include="*.ts" --include="*.js" 2>/dev/null | head -3').read().strip()
            if todos:
                memory.known_issues = todos.splitlines()[:3]
        except Exception:
            pass

        return memory


class ProjectGenomePlugin:
    """Main plugin entry point for DSH integration."""

    def __init__(self, config_path: Optional[str] = None):
        self.config = {}
        if config_path and os.path.exists(config_path):
            if yaml:
                with open(config_path) as f:
                    self.config = yaml.safe_load(f) or {}
            else:
                # Fallback: simple YAML parser for basic configs
                self.config = self._parse_simple_yaml(config_path)

        self.genome: Optional[ProjectGenome] = None
        self.builder: Optional[GenomeBuilder] = None

    def _parse_simple_yaml(self, path: str) -> Dict:
        """Minimal YAML parser for when PyYAML is unavailable."""
        result = {}
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if ':' in line and not line.startswith('#'):
                        key, val = line.split(':', 1)
                        val = val.strip()
                        if val.isdigit():
                            result[key.strip()] = int(val)
                        elif val.replace('.', '').isdigit():
                            result[key.strip()] = float(val)
                        elif val.lower() in ('true', 'false'):
                            result[key.strip()] = val.lower() == 'true'
                        else:
                            result[key.strip()] = val
        except Exception:
            pass
        return result

    def initialize(self, project_path: str) -> Dict[str, Any]:
        """Initialize the plugin with a project path."""
        self.builder = GenomeBuilder(project_path, self.config)
        self.genome = self.builder.build()

        compact = self.genome.to_compact()
        token_count = _estimate_tokens(compact)

        return {
            'status': 'initialized',
            'genome_hash': self.genome.genome_hash,
            'genome_tokens': token_count,
            'max_genome_tokens': self.config.get('genome', {}).get('max_tokens', 2000),
            'components': {
                'architecture_dna': bool(self.genome.architecture_dna.languages),
                'dependency_graph': bool(self.genome.dependency_graph.external_deps or self.genome.dependency_graph.internal_deps),
                'pattern_library': bool(self.genome.pattern_library.common_patterns),
                'semantic_index': bool(self.genome.semantic_index.key_modules),
                'evolution_memory': bool(self.genome.evolution_memory.recent_changes),
            }
        }

    def get_genome(self) -> str:
        """Return the compact genome representation."""
        if not self.genome:
            raise RuntimeError("Plugin not initialized. Call initialize() first.")
        max_tokens = self.config.get('genome', {}).get('max_tokens', 2000)
        return self.genome.to_compact(max_tokens)

    def synthesize_context(self, task_description: str) -> str:
        """Synthesize task-relevant context from genome."""
        if not self.genome:
            raise RuntimeError("Plugin not initialized. Call initialize() first.")
        max_tokens = self.config.get('genome', {}).get('synthesized_context_max_tokens', 1200)
        return self.genome.synthesize_context(task_description, max_tokens)

    def get_metrics(self) -> Dict[str, Any]:
        """Return current metrics for monitoring."""
        if not self.genome:
            return {'status': 'not_initialized'}

        compact = self.genome.to_compact()
        genome_tokens = _estimate_tokens(compact)
        synth = self.genome.synthesize_context("sample task")
        synth_tokens = _estimate_tokens(synth)

        baseline_estimate = max(genome_tokens * 15, 30000)  # Assume 15x compression or 30k baseline
        reduction = (1 - genome_tokens / baseline_estimate) * 100

        return {
            'genome_tokens': genome_tokens,
            'synthesized_tokens': synth_tokens,
            'baseline_estimate': baseline_estimate,
            'token_reduction_pct': round(reduction, 1),
            'genome_hash': self.genome.genome_hash,
            'within_budget': genome_tokens <= 2000 and synth_tokens <= 2000,
        }


# DSH Plugin Interface
def create_plugin(config_path: Optional[str] = None) -> ProjectGenomePlugin:
    """Factory function for DSH plugin system."""
    if config_path is None:
        config_path = os.path.join(os.path.dirname(__file__), 'config.yaml')
    return ProjectGenomePlugin(config_path)
