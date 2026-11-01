"""Explicit boundary-policy editing; analysis and previews remain read-only."""
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tempfile

from .scan import Repository, analyze, git, infer_modules, module_for, safe_path


def _root(repo):
    return Path(git(repo, 'rev-parse', '--show-toplevel').decode().strip()).resolve()


def _configuration(path, required=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        if required:
            raise ValueError('Configured boundary policy was not found: ' + str(path))
        raw, config, mode = None, {}, 0o644
    else:
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('%s must be a regular file, not a symbolic link.' % path)
        raw = path.read_bytes()
        try:
            config = json.loads(raw)
        except (ValueError, UnicodeDecodeError) as error:
            raise ValueError('%s is not valid JSON: %s' % (path, error))
        if not isinstance(config, dict):
            raise ValueError('%s must contain a JSON object.' % path)
        mode = stat.S_IMODE(info.st_mode)
    revision = hashlib.sha256(b'missing' if raw is None else b'file\0' + raw).hexdigest()
    return config, revision, mode


def _policy(root, config=None):
    target = root / 'strata.config.json'
    supplied = Path(os.path.abspath(config)) if config is not None else target
    # Resolve parent aliases (for example /var -> /private/var on macOS),
    # while retaining the final component so its symlink check cannot be bypassed.
    source = supplied.parent.resolve() / supplied.name
    destination, revision, mode = _configuration(target)
    importing = source != target
    effective = original = destination
    if importing:
        original, source_revision, _ = _configuration(source, required=True)
        # The external policy supplies defaults; established repository settings
        # retain ownership of privacy, resolution, and adapter exemptions.
        effective = {**original, **{key: value for key, value in destination.items() if key != 'modules'}}
        revision = hashlib.sha256(json.dumps([str(source), source_revision, str(target), revision]).encode()).hexdigest()
    provenance = {'importRequired': importing, 'sourceConfig': str(source), 'targetConfig': str(target),
                  'importNote': ('Saving imports these rules into the repository. Existing repository settings '
                                 'outside modules are preserved; the external file is unchanged.') if importing else ''}
    return effective, revision, mode, provenance, original


def _path(value, label, pattern=False):
    if (not isinstance(value, str) or not safe_path(value) or value == '.'
            or PurePosixPath(value).as_posix() != value or value.strip() != value
            or any(ord(char) < 32 for char in value)):
        raise ValueError('%s must be a canonical repository-relative path.' % label)
    if not pattern and any(char in value for char in '*?['):
        raise ValueError('%s must name a module, not a glob pattern.' % label)
    return value


def _modules(value, sources=None):
    if not isinstance(value, list):
        raise ValueError('Modules must be an array of module paths and public gates.')
    result, seen = [], set()
    for entry in value:
        if not isinstance(entry, dict):
            raise ValueError('Each module must contain a path and a public array.')
        path = _path(entry.get('path'), 'Module path')
        if path in seen:
            raise ValueError('Module is declared more than once: ' + path)
        seen.add(path)
        gates = entry.get('public', [])
        if not isinstance(gates, list):
            raise ValueError('Public gates must be an array for module ' + path)
        gates = [_path(gate, 'Public gate', pattern=True) for gate in gates]
        if len(gates) != len(set(gates)):
            raise ValueError('Public gates must not repeat within module ' + path)
        if any(gate != path and not gate.startswith(path + '/') for gate in gates):
            raise ValueError('Public gates must be inside their module: ' + path)
        result.append({'path': path, 'public': gates})
    if sources is not None:
        for entry in result:
            path = entry['path']
            owned = {source for source in sources if module_for(source, result) == path}
            if not owned:
                raise ValueError('Module has no analyzed source files: ' + path)
            for gate in entry['public']:
                matches = {source for source in sources if fnmatch.fnmatchcase(source, gate)}
                if not matches:
                    raise ValueError('Public gate matches no analyzed source files: ' + gate)
                if not matches <= owned:
                    raise ValueError('Public gate belongs to another declared module: ' + gate)
    return result


def _context(repo, revision=None, config=None):
    root = _root(repo)
    settings, current, mode, provenance, baseline = _policy(root, config)
    if revision is not None and revision != current:
        raise ValueError('Boundary rules changed. Reload them and preview again before saving.')
    # Validate stored declarations too, but let the editor remove obsolete paths.
    if 'modules' in settings:
        _modules(settings['modules'])
    return root, settings, current, mode, Repository(root).working(), provenance, baseline


def _token(root, revision, modules, sources):
    material = json.dumps([str(root), revision, modules, sources], sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(material.encode()).hexdigest()


def read_boundaries(repo, config=None):
    """Read editable declarations and separately labeled inference suggestions."""
    root, settings, revision, mode, sources, provenance, baseline = _context(repo, config=config)
    entries = settings.get('modules', [])
    normalized = _modules(entries)
    modules = [entry for entry, original in zip(normalized, entries) if not original.get('inferred')]
    declared = {entry['path'] for entry in modules}
    suggestions = {entry['path']: {'path': entry['path'], 'public': entry['public']}
                   for entry in infer_modules(sources, settings.get('pythonRoots', ('', 'src'))) if entry['path'] not in declared}
    suggestions.update({entry['path']: entry for entry, original in zip(normalized, entries) if original.get('inferred')})
    return {'revision': revision, 'modules': modules, 'suggestions': list(suggestions.values()),
            'files': sorted(sources), 'configured': 'modules' in settings, **provenance}


def _preview(root, config, revision, sources, modules, baseline):
    modules = _modules(modules, sources)
    before = analyze(sources, baseline)
    after = analyze(sources, {**config, 'modules': modules})
    key = lambda edge: (edge['source'], edge['target'])
    old = {key(edge) for edge in before['shortcuts']}
    new = {key(edge) for edge in after['shortcuts']}
    added = [edge for edge in after['shortcuts'] if key(edge) not in old]
    removed = [edge for edge in before['shortcuts'] if key(edge) not in new]
    return {'revision': revision, 'previewToken': _token(root, revision, modules, sources),
            'modules': modules, 'shortcuts': after['shortcuts'], 'added': added, 'removed': removed,
            'warnings': sorted(set(before['warnings'] + after['warnings'])),
            'counts': {'before': len(old), 'after': len(new), 'added': len(added), 'removed': len(removed)}}


def preview_boundaries(repo, modules, revision, config=None):
    """Compare policies against the same current source snapshot without writing."""
    if not isinstance(revision, str):
        raise ValueError('Load the boundary rules before previewing changes.')
    root, settings, current, mode, sources, provenance, baseline = _context(repo, revision, config)
    return _preview(root, settings, current, sources, modules, baseline)


def save_boundaries(repo, modules, revision, preview_token, config=None, import_config=False):
    """Save reviewed rules atomically, refusing stale or incomplete previews."""
    if not isinstance(revision, str) or not isinstance(preview_token, str):
        raise ValueError('Preview the boundary rules before saving them.')
    try:
        import fcntl
    except ImportError:
        raise ValueError('Saving boundary rules requires a host with POSIX file locking.')
    root = _root(repo)
    # Lock the directory, not the replaceable config inode. The OS releases this
    # advisory lock even if the service times out or its subprocess is killed.
    lock_fd = os.open(root, os.O_RDONLY)
    temporary = None
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Boundary rules are being saved. Reload and preview again.')
        root, settings, current, mode, sources, provenance, baseline = _context(root, revision, config)
        if provenance['importRequired'] and import_config is not True:
            raise ValueError('Confirm importing the external rules into repository strata.config.json before saving.')
        preview = _preview(root, settings, current, sources, modules, baseline)
        if preview['previewToken'] != preview_token:
            raise ValueError('Source files or proposed rules changed. Preview again before saving.')
        if preview['warnings']:
            raise ValueError('Cannot save an incomplete analysis. Resolve these warnings and preview again: '
                             + '; '.join(preview['warnings'][:8]))
        raw = (json.dumps({**settings, 'modules': preview['modules']}, indent=2) + '\n').encode()
        fd, temporary = tempfile.mkstemp(prefix='.strata.config-', suffix='.tmp', dir=root)
        with os.fdopen(fd, 'wb') as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
            os.fchmod(output.fileno(), mode)
        # Recheck after analysis and staging so concurrent edits are not silently lost.
        if _policy(root, config)[1] != revision:
            raise ValueError('Boundary rules changed. Reload them and preview again before saving.')
        if _token(root, current, preview['modules'], Repository(root).working()) != preview_token:
            raise ValueError('Source files changed. Preview again before saving.')
        os.replace(temporary, root / 'strata.config.json')
        temporary = None
        return {'revision': hashlib.sha256(b'file\0' + raw).hexdigest(),
                'modules': preview['modules'], 'saved': True,
                'targetConfig': provenance['targetConfig'], 'importRequired': False}
    finally:
        if temporary is not None:
            os.unlink(temporary)
        os.close(lock_fd)
