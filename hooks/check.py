#!/usr/bin/env python3
"""Codex hook: preview supported edits without writing any repository files."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import Repository, check, compare_imports, load_config

def repository_path(rawpath, repo, cwd=None):
    """Resolve a tool path using its working directory, bounded to the repo."""
    if not isinstance(rawpath, str) or not rawpath:
        raise ValueError('Missing file path')
    repo = Path(repo).resolve()
    cwd = Path(cwd).resolve() if cwd is not None else repo
    path = Path(rawpath)
    if not path.is_absolute():
        path = cwd / path
    try:
        return path.resolve().relative_to(repo).as_posix()
    except ValueError:
        raise ValueError('Edit includes a file outside the repository')

def patch_sources(sources, patch, repo, cwd=None):
    """Apply Codex's textual patch to an in-memory source map, conservatively."""
    if not isinstance(patch, str):
        raise ValueError('Missing patch text')
    lines = patch.splitlines()
    if not lines or lines[0] != '*** Begin Patch' or lines[-1] != '*** End Patch':
        raise ValueError('Unrecognized patch format')
    result = dict(sources)
    i = 1
    while i < len(lines) - 1:
        header = lines[i]
        kind = next((k for k in ['Add', 'Update', 'Delete'] if header.startswith('*** ' + k + ' File: ')), None)
        if not kind:
            raise ValueError('Unsupported patch header')
        name = repository_path(header.split(' File: ', 1)[1], repo, cwd)
        i += 1
        moved = None
        if i < len(lines) and lines[i].startswith('*** Move to: '):
            if kind != 'Update':
                raise ValueError('Only an update can move a file')
            moved = repository_path(lines[i].split(': ', 1)[1], repo, cwd)
            i += 1
        content = []
        while i < len(lines) and not lines[i].startswith(('*** Add File:', '*** Update File:', '*** Delete File:', '*** End Patch')):
            content.append(lines[i]); i += 1
        if kind == 'Delete':
            result.pop(name, None); continue
        if kind == 'Add':
            if any(not line.startswith('+') for line in content):
                raise ValueError('Invalid added file')
            result[name] = '\n'.join(line[1:] for line in content) + '\n'; continue
        if name not in result:
            # Non-source files do not influence import facts.
            continue
        original = result[name].splitlines()
        chunks, chunk = [], []
        for line in content:
            if line.startswith('@@'):
                if chunk:
                    chunks.append(chunk); chunk = []
            elif line != '*** End of File':
                chunk.append(line)
        if chunk:
            chunks.append(chunk)
        cursor = 0
        for chunk in chunks:
            if any(not line or line[0] not in ' +-' for line in chunk):
                raise ValueError('Unrecognized patch context')
            old = [line[1:] for line in chunk if line[0] in ' -']
            new = [line[1:] for line in chunk if line[0] in ' +']
            if not old:
                raise ValueError('Insertion without context needs a post-edit check')
            hits = [j for j in range(cursor, len(original) - len(old) + 1) if original[j:j + len(old)] == old]
            if len(hits) != 1:
                raise ValueError('Patch context is ambiguous')
            at = hits[0]; original[at:at + len(old)] = new; cursor = at + len(new)
        result.pop(name, None)
        result[moved or name] = '\n'.join(original) + '\n'
    return result

def preview_sources(sources, tool_name, tool_input, repo, cwd):
    if tool_name == 'apply_patch':
        if not isinstance(tool_input, (str, dict)):
            raise ValueError('Unrecognized patch input')
        patch = tool_input if isinstance(tool_input, str) else tool_input.get('command', tool_input.get('patch', ''))
        return patch_sources(sources, patch, repo, cwd)
    if not isinstance(tool_input, dict):
        raise ValueError('Unrecognized edit input')
    name = repository_path(tool_input.get('file_path'), repo, cwd)
    result = dict(sources)
    if tool_name == 'Write':
        content = tool_input.get('content')
        if not isinstance(content, str):
            raise ValueError('Write requires text content')
        result[name] = content
        return result
    old, new = tool_input.get('old_string'), tool_input.get('new_string')
    if not isinstance(old, str) or not old or not isinstance(new, str):
        raise ValueError('Edit requires non-empty old_string and text new_string')
    replace_all = tool_input.get('replace_all', False)
    if not isinstance(replace_all, bool):
        raise ValueError('Edit replace_all must be a boolean')
    if name not in result:
        # Files absent from the scanner's source map cannot introduce imports
        # through a replacement. New source files use Write or Add File.
        return result
    count = result[name].count(old)
    if not count or (count != 1 and not replace_all):
        raise ValueError('Edit text is missing or ambiguous')
    result[name] = result[name].replace(old, new, -1 if replace_all else 1)
    return result

def evaluate(payload, config_path=None, languages=None):
    cwd = payload.get('cwd', '.')
    p = subprocess.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    if p.returncode:
        return {}
    repo = Path(p.stdout.strip()).resolve()
    if config_path is None and not (repo / 'strata.config.json').exists():
        return {}
    if config_path is not None and not Path(config_path).is_file():
        raise ValueError('Configured Strata policy does not exist')
    config = load_config(repo, config_path)
    event = payload.get('hook_event_name')
    if event == 'Stop':
        if payload.get('stop_hook_active'):
            return {}
        result = check(repo, config, languages=languages)
        if result['added']:
            return {'decision': 'block', 'reason': reason(result['added'])}
        if result['warnings']:
            return {'systemMessage': 'Strata could not fully check the working tree: ' + '; '.join(result['warnings'][:8])}
        return {}
    if event != 'PreToolUse' or payload.get('tool_name') not in ('apply_patch', 'Edit', 'Write'):
        return {}
    sources = Repository(repo).working()
    try:
        proposed = preview_sources(sources, payload['tool_name'], payload.get('tool_input', {}), repo, cwd)
    except ValueError as error:
        return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'additionalContext': 'Strata could not preview this edit: %s. Run strata check after the edit.' % error}}
    if proposed == sources:
        return {}
    # With the same file paths, import resolution and inferred gates are stable.
    # Only changed importers can introduce a new edge. Additions/deletions/moves
    # need a full analysis because unchanged imports may resolve differently.
    changed = {p for p in sources.keys() | proposed.keys() if sources.get(p) != proposed.get(p)}
    importers = changed if sources.keys() == proposed.keys() else None
    if languages is not None and 'swift' not in languages:
        # Keep the explicit Stop scope from producing unrelated Swift warnings
        # on every JS edit. Edits to Swift itself are still disclosed below.
        sources = {p: text for p, text in sources.items() if not p.endswith('.swift')}
        proposed = {p: text for p, text in proposed.items() if not p.endswith('.swift')}
    result = compare_imports(sources, proposed, config, importers=importers)
    if result['added']:
        return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': reason(result['added'])}}
    if not result['warnings'] and any(p.endswith('.swift') for p in changed):
        result['warnings'].append('Swift import and boundary checks are unavailable; inferred type references are for layout only.')
    if result['warnings']:
        return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'additionalContext': 'Strata could not fully check this edit: ' + '; '.join(result['warnings'][:8]) + '. Run strata check after the edit.'}}
    return {}

def reason(edges):
    return 'Strata found new imports past a module gate: ' + '; '.join('%s:%s -> %s' % (e['source'], e['line'], e['target']) for e in edges[:8]) + '. Inferred gates are hypotheses: confirm the intended boundary. Use the owning module\'s public API, or expose a narrow operation through its gate. Do not widen the configuration just to silence this check. Verify behavior and rerun Strata.'

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', help='Use an explicit local boundary policy, including from a linked worktree.')
    parser.add_argument('--languages', nargs='+', choices=['python', 'javascript', 'typescript', 'swift'], help='Limit the Stop import check to these languages. Pre-edit checks still report unsupported edits.')
    args = parser.parse_args()
    try:
        print(json.dumps(evaluate(json.load(sys.stdin), config_path=args.config, languages=args.languages)))
    except Exception as error:
        # A diagnostic is explicit; it is not represented as a successful scan.
        print(json.dumps({'systemMessage': 'Strata check unavailable: ' + str(error)[:250]}))
