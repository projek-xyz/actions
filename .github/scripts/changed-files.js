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
  pnpm: ['pnpm-*.{yaml,yml}'],
}

/** @type {string[]} */
const jsPatterns = [
  '**/*.{cjs,js,jsx,mjs,mts,ts,tsx}',
  '{jsconfig,tsconfig}.json',
  'biome.*',
  'package.json',
];

/** @type {string[]} */
const phpPatterns = [
  '**/*.php',
  'composer.*',
  'phpcs.*',
  'phpstan.*',
  'phpunit.*',
  'pint.json',
];

/**
 * @param {import('@actions/github-script').AsyncFunctionArguments} p2
 */
export function changedFiles({ context, core, exec, glob }) {
  /** @type {string[]} */
  const files = [];

  /**
   * @param {string[]} files
   * @param {AssesmentOpt} p0
   * @returns {Promise<Assesment>}
   */
  async function getAssesment(files, { isPhp, isNode, nodePM }) {
    const assesment = { build: false, deploy: false, tests: false, report: '' };

    /** @type {string[]} */
    const patterns = [
      '.github/{actions,workflows}/*.{yaml,yml}'
    ]

    if (isPhp) {
      patterns.push(...phpPatterns)
    }

    if (isNode) {
      jsPatterns.push(...pmPatterns[nodePM])
      patterns.push(...jsPatterns)
    }

    const globber = await glob.create(patterns.join('\n'))
    const matches = []

    for await (const file of globber.globGenerator()) {
      matches.push(file)
      if (files.find(path => file.endsWith(path))) {
        assesment.build = true;
        assesment.tests = true;
        break;
      }
    }

    console.log({ files, matches })
    const reports = [];

    for (const [key, val] of Object.entries(assesment)) {
      if (key === 'report') continue;
      const color = val ? '35' : '36'
      reports.push(`\u001b[1m${key}\u001b[0m: \u001b[${color}m${val}\u001b[0m`);
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

    current = current.slice(0, 8)
    previous = previous.slice(0, 8)

    const notices = [
      `Found \u001b[33m${files.length}\u001b[0m files changed from \u001b[33m${previous}\u001b[0m to \u001b[33m${current}\u001b[0m`
    ]

    for (const diff of files) {
      notices.push(`- \u001b[34m${diff}\u001b[0m`)
    }

    core.notice(notices.join('\n'));

    /** @type {Assesment} */
    const assesment = context.eventName === 'workflow_dispatch'
      ? { build: true, deploy: true, tests: true, report: 'Runs from `workflow_dispatch`' }
      : (await getAssesment(files, opt))

    core.notice(`Assesment: ${assesment.report}`);

    core.setOutput('should-build', assesment.build ? 1 : 0);
    core.setOutput('should-deploy', assesment.deploy ? 1 : 0);
    core.setOutput('should-tests', assesment.tests ? 1 : 0);

    core.setOutput('available', files.length ? 1 : 0);

    return files;
  }
}
