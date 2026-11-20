import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

// A `workflow_run` caller runs on the default branch ref, so `GITHUB_REF` and
// `GITHUB_SHA` describe `main` while the run being processed is on another
// branch (or a PR). The project step prefers the upstream payload when it is
// present; these cases pin both shapes so a later refactor cannot drop it.

/** @type {any} */
const prepare = load(readFileSync('.github/workflows/prepare.yml', 'utf8'));

/** @type {{id?: string, run?: string}} */
const project = prepare.jobs.environments.steps.find(
  /** @param {any} step */ (step) => step.id === 'project',
);

/**
 * @param {Record<string, string>} env
 * @returns {Record<string, string>}
 */
const runProject = (env) => {
  const dir = mkdtempSync(join(tmpdir(), 'prepare-'));
  const output = join(dir, 'output');

  mkdirSync(join(dir, '.github/xyz-actions/.github/scripts'), { recursive: true });
  writeFileSync(output, '');

  execFileSync('bash', ['-c', project.run ?? ''], {
    cwd: dir,
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'Owner/Repo', ...env },
  });

  return Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
};

const direct = {
  GITHUB_REF: 'refs/pull/44/merge',
  GITHUB_HEAD_REF: 'feat/prepare-dist',
  GITHUB_BASE_REF: 'main',
  GITHUB_SHA: '111aaaabbbbbcccccdddddeeeeefffff00001111',
  COMMIT_MESSAGE: '',
  BASE_BRANCH: 'main',
};

const upstream = {
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REF_NAME: 'main',
  GITHUB_SHA: '222aaaabbbbbcccccdddddeeeeefffff00002222',
  COMMIT_MESSAGE: '',
  BASE_BRANCH: 'main',
};

test('direct caller keeps describing its own ref', () => {
  const out = runProject(direct);

  assert.equal(out['branch-name'], 'feat/prepare-dist');
  assert.equal(out['branch-slug'], 'feat_prepare-dist');
  assert.equal(out['pr-number'], '44');
  assert.equal(out['base-branch'], 'main');
  assert.equal(out.version, 'pr44-feat_prepare-dist.111aaaab');
});

test('workflow_run caller describes the upstream PR run', () => {
  const out = runProject({
    ...upstream,
    UPSTREAM_BRANCH: 'feat/prepare-dist',
    UPSTREAM_SHA: '333aaaabbbbbcccccdddddeeeeefffff00003333',
    UPSTREAM_PR: '44',
    UPSTREAM_BASE: 'main',
  });

  assert.equal(out['branch-name'], 'feat/prepare-dist');
  assert.equal(out['branch-slug'], 'feat_prepare-dist');
  assert.equal(out['pr-number'], '44');
  assert.equal(out['base-branch'], 'main');
  assert.equal(out.version, 'pr44-feat_prepare-dist.333aaaab');
});

test('workflow_run caller describes the upstream branch push', () => {
  const out = runProject({
    ...upstream,
    UPSTREAM_BRANCH: 'main',
    UPSTREAM_SHA: '444aaaabbbbbcccccdddddeeeeefffff00004444',
    UPSTREAM_PR: '',
    UPSTREAM_BASE: '',
  });

  assert.equal(out['branch-name'], 'main');
  assert.equal(out['branch-slug'], 'main');
  assert.equal(out['pr-number'], '');
  assert.equal(out['base-branch'], 'main');
  assert.equal(out.version, 'main.444aaaab');
});

test('release commit from a workflow_run overrides the version', () => {
  const out = runProject({
    ...upstream,
    UPSTREAM_BRANCH: 'main',
    UPSTREAM_SHA: '444aaaabbbbbcccccdddddeeeeefffff00004444',
    COMMIT_MESSAGE: 'chore(release): 1.2.3\n\nSigned-off-by: someone',
  });

  assert.equal(out['should-release'], '1');
  assert.equal(out.version, '1.2.3');
  assert.equal(out['commit-title'], 'chore(release): 1.2.3');
});

test('commit-message default falls back to the upstream commit', () => {
  assert.match(
    prepare.on.workflow_call.inputs['commit-message'].default,
    /github\.event\.head_commit\.message \|\| github\.event\.workflow_run\.head_commit\.message/,
  );
});
