'use strict';
// Servidor de prueba: sirve la interfaz real en un navegador y reemplaza el puente de Electron por HTTP.
// Uso: SIGEX_LEGACY=/ruta/sigex.sqlite node test/ui-server.js [puerto]
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, seedCourts, importLegacy } = require('../src/db');
const { createService } = require('../src/service');
const { createScanSession } = require('../src/scan');
const { createDocumentWorkflow } = require('../src/document-workflow');
const { MODELS } = require('../src/exhorto-documents');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigex-ui-'));
const db = openDatabase(path.join(tmp, 'data', 'ui.sqlite'));
const svc = createService({ db, attachmentsDir: path.join(tmp, 'docs') });
const legacy = process.env.SIGEX_LEGACY;
if (legacy && fs.existsSync(legacy)) importLegacy(db, legacy);
seedCourts(db, path.join(root, 'data', 'courts_seed.json'));

const samplePdf = path.join(tmp, 'sentencia_prueba.pdf');
fs.writeFileSync(samplePdf, '%PDF-1.4\n% prueba\n');
const calls = [];
const documentWorkflow = createDocumentWorkflow({ service: svc, templateDir: path.join(tmp, 'templates'), outputDir: path.join(tmp, 'word'),
  signers: () => ({ judge: 'Juez de Prueba', judgeRole: 'Juez titular', secretary: 'Secretaría de Prueba', secretaryRole: 'Secretaria titular' }),
  reserveOrd: async p => { calls.push({ type: 'ord', ...p }); return String(1000 + calls.filter(c => c.type === 'ord').length); },
  openFile: async file => { calls.push({ type: 'word', file }); return ''; } });
if (process.env.SIGEX_TEST_AUTO_ORD) svc.saveSettings({ ord_endpoint: 'https://script.google.com/macros/s/prueba/exec' });
const JPG = fs.readFileSync(path.join(__dirname, 'hoja.jpg'));
const scanner = createScanSession({ tmpRoot: path.join(tmp, 'scan'), acquire: async (f, o = {}) => { if (process.env.SCAN_FAIL) throw new Error('No se encontró un escáner conectado'); const n = o.source === 'feeder' ? (o.duplex ? 4 : 3) : 1; const out = []; for (let i = 0; i < n; i++) { const g = f.replace(/\.jpg$/, `_${i}.jpg`); fs.writeFileSync(g, JPG); out.push(g); } return out; } });

const handlers = {
  ...svc,
  ...documentWorkflow,
  documentModels: () => MODELS,
  openGeneratedDocument: async id => { calls.push({ type: 'reprint', path: svc.generatedDocumentPath(id) }); return { ok: true }; },
  openCaseFolder: async () => ({ ok: true }),
  openCorrespondenceSheet: async () => ({ ok: true }),
  openOrdInstructions: async () => ({ ok: true }),
  pickDocumentFolder: async () => ({ canceled: true }),
  testOrdConnection: async () => ({ ok: true, name: 'Libro de prueba' }),
  saveOrdConnection: async () => ({ ok: true }),
  pickFilePath: async () => samplePdf,
  pickAndAttach: async (id, kind) => { svc.addDocument(id, kind, samplePdf); return { canceled: false, count: 1 }; },
  attachPaths: async (id, kind, paths) => { for (const p of paths) svc.addDocument(id, kind, p); return { count: paths.length }; },
  scanPage: o => scanner.scanPage(o || {}),
  scanRemoveAt: async i => scanner.removeAt(i),
  scanMove: async (a, b) => scanner.move(a, b),
  scanFinish: async n => scanner.finish(n),
  scanCancel: async () => scanner.cancel(),
  openDocument: async () => ({ ok: true }),
  pickSignatureImage: async () => { svc.saveSettings({ signature_image: path.join(__dirname, 'hoja.jpg') }); return { canceled: false }; },
  removeSignatureImage: async () => { svc.saveSettings({ signature_image: '' }); return { ok: true }; },
  getSignatureImage: async () => (svc.getSettings().signature_image ? 'data:image/jpeg;base64,' + fs.readFileSync(svc.getSettings().signature_image).toString('base64') : null),
  pickBackupFolder: async () => { const d = path.join(tmp, 'nube'); fs.mkdirSync(d, { recursive: true }); svc.saveSettings({ backup_dir: d }); return { canceled: false, path: d }; },
  openEmailDraft: async m => { calls.push({ type: 'email', ...m }); return { method: 'outlook' }; },
  exportCourts: async () => ({ canceled: false }),
  importCourtsFile: async () => ({ canceled: true }),
  backupDatabase: async () => ({ canceled: false }),
  importLegacyNow: async () => (legacy ? importLegacy(db, legacy) : { ok: false, reason: 'sin base anterior' }),
  openDataFolder: async () => ({ ok: true }),
  appInfo: async () => ({ dataRoot: tmp, dbPath: path.join(tmp, 'data', 'ui.sqlite'), attachmentsDir: path.join(tmp, 'docs'), version: 'test' })
};

const SHIM = `Object.defineProperty(window,'api',{configurable:false,writable:false,value:{call:(name,...args)=>fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,args})}).then(r=>r.json()).then(j=>{if(j.error)throw new Error(j.error);return j.result}),pathForFile:()=>null,onStartup(){},onGoto(){}}});`;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/rpc') {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', async () => {
      try {
        const { name, args } = JSON.parse(b);
        if (process.env.LOG_RPC && !/^(list|get|dashboard|meta)/.test(name)) console.log(name, JSON.stringify(args).slice(0, 200));
        if (!Object.prototype.hasOwnProperty.call(handlers, name)) throw new Error('Operación desconocida: ' + name);
        const result = await handlers[name](...(args || []));
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result: result ?? null }));
      } catch (e) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (req.url === '/__shim.js') { res.setHeader('content-type', types['.js']); return res.end(SHIM); }
  if (req.url === '/__calls') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(calls)); }
  const rel = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(root, 'renderer', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(root, 'renderer')) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('no'); }
  let data = fs.readFileSync(file);
  if (rel === '/index.html') data = Buffer.from(String(data).replace('<script src="./app.js">', '<script src="/__shim.js"></script><script src="./app.js">'));
  res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
  res.end(data);
}).listen(Number(process.argv[2]) || 4173, () => console.log('listo'));
