#!/usr/bin/env python3
"""
Glimax CLI — unified entry point for the token-darwin evolution layer and
the project-genome compressor.

Usage:
    python cli/glimax.py darwin <register|use|evolve|list|context|metrics> [args]
    python cli/glimax.py genome <build|context|metrics> [project_path]

No third-party dependencies required (PyYAML optional).
"""

import argparse
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, 'src', 'token_darwin'))
sys.path.insert(0, os.path.join(REPO_ROOT, 'src', 'project_genome'))

from token_darwin import TokenDarwinPlugin
from project_genome import ProjectGenomePlugin

DARWIN_CONFIG = os.path.join(REPO_ROOT, 'src', 'token_darwin', 'config.yaml')
GENOME_CONFIG = os.path.join(REPO_ROOT, 'src', 'project_genome', 'config.yaml')


def _darwin_plugin(state_path):
    plugin = TokenDarwinPlugin(DARWIN_CONFIG, state_path)
    plugin.initialize()
    return plugin


def cmd_darwin(args):
    plugin = _darwin_plugin(args.state)

    if args.action == 'register':
        content = args.content
        if args.file:
            with open(args.file) as f:
                content = f.read()
        if content is None and not sys.stdin.isatty():
            content = sys.stdin.read()
        if not content:
            print('error: provide --content, --file, or pipe content on stdin', file=sys.stderr)
            return 1
        print(json.dumps(plugin.register(args.name, args.type, content), indent=2))

    elif args.action == 'use':
        print(json.dumps(plugin.use(args.artifact_id, args.success == 'true'), indent=2))

    elif args.action == 'evolve':
        result = plugin.evolve()
        print(json.dumps(result, indent=2))

    elif args.action == 'list':
        print(json.dumps(plugin.get_active(args.type), indent=2))

    elif args.action == 'context':
        print(plugin.get_context(max_tokens=args.max_tokens))

    elif args.action == 'metrics':
        print(json.dumps(plugin.get_metrics(), indent=2))

    plugin.shutdown()
    return 0


def cmd_genome(args):
    plugin = ProjectGenomePlugin(GENOME_CONFIG)
    project = args.project_path or '.'

    if args.action == 'build':
        result = plugin.initialize(project)
        print(json.dumps(result, indent=2))
        print('\n' + plugin.get_genome())

    elif args.action == 'context':
        plugin.initialize(project)
        print(plugin.synthesize_context(args.task))

    elif args.action == 'metrics':
        plugin.initialize(project)
        print(json.dumps(plugin.get_metrics(), indent=2))

    return 0


def main():
    parser = argparse.ArgumentParser(prog='glimax', description=__doc__.splitlines()[1])
    sub = parser.add_subparsers(dest='engine', required=True)

    darwin = sub.add_parser('darwin', help='token-darwin evolution layer')
    darwin.add_argument('action', choices=['register', 'use', 'evolve', 'list', 'context', 'metrics'])
    darwin.add_argument('name', nargs='?', help='artifact name (register)')
    darwin.add_argument('type', nargs='?', choices=['skill', 'tool', 'pattern', 'context_snippet'],
                        help='artifact type (register) or filter (list)')
    darwin.add_argument('success', nargs='?', choices=['true', 'false'], help='outcome (use)')
    darwin.add_argument('artifact_id', nargs='?', help='artifact id (use)')
    darwin.add_argument('--content', help='artifact content (register)')
    darwin.add_argument('--file', help='read artifact content from file (register)')
    darwin.add_argument('--max-tokens', type=int, default=800, help='context budget (context)')
    darwin.add_argument('--state', default=os.path.join(os.getcwd(), '.darwin_state.json'),
                        help='state file path')
    darwin.set_defaults(func=cmd_darwin)

    genome = sub.add_parser('genome', help='project-genome compressor')
    genome.add_argument('action', choices=['build', 'context', 'metrics'])
    genome.add_argument('task', nargs='?', help='task description (context)')
    genome.add_argument('project_path', nargs='?', help='project directory (default: .)')
    genome.set_defaults(func=cmd_genome)

    args = parser.parse_args()
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())