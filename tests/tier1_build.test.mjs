import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './helpers/process_runner.mjs';

const ROOT_DIR = process.cwd();
const TAURI_DIR = path.join(ROOT_DIR, 'src-tauri');

describe('Tier 1: Build & Compilation Verification', () => {
  it('Test 1.1: npm run build exits with code 0', { timeout: 120000 }, async () => {
    const result = await runCommand('npm', ['run', 'build'], ROOT_DIR);
    assert.equal(
      result.exitCode,
      0,
      `npm run build failed with exit code ${result.exitCode}.\nStderr: ${result.stderr}\nStdout: ${result.stdout}`
    );
  });

  it('Test 1.2: npx tsc --noEmit exits with code 0', { timeout: 120000 }, async () => {
    const result = await runCommand('npx', ['tsc', '--noEmit'], ROOT_DIR);
    assert.equal(
      result.exitCode,
      0,
      `npx tsc --noEmit failed with exit code ${result.exitCode}.\nStderr: ${result.stderr}\nStdout: ${result.stdout}`
    );
  });

  it('Test 1.3: cargo check in src-tauri exits with code 0', { timeout: 180000 }, async () => {
    const result = await runCommand('cargo', ['check', '--locked'], TAURI_DIR);
    assert.equal(
      result.exitCode,
      0,
      `cargo check failed with exit code ${result.exitCode}.\nStderr: ${result.stderr}\nStdout: ${result.stdout}`
    );
  });

  it('Test 1.4: dist/index.html exists after build', () => {
    const indexPath = path.join(ROOT_DIR, 'dist', 'index.html');
    const exists = fs.existsSync(indexPath);
    assert.ok(exists, `Expected build artifact dist/index.html to exist at ${indexPath}`);
  });

  it('Test 1.5: dist/assets contains JS and CSS bundles', () => {
    const assetsDir = path.join(ROOT_DIR, 'dist', 'assets');
    assert.ok(fs.existsSync(assetsDir), `Expected dist/assets directory to exist at ${assetsDir}`);

    const files = fs.readdirSync(assetsDir);
    const hasJs = files.some((f) => f.endsWith('.js'));
    const hasCss = files.some((f) => f.endsWith('.css'));

    assert.ok(hasJs, `dist/assets should contain at least one .js bundle file. Found: ${files.join(', ')}`);
    assert.ok(hasCss, `dist/assets should contain at least one .css bundle file. Found: ${files.join(', ')}`);
  });
});
