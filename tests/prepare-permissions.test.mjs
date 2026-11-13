import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

// GitHub validates the permissions of a called workflow statically: a nested job
// requesting `write` is rejected unless the caller grants it. The fork downgrade
// happens later, when the token is minted, so the static contract still says
// `write` while the runtime token is `read` — invisible to any CI simulation.
// Hence the invariant: in `prepare.yml`, a job that needs a write scope may
// never fail the caller's pipeline.

/** @type {any} */
const prepare = load(readFileSync('.github/workflows/prepare.yml', 'utf8'));

/** @param {any} job */
const requestsWrite = (job) =>
  typeof job.permissions === 'object' &&
  Object.values(job.permissions).includes('write');

const writeJobs = Object.entries(prepare.jobs).filter(([, job]) =>
  requestsWrite(job),
);

test('every prepare.yml job needing a write scope is non-fatal', () => {
  assert.ok(
    writeJobs.length > 0,
    'expected at least the labels job to request a write scope',
  );

  for (const [name, job] of writeJobs) {
    assert.equal(
      job['continue-on-error'],
      true,
      `${name} requests a write scope and must set continue-on-error: true,` +
        ' or a fork PR (read-only token) fails the whole caller pipeline',
    );
  }
});
