import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { extractCallContract } from '../tools/extract-contracts.mjs';

// configure.yml is a deprecated facade over prepare.yml: it must keep its
// workflow_call contract (guarded separately by `npm run contracts`) while
// delegating to prepare, warning callers in the run summary, and never
// self-triggering on pull_request.

/** @type {any} */
const configure = load(readFileSync('.github/workflows/configure.yml', 'utf8'));

test('configure keeps workflow_call but no longer self-triggers on pull_request', () => {
  assert.equal(configure.on.pull_request, undefined, 'pull_request trigger must be removed');
  assert.ok(configure.on.workflow_call, 'workflow_call trigger must remain');
});

test('configure runs exactly two jobs, with the deprecation notice inside environments', () => {
  assert.deepEqual(Object.keys(configure.jobs).sort(), ['environments', 'prepare']);

  const notice = (configure.jobs.environments.steps ?? [])
    .find((/** @type {any} */ s) =>
      typeof s.run === 'string' && s.run.includes('$GITHUB_STEP_SUMMARY') && s.run.includes('deprecated'));
  assert.ok(notice, 'the deprecation notice must be a step of the environments job');
});

test('configure delegates to ./prepare with inputs, secret, and permissions passed through', () => {
  const entry = Object.entries(configure.jobs)
    .find(([, /** @type {any} */ job]) => job.uses === './.github/workflows/prepare.yml');
  assert.ok(entry, 'expected a job calling ./\.github/workflows/prepare.yml');

  const [, call] = entry;
  assert.equal(call.with['php-version'], '${{ inputs.php-version }}');
  assert.equal(call.with['target-env'], '${{ inputs.target-env }}');
  assert.equal(call.secrets['COVERALLS_REPO_TOKEN'], '${{ secrets.COVERALLS_REPO_TOKEN }}');
  assert.deepEqual(call.permissions, { contents: 'read', 'pull-requests': 'write' });
});

test('every workflow_call output is backed by a real job output; literals only for has-codeclimate', () => {
  for (const [name, output] of Object.entries(configure.on.workflow_call.outputs ?? {})) {
    const match = /^\$\{\{ jobs\.([\w-]+)\.outputs\.([\w-]+) \}\}$/.exec(String(output.value));
    if (!match) {
      assert.equal(name, 'has-codeclimate', `output ${name} must reference a job output, got ${output.value}`);
      continue;
    }
    const job = configure.jobs[match[1]];
    assert.ok(job, `output ${name} references missing job ${match[1]}`);
    if (typeof job.uses === 'string') {
      // Reusable-call job: the output must exist on the called workflow's contract.
      const called = extractCallContract(readFileSync(job.uses.replace(/^\.\//, ''), 'utf8'));
      assert.ok(
        called?.outputs.some((o) => o.name === match[2]),
        `output ${name} references ${match[1]}.${match[2]} which the called workflow does not expose`,
      );
    } else {
      assert.ok(match[2] in (job.outputs ?? {}), `output ${name} references missing job output ${match[2]}`);
    }
  }
});
