"""Bounded local change evidence with explicit city-snapshot alignment."""
import datetime as dt
import re
import subprocess

from .scan import CODE, SKIP, Repository, git, safe_path


_REVISION = re.compile(r'[0-9a-fA-F]{12,40}\Z')
_EMAIL = re.compile(r'[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+')
_PATCH_BYTES = 6000
_TOTAL_PATCH_BYTES = 120000
_MAX_FILES = 100


def _source_paths(repo, revision):
    paths = set()
    for entry in git(repo, 'ls-tree', '-rz', revision).split(b'\0'):
        if not entry:
            continue
        info, rawpath = entry.split(b'\t', 1)
        mode, kind, _ = info.decode().split()
        path = rawpath.decode('utf-8', 'replace')
        if kind == 'blob' and mode != '120000' and safe_path(path) and CODE.search(path) and not SKIP.search(path):
            paths.add(path)
    return paths


def _patch(repo, before, after, paths, limit):
    # Literal pathspecs prevent a repository filename from turning into a glob
    # or Git pathspec directive. Diff helpers and textconv must never execute.
    command = ['git', '-C', str(repo), '--literal-pathspecs', 'diff',
               '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color',
               '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3',
               before, after, '--', *paths]
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
        raw = child.stdout.read(limit + 1)
        truncated = len(raw) > limit
        if truncated:
            child.kill()
        _, error = child.communicate()
        if child.returncode and not truncated:
            raise ValueError('Git history diff failed: ' + error.decode(errors='replace')[:300])
    patch = _EMAIL.sub('[email]', raw[:limit].decode('utf-8', 'replace')).encode('utf-8')
    truncated = truncated or len(patch) > limit
    patch = patch[:limit].decode('utf-8', 'ignore')
    return patch, truncated, len(patch.encode('utf-8'))


def history_evidence(repo, config, revisions, maximum=50):
    """Return recent first-parent changes represented in the city.

    ``revisions`` are city snapshot revision strings, in display order. Snapshot
    indices refer to that input. Each diff compares the actual parent and commit.
    If the parent is not stored in the city, the view uses the nearest earlier
    scan and ``exactSnapshots`` is false: its visual delta spans other commits.
    Root, working, missing-earlier-view and source-empty snapshots are skipped,
    as are older changes beyond the request/size limits.
    ``skipped`` counts supplied snapshots without an emitted change. This
    operation exposes bounded subjects and source diffs for the requested local
    workflow. Callers own consent before sending this evidence to a model.
    Normal scan data never gains these fields and export privacy is unchanged.
    """
    if not isinstance(config, dict):
        raise ValueError('History evidence requires a repository configuration object.')
    if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= 50:
        raise ValueError('History label maximum must be an integer between 1 and 50.')
    if not isinstance(revisions, (list, tuple)) or any(
            not isinstance(value, str) or (value != 'working' and not _REVISION.fullmatch(value))
            for value in revisions):
        raise ValueError('Snapshot revisions must be 12–40 hexadecimal characters or working.')
    repository = Repository(repo)
    head = repository.head()
    if head is None:
        if any(value != 'working' for value in revisions):
            raise ValueError('Snapshot revision is not on the repository first-parent history.')
        return {'changes': [], 'skipped': len(revisions)}
    rows = [row.split() for row in git(repository.path, 'log', '--first-parent', '--reverse',
                                      '--format=%H %ct', head).decode().splitlines()]
    lineage = [row[0] for row in rows]
    snapshots = {}
    for index, value in enumerate(revisions):
        if value == 'working':
            continue
        matches = [sha for sha in lineage if sha.startswith(value.lower())]
        if len(matches) != 1:
            raise ValueError('Snapshot revision is missing or ambiguous on the repository first-parent history.')
        if matches[0] in snapshots:
            raise ValueError('City snapshot revisions must not repeat a committed revision.')
        snapshots[matches[0]] = index
    pairs, earlier = [], None
    for index, (sha, timestamp) in enumerate(rows):
        if sha not in snapshots:
            continue
        if index and earlier is not None and snapshots[earlier] < snapshots[sha]:
            pairs.append((lineage[index - 1], sha, timestamp, earlier))
        earlier = sha
    changes, remaining = [], _TOTAL_PATCH_BYTES
    for before, after, timestamp, before_snapshot in reversed(pairs):
        if len(changes) >= maximum or not remaining:
            break
        changed = git(repository.path, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames',
                      '--no-relative', '--name-only', '-z', before, after, '--').decode('utf-8', 'replace').split('\0')
        sources = _source_paths(repository.path, before) | _source_paths(repository.path, after)
        files = sorted(path for path in changed if path in sources)
        if not files:
            continue
        limited_files = files[:_MAX_FILES]
        patch, truncated, consumed = _patch(repository.path, before, after, limited_files,
                                             min(_PATCH_BYTES, remaining))
        remaining -= consumed
        subject = git(repository.path, 'show', '-s', '--format=%s', after, '--').decode('utf-8', 'replace').strip()
        clean_subject = _EMAIL.sub('[email]', subject)
        changes.append({'id': after, 'beforeRevision': before, 'revision': after,
                        'beforeSnapshot': snapshots[before_snapshot], 'afterSnapshot': snapshots[after],
                        'beforeSnapshotRevision': before_snapshot, 'exactSnapshots': before_snapshot == before,
                        'date': dt.datetime.fromtimestamp(int(timestamp), dt.timezone.utc).date().isoformat(),
                        'subject': clean_subject[:250], 'patch': patch, 'files': limited_files,
                        'truncated': truncated or len(files) > _MAX_FILES or len(clean_subject) > 250})
    changes.reverse()
    return {'changes': changes, 'skipped': len(revisions) - len(changes)}
