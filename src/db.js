'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS courts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  commune TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  address TEXT,
  email TEXT,
  phone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rol TEXT NOT NULL,
  court_id INTEGER NOT NULL REFERENCES courts(id) ON DELETE RESTRICT,
  offender_name TEXT,
  offender_rut TEXT,
  offender_email TEXT,
  offender_phone TEXT,
  offender_gender TEXT CHECK (offender_gender IS NULL OR offender_gender IN ('M','F')),
  entry_date TEXT NOT NULL,
  letter_sent_date TEXT,
  sentence_date TEXT,
  resolution TEXT,
  notification_date TEXT,
  is_resend INTEGER NOT NULL DEFAULT 0,
  receipt_date TEXT,
  return_date TEXT,
  final_status TEXT CHECK (final_status IS NULL OR final_status IN ('Devuelto','Archivado','Anulado')),
  suspension_days INTEGER,
  permit_delivery_date TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  legacy_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('sentencia','comprobante','otro')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'sentencia',
  to_email TEXT,
  subject TEXT,
  body TEXT,
  attachments TEXT,
  sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_cases_rol ON cases(rol);
CREATE INDEX IF NOT EXISTS idx_cases_court ON cases(court_id);
CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(case_id);
CREATE INDEX IF NOT EXISTS idx_notifications_case ON notifications(case_id);
`;

const DEFAULT_SETTINGS = {
  alert_sentence_days: '30',
  alert_reminder_wait_days: '15',
  alert_payment_days: '30',
  home_court_name: 'Segundo Juzgado de Policía Local de Valdivia',
  os_notifications: '1',
  mail_client: 'new',
  greeting_name: 'first',
  email_signature: '',
  backup_dir: '',
  backup_keep: '14',
  signature_image: '',
  // Feriados (días no hábiles además de sábado y domingo). Revísalos y complétalos en Ajustes.
  holidays: '2026-10-12\n2026-12-08\n2026-12-25\n2027-01-01\n2027-03-26\n2027-05-21\n2027-07-16\n2027-12-08'
};

// Columnas agregadas después de la primera versión. Se añaden solo si faltan, sin tocar los datos existentes.
const MIGRATIONS = [
  ['cases', 'citation_number', 'TEXT'],   // N.º de boleta de citación
  ['cases', 'tracking_code', 'TEXT']      // código de seguimiento de Correos de la carta al juzgado
];
function migrate(db) {
  for (const [table, col, type] of MIGRATIONS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

function seedCourts(db, seedPath) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM courts').get().n;
  if (count > 0 || !fs.existsSync(seedPath)) return 0;
  const rows = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const ins = db.prepare(`INSERT OR IGNORE INTO courts (name, commune, region, address, email, phone, notes)
    VALUES (@name, @commune, @region, @address, @email, @phone, @notes)`);
  const tx = db.transaction(list => { for (const r of list) ins.run({ notes: null, address: null, email: null, phone: null, region: '', ...r }); });
  tx(rows);
  return rows.length;
}

function communeFromName(name) {
  const m = String(name || '').match(/Juzgado de Polic[ií]a Local de\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// Importa los datos de la versión anterior de SIGEX (sigex.sqlite). Es idempotente: usa legacy_id.
function importLegacy(db, legacyPath) {
  if (!fs.existsSync(legacyPath)) return { ok: false, reason: 'No se encontró la base anterior.' };

  // Se trabaja sobre una copia para no tocar nunca el archivo original (puede tener un -wal activo).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigex-legacy-'));
  const copy = path.join(tmp, 'legacy.sqlite');
  fs.copyFileSync(legacyPath, copy);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(legacyPath + ext)) fs.copyFileSync(legacyPath + ext, copy + ext);
  }
  const old = new Database(copy);
  const result = { ok: true, courts: 0, cases: 0, notifications: 0, skipped: 0, review: 0 };
  try {
    const hasTable = n => old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
    if (!hasTable('exhortos')) return { ok: false, reason: 'La base anterior no tiene exhortos.' };

    const findCourt = db.prepare('SELECT id FROM courts WHERE name = ?');
    const insCourt = db.prepare('INSERT INTO courts (name, commune, region, address, email, phone, notes) VALUES (?,?,?,?,?,?,?)');
    const ensureCourt = (name, extra = {}) => {
      const clean = String(name || '').trim();
      if (!clean) return null;
      let r = findCourt.get(clean);
      if (!r) {
        insCourt.run(clean, extra.commune || communeFromName(clean) || '', '', extra.address || null, extra.email || null, extra.phone || null, extra.notes || null);
        result.courts++;
        r = findCourt.get(clean);
      }
      return r.id;
    };

    const tx = db.transaction(() => {
      const oldCourts = new Map(old.prepare('SELECT * FROM courts').all().map(c => [c.id, c]));
      for (const c of oldCourts.values()) {
        const id = ensureCourt(c.name, c);
        // Completa datos faltantes de un juzgado que ya existía sin pisar lo que el usuario editó.
        db.prepare(`UPDATE courts SET
          address = COALESCE(NULLIF(address,''), ?), email = COALESCE(NULLIF(email,''), ?), phone = COALESCE(NULLIF(phone,''), ?)
          WHERE id = ?`).run(c.address || null, c.email || null, c.phone || null, id);
      }

      const offenders = new Map(old.prepare('SELECT * FROM offenders').all().map(o => [o.id, o]));
      const existing = db.prepare('SELECT id FROM cases WHERE legacy_id = ?');
      const insCase = db.prepare(`INSERT INTO cases
        (rol, court_id, offender_name, offender_rut, offender_email, offender_phone, offender_gender,
         entry_date, letter_sent_date, sentence_date, resolution, notification_date, return_date, final_status,
         needs_review, notes, legacy_id, created_at)
        VALUES (@rol,@court_id,@offender_name,@offender_rut,@offender_email,@offender_phone,@offender_gender,
         @entry_date,NULL,@sentence_date,@resolution,@notification_date,@return_date,@final_status,
         @needs_review,@notes,@legacy_id,@created_at)`);
      const idMap = new Map();
      const created = new Set(); // solo se importan notificaciones de causas creadas en esta pasada

      for (const e of old.prepare('SELECT * FROM exhortos ORDER BY id').all()) {
        const prev = existing.get(e.id);
        if (prev) { idMap.set(e.id, prev.id); result.skipped++; continue; }
        const courtName = e.target_court_name || (oldCourts.get(e.target_court_id) || {}).name;
        const courtId = ensureCourt(courtName);
        if (!courtId) { result.skipped++; continue; }
        const o = offenders.get(e.offender_id) || {};
        const finalStatus = ['Devuelto', 'Archivado', 'Anulado'].includes(e.status) ? e.status : null;
        // Datos que la versión anterior no registraba: se marcan para revisión en vez de inventarlos.
        const noLetter = !finalStatus && !e.sentence_date && !e.notification_date;
        const notifiedNoDate = e.status === 'Notificado' && !e.notification_date;
        const needsReview = (noLetter || notifiedNoDate) ? 1 : 0;
        if (needsReview) result.review++;
        const r = insCase.run({
          rol: e.rol, court_id: courtId,
          offender_name: o.full_name || null, offender_rut: o.rut || null,
          offender_email: o.email || null, offender_phone: o.phone || null,
          offender_gender: e.offender_gender === 'M' || e.offender_gender === 'F' ? e.offender_gender : null,
          entry_date: e.entry_date, sentence_date: e.sentence_date || null, resolution: e.compliance_type || null,
          notification_date: e.notification_date || null, return_date: e.return_date || null,
          final_status: finalStatus, needs_review: needsReview,
          notes: e.notes || null, legacy_id: e.id, created_at: e.created_at || new Date().toISOString().slice(0, 19).replace('T', ' ')
        });
        idMap.set(e.id, r.lastInsertRowid);
        created.add(e.id);
        result.cases++;
      }

      if (hasTable('notifications')) {
        const insN = db.prepare('INSERT INTO notifications (case_id, kind, to_email, subject, body, attachments, sent_at) VALUES (?,?,?,?,?,?,?)');
        for (const n of old.prepare('SELECT * FROM notifications ORDER BY id').all()) {
          if (!created.has(n.exhorto_id)) continue;
          const caseId = idMap.get(n.exhorto_id);
          insN.run(caseId, 'sentencia', n.recipient_email, n.subject, n.body, null, n.sent_at);
          result.notifications++;
        }
      }
    });
    tx();
  } finally {
    old.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return result;
}

module.exports = { openDatabase, seedCourts, importLegacy, communeFromName, DEFAULT_SETTINGS };
