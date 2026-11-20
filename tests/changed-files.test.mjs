import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

// The script mutates a module-level `jsPatterns` array, so each test loads a
// fresh module instance via cache-busting dynamic import.
let importCounter = 0;
async function loadChangedFiles() {
  const mod = await import(`../.github/scripts/changed-files.mjs?fresh=${++importCounter}`);
  return mod.changedFiles;
}

function makeCore() {
  const outputs = {};
  return {
    outputs,
    core: {
      setOutput: (k, v) => { outputs[k] = String(v); },
      notice: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
    },
  };
}

function makeExec(diffText, exitCode = 0) {
  return {
    exec: async (cmd, args, opts) => {
      if (exitCode === 0) {
        opts.listeners.stdout(Buffer.from(diffText));
      } else {
        opts.listeners.stderr(Buffer.from('fatal: bad object'));
      }
      return exitCode;
    },
  };
}

const ctx = (eventName) => ({ eventName });

// Consumers run this workflow from a pinned ref but the scripts are checked out
// from `main`, so both revisions meet; an older script still requires `glob`.
test('workflow passes `glob` for scripts checked out from `main`', () => {
  const prepare = load(readFileSync('.github/workflows/prepare.yml', 'utf8'));
  const step = prepare.jobs.environments.steps.find((s) => s.id === 'changed-files');

  assert.match(step.with.script, /changedFiles\(\{[^}]*\bglob\b[^}]*\}\)/);
});

test('workflow_dispatch forces build, deploy and tests', async () => {
  const changedFiles = await loadChangedFiles();
  const { outputs, core } = makeCore();
  const exec = makeExec('');

  await changedFiles({ context: ctx('workflow_dispatch'), core, exec })(
    'aaaaaaaabbbbbbbbb',
    'ccccccccdddddddd',
    { isPhp: false, isNode: false, nodePM: 'npm' },
  );

  assert.equal(outputs['should-build'], '1');
  assert.equal(outputs['should-deploy'], '1');
  assert.equal(outputs['should-tests'], '1');
});

test('node tsx change triggers build and tests but not deploy', async () => {
  const changedFiles = await loadChangedFiles();
  const { outputs, core } = makeCore();
  const exec = makeExec('src/App.tsx');

  await changedFiles({ context: ctx('push'), core, exec })(
    'aaaaaaaabbbbbbbbb',
    'ccccccccdddddddd',
    { isPhp: false, isNode: true, nodePM: 'npm' },
  );

  assert.equal(outputs['should-build'], '1');
  assert.equal(outputs['should-tests'], '1');
  assert.equal(outputs['should-deploy'], '0');
});

// A `workflow_run` caller has the default branch checked out, so the diff can
// name a file that does not exist on disk; the path alone must decide.
test('added file absent from the checkout still triggers build and tests', async () => {
  const changedFiles = await loadChangedFiles();
  const { outputs, core } = makeCore();
  const exec = makeExec('src/new.js');

  await changedFiles({ context: ctx('workflow_run'), core, exec })(
    'aaaaaaaabbbbbbbbb',
    'ccccccccdddddddd',
    { isPhp: false, isNode: true, nodePM: 'npm' },
  );

  assert.equal(outputs['should-build'], '1');
  assert.equal(outputs['should-tests'], '1');
});

test('deleted php file triggers build and tests', async () => {
  const changedFiles = await loadChangedFiles();
  const { outputs, core } = makeCore();
  const exec = makeExec('app/Models/Gone.php');

  await changedFiles({ context: ctx('workflow_run'), core, exec })(
    'aaaaaaaabbbbbbbbb',
    'ccccccccdddddddd',
    { isPhp: true, isNode: false, nodePM: 'npm' },
  );

  assert.equal(outputs['should-build'], '1');
  assert.equal(outputs['should-tests'], '1');
});

test('php composer.json change triggers build and tests', async () => {
  const changedFiles = await loadChangedFiles();
  const { outputs, core } = makeCore();
  const exec = makeExec('composer.json');

  await changedFiles({ context: ctx('push'), core, exec })(
    'aaaaaaaabbbbbbbbb',
    'ccccccccdddddddd',
    { isPhp: true, isNode: false, nodePM: 'npm' },
  );

  assert.equal(outputs['should-build'], '1');
  assert.equal(outputs['should-tests'], '1');
});

test('lockfile changes build only for the active package manager', async () => {
  const cases = [
    { file: 'package-lock.json', nodePM: 'npm', expected: '1' },
    { file: 'package-lock.json', nodePM: 'pnpm', expected: '0' },
    { file: 'pnpm-lock.yaml', nodePM: 'pnpm', expected: '1' },
    { file: 'pnpm-lock.yaml', nodePM: 'npm', expected: '0' },
    { file: 'bun.lock', nodePM: 'bun', expected: '1' },
    { file: 'bun.lock', nodePM: 'npm', expected: '0' },
  ];

  for (const { file, nodePM, expected } of cases) {
    const changedFiles = await loadChangedFiles();
    const { outputs, core } = makeCore();
    const exec = makeExec(file);

    await changedFiles({ context: ctx('push'), core, exec })(
      'aaaaaaaabbbbbbbbb',
      'ccccccccdddddddd',
      { isPhp: false, isNode: true, nodePM },
    );

    assert.equal(outputs['should-build'], expected, `${file} with nodePM=${nodePM}`);
  }
});

test('no changed files reports available=0 and no build', async () => {
  const changedFiles = await loadChangedFiles();
  const { outputs, core } = makeCore();
  const exec = makeExec('');

  await changedFiles({ context: ctx('push'), core, exec })(
    'aaaaaaaabbbbbbbbb',
    'ccccccccdddddddd',
    { isPhp: true, isNode: true, nodePM: 'npm' },
  );

  assert.equal(outputs['available'], '0');
  assert.equal(outputs['should-build'], '0');
  assert.equal(outputs['should-tests'], '0');
});

// The upstream commit can be missing from the clone (fork PR head); the diff
// then fails, which must not read as "nothing to build".
test('failed diff falls back to build and tests', async () => {
  const changedFiles = await loadChangedFiles();
  const { outputs, core } = makeCore();
  const exec = makeExec('', 128);

  await changedFiles({ context: ctx('workflow_run'), core, exec })(
    'aaaaaaaabbbbbbbbb',
    'ccccccccdddddddd',
    { isPhp: true, isNode: true, nodePM: 'npm' },
  );

  assert.equal(outputs['available'], '0');
  assert.equal(outputs['should-build'], '1');
  assert.equal(outputs['should-tests'], '1');
  assert.equal(outputs['should-deploy'], '0');
});
