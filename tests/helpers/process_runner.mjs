import { spawn } from 'node:child_process';

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
