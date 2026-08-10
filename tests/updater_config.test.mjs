import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const cargoToml = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri', 'Cargo.toml'), 'utf8');

describe('Updater release configuration', () => {
  it('uses the Void release endpoint for updater metadata', () => {
    assert.deepEqual(tauriConf.plugins?.updater?.endpoints, [
      'https://github.com/mrkrecha3321-max/Void/releases/latest/download/latest.json',
    ]);
  });

  it('keeps app versions aligned across package.json, tauri.conf.json and Cargo.toml', () => {
    const cargoVersionMatch = cargoToml.match(/^\s*version\s*=\s*"([^"]+)"\s*$/m);
    assert.ok(cargoVersionMatch, 'Expected to find version in src-tauri/Cargo.toml');
    const cargoVersion = cargoVersionMatch[1];

    assert.equal(packageJson.version, tauriConf.version, 'package.json and tauri.conf.json versions must match');
    assert.equal(packageJson.version, cargoVersion, 'package.json and Cargo.toml versions must match');
  });
});
