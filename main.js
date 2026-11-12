'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, seedCourts, importLegacy } = require('./src/db');
const { createService } = require('./src/service');
const { openDraft } = require('./src/outlook');
const { MODELS, buildDocument, makeDocx } = require('./src/exhorto-documents');
const { createScanSession } = require('./src/scan');

// Los datos viven en la misma carpeta que usaba la versión anterior (%APPDATA%\sigex), en un archivo nuevo.
// Los archivos internos de Chromium usan otra carpeta, para poder abrir la versión anterior al mismo tiempo.
const dataRoot = path.join(app.getPath('appData'), 'sigex');
app.setPath('userData', path.join(app.getPath('appData'), 'sigex2-app'));

let win = null;
let db, service;
const dbPath = path.join(dataRoot, 'data', 'sigex2.sqlite');
const legacyPath = path.join(dataRoot, 'data', 'sigex.sqlite');
const attachmentsDir = path.join(dataRoot, 'documentos');

function boot() {
  const firstRun = !fs.existsSync(dbPath);
  db = openDatabase(dbPath);
  service = createService({ db, attachmentsDir });
  let startup = null;
  if (firstRun) {
    if (fs.existsSync(legacyPath)) {
      try { startup = { legacy: importLegacy(db, legacyPath) }; } catch (e) { startup = { legacyError: e.message }; }
    }
    seedCourts(db, path.join(__dirname, 'data', 'courts_seed.json'));
  }
  return startup;
}

function pickFile(options) {
  return dialog.showOpenDialog(win, options).then(r => (r.canceled ? null : r.filePaths));
}

// Todo lo que el renderer puede invocar. Las funciones del servicio se exponen tal cual.
function buildHandlers() {
  const h = { ...service };
  h.documentModels = () => MODELS;
  h.previewExhortoDocument = (id, input) => buildDocument(service.getCase(id), { ...input, preview: !input.ord }, service.getSettings().home_court_name);
  h.exportExhortoDocument = async (id, input) => {
    const c = service.getCase(id);
    const lines = buildDocument(c, { ...input, preview: false }, service.getSettings().home_court_name);
    const name = (input.model.toUpperCase() + ' - ' + c.rol).replace(/[^a-zA-Z0-9 ._-]/g, '_');
    const result = await dialog.showSaveDialog(win, { defaultPath: name + '.docx', filters: [{ name: 'Word', extensions: ['docx'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.promises.writeFile(result.filePath, makeDocx(lines));
    return { canceled: false };
  };
  h.pickAndAttach = async (caseId, kind) => {
    const files = await pickFile({ title: 'Seleccionar documento', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF e imágenes', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }, { name: 'Todos los archivos', extensions: ['*'] }] });
    if (!files) return { canceled: true };
    for (const f of files) service.addDocument(caseId, kind, f);
    return { canceled: false, count: files.length };
  };
  h.attachPaths = async (caseId, kind, paths) => { for (const p of paths || []) service.addDocument(caseId, kind, p); return { count: (paths || []).length }; };
  h.pickFilePath = async () => {
    const files = await pickFile({ title: 'Seleccionar documento', properties: ['openFile'], filters: [{ name: 'PDF e imágenes', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }, { name: 'Todos los archivos', extensions: ['*'] }] });
    return files ? files[0] : null;
  };
  const scanner = createScanSession();
  h.scanPage = opts => scanner.scanPage(opts || {});
  h.scanRemoveAt = async i => scanner.removeAt(i);
  h.scanMove = async (from, to) => scanner.move(from, to);
  h.scanFinish = async name => scanner.finish(name);
  h.scanCancel = async () => scanner.cancel();
  h.openDocument = async id => {
    const err = await shell.openPath(service.documentPath(id));
    if (err) throw new Error(err);
    return { ok: true };
  };
  // Los adjuntos viajan con su nombre original (no con el nombre interno guardado en disco).
  h.openEmailDraft = async ({ to, subject, body, document_ids }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigex-adj-'));
    const attachments = (document_ids || []).map(id => {
      const src = service.documentPath(id);
      const orig = db.prepare('SELECT original_name FROM documents WHERE id = ?').get(Number(id));
      const dest = path.join(tmp, String((orig && orig.original_name) || path.basename(src)).replace(/[\\/:*?"<>|]/g, '_'));
      fs.copyFileSync(src, dest);
      return dest;
    });
    const st = service.getSettings();
    const mode = ['classic', 'gmail'].includes(st.mail_client) ? st.mail_client : 'new';
    const signatureImage = st.signature_image && fs.existsSync(st.signature_image) ? st.signature_image : null;
    return openDraft({ to, subject, body, attachments, signatureImage }, shell, mode);
  };
  h.pickSignatureImage = async () => {
    const files = await pickFile({ title: 'Imagen de firma', properties: ['openFile'], filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'gif'] }] });
    if (!files) return { canceled: true };
    const dir = path.join(dataRoot, 'firma');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'firma' + path.extname(files[0]).toLowerCase());
    fs.copyFileSync(files[0], dest);
    service.saveSettings({ signature_image: dest });
    return { canceled: false };
  };
  h.pickBackupFolder = async () => {
    const dirs = await pickFile({ title: 'Carpeta para los respaldos (por ejemplo, tu OneDrive o Google Drive)', properties: ['openDirectory', 'createDirectory'] });
    if (!dirs) return { canceled: true };
    if (path.resolve(dirs[0]).toLowerCase().startsWith(path.resolve(dataRoot).toLowerCase())) throw new Error('Elige una carpeta distinta a la de datos de SIGEX.');
    service.saveSettings({ backup_dir: dirs[0] });
    return { canceled: false, path: dirs[0] };
  };
  h.removeSignatureImage = async () => { service.saveSettings({ signature_image: '' }); return { ok: true }; };
  h.getSignatureImage = async () => {
    const f = service.getSettings().signature_image;
    if (!f || !fs.existsSync(f)) return null;
    const ext = path.extname(f).toLowerCase();
    return `data:${ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg'};base64,${fs.readFileSync(f).toString('base64')}`;
  };
  h.exportCourts = async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Exportar directorio de juzgados', defaultPath: 'directorio_juzgados.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled) return { canceled: true };
    fs.writeFileSync(r.filePath, service.exportCourtsCSV(), 'utf8');
    return { canceled: false, path: r.filePath };
  };
  h.importCourtsFile = async () => {
    const files = await pickFile({ title: 'Importar directorio (CSV)', properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }] });
    if (!files) return { canceled: true };
    return { canceled: false, ...service.importCourtsCSV(fs.readFileSync(files[0], 'utf8')) };
  };
  h.backupDatabase = async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, { title: 'Guardar respaldo', defaultPath: `respaldo_sigex_${stamp}.sqlite`, filters: [{ name: 'Base de datos', extensions: ['sqlite'] }] });
    if (r.canceled) return { canceled: true };
    await service.backupTo(r.filePath);
    return { canceled: false, path: r.filePath };
  };
  h.importLegacyNow = async () => importLegacy(db, legacyPath);
  h.openDataFolder = async () => { await shell.openPath(dataRoot); return { ok: true }; };
  h.appInfo = async () => ({ dataRoot, dbPath, attachmentsDir, version: app.getVersion() });
  return h;
}

function createWindow(startup) {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 1000, minHeight: 640,
    title: 'SIGEX · Gestión de exhortos',
    icon: path.join(__dirname, 'build', 'icon_512.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3', // igual al fondo de Windows 11, sin destello al abrir
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  win.setMenuBarVisibility(false);

  // Corrector ortográfico en español y menú contextual con sugerencias (Electron no lo muestra solo).
  const ses = win.webContents.session;
  try {
    const avail = ses.availableSpellCheckerLanguages || [];
    const wanted = ['es-CL', 'es-419', 'es-ES', 'es-MX', 'es'].filter(l => avail.includes(l));
    if (wanted.length) ses.setSpellCheckerLanguages(wanted.slice(0, 2));
  } catch (_) { /* si falla, queda el idioma del sistema */ }
  win.webContents.on('context-menu', (_e, params) => {
    const items = [];
    if (params.misspelledWord) {
      for (const sug of (params.dictionarySuggestions || []).slice(0, 6)) items.push({ label: sug, click: () => win.webContents.replaceMisspelling(sug) });
      if (!(params.dictionarySuggestions || []).length) items.push({ label: 'Sin sugerencias', enabled: false });
      items.push({ label: 'Agregar al diccionario', click: () => ses.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
    }
    if (params.isEditable) {
      items.push({ label: 'Cortar', role: 'cut', enabled: params.editFlags.canCut }, { label: 'Copiar', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Pegar', role: 'paste', enabled: params.editFlags.canPaste }, { type: 'separator' }, { label: 'Seleccionar todo', role: 'selectAll' });
    } else if (params.selectionText) {
      items.push({ label: 'Copiar', role: 'copy' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => { if (startup) win.webContents.send('startup', startup); });
  win.on('closed', () => { win = null; });
}

let lastNotified = '';
function checkSystemAlerts(force = false) {
  try {
    const s = service.getSettings();
    if (s.os_notifications !== '1' || !Notification.isSupported()) return;
    const d = service.dashboard();
    if (d.today === lastNotified && !force) return;
    const { overdue, soon } = d.counts;
    if (!overdue && !soon) return;
    lastNotified = d.today;
    const n = new Notification({
      title: 'SIGEX · plazos de exhortos',
      body: [overdue ? `${overdue} plazo(s) vencido(s)` : '', soon ? `${soon} por vencer en 7 días` : ''].filter(Boolean).join(' · ')
    });
    n.on('click', () => { if (win) { win.show(); win.focus(); win.webContents.send('goto', 'panel'); } });
    n.show();
  } catch (_) { /* las alertas del sistema nunca deben romper la app */ }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    const startup = boot();
    const handlers = buildHandlers();
    ipcMain.handle('rpc', async (_e, name, args) => {
      if (!Object.prototype.hasOwnProperty.call(handlers, name)) throw new Error(`Operación desconocida: ${name}`);
      return handlers[name](...(args || []));
    });
    createWindow(startup);
    setTimeout(() => checkSystemAlerts(), 4000);
    setInterval(() => checkSystemAlerts(), 60 * 60 * 1000);
  });
  // Al cerrar, si hay carpeta de respaldo configurada, se deja la copia del día. Un fallo aquí nunca debe impedir cerrar.
  app.on('window-all-closed', () => {
    try { if (service && service.getSettings().backup_dir) service.runBackup(); } catch (_) { /* se avisa al abrir si pasan días sin respaldo */ }
    if (db) db.close();
    app.quit();
  });
}
