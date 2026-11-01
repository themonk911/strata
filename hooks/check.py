#!/usr/bin/env python3
"""Codex hook: compare pending apply_patch imports without writing any files."""
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import Repository, analyze, check, load_config

def patch_sources(sources, patch, repo):
    """Apply Codex's textual patch to an in-memory source map, conservatively."""
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
        rawpath = header.split(' File: ', 1)[1]
        path = Path(rawpath)
        if path.is_absolute():
            try:
                name = path.relative_to(repo).as_posix()
            except ValueError:
                raise ValueError('Patch includes a file outside the repository')
        else:
            if '..' in path.parts:
                raise ValueError('Patch path escapes repository')
            name = path.as_posix()
        i += 1
        moved = None
        if i < len(lines) and lines[i].startswith('*** Move to: '):
            moved = lines[i].split(': ', 1)[1]
            if Path(moved).is_absolute():
                moved = Path(moved).relative_to(repo).as_posix()
            if '..' in Path(moved).parts:
                raise ValueError('Move path escapes repository')
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

def evaluate(payload):
    cwd = payload.get('cwd', '.')
    p = subprocess.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    if p.returncode:
        return {}
    repo = Path(p.stdout.strip()).resolve()
    if not (repo / 'strata.config.json').exists():
        return {}
    config = load_config(repo)
    event = payload.get('hook_event_name')
    if event == 'Stop':
        if payload.get('stop_hook_active'):
            return {}
        result = check(repo, config)
        if result['added']:
            return {'decision': 'block', 'reason': reason(result['added'])}
        return {}
    if event != 'PreToolUse' or payload.get('tool_name') not in ('apply_patch', 'Edit', 'Write'):
        return {}
    patch = payload.get('tool_input', {}).get('command', '')
    sources = Repository(repo).working()
    before = analyze(sources, config)
    try:
        proposed = patch_sources(sources, patch, repo)
    except ValueError as error:
        return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'additionalContext': 'Strata could not preview this patch: %s. Run strata check after the edit.' % error}}
    after = analyze(proposed, config)
    old = {(e['source'], e['target']) for e in before['shortcuts']}
    added = [e for e in after['shortcuts'] if (e['source'], e['target']) not in old]
    if added:
        return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': reason(added)}}
    return {}

def reason(edges):
    return 'Strata found new imports past a declared gate: ' + '; '.join('%s:%s -> %s' % (e['source'], e['line'], e['target']) for e in edges[:8]) + '. Use the owning module\'s public API, or expose a narrow operation through its gate. Do not widen the configuration just to silence this check. Verify behavior and rerun Strata.'

if __name__ == '__main__':
    try:
        print(json.dumps(evaluate(json.load(sys.stdin))))
    except Exception as error:
        # A diagnostic is explicit; it is not represented as a successful scan.
        print(json.dumps({'systemMessage': 'Strata check unavailable: ' + str(error)[:250]}))
