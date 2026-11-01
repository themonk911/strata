import test from 'node:test';
import assert from 'node:assert/strict';
import { districtPresentation, DISTRICT_PALETTE } from '../web/districts.js';

const file = (district, name) => ({ district, path: `${district}/${name}` });

test('repeated names get path context and distinct native/web language colors', () => {
  const data = { files: [file('ios/Improve/Person', 'Person.swift'), file('src/features/person', 'store.ts'),
    file('src/app/api/person', 'route.ts'), file('src/server/codex', 'run.mts'), file('tests', 'scan.py')] };
  const presentation = districtPresentation(data);
  assert.equal(presentation.get('ios/Improve/Person').label, 'Person · iOS');
  assert.equal(presentation.get('src/features/person').label, 'person · features');
  assert.equal(presentation.get('src/app/api/person').label, 'person · API');
  assert.equal(presentation.get('src/server/codex').context, 'server');
  assert.equal(presentation.get('tests').context, 'tests');
  assert.equal(presentation.get('src/server/codex').label, 'codex');
  assert.notEqual(presentation.get('ios/Improve/Person').color, presentation.get('src/features/person').color);
  assert.deepEqual(districtPresentation({ ...data, snapshots: [{ files: {} }] }), presentation);
});

test('language follows file majority, ties remain mixed, and labels remain distinguishable within one context', () => {
  const data = { files: [file('src/features/a/utils', 'first.ts'), file('src/features/a/utils', 'second.tsx'),
    file('src/features/a/utils', 'third.js'), file('src/features/b/utils', 'first.py'), file('src/features/b/utils', 'second.swift')] };
  const presentation = districtPresentation(data);
  assert.equal(presentation.get('src/features/a/utils').language, 'typescript');
  assert.equal(presentation.get('src/features/b/utils').language, 'mixed');
  assert.notEqual(presentation.get('src/features/a/utils').label, presentation.get('src/features/b/utils').label);
  assert.deepEqual(districtPresentation({ files: [...data.files].reverse() }), presentation);
  for (const entry of presentation.values()) assert.ok(DISTRICT_PALETTE.some(color => color.title === entry.title && color.color === entry.color));
});
