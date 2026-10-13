// impact-report: renders what this PR changes about the reusable-workflow
// surface and who is affected, into impact.md (consumed by _ci.yml's impact job
// for a sticky PR comment) and the Actions job summary.
//
// Trigger rule (phase 1): a changed reusable workflow gets a section when
// baseline → PR removes a `workflow_call` input or output — that is what
// consumers can still be passing or reading. Consumed surface comes from
// consumers.yml, refreshed by the impact job from GitHub code search (or
// consumers-manual.yml for repos search cannot see); a missing or empty
// inventory renders the report with an incompleteness warning instead of
// failing. The baseline is fetched from `contracts/<workflow>.json` at the
// merge base of the PR — before that file exists on the default branch every
// workflow reports as "baseline introduced". Non-removal breaking rows (type
// or default change, required false→true) are deferred to the Contracts job
// (phase 2). Non-reusable workflow files (e.g. `_ci.yml`) never appear.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { extractCurrentContracts, diffContracts } from './check-contracts.mjs';
import { readPrevEntries } from './inventory.mjs';

const WORKFLOW_PATH_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const help = `usage: impact-report.mjs [--base <branch>]

Writes the consumer-impact report to impact.md and appends it to the job
summary. The contract baseline is read from contracts/<workflow>.json at the
merge base of --base (default: main); consumers.yml should be refreshed in the
same job before this runs.
`;

/**
 * Names of workflow files changed in the diff, sorted, e.g. '.github/workflows/prepare.yml'.
 *
 * @param {string} diffText
 * @returns {string[]}
 */
export function changedWorkflowFiles(diffText) {
  const files = new Set();
  for (const m of diffText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const path = m[2] ?? '';
    if (WORKFLOW_PATH_RE.test(path)) files.add(path);
  }
  return [...files].sort();
}

/**
 * @typedef {object} FileUsage
 * @property {string} path consumer workflow file path
 * @property {string[]} passes inputs the file passes to this workflow
 * @property {string[]} reads outputs the file reads from this workflow
 *
 * @typedef {object} Section
 * @property {string} file changed workflow file ('build.yml')
 * @property {'impacted'|'clean'} status CAUTION (consumers use removed items) vs NOTE
 * @property {number} consumerCount total recorded consumer files of this workflow
 * @property {Array<{repo: string, files: FileUsage[]}>} impacted grouped by repo, sorted
 *
 * @typedef {object} ImpactModel
 * @property {Section[]} sections per changed workflow with removals
 * @property {string[]} noImpact changed, base present, nothing breaking removed
 * @property {string[]} nonRemovalBreaking breaking rows that are not removals (see Contracts job)
 * @property {string[]} introduced changed, no baseline to compare against
 * @property {boolean} inventoryEmpty the consumer inventory is missing or empty
 * @property {boolean} noChanges no changed reusable workflow at all
 */

/**
 * Analyze changed workflow files against baseline and current contracts,
 * filtering recorded consumers to those using the removed interface.
 *
 * @param {object} options
 * @param {string[]} options.changedFiles workflow file paths from the diff
 * @param {Map<string, any>} options.baseContracts baseline contracts by workflow name
 * @param {Map<string, any>} options.currentContracts PR contracts by workflow name
 * @param {Array<{repo: string, path: string, calls: Array<{workflow: string, inputs: string[], outputs?: string[]}>}>} options.inventory
 * @returns {ImpactModel}
 */
export function analyzeChanges({ changedFiles, baseContracts, currentContracts, inventory }) {
  /** @type {ImpactModel} */
  const model = {
    sections: [],
    noImpact: [],
    nonRemovalBreaking: [],
    introduced: [],
    inventoryEmpty: inventory.length === 0,
    noChanges: false,
  };

  for (const file of changedFiles) {
    const shortPath = file.replace(/^\.github\/workflows\//, '');
    const name = shortPath.replace(/\.ya?ml$/, '');
    const base = baseContracts.get(name) ?? null;
    const current = currentContracts.get(name) ?? null;

    // Not a reusable workflow on either side (internal workflow) → never shown.
    if (!base && !current) continue;
    // Reusable in the PR but not in the baseline → nothing to compare yet.
    if (!base) {
      model.introduced.push(shortPath);
      continue;
    }

    // Union each consumer file's surface for this workflow across its calls.
    /** @type {Array<{repo: string, path: string, passes: Set<string>, reads: Set<string>}>} */
    const consumerFiles = [];
    for (const entry of inventory) {
      const calls = entry.calls.filter((c) => c.workflow === name);
      if (calls.length === 0) continue;
      let rec = consumerFiles.find((f) => f.repo === entry.repo && f.path === entry.path);
      if (!rec) {
        rec = { repo: entry.repo, path: entry.path, passes: new Set(), reads: new Set() };
        consumerFiles.push(rec);
      }
      for (const call of calls) {
        for (const input of call.inputs) rec.passes.add(input);
        for (const output of call.outputs ?? []) rec.reads.add(output);
      }
    }

    // Deleted (or no longer workflow_call) → everything consumers use is gone.
    if (!current) {
      model.sections.push(buildSection(shortPath, consumerFiles, consumerFiles));
      continue;
    }

    const { changes } = diffContracts(base, current);
    /** @type {string[]} */
    const removedInputs = [];
    /** @type {string[]} */
    const removedOutputs = [];
    let otherBreaking = false;
    for (const change of changes) {
      if (change.change === 'removed' && change.kind === 'input') removedInputs.push(change.name);
      else if (change.change === 'removed' && change.kind === 'output') removedOutputs.push(change.name);
      else if (change.change === 'changed') otherBreaking = true;
    }

    if (removedInputs.length === 0 && removedOutputs.length === 0) {
      if (otherBreaking) model.nonRemovalBreaking.push(shortPath);
      else model.noImpact.push(shortPath);
      continue;
    }

    const overlapping = consumerFiles.filter(
      (f) =>
        [...f.passes].some((i) => removedInputs.includes(i)) ||
        [...f.reads].some((o) => removedOutputs.includes(o)),
    );
    model.sections.push(buildSection(shortPath, overlapping, consumerFiles));
  }

  model.noChanges =
    model.sections.length === 0 &&
    model.noImpact.length === 0 &&
    model.nonRemovalBreaking.length === 0 &&
    model.introduced.length === 0;
  return model;
}

/**
 * @param {string} file
 * @param {Array<{repo: string, path: string, passes: Set<string>, reads: Set<string>}>} files impacted subset
 * @param {Array<{repo: string, path: string, passes: Set<string>, reads: Set<string>}>} allFiles every consumer file
 * @returns {Section}
 */
function buildSection(file, files, allFiles) {
  /** @type {Map<string, FileUsage[]>} */
  const byRepo = new Map();
  for (const f of files) {
    const group = byRepo.get(f.repo) ?? [];
    group.push({ path: f.path, passes: [...f.passes].sort(), reads: [...f.reads].sort() });
    byRepo.set(f.repo, group);
  }
  const impacted = [...byRepo.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, groupFiles]) => ({ repo, files: groupFiles.sort((a, b) => a.path.localeCompare(b.path)) }));
  return {
    file,
    status: files.length > 0 ? 'impacted' : 'clean',
    consumerCount: allFiles.length,
    impacted,
  };
}

/**
 * Render the analysis to GitHub-flavoured markdown.
 *
 * @param {ImpactModel} model
 * @returns {string}
 */
export function renderImpactReport(model) {
  if (model.noChanges) return 'No reusable workflow changes in this PR — no consumer impact to report.\n';

  /** @type {string[]} */
  const lines = [];
  if (model.inventoryEmpty) {
    lines.push(
      '> [!WARNING]',
      '> Inventory unavailable (refresh failed or no token) — consumer lists below may be incomplete.',
      '',
    );
  }

  for (const section of model.sections) {
    lines.push(`### \`${section.file}\``, '');
    if (section.status === 'impacted') {
      lines.push(
        '> [!CAUTION]',
        `> This PR changes the \`workflow_call\` interface of \`${section.file}\`; the contract baseline and diff show what changed. The consumers below still use the old interface.`,
        '',
      );
      const impactedCount = section.impacted.reduce((n, group) => n + group.files.length, 0);
      lines.push(`Impacted consumers (${impactedCount} of ${section.consumerCount}):`);
      for (const group of section.impacted) {
        lines.push(`- \`${group.repo}\`:`);        for (const f of group.files) {
          const segments = [];
          if (f.passes.length > 0) segments.push(`passes: ${f.passes.map((n) => `\`${n}\``).join(', ')}`);
          if (f.reads.length > 0) segments.push(`reads: ${f.reads.map((n) => `\`${n}\``).join(', ')}`);
          lines.push(`  - \`${f.path.replace(/^\.github\/workflows\//, '')}\` — ${segments.join('; ')}`);
        }
      }
    } else {
      lines.push('> [!NOTE]', '> Interface changed, but no recorded consumer uses the removed items.');
    }
    lines.push('');
  }

  const list = (names) => names.map((n) => `\`${n}\``).join(', ');
  if (model.nonRemovalBreaking.length > 0) {
    lines.push(`Changed with non-removal interface changes (see the Contracts job): ${list(model.nonRemovalBreaking)}`);
  }
  if (model.noImpact.length > 0) lines.push(`Changed with no interface impact: ${list(model.noImpact)}`);
  if (model.introduced.length > 0) {
    lines.push(`Baseline introduced in this PR (nothing to compare): ${list(model.introduced)}`);
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * @param {string[]} args
 * @param {string} flag
 * @returns {string | undefined}
 */
function flag(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function appendToSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    writeFileSync(file, `${markdown}\n`, { flag: 'a' });
  } catch {
    // summary is best-effort
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(help);
    process.exit(0);
  }
  const base = flag(args, '--base') ?? 'main';

  let diffText = '';
  try {
    // --no-ext-diff/--no-textconv keep the output parseable even when a
    // developer has diff.external (e.g. difftastic) configured locally.
    diffText = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', `origin/${base}...HEAD`], {
      encoding: 'utf8',
    });
  } catch (err) {
    console.warn(`could not diff against origin/${base}: ${String(err)} — reporting no changes`);
  }
  const changedFiles = changedWorkflowFiles(diffText);

  // PR-side contracts, extracted from the worktree (reusable workflows only).
  const currentContracts = extractCurrentContracts('.github/workflows');

  // Baseline contracts at the merge base; a workflow without one has no
  // baseline to diff against yet.
  const mergeBase = execFileSync('git', ['merge-base', `origin/${base}`, 'HEAD'], { encoding: 'utf8' }).trim();
  /** @type {Map<string, any>} */
  const baseContracts = new Map();
  for (const file of changedFiles) {
    const name = file.replace(/^\.github\/workflows\//, '').replace(/\.ya?ml$/, '');
    if (baseContracts.has(name)) continue;
    try {
      const json = execFileSync('git', ['show', `${mergeBase}:contracts/${name}.json`], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        // stderr silenced: "does not exist" is the expected no-baseline case
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      baseContracts.set(name, JSON.parse(json));
    } catch {
      // no baseline on disk for this workflow yet
    }
  }

  const inventory = readPrevEntries('consumers.yml');
  const report = renderImpactReport(
    analyzeChanges({ changedFiles, baseContracts, currentContracts, inventory }),
  );

  writeFileSync('impact.md', report);
  appendToSummary(report);
  console.log(report);
  console.log('wrote impact.md; posting handled by the workflow step');
}
