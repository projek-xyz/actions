import test from 'node:test';
import assert from 'node:assert/strict';
import { previousRun } from '../.github/scripts/previous-run.js';

const CONTEXT = { repo: { owner: 'projek-xyz', repo: 'actions' }, workflow: 'CI' };
const SHA = 'a'.repeat(40);

function makeCore() {
  const outputs = {};
  return {
    outputs,
    core: {
      setOutput: (k, v) => { outputs[k] = String(v); },
      info: () => {},
      debug: () => {},
      notice: () => {},
    },
  };
}

function makeGithub({
  workflows = [{ name: 'CI', id: 11 }],
  runsByBranch = {},
  artifacts = [{ id: 7, name: 'build-testing' }],
  throwOnRuns = false,
} = {}) {
  return {
    github: {
      rest: {
        actions: {
          listRepoWorkflows: async () => ({ data: { workflows } }),
          listWorkflowRuns: async ({ branch }) => {
            if (throwOnRuns) throw new Error('boom');
            return { data: { workflow_runs: runsByBranch[branch] ?? [] } };
          },
          listWorkflowRunArtifacts: async () => ({ data: { artifacts } }),
        },
      },
    },
  };
}

test('workflow name not found yields available=0 and null sha', async () => {
  const { outputs, core } = makeCore();
  const { github } = makeGithub({ workflows: [{ name: 'Other', id: 1 }] });

  const result = await previousRun({ context: CONTEXT, core, exec: { exec: async () => 0 }, github })(['feature', 'main']);

  assert.equal(outputs['available'], '0');
  assert.equal(result.sha, null);
});

test('valid run on current branch is selected with artifacts', async () => {
  const { outputs, core } = makeCore();
  const { github } = makeGithub({
    runsByBranch: { feature: [{ id: 1, head_commit: { id: SHA, message: 'feat: x' } }] },
  });

  const result = await previousRun({ context: CONTEXT, core, exec: { exec: async () => 0 }, github })(['feature', 'main']);

  assert.equal(outputs['available'], '1');
  assert.equal(result.sha, SHA);
  assert.equal(result.branch, 'feature');
  assert.equal(result.message, 'feat: x');
  assert.deepEqual(result.artifacts, [{ id: 7, name: 'build-testing' }]);
});

test('run with invalid sha (cat-file fails) is skipped for the next run', async () => {
  const { outputs, core } = makeCore();
  const { github } = makeGithub({
    runsByBranch: {
      feature: [
        { id: 1, head_commit: { id: 'bad', message: 'bad' } },
        { id: 2, head_commit: { id: SHA, message: 'good' } },
      ],
    },
  });
  // git cat-file -e <id>: args[2] is the id; non-zero exit = invalid object
  const exec = { exec: async (cmd, args) => (args[2] === 'bad' ? 1 : 0) };

  const result = await previousRun({ context: CONTEXT, core, exec, github })(['feature', 'main']);

  assert.equal(outputs['available'], '1');
  assert.equal(result.sha, SHA);
});

test('falls through to base branch when current branch has no runs', async () => {
  const { outputs, core } = makeCore();
  const { github } = makeGithub({
    runsByBranch: { main: [{ id: 9, head_commit: { id: SHA, message: 'merge' } }] },
  });

  const result = await previousRun({ context: CONTEXT, core, exec: { exec: async () => 0 }, github })(['feature', 'main']);

  assert.equal(outputs['available'], '1');
  assert.equal(result.branch, 'main');
});

test('api error is swallowed and yields available=0', async () => {
  const { outputs, core } = makeCore();
  const { github } = makeGithub({ throwOnRuns: true });

  const result = await previousRun({ context: CONTEXT, core, exec: { exec: async () => 0 }, github })(['feature']);

  assert.equal(outputs['available'], '0');
  assert.equal(result.sha, null);
});
