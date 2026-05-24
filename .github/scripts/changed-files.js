// @ts-check

/**
 * @typedef {object} AssesmentOpt
 * @property {boolean} isPhp
 * @property {boolean} isNode
 * @property {NodePM} nodePM
 */

/**
 * @typedef {object} Assesment
 * @property {boolean} build
 * @property {boolean} deploy
 * @property {boolean} tests
 * @property {string} report
 */

/**
 * @typedef {'bun'|'npm'|'pnpm'} NodePM
 */

/** @type {Record<NodePM, string[]>} */
const pmPatterns = {
  bun: ['bun.lock', 'bunfig.toml'],
  npm: ['package-lock.json'],
  pnpm: ['pnpm-lock.y?aml'],
}

/** @type {string[]} */
const jsPatterns = [
  '**/*.?(c|m)[jt]s?(x)',
  'package.json',
];

/** @type {string[]} */
const phpPatterns = [
  '**/*.php',
  'composer.*',
  'phpunit.xml',
];

/**
 * @param {import('minimatch')} minimatch
 * @param {import('@actions/github-script').AsyncFunctionArguments} p2
 */
export function changedFiles(minimatch, { context, core, exec }) {
  /** @type {string[]} */
  const files = [];

  /**
   * @param {string[]} files
   * @param {AssesmentOpt} p0
   * @returns {Assesment}
   */
  function getAssesment(files, { isPhp, isNode, nodePM }) {
    const assesment = { build: false, deploy: false, tests: false, report: '' };

    if (isPhp) {
      for (const phpPatt of phpPatterns) {
        if (files.some(minimatch.filter(phpPatt))) {
          assesment.tests = true;
          break;
        }
      }
    }

    if (isNode) {
      jsPatterns.push(...pmPatterns[nodePM])

      for (const jsPatt of jsPatterns) {
        if (files.some(minimatch.filter(jsPatt))) {
          assesment.tests = true;
          break;
        }
      }
    }

    const reports = []

    for (const [key, val] of Object.entries(assesment)) {
      reports.push(`${key}: \u001b[1m${val}\u001b[0m`)
    }

    assesment.report = reports.join(', ')

    return assesment
  }


  /**
   * @param {string} current
   * @param {string} previous
   * @param {AssesmentOpt} opt
   */
  return async function main(current, previous, opt) {
    await exec.exec('git', ['diff', '--name-only', current, previous], {
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data) => {
          const changedFiles = data.toString().split('\n').map(f => f.trim())
          files.push(...changedFiles.filter(file => file.length > 0));
        },
        stderr: (data) => {
          const message = data.toString().split('\n').join(' ');
          core.error(`Failed to get changed files: ${message}`);
        }
      }
    });

    for (const diff of files) {
      core.info(`- \u001b[33m${diff}\u001b[0m`)
    }

    core.notice(`Found \u001b[1m${files.length}\u001b[0m files changed from ${current} to ${previous}`);

    /** @type {Assesment} */
    const assesment = context.eventName === 'workflow_dispatch'
      ? { build: true, deploy: true, tests: true, report: 'Runs from `workflow_dispatch`' }
      : getAssesment(files, opt)

    core.notice(`Assesment: ${assesment.report}`);

    core.setOutput('should-build', assesment.build ? 1 : 0);
    core.setOutput('should-deploy', assesment.deploy ? 1 : 0);
    core.setOutput('should-tests', assesment.tests ? 1 : 0);

    core.setOutput('available', files.length ? 1 : 0);

    return files;
  }
}
