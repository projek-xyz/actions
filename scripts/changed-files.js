// @ts-check

/** @param {import('@actions/github-script').AsyncFunctionArguments} _ */
export function changedFiles({ core, exec }) {
  /** @type {string[]} */
  const files = [];

  /**
   * @param {string} current
   * @param {string} previous
   */
  return async function main(current, previous) {
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
    core.setOutput('available', files.length ? 1 : 0);

    return files;
  }
}
