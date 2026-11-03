"""Advisory entry-point evidence from the resolved import graph."""
if __package__:
    from .scan import TEST, Repository, analyze
else:
    from scan import TEST, Repository, analyze


def _reachable(graph, starts, blocked=()):
    seen, blocked = set(), set(blocked)
    pending = list(starts)
    while pending:
        node = pending.pop()
        if node in seen or node in blocked:
            continue
        seen.add(node)
        pending.extend(graph[node] - seen - blocked)
    return seen


def _components(graph):
    """Iterative Kosaraju: cycles remain groups, never arbitrary single gates."""
    seen, order = set(), []
    for start in sorted(graph):
        pending = [(start, False)]
        while pending:
            node, finished = pending.pop()
            if finished:
                order.append(node)
            elif node not in seen:
                seen.add(node)
                pending.append((node, True))
                pending.extend((target, False) for target in sorted(graph[node], reverse=True) if target not in seen)
    reverse = {node: set() for node in graph}
    for source, targets in graph.items():
        for target in targets:
            reverse[target].add(source)
    groups, assigned = {}, set()
    for node in reversed(order):
        if node not in assigned:
            group = _reachable(reverse, [node], assigned)
            assigned.update(group)
            for member in group:
                groups[member] = group
    return groups


def gate_evidence(repo, config, module=None, maximum=30):
    """Describe observed entry files without declaring or changing public gates.

    Counts describe resolved import paths within each existing district. SCC
    reach and dominance concern the whole component, not a callable interface.
    """
    if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= 100:
        raise ValueError('maximum must be an integer between 1 and 100 candidates per module')
    result = analyze(Repository(repo).working(), config)
    districts = {district['id']: district for district in result['districts']}
    if module is not None and module not in districts:
        raise ValueError('Unknown module: ' + str(module))
    files = {path: file for path, file in result['files'].items() if not TEST.search(path) and not path.endswith('.swift')}
    edges = [edge for edge in result['imports'] if edge['source'] in files and edge['target'] in files]
    output = []
    for name in sorted(districts if module is None else [module]):
        members = {path for path, file in files.items() if file['district'] == name}
        graph = {path: set() for path in members}
        incoming = []
        for edge in edges:
            source, target = edge['source'], edge['target']
            if target in members:
                if source in members:
                    graph[source].add(target)
                else:
                    incoming.append(edge)
        groups = _components(graph)
        entries = {edge['target'] for edge in incoming}
        reached = _reachable(graph, entries)
        metrics, candidates = {}, []
        for path in sorted(entries):
            group = groups[path]
            key = tuple(sorted(group))
            if key not in metrics:
                reach = _reachable(graph, group)
                alternative_reach = _reachable(graph, entries - group, group)
                metrics[key] = (reach, len(reach - group), len(reached - alternative_reach - group))
            reach, internal_count, dominated_count = metrics[key]
            callers = {edge['source'] for edge in incoming if edge['target'] == path}
            alternatives = sorted((edge for edge in incoming if edge['target'] in reach and edge['target'] != path),
                                  key=lambda edge: (edge['source'], edge['target'], edge['line']))
            candidates.append({'path': path, 'component': list(key[:32]), 'componentSize': len(group),
                               'externalCallerFiles': len(callers),
                               'externalCallerModules': len({files[caller]['district'] for caller in callers}),
                               'internallyReachableFiles': internal_count, 'dominatedFiles': dominated_count,
                               'alternateEntries': {'count': len(alternatives), 'examples': alternatives[:5]}})
        candidates.sort(key=lambda candidate: (-candidate['externalCallerFiles'], -candidate['internallyReachableFiles'], candidate['path']))
        district = districts[name]
        item = {'path': name, 'gateStatus': district.get('gateStatus', 'inferred' if district['inferred'] else 'declared' if district['walled'] else 'unbounded'),
                'public': district['public'], 'fileCount': len(members),
                'internalImportCount': sum(len(targets) for targets in graph.values()), 'externalImportCount': len(incoming),
                'candidateCount': len(candidates), 'candidates': candidates[:maximum]}
        output.append(item)
    return {'modules': output,
            'coverage': {'basis': 'Resolved production Python and JavaScript/TypeScript imports, including type-only imports.',
                         'excludedTestFiles': sum(bool(TEST.search(path)) for path in result['files']),
                         'uncheckedSwiftFiles': sum(path.endswith('.swift') for path in result['files']),
                         'limitations': ['Candidates are observed entry files, not confirmed public APIs; no gate policy is changed.',
                                         'Reachability and dominance use paths within the current module grouping, not calls or protocols.',
                                         'Reachable and dominated counts exclude the candidate component; dominance removes its entire SCC.',
                                         'SCCs include type-only imports and do not establish runtime dependency cycles.',
                                         'Unresolved or computed imports and Swift references are not included.']},
            'warnings': result['warnings']}
