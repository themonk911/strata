"""Mature first-parent line cohorts, without reading or executing repository code.

The caller supplies complete filtered trees in first-parent order. Branch-local
iterations are therefore invisible: only the integrated parent-to-child delta is
observed. A first-parent commit is an integration proxy, not proof of a PR merge.
"""
from collections import defaultdict
import math


REWORK_METHOD = {
    'name': 'rolling_mature_first_parent_rework',
    'windowDays': 14,
    'cohortDays': 14,
    'definition': 'Of nonblank source lines whose 14-day survival window ended in the last 14 days, the share removed within 14 days of introduction.',
    'cohorts': 'Rolling mature cohorts. At time t, introductions fall in (t - windowDays - cohortDays, t - windowDays], in days. The first observed tree is an unmeasured baseline; uncommitted working-tree edits are excluded.',
    'integration': 'First-parent commits are an integration proxy; Git alone does not establish pull-request merge or deployment status.',
    'matching': 'Equal whitespace-normalized lines retain their cohort, first within a file and then across changed files in the same commit. Reorders and exact moves survive.',
    'ownership': 'A line belongs to its district at introduction, including after a move. Missing ownership remains unassigned.',
    'limitations': [
        'Textual line matching is not semantic identity. Identical duplicate lines are ambiguous and matched deterministically, preferring recent cohorts.',
        'Whitespace within a line is ignored, including inside strings. Line splitting/joining can still count as rework.',
        'A move split across separate commits is a removal followed by an addition.',
        'A high rework rate is not proof of bugs, wasted work, or a validated prediction.',
    ],
}


class ReworkTracker:
    """Track line survival behind one streaming, snapshot-safe operation.

``owner_for_path(path)`` returns a district id or None. The owner is consulted
only for newly introduced lines. ``sources`` must include all selected files;
omission means deletion. Use a fresh tracker for every complete history replay.
The caller must reject truncated/shallow history before claiming availability.
"""

    def __init__(self, owner_for_path, window_days=14, cohort_days=14):
        if not callable(owner_for_path):
            raise TypeError('owner_for_path must be callable')
        for name, value in (('window_days', window_days), ('cohort_days', cohort_days)):
            if (isinstance(value, bool) or not isinstance(value, (int, float))
                    or not math.isfinite(value) or value <= 0):
                raise ValueError('%s must be positive and finite' % name)
        self.owner_for_path = owner_for_path
        self.window_days = window_days
        self.window_seconds = window_days * 86400
        self.cohort_days = cohort_days
        self.cohort_seconds = cohort_days * 86400
        self._contents = {}
        self._files = {}
        # Zero represents the initial unmeasured baseline, never a cohort.
        self._cohorts = [None]
        self._observed_at = None
        self._reason = None
        self._first_at = None

    @staticmethod
    def _lines(source):
        # Retain line boundaries, discard blank lines and horizontal whitespace.
        return [value for line in source.splitlines() if (value := ''.join(line.split()))]

    def observe(self, sources, timestamp):
        """Observe a committed tree. This never observes a future snapshot."""
        if not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp):
            raise ValueError('Commit timestamp must be finite')
        if self._observed_at is not None and timestamp < self._observed_at:
            self._reason = 'First-parent commit timestamps move backwards; a reliable survival observation window is unavailable.'
        self._observed_at = timestamp
        if self._reason:
            return
        if self._first_at is None:
            self._first_at = timestamp
            self._contents = dict(sources)
            self._files = {path: [(line, 0) for line in self._lines(text)] for path, text in sources.items()}
            return

        changed = sorted(path for path in self._contents.keys() | sources.keys()
                         if self._contents.get(path) != sources.get(path))
        if not changed:
            return
        # First retain same-file equal lines. This prevents an unrelated file
        # from stealing a line identity solely because it has identical text.
        removed = defaultdict(list)
        pending = []
        replacements = {}
        for path in changed:
            pools = defaultdict(list)
            for line, cohort in self._files.get(path, []):
                pools[line].append(cohort)
            # In ambiguous duplicate cases, retain young lines before old ones.
            # This avoids asserting early rework solely from duplicate matching.
            for pool in pools.values():
                pool.sort()
            records = []
            for line in self._lines(sources.get(path, '')):
                pool = pools.get(line)
                if pool:
                    records.append((line, pool.pop()))
                else:
                    pending.append((path, len(records), line))
                    records.append(None)
            replacements[path] = records
            for line, pool in pools.items():
                removed[line].extend(pool)

        # Cross-file moves in the same integration retain their original cohort
        # and owner. Reordering is naturally covered by equal-line matching.
        for pool in removed.values():
            pool.sort()
        new_by_owner = {}
        for path, index, line in pending:
            pool = removed.get(line)
            if pool:
                cohort = pool.pop()
            else:
                owner = self.owner_for_path(path)
                if owner not in new_by_owner:
                    new_by_owner[owner] = len(self._cohorts)
                    self._cohorts.append({'introducedAt': timestamp, 'owner': owner, 'added': 0, 'deleted': 0})
                cohort = new_by_owner[owner]
                self._cohorts[cohort]['added'] += 1
            replacements[path][index] = (line, cohort)
        for pool in removed.values():
            for cohort_id in pool:
                if not cohort_id:
                    continue
                cohort = self._cohorts[cohort_id]
                if timestamp - cohort['introducedAt'] <= self.window_seconds:
                    cohort['deleted'] += 1
        for path, records in replacements.items():
            if path in sources:
                self._files[path] = records
                self._contents[path] = sources[path]
            else:
                self._files.pop(path, None)
                self._contents.pop(path, None)

    def _signal(self, timestamp, added=0, deleted=0, reason=None):
        return {'value': None if reason or not added else deleted / added,
                'status': 'unavailable' if reason else 'available' if added else 'no_mature_cohorts',
                'eligibleLines': added, 'deletedLines': deleted, 'windowDays': self.window_days,
                'cohortDays': self.cohort_days,
                'cohortStartExclusive': timestamp - self.window_seconds - self.cohort_seconds,
                'cohortEndInclusive': timestamp - self.window_seconds,
                **({'reason': reason} if reason else {})}

    def signals(self, timestamp):
        """Read recent mature cohorts; immature and expired cohorts are excluded.

Calling this after replaying later commits cannot retrieve an older snapshot:
the result is explicitly unavailable, rather than leaking later deletions.
After the final committed tree, a later timestamp can mature or expire cohorts.
"""
        if not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp):
            raise ValueError('Snapshot timestamp must be finite')
        reason = self._reason
        if self._observed_at is None:
            reason = 'No committed first-parent history was observed.'
        elif timestamp < self._observed_at:
            reason = 'Snapshot precedes the latest observed commit; replay history only through the requested snapshot.'
        if reason:
            return {'repo': self._signal(timestamp, reason=reason), 'districts': {}, 'unassigned': self._signal(timestamp, reason=reason),
                    'unknownLines': 0, 'unknownDeletedLines': 0}

        totals = defaultdict(lambda: [0, 0])
        known_owners = set()
        mature_through = timestamp - self.window_seconds
        mature_after = mature_through - self.cohort_seconds
        for cohort in self._cohorts[1:]:
            owner = cohort['owner']
            if owner is not None:
                known_owners.add(owner)
            if mature_after < cohort['introducedAt'] <= mature_through:
                totals[owner][0] += cohort['added']
                totals[owner][1] += cohort['deleted']
        added = sum(value[0] for value in totals.values())
        deleted = sum(value[1] for value in totals.values())
        unknown, unknown_deleted = totals[None]
        return {'repo': self._signal(timestamp, added, deleted),
                'districts': {owner: self._signal(timestamp, *totals[owner]) for owner in sorted(known_owners)},
                'unassigned': self._signal(timestamp, unknown, unknown_deleted),
                'unknownLines': unknown, 'unknownDeletedLines': unknown_deleted}
