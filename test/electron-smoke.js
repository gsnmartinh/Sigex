'use strict';
// Ejecutar con Node: node test/electron-smoke.js /ruta/electron.exe
const fs = require('node:fs');
const path = require('node:path');
if (process.versions.electron) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    fs.writeFileSync(process.env.SIGEX_SMOKE_PROOF, JSON.stringify({ electron: process.versions.electron, sqlite: db.prepare('select sqlite_version() v').get().v }));
    db.close();
  } catch (error) { fs.writeFileSync(process.env.SIGEX_SMOKE_PROOF, JSON.stringify({ error: error.message })); process.exitCode = 1; }
} else {
  const proof = path.join(require('node:os').tmpdir(), 'sigex-electron-' + require('node:crypto').randomUUID() + '.json');
  const child = require('node:child_process').spawnSync(path.resolve(process.argv[2]), [__filename], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SIGEX_SMOKE_PROOF: proof }, encoding: 'utf8', timeout: 25000, windowsHide: true });
  if (!fs.existsSync(proof)) throw new Error('Electron no completó la prueba: ' + (child.error?.message || child.stderr || child.status));
  const result = JSON.parse(fs.readFileSync(proof, 'utf8')); fs.rmSync(proof);
  console.log(result);
  if (result.error || child.status !== 0) process.exitCode = 1;
}
