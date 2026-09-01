"""
Token-Darwin Evolution Layer Plugin

Manages self-generated artifacts (skills, tools, patterns) via ROI-based
natural selection. Artifacts that don't prove their value are automatically
pruned to prevent context bloat accumulation.
"""

import os
import json
import time
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field, asdict
from collections import deque

try:
    import yaml
except ImportError:
    yaml = None


def _estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token."""
    if not text:
        return 0
    return max(1, len(text) // 4)


@dataclass
class Artifact:
    """A self-generated artifact managed by the evolution layer."""
    id: str
    name: str
    artifact_type: str  # skill, tool, pattern, context_snippet
    content: str
    created_at: float = field(default_factory=time.time)
    last_used: float = field(default_factory=time.time)
    use_count: int = 0
    success_count: int = 0
    failure_count: int = 0
    roi: float = 0.5
    generation: int = 0
    tags: List[str] = field(default_factory=list)
    token_cost: int = 0
    pruned: bool = False
    prune_reason: str = ""

    def __post_init__(self):
        if not self.id:
            self.id = hashlib.md5(f"{self.name}:{self.artifact_type}:{self.created_at}".encode()).hexdigest()[:12]
        if not self.token_cost:
            self.token_cost = _estimate_tokens(self.content)

    @property
    def success_rate(self) -> float:
        total = self.success_count + self.failure_count
        if total == 0:
            return 0.5  # Neutral until proven
        return self.success_count / total

    @property
    def age_generations(self) -> int:
        return self.generation

    def record_use(self, success: bool):
        """Record a usage event and update ROI."""
        self.use_count += 1
        self.last_used = time.time()
        if success:
            self.success_count += 1
        else:
            self.failure_count += 1
        self._recalculate_roi()

    def _recalculate_roi(self):
        """Recalculate ROI based on usage history."""
        if self.use_count == 0:
            self.roi = 0.5
            return

        # ROI heavily weighted toward success rate for effective Darwin selection
        sr = self.success_rate
        freq_score = min(self.use_count / 10.0, 1.0)

        # Success rate dominates; low success => low ROI => prunable
        self.roi = 0.8 * sr + 0.2 * freq_score
        self.roi = max(0.0, min(1.0, self.roi))

    def apply_decay(self, decay_rate: float):
        """Apply generational decay to ROI."""
        self.roi *= decay_rate
        self.generation += 1

    def to_summary(self) -> str:
        """Compact summary for context inclusion."""
        return f"[{self.artifact_type}] {self.name} (roi:{self.roi:.2f}, uses:{self.use_count}, sr:{self.success_rate:.0%})"

    def to_dict(self) -> Dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict) -> 'Artifact':
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


class EvolutionEngine:
    """Core evolution logic for artifact management."""

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.artifacts: Dict[str, Artifact] = {}
        self.prune_log: List[Dict] = []
        self.success_history: deque = deque(maxlen=config.get('metrics', {}).get('success_rate_window', 50))
        self.current_generation = 0

        # Config values
        evo_cfg = config.get('evolution', {})
        self.roi_threshold = evo_cfg.get('roi_threshold', 0.3)
        self.max_artifacts = evo_cfg.get('max_artifacts', 100)
        self.decay_rate = evo_cfg.get('decay_rate', 0.95)
        self.min_uses = evo_cfg.get('min_uses_to_evaluate', 3)
        self.prune_batch = evo_cfg.get('prune_batch_size', 10)
        self.protect_recent = config.get('pruning', {}).get('protect_recent', 5)

        # Type-specific initial ROI
        self.type_config = config.get('artifact_types', {})

    def register_artifact(self, name: str, artifact_type: str, content: str,
                          tags: Optional[List[str]] = None) -> Artifact:
        """Register a new artifact into the evolution pool."""
        type_cfg = self.type_config.get(artifact_type, {})
        initial_roi = type_cfg.get('initial_roi', 0.5)

        artifact = Artifact(
            id="",
            name=name,
            artifact_type=artifact_type,
            content=content,
            roi=initial_roi,
            generation=self.current_generation,
            tags=tags or [],
        )

        self.artifacts[artifact.id] = artifact
        return artifact

    def record_usage(self, artifact_id: str, success: bool) -> Optional[Artifact]:
        """Record usage of an artifact and update metrics."""
        artifact = self.artifacts.get(artifact_id)
        if not artifact or artifact.pruned:
            return None

        artifact.record_use(success)
        self.success_history.append(1 if success else 0)
        return artifact

    def evolve(self) -> Dict[str, Any]:
        """Run one evolution cycle: apply decay, prune low-ROI artifacts."""
        self.current_generation += 1
        pruned = []
        survivors = []

        # Apply decay to all active artifacts
        for artifact in self.artifacts.values():
            if not artifact.pruned:
                artifact.apply_decay(self.decay_rate)

        # Identify candidates for pruning
        candidates = [
            a for a in self.artifacts.values()
            if not a.pruned and a.use_count >= self.min_uses
        ]

        # Sort by ROI ascending (worst first)
        candidates.sort(key=lambda a: a.roi)

        # Protect most recently used
        protected_ids = set()
        recent = sorted(
            [a for a in self.artifacts.values() if not a.pruned],
            key=lambda a: a.last_used,
            reverse=True
        )[:self.protect_recent]
        protected_ids = {a.id for a in recent}

        # Prune low-ROI artifacts
        prune_count = 0
        for artifact in candidates:
            if prune_count >= self.prune_batch:
                break
            if artifact.id in protected_ids:
                continue
            if artifact.roi < self.roi_threshold:
                artifact.pruned = True
                artifact.prune_reason = f"roi={artifact.roi:.3f} < threshold={self.roi_threshold}"
                pruned.append({
                    'id': artifact.id,
                    'name': artifact.name,
                    'type': artifact.artifact_type,
                    'roi': artifact.roi,
                    'uses': artifact.use_count,
                    'reason': artifact.prune_reason,
                    'generation': self.current_generation,
                })
                prune_count += 1
            else:
                survivors.append(artifact)

        # Force prune if over capacity
        active = [a for a in self.artifacts.values() if not a.pruned]
        if len(active) > self.max_artifacts:
            excess = len(active) - self.max_artifacts
            active.sort(key=lambda a: a.roi)
            for artifact in active[:excess]:
                if artifact.id not in protected_ids:
                    artifact.pruned = True
                    artifact.prune_reason = f"capacity_overflow (roi={artifact.roi:.3f})"
                    pruned.append({
                        'id': artifact.id,
                        'name': artifact.name,
                        'type': artifact.artifact_type,
                        'roi': artifact.roi,
                        'uses': artifact.use_count,
                        'reason': artifact.prune_reason,
                        'generation': self.current_generation,
                    })

        self.prune_log.extend(pruned)

        return {
            'generation': self.current_generation,
            'pruned_count': len(pruned),
            'survivor_count': len([a for a in self.artifacts.values() if not a.pruned]),
            'total_artifacts': len(self.artifacts),
            'pruned': pruned,
        }

    def get_active_artifacts(self, artifact_type: Optional[str] = None) -> List[Artifact]:
        """Get all non-pruned artifacts, optionally filtered by type."""
        active = [a for a in self.artifacts.values() if not a.pruned]
        if artifact_type:
            active = [a for a in active if a.artifact_type == artifact_type]
        return sorted(active, key=lambda a: a.roi, reverse=True)

    def get_context_budget(self, max_tokens: int = 800) -> str:
        """Generate a compact summary of active artifacts within token budget."""
        active = self.get_active_artifacts()
        lines = ["[DARWIN_ARTIFACTS]"]
        total_tokens = 0

        for artifact in active:
            summary = artifact.to_summary()
            line_tokens = _estimate_tokens(summary)
            if total_tokens + line_tokens > max_tokens:
                break
            lines.append(summary)
            total_tokens += line_tokens

        lines.append(f"total: {len(active)} active, gen:{self.current_generation}")
        return "\n".join(lines)

    def get_success_rate(self) -> float:
        """Calculate rolling success rate."""
        if not self.success_history:
            return 0.95  # Default optimistic
        return sum(self.success_history) / len(self.success_history)

    def get_metrics(self) -> Dict[str, Any]:
        """Return comprehensive metrics."""
        active = [a for a in self.artifacts.values() if not a.pruned]
        total_pruned = len([a for a in self.artifacts.values() if a.pruned])

        type_breakdown = {}
        for a in active:
            if a.artifact_type not in type_breakdown:
                type_breakdown[a.artifact_type] = {'count': 0, 'avg_roi': 0, 'total_uses': 0}
            type_breakdown[a.artifact_type]['count'] += 1
            type_breakdown[a.artifact_type]['avg_roi'] += a.roi
            type_breakdown[a.artifact_type]['total_uses'] += a.use_count

        for t in type_breakdown:
            if type_breakdown[t]['count'] > 0:
                type_breakdown[t]['avg_roi'] /= type_breakdown[t]['count']

        total_tokens = sum(a.token_cost for a in active)

        return {
            'generation': self.current_generation,
            'active_artifacts': len(active),
            'pruned_artifacts': total_pruned,
            'total_artifacts': len(self.artifacts),
            'success_rate': round(self.get_success_rate(), 4),
            'total_token_cost': total_tokens,
            'avg_roi': round(sum(a.roi for a in active) / max(len(active), 1), 4),
            'type_breakdown': type_breakdown,
            'prune_log_size': len(self.prune_log),
        }

    def save_state(self, path: str):
        """Persist evolution state to disk."""
        state = {
            'generation': self.current_generation,
            'artifacts': {aid: a.to_dict() for aid, a in self.artifacts.items()},
            'prune_log': self.prune_log[-100:],  # Keep last 100 entries
            'success_history': list(self.success_history),
        }
        with open(path, 'w') as f:
            json.dump(state, f, indent=2)

    def load_state(self, path: str):
        """Load evolution state from disk."""
        if not os.path.exists(path):
            return
        try:
            with open(path) as f:
                state = json.load(f)
            self.current_generation = state.get('generation', 0)
            self.artifacts = {
                aid: Artifact.from_dict(data)
                for aid, data in state.get('artifacts', {}).items()
            }
            self.prune_log = state.get('prune_log', [])
            self.success_history = deque(
                state.get('success_history', []),
                maxlen=self.config.get('metrics', {}).get('success_rate_window', 50)
            )
        except Exception:
            pass  # Start fresh on corrupt state


class TokenDarwinPlugin:
    """Main plugin entry point for DSH integration."""

    def __init__(self, config_path: Optional[str] = None, state_path: Optional[str] = None):
        self.config = {}
        if config_path and os.path.exists(config_path):
            if yaml:
                with open(config_path) as f:
                    self.config = yaml.safe_load(f) or {}
            else:
                self.config = self._parse_simple_yaml(config_path)

        self.engine = EvolutionEngine(self.config)
        self.state_path = state_path or os.path.join(
            os.path.dirname(config_path or '.'), '.darwin_state.json'
        )

    def _parse_simple_yaml(self, path: str) -> Dict:
        """Minimal YAML parser fallback."""
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

    def initialize(self) -> Dict[str, Any]:
        """Initialize the plugin and load persisted state."""
        self.engine.load_state(self.state_path)
        return {
            'status': 'initialized',
            'generation': self.engine.current_generation,
            'active_artifacts': len(self.engine.get_active_artifacts()),
            'config': {
                'roi_threshold': self.engine.roi_threshold,
                'max_artifacts': self.engine.max_artifacts,
                'decay_rate': self.engine.decay_rate,
            }
        }

    def register(self, name: str, artifact_type: str, content: str,
                 tags: Optional[List[str]] = None) -> Dict[str, Any]:
        """Register a new artifact."""
        artifact = self.engine.register_artifact(name, artifact_type, content, tags)
        return {
            'id': artifact.id,
            'name': artifact.name,
            'type': artifact.artifact_type,
            'roi': artifact.roi,
            'token_cost': artifact.token_cost,
        }

    def use(self, artifact_id: str, success: bool) -> Dict[str, Any]:
        """Record artifact usage."""
        artifact = self.engine.record_usage(artifact_id, success)
        if not artifact:
            return {'error': 'artifact_not_found_or_pruned'}
        return {
            'id': artifact.id,
            'roi': artifact.roi,
            'use_count': artifact.use_count,
            'success_rate': artifact.success_rate,
        }

    def evolve(self) -> Dict[str, Any]:
        """Run evolution cycle and persist state."""
        result = self.engine.evolve()
        self.engine.save_state(self.state_path)
        return result

    def get_context(self, max_tokens: int = 800) -> str:
        """Get compact artifact summary for context injection."""
        return self.engine.get_context_budget(max_tokens)

    def get_metrics(self) -> Dict[str, Any]:
        """Get current evolution metrics."""
        return self.engine.get_metrics()

    def get_active(self, artifact_type: Optional[str] = None) -> List[Dict]:
        """List active artifacts."""
        return [
            {
                'id': a.id,
                'name': a.name,
                'type': a.artifact_type,
                'roi': round(a.roi, 3),
                'uses': a.use_count,
                'success_rate': round(a.success_rate, 3),
                'token_cost': a.token_cost,
            }
            for a in self.engine.get_active_artifacts(artifact_type)
        ]

    def shutdown(self):
        """Persist state on shutdown."""
        self.engine.save_state(self.state_path)


# DSH Plugin Interface
def create_plugin(config_path: Optional[str] = None, state_path: Optional[str] = None) -> TokenDarwinPlugin:
    """Factory function for DSH plugin system."""
    if config_path is None:
        config_path = os.path.join(os.path.dirname(__file__), 'config.yaml')
    return TokenDarwinPlugin(config_path, state_path)

