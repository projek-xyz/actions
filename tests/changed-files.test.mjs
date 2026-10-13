import test from 'node:test';
import assert from 'node:assert/strict';

// The script mutates a module-level `jsPatterns` array, so each test loads a
// fresh module instance via cache-busting dynamic import.
let importCounter = 0;
async function loadChangedFiles() {
  const mod = await import(`../.github/scripts/changed-files.js?fresh=${++importCounter}`);
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

function makeExec(diffText) {
  return {
    exec: async (cmd, args, opts) => {
      opts.listeners.stdout(Buffer.from(diffText));
      return 0;
    },
  };
}

function makeGlob(files) {
  const calls = [];
  return {
    calls,
    glob: {
      create: async (patterns) => {
        calls.push(patterns);
        return {
          async *globGenerator() {
            for (const f of files) yield f;
          },
        };
      },
    },
  };
}

const ctx = (eventName) => ({ eventName });

test('workflow_dispatch forces build, deploy and tests', async () => {
  const changedFiles = await loadChangedFiles();
  const { outputs, core } = makeCore();
  const exec = makeExec('');
  const { glob } = makeGlob([]);

  await changedFiles({ context: ctx('workflow_dispatch'), core, exec, glob })(
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
  const { glob } = makeGlob(['/workspace/src/App.tsx']);

  await changedFiles({ context: ctx('push'), core, exec, glob })(
    'aaaaaaaabbbbbbbbb',
    'ccccccccdddddddd',
    { isPhp: false, isNode: true, nodePM: 'npm' },
  );

  assert.equal(outputs['should-build'], '1');
  assert.equal(outputs['should-tests'], '1');
  assert.equal(outputs['should-deploy'], '0');
});

test('php composer.json change triggers build and tests', async () => {
  const changedFiles = await loadChangedFiles();
  const { outputs, core } = makeCore();
  const exec = makeExec('composer.json');
  const { glob } = makeGlob(['/workspace/composer.json']);

  await changedFiles({ context: ctx('push'), core, exec, glob })(
    'aaaaaaaabbbbbbbbb',
    'ccccccccdddddddd',
    { isPhp: true, isNode: false, nodePM: 'npm' },
  );

  assert.equal(outputs['should-build'], '1');
  assert.equal(outputs['should-tests'], '1');
});

test('package-manager lockfile patterns: only the active pm globs its lockfile', async () => {
  const cases = [
    { nodePM: 'npm', includes: ['package-lock.json'], excludes: ['bun.lock'] },
    { nodePM: 'pnpm', includes: ['pnpm-*.{yaml,yml}'], excludes: ['bun.lock'] },
    { nodePM: 'bun', includes: ['bun.lock'], excludes: [] },
  ];

  for (const { nodePM, includes, excludes } of cases) {
    const changedFiles = await loadChangedFiles();
    const { core } = makeCore();
    const exec = makeExec('');
    const { calls, glob } = makeGlob([]);

    await changedFiles({ context: ctx('push'), core, exec, glob })(
      'aaaaaaaabbbbbbbbb',
      'ccccccccdddddddd',
      { isPhp: false, isNode: true, nodePM },
    );

    const patterns = calls[0];
    for (const needle of includes) {
      assert.ok(patterns.includes(needle), `expected patterns for ${nodePM} to include ${needle}`);
    }
    for (const needle of excludes) {
      assert.ok(!patterns.includes(needle), `expected patterns for ${nodePM} to exclude ${needle}`);
    }
  }
});

test('no changed files reports available=0 and no build', async () => {
  const changedFiles = await loadChangedFiles();
  const { outputs, core } = makeCore();
  const exec = makeExec('');
  const { glob } = makeGlob([]);

  await changedFiles({ context: ctx('push'), core, exec, glob })(
    'aaaaaaaabbbbbbbbb',
    'ccccccccdddddddd',
    { isPhp: true, isNode: true, nodePM: 'npm' },
  );

  assert.equal(outputs['available'], '0');
  assert.equal(outputs['should-build'], '0');
});
