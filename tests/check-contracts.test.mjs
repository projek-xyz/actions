import test from 'node:test';
import assert from 'node:assert/strict';
import { diffContracts } from '../tools/check-contracts.mjs';

function contract(inputs = [], outputs = [], secrets = []) {
  return { workflow: 'x', inputs, outputs, secrets };
}

const input = (name, { type = 'string', required = false, def = null } = {}) =>
  ({ name, type, required, default: def });

test('identical contracts produce no breaking changes and no additions', () => {
  const base = contract([input('a')], [{ name: 'o', description: 'd' }], [{ name: 's', required: false }]);
  const curr = contract([input('a')], [{ name: 'o', description: 'other' }], [{ name: 's', required: false }]);

  assert.deepEqual(diffContracts(base, curr), { breaking: [], additions: [] });
});

test('removed input is breaking', () => {
  const base = contract([input('php-version'), input('keep')]);
  const curr = contract([input('keep')]);

  assert.deepEqual(diffContracts(base, curr).breaking, ['input removed: php-version']);
});

test('type change, default change and required false->true are breaking', () => {
  const base = contract([input('t', { type: 'string' }), input('d', { def: '1' }), input('r')]);
  const curr = contract([input('t', { type: 'boolean' }), input('d', { def: '2' }), input('r', { required: true })]);

  assert.deepEqual(diffContracts(base, curr).breaking, [
    'input changed: t',
    'input changed: d',
    'input changed: r',
  ]);
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
