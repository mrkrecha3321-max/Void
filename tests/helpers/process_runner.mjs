import { spawn } from 'node:child_process';

/**
 * Asynchronously executes a CLI command and returns exit code, stdout, and stderr.
 *
 * @param {string} cmd - Command to execute (e.g. 'npm', 'npx', 'cargo')
 * @param {string[]} [args=[]] - Array of argument strings
 * @param {string} [cwd=process.cwd()] - Working directory for execution
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export async function runCommand(cmd, args = [], cwd = process.cwd()) {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const command = isWindows ? 'cmd.exe' : cmd;
    const commandArgs = isWindows ? ['/c', cmd, ...args] : args;

    const child = spawn(command, commandArgs, {
      cwd,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      stderr += err.message;
      resolve({ exitCode: 1, stdout, stderr });
    });

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}
