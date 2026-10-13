import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCallContract, listWorkflowFiles } from '../tools/extract-contracts.mjs';

const FIXTURE_FULL = `
name: Full
on:
  workflow_call:
    inputs:
      php-version:
        type: string
        default: "\${{ vars.PHP_VERSION || '8.1' }}"
      target-env:
        type: string
      commit-message:
        type: string
      composer-cache-dir:
        type: string
        required: true
    outputs:
      app-key:
        description: The generated app key
        value: \${{ jobs.build.outputs.app-key }}
      target-env:
        value: ignored
    secrets:
      CODECOV_TOKEN:
        required: false
      ACCESS_TOKEN:
        required: true
`;

const FIXTURE_BARE = `
name: Release
on:
  workflow_call:
`;

const FIXTURE_NO_CALL = `
name: Lint
on:
  pull_request:
`;

test('extracts inputs with types, required flags and verbatim defaults', () => {
  const contract = extractCallContract(FIXTURE_FULL);

  assert.ok(contract);
  assert.deepEqual(contract.inputs, [
    { name: 'commit-message', type: 'string', required: false, default: null },
    { name: 'composer-cache-dir', type: 'string', required: true, default: null },
    { name: 'php-version', type: 'string', required: false, default: "${{ vars.PHP_VERSION || '8.1' }}" },
    { name: 'target-env', type: 'string', required: false, default: null },
  ]);
});

test('extracts outputs with descriptions defaulting to empty string', () => {
  const contract = extractCallContract(FIXTURE_FULL);

  assert.ok(contract);
  assert.deepEqual(contract.outputs, [
    { name: 'app-key', description: 'The generated app key' },
    { name: 'target-env', description: '' },
  ]);
});

test('extracts secrets with required flags (default false)', () => {
  const contract = extractCallContract(FIXTURE_FULL);

  assert.ok(contract);
  assert.deepEqual(contract.secrets, [
    { name: 'ACCESS_TOKEN', required: true },
    { name: 'CODECOV_TOKEN', required: false },
  ]);
});

test('bare workflow_call yields a contract with empty arrays, not null', () => {
  const contract = extractCallContract(FIXTURE_BARE);

  assert.ok(contract);
  assert.deepEqual(contract.inputs, []);
  assert.deepEqual(contract.outputs, []);
  assert.deepEqual(contract.secrets, []);
});

test('scalar and sequence on: forms are normalized instead of throwing', () => {
  const scalar = extractCallContract('name: X\non: workflow_call\n', 'scalar-form');
  assert.ok(scalar);
  assert.equal(scalar.workflow, 'scalar-form');
  assert.deepEqual(scalar.inputs, []);

  const sequence = extractCallContract('name: Y\non: [push, workflow_call]\n', 'sequence-form');
  assert.ok(sequence);
  assert.deepEqual(sequence.inputs, []);

  assert.equal(extractCallContract('name: Z\non: [push]\n'), null, 'sequence without workflow_call');
  assert.equal(extractCallContract('name: W\non: push\n'), null, 'scalar non-callable trigger');
});

test('workflow without workflow_call returns null', () => {
  assert.equal(extractCallContract(FIXTURE_NO_CALL), null);
});

test('workflow name defaults to empty string and accepts an override', () => {
  assert.equal(extractCallContract(FIXTURE_BARE).workflow, '');
  assert.equal(extractCallContract(FIXTURE_BARE, 'release').workflow, 'release');
});

test('listWorkflowFiles returns only workflow_call workflows, sorted', () => {
  assert.deepEqual(listWorkflowFiles('.github/workflows'), [
    'build.yml',
    'configure.yml',
    'docker.yml',
    'prepare.yml',
    'release.yml',
    'report.yml',
    'uploads.yml',
  ]);
});
