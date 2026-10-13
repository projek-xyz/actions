import test from 'node:test';
import assert from 'node:assert/strict';
import { diffContracts, isBreakingChange } from '../tools/check-contracts.mjs';

function contract(inputs = [], outputs = [], secrets = []) {
  return { workflow: 'x', inputs, outputs, secrets };
}

const input = (name, { type = 'string', required = false, def = null } = {}) =>
  ({ name, type, required, default: def });

test('identical contracts produce no breaking changes and no additions', () => {
  const base = contract([input('a')], [{ name: 'o', description: 'd' }], [{ name: 's', required: false }]);
  const curr = contract([input('a')], [{ name: 'o', description: 'other' }], [{ name: 's', required: false }]);

  assert.deepEqual(diffContracts(base, curr), { breaking: [], additions: [], changes: [] });
});

test('changes carries structured kind/name/change entries in message order', () => {
  const base = contract(
    [input('gone'), input('t', { type: 'string' }), input('r', { required: true })],
    [{ name: 'out-gone', description: '' }, { name: 'out-keep', description: '' }],
    [{ name: 's-new', required: false }],
  );
  const curr = contract(
    [input('t', { type: 'number' }), input('r', { required: false }), input('added')],
    [{ name: 'out-keep', description: '' }],
    [{ name: 's-new', required: true }],
  );

  assert.deepEqual(diffContracts(base, curr).changes, [
    { kind: 'input', name: 'gone', change: 'removed' },
    { kind: 'input', name: 't', change: 'retyped' },
    { kind: 'input', name: 'r', change: 'relaxed' },
    { kind: 'input', name: 'added', change: 'added' },
    { kind: 'output', name: 'out-gone', change: 'removed' },
    { kind: 'secret', name: 's-new', change: 'tightened' },
  ]);
});

test('removed input is breaking', () => {
  const base = contract([input('php-version'), input('keep')]);
  const curr = contract([input('keep')]);

  assert.deepEqual(diffContracts(base, curr).breaking, ['input removed: php-version']);
});

test('type change and required false->true are breaking; default change is soft', () => {
  const base = contract([input('t', { type: 'string' }), input('d', { def: '1' }), input('r')]);
  const curr = contract([input('t', { type: 'boolean' }), input('d', { def: '2' }), input('r', { required: true })]);

  const diff = diffContracts(base, curr);
  assert.deepEqual(diff.breaking, ['input changed: t', 'input changed: r']);
  assert.deepEqual(diff.additions, ['input changed: d']);
});

test("optional no-default <-> default:'' swap produces no breaking rows", () => {
  const base = contract([input('input-one'), input('input-two', { def: '' })]);
  const curr = contract([input('input-one', { def: '' }), input('input-two')]);

  const diff = diffContracts(base, curr);
  assert.deepEqual(diff.breaking, []);
  assert.deepEqual(diff.additions, ['input changed: input-one', 'input changed: input-two']);
});

test('added input or secret with required: true is breaking; optional additions stay soft', () => {
  const base = contract([], [], []);
  const curr = contract(
    [input('need', { required: true }), input('want')],
    [],
    [{ name: 'tok', required: true }, { name: 'open', required: false }],
  );

  const diff = diffContracts(base, curr);
  assert.deepEqual(diff.breaking, ['input added: need', 'secret added: tok']);
  assert.deepEqual(diff.additions, ['input added: want', 'secret added: open']);
});

test('required true->false is an addition-class relaxation, not breaking', () => {
  const base = contract([input('r', { required: true })]);
  const curr = contract([input('r', { required: false })]);

  const result = diffContracts(base, curr);
  assert.deepEqual(result.breaking, []);
  assert.deepEqual(result.additions, ['input relaxed: r']);
});

test('new input is an addition', () => {
  const base = contract([]);
  const curr = contract([input('project-ref')]);

  assert.deepEqual(diffContracts(base, curr).additions, ['input added: project-ref']);
});

test('removed output is breaking, added output is an addition', () => {
  const base = contract([], [{ name: 'gone', description: '' }]);
  const curr = contract([], [{ name: 'fresh', description: '' }]);

  const result = diffContracts(base, curr);
  assert.deepEqual(result.breaking, ['output removed: gone']);
  assert.deepEqual(result.additions, ['output added: fresh']);
});

test('secret required changes follow the same relaxation rules', () => {
  const base = contract([], [], [{ name: 'tightened', required: false }, { name: 'relaxed', required: true }]);
  const curr = contract([], [], [{ name: 'tightened', required: true }, { name: 'relaxed', required: false }]);

  const result = diffContracts(base, curr);
  assert.deepEqual(result.breaking, ['secret changed: tightened']);
  assert.deepEqual(result.additions, ['secret relaxed: relaxed']);
});

test('isBreakingChange recognizes only the hard kinds', () => {
  const hard = ['removed', 'retyped', 'tightened', 'added-required'];
  const soft = ['default-changed', 'relaxed', 'added'];
  for (const change of hard) assert.equal(isBreakingChange({ kind: 'input', name: 'x', change }), true, change);
  for (const change of soft) assert.equal(isBreakingChange({ kind: 'input', name: 'x', change }), false, change);
});

test('multi-move inputs resolve hard-first: retype and tighten beat default changes', () => {
  const base = contract([input('a', { type: 'string', def: '1' }), input('b', { def: '1' })]);
  const curr = contract([input('a', { type: 'number', def: '2' }), input('b', { def: '2', required: true })]);

  const diff = diffContracts(base, curr);
  assert.deepEqual(diff.breaking, ['input changed: a', 'input changed: b']);
  assert.deepEqual(diff.additions, []);
  assert.deepEqual(diff.changes, [
    { kind: 'input', name: 'a', change: 'retyped' },
    { kind: 'input', name: 'b', change: 'tightened' },
  ]);
});
