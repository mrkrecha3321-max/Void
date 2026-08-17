const fs = require('fs');
const path = require('path');

const newVersion = String(process.argv[2] || '').trim().replace(/^v/i, '');
if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error('[BLAD] Wersja musi miec format X.Y.Z, np. 0.2.1');
  process.exit(1);
}

const rootDir = path.join(__dirname, '..');

function readJson(relativePath) {
  const filePath = path.join(rootDir, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`Brak pliku ${relativePath}`);
  return [filePath, JSON.parse(fs.readFileSync(filePath, 'utf8'))];
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

try {
  const [packagePath, packageJson] = readJson('package.json');
  packageJson.version = newVersion;
  writeJson(packagePath, packageJson);
  console.log(`[OK] package.json -> ${newVersion}`);

  const [packageLockPath, packageLock] = readJson('package-lock.json');
  packageLock.version = newVersion;
  if (!packageLock.packages || !packageLock.packages['']) {
    throw new Error('package-lock.json nie zawiera rekordu packages[""]');
  }
  packageLock.packages[''].version = newVersion;
  writeJson(packageLockPath, packageLock);
  console.log(`[OK] package-lock.json -> ${newVersion}`);

  const [tauriConfigPath, tauriConfig] = readJson('src-tauri/tauri.conf.json');
  tauriConfig.version = newVersion;
  writeJson(tauriConfigPath, tauriConfig);
  console.log(`[OK] src-tauri/tauri.conf.json -> ${newVersion}`);

  const cargoPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
  let cargoContent = fs.readFileSync(cargoPath, 'utf8');
  const cargoUpdated = cargoContent.replace(
    /^(\[package\][\s\S]*?^version\s*=\s*")[^"]+(".*$)/m,
    `$1${newVersion}$2`,
  );
  if (cargoUpdated === cargoContent) {
    throw new Error('Nie znaleziono wersji pakietu w src-tauri/Cargo.toml');
  }
  fs.writeFileSync(cargoPath, cargoUpdated, 'utf8');
  console.log(`[OK] src-tauri/Cargo.toml -> ${newVersion}`);

  const cargoLockPath = path.join(rootDir, 'src-tauri', 'Cargo.lock');
  let cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
  const cargoLockUpdated = cargoLock.replace(
    /(\[\[package\]\]\s*\nname = "vortex-app"\s*\nversion = ")[^"]+("\s*\n)/,
    `$1${newVersion}$2`,
  );
  if (cargoLockUpdated === cargoLock) {
    throw new Error('Nie znaleziono pakietu vortex-app w src-tauri/Cargo.lock');
  }
  fs.writeFileSync(cargoLockPath, cargoLockUpdated, 'utf8');
  console.log(`[OK] src-tauri/Cargo.lock -> ${newVersion}`);

  const values = [
    JSON.parse(fs.readFileSync(packagePath, 'utf8')).version,
    JSON.parse(fs.readFileSync(packageLockPath, 'utf8')).version,
    JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8')).version,
  ];
  if (!values.every((value) => value === newVersion)) {
    throw new Error('Kontrola koncowa wersji nie powiodla sie');
  }

  console.log(`[OK] Wszystkie wersje ustawiono na ${newVersion}`);
} catch (error) {
  console.error(`[BLAD] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
