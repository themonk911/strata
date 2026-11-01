"""Conservative lexical Swift type references, never compiler-resolved imports."""
import collections
from functools import lru_cache


_TYPES = {'class', 'struct', 'enum', 'protocol', 'actor', 'typealias'}
_DECLARATIONS = _TYPES | {'let', 'var', 'func', 'init', 'deinit', 'subscript', 'extension', 'import'}
_REGEX_PREFIX = {'=', '(', '[', '{', ',', ':', 'return', 'case', 'in', '!', '?'}


def _literal_end(text, opening, hashes, regex=False):
    delimiter = '"""' if not regex and text.startswith('"""', opening) else '/' if regex else '"'
    closing, escape = delimiter + '#' * hashes, '\\' + '#' * hashes
    i, character_class = opening + len(delimiter), False
    while i < len(text):
        if not regex and text.startswith(escape + '(', i):
            i, depth = i + len(escape) + 1, 1
            while i < len(text) and depth:
                if text.startswith('//', i):
                    end = text.find('\n', i)
                    i = len(text) if end < 0 else end
                    continue
                if text.startswith('/*', i):
                    i, closed = _comment_end(text, i)
                    if not closed:
                        return i, False
                    continue
                nested = i
                while nested < len(text) and text[nested] == '#':
                    nested += 1
                if nested < len(text) and text[nested] == '"':
                    i, closed = _literal_end(text, nested, nested - i)
                    if not closed:
                        return i, False
                    continue
                depth += (text[i] == '(') - (text[i] == ')')
                i += 1
            if depth:
                return i, False
        elif text.startswith(escape, i):
            i += len(escape) + 1
        elif regex and not hashes and text[i] in '[]':
            character_class = text[i] == '['
            i += 1
        elif not character_class and text.startswith(closing, i):
            return i + len(closing), True
        elif text[i] == '\n' and not hashes and delimiter != '"""':
            return i, False
        else:
            i += 1
    return i, False


def _comment_end(text, i):
    i, depth = i + 2, 1
    while i < len(text) and depth:
        if text.startswith('/*', i):
            depth += 1
            i += 2
        elif text.startswith('*/', i):
            depth -= 1
            i += 2
        else:
            i += 1
    return i, depth == 0


def _lex(text):
    tokens, failures = [], []
    i, line, length = 0, 1, len(text)
    while i < length:
        start, start_line = i, line
        char = text[i]
        if char.isspace():
            line += char == '\n'
            i += 1
            continue
        if text.startswith('//', i):
            end = text.find('\n', i + 2)
            i = length if end < 0 else end
            continue
        if text.startswith('/*', i):
            i, closed = _comment_end(text, i)
            line += text.count('\n', start, i)
            if not closed:
                failures.append('unterminated block comment')
            continue
        hashes = 0
        while i + hashes < length and text[i + hashes] == '#':
            hashes += 1
        opening = i + hashes
        string = opening < length and text[opening] == '"'
        regex = opening < length and text[opening] == '/' and (
            hashes or (tokens and tokens[-1][0] in _REGEX_PREFIX
                       and opening + 1 < length and not text[opening + 1].isspace()))
        if string or regex:
            i, closed = _literal_end(text, opening, hashes, regex)
            line += text.count('\n', start, min(i, length))
            if not closed:
                failures.append('unterminated ' + ('string literal' if string else 'regex literal'))
            continue
        if char == '`':
            end = text.find('`', i + 1)
            if end < 0 or '\n' in text[i + 1:end]:
                failures.append('unterminated escaped identifier')
                break
            tokens.append((text[i + 1:end], line, True))
            i = end + 1
        elif char.isalpha() or char == '_':
            i += 1
            while i < length and (text[i].isalnum() or text[i] == '_'):
                i += 1
            tokens.append((text[start:i], start_line, True))
        else:
            tokens.append((char, line, False))
            i += 1
    return tuple(tokens), tuple(failures)


@lru_cache(maxsize=1024)
def _source(text):
    tokens, failures = _lex(text)
    declarations, declaration_tokens, depth = [], set(), 0
    for index, (value, line, identifier) in enumerate(tokens):
        if index in declaration_tokens:
            continue
        if value == 'import':
            for following in range(index, len(tokens)):
                if tokens[following][1] != line or tokens[following][0] == ';':
                    break
                declaration_tokens.add(following)
            continue
        if value == '{':
            depth += 1
        elif value == '}':
            depth -= 1
            if depth < 0:
                failures += ('unbalanced braces',)
                depth = 0
        elif value in _TYPES and index + 1 < len(tokens):
            name, _, is_name = tokens[index + 1]
            if not is_name or name in _DECLARATIONS:
                continue
            declaration_tokens.add(index + 1)
            private = False
            for previous_index in range(index - 1, -1, -1):
                previous = tokens[previous_index][0]
                if previous in _DECLARATIONS or previous in {'{', '}', ';'}:
                    break
                private |= previous in {'private', 'fileprivate'}
            declarations.append((name, depth == 0 and not private))
    if depth:
        failures += ('unbalanced braces',)
    references = tuple((value, line) for index, (value, line, identifier) in enumerate(tokens)
                       if identifier and index not in declaration_tokens)
    return tuple(declarations), references, failures


def swift_references(sources, importers=None):
    """Find unambiguous lexical references; resolve owners afresh each snapshot.

    These are hypotheses about file dependencies. Build targets, overloads,
    conditional compilation, generic shadowing and member lookup are not resolved.
    Private/nested declarations cannot own edges; duplicate names are omitted.
    """
    owners = collections.defaultdict(list)
    parsed, warnings = {}, []
    for path, text in sorted(sources.items()):
        declarations, references, failures = _source(text)
        if failures:
            warnings.append('Swift references could not be fully read: %s (%s).' % (path, ', '.join(sorted(set(failures)))))
            continue
        parsed[path] = references
        for name, eligible in declarations:
            owners[name].append((path, eligible))
    unique = {name: candidates[0][0] for name, candidates in owners.items()
              if len(candidates) == 1 and candidates[0][1]}
    edges = []
    for path, references in parsed.items():
        if importers is not None and path not in importers:
            continue
        seen = set()
        for name, line in references:
            target = unique.get(name)
            if target and target != path and target not in seen:
                edges.append({'source': path, 'target': target, 'line': line,
                              'kind': 'swift_type_reference', 'inferred': True})
                seen.add(target)
    return edges, warnings
