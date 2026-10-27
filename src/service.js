'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./logic');

const REGIONS = [
  'Arica y Parinacota', 'Tarapacá', 'Antofagasta', 'Atacama', 'Coquimbo', 'Valparaíso',
  'Metropolitana de Santiago', "O'Higgins", 'Maule', 'Ñuble', 'Biobío', 'La Araucanía',
  'Los Ríos', 'Los Lagos', 'Aysén', 'Magallanes'
];

const clean = v => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

function createService({ db, attachmentsDir, now = () => new Date() }) {
  const today = () => L.todayISO(now());

  // ---------- Ajustes ----------
  function getSettings() {
    const out = {};
    for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
    return out;
  }
  function saveSettings(patch) {
    const allowed = ['alert_sentence_days', 'alert_payment_days', 'home_court_name', 'os_notifications', 'holidays', 'mail_client', 'email_signature', 'signature_image', 'greeting_name', 'backup_dir', 'backup_keep'];
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const k of allowed) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (k.endsWith('_days')) {
        v = Math.round(Number(v));
        if (!Number.isFinite(v) || v < 1 || v > 365) throw new Error('Los plazos deben estar entre 1 y 365 días.');
      }
      if (k === 'holidays') {
        const bad = String(v || '').split(/[\s,;]+/).filter(Boolean).filter(x => !L.isValidISO(x));
        if (bad.length) throw new Error(`Feriados con formato inválido: ${bad.slice(0, 3).join(', ')}. Usa AAAA-MM-DD, uno por línea.`);
        v = [...L.parseHolidays(v)].sort().join('\n');
      }
      if (k === 'backup_keep') {
        v = Math.round(Number(v));
        if (!Number.isFinite(v) || v < 1 || v > 365) throw new Error('Las copias de respaldo a conservar deben estar entre 1 y 365.');
      }
      if (k === 'backup_dir') {
        v = String(v || '').trim();
        if (v && (!fs.existsSync(v) || !fs.statSync(v).isDirectory())) throw new Error('No se encuentra esa carpeta.');
      }
      if (k === 'greeting_name' && !['first', 'full'].includes(v)) throw new Error('Opción de saludo no válida.');
      if (k === 'mail_client' && !['new', 'classic', 'gmail'].includes(v)) throw new Error('Programa de correo no válido.');
      if (k === 'home_court_name' && !clean(v)) throw new Error('El nombre del juzgado no puede quedar vacío.');
      up.run(k, String(v).trim());
    }
    return getSettings();
  }

  // ---------- Plantillas de correo ----------
  const tplKinds = ['carta', 'recordatorio', 'sentencia'];
  function customTemplate(kind) {
    const s = getSettings();
    const out = {};
    if (s[`tpl_${kind}_subject`]) out.subject = s[`tpl_${kind}_subject`];
    if (s[`tpl_${kind}_body`]) out.body = s[`tpl_${kind}_body`];
    return out;
  }
  function getTemplates() {
    const out = {};
    for (const k of tplKinds) {
      const t = { ...L.DEFAULT_TEMPLATES[k], ...customTemplate(k) };
      out[k] = { ...t, vars: L.TEMPLATE_VARS[k], defaults: L.DEFAULT_TEMPLATES[k], custom: !!(customTemplate(k).subject || customTemplate(k).body) };
    }
    return out;
  }
  function saveTemplate(kind, { subject, body }) {
    if (!tplKinds.includes(kind)) throw new Error('Tipo de plantilla desconocido.');
    subject = String(subject || '').trim(); body = String(body || '').trim();
    if (!subject) throw new Error('El asunto no puede quedar vacío.');
    if (!body) throw new Error('El cuerpo del correo no puede quedar vacío.');
    const bad = L.unknownPlaceholders(kind, subject, body);
    if (bad.length) throw new Error(`Marcadores desconocidos: ${bad.join(', ')}. Usa solo los de la lista.`);
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    up.run(`tpl_${kind}_subject`, subject); up.run(`tpl_${kind}_body`, body);
    return getTemplates();
  }
  function resetTemplate(kind) {
    if (!tplKinds.includes(kind)) throw new Error('Tipo de plantilla desconocido.');
    db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(`tpl_${kind}_subject`, `tpl_${kind}_body`);
    return getTemplates();
  }
  // Vista previa con datos de ejemplo (sin guardar).
  function previewTemplate(kind, { subject, body }) {
    const template = { subject, body };
    const signer = getSettings().home_court_name;
    if (kind === 'recordatorio') {
      const demo = [
        { rol: '1234-2026', offender_name: 'Jorge Pérez Soto', offender_rut: '12345678-5', citation_number: '8100001', tracking_code: '1181800000001', entry_date: '2026-09-01', letter_sent_date: '2026-09-02', due_date: '2026-10-02' },
        { rol: '1250-2026', offender_name: 'María Rojas Díaz', offender_rut: '9876543-2', citation_number: '8100002', entry_date: '2026-09-03', letter_sent_date: '2026-09-04', due_date: '2026-10-04' }
      ];
      return L.buildReminderEmail({ courtName: 'Juzgado de Policía Local de Osorno', cases: demo, sentenceDays: getSettings().alert_sentence_days, today: today(), signer, template, footer: footerFor(getSettings()) });
    }
    if (kind === 'carta') return L.buildCourtLetterEmail({ rol: '1234-2026', courtName: 'Juzgado de Policía Local de Osorno', entryDate: '15-10-2026', signer, template, footer: footerFor(getSettings()) });
    return L.buildSentenceEmail({ rol: '1234-2026', gender: 'M', offenderName: 'Jorge Pérez Soto', greetingName: getSettings().greeting_name, courtName: 'Juzgado de Policía Local de Osorno', resolution: 'Transferencia|Vale Vista', suspensionDays: 30, includeSuspension: true, isResend: false, signer, paymentDays: 30, template, footer: footerFor(getSettings()) });
  }

  // ---------- Juzgados ----------
  const courtSelect = `SELECT c.*, (SELECT COUNT(*) FROM cases x WHERE x.court_id = c.id) AS case_count FROM courts c`;

  function listCourts(q) {
    const term = clean(q);
    if (!term) return db.prepare(`${courtSelect} ORDER BY c.name COLLATE NOCASE`).all();
    const like = `%${term}%`;
    return db.prepare(`${courtSelect} WHERE c.name LIKE @l OR c.commune LIKE @l OR c.region LIKE @l
      OR IFNULL(c.address,'') LIKE @l OR IFNULL(c.email,'') LIKE @l OR IFNULL(c.phone,'') LIKE @l OR IFNULL(c.notes,'') LIKE @l
      ORDER BY c.name COLLATE NOCASE`).all({ l: like });
  }
  function courtFields(p) {
    const name = clean(p.name);
    if (!name) throw new Error('El nombre del juzgado es obligatorio.');
    return {
      name,
      commune: clean(p.commune) || '',
      region: clean(p.region) || '',
      address: clean(p.address), email: clean(p.email), phone: clean(p.phone), notes: clean(p.notes)
    };
  }
  function createCourt(p) {
    const f = courtFields(p);
    if (db.prepare('SELECT 1 FROM courts WHERE name = ?').get(f.name)) throw new Error('Ya existe un juzgado con ese nombre.');
    const r = db.prepare(`INSERT INTO courts (name, commune, region, address, email, phone, notes)
      VALUES (@name,@commune,@region,@address,@email,@phone,@notes)`).run(f);
    return { id: Number(r.lastInsertRowid) };
  }
  function updateCourt(id, p) {
    const f = courtFields(p);
    const dup = db.prepare('SELECT id FROM courts WHERE name = ? AND id <> ?').get(f.name, Number(id));
    if (dup) throw new Error('Ya existe otro juzgado con ese nombre.');
    const r = db.prepare(`UPDATE courts SET name=@name, commune=@commune, region=@region, address=@address,
      email=@email, phone=@phone, notes=@notes, updated_at=datetime('now','localtime') WHERE id=@id`).run({ ...f, id: Number(id) });
    if (!r.changes) throw new Error('Juzgado no encontrado.');
    return { ok: true };
  }
  function deleteCourt(id) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE court_id = ?').get(Number(id)).n;
    if (n > 0) throw new Error(`No se puede borrar: el juzgado tiene ${n} exhorto(s) asociados.`);
    const r = db.prepare('DELETE FROM courts WHERE id = ?').run(Number(id));
    if (!r.changes) throw new Error('Juzgado no encontrado.');
    return { ok: true };
  }

  // CSV de juzgados (separador ; para Excel en configuración regional chilena; al importar se detecta , o ;)
  const CSV_COLS = [['name', 'nombre'], ['commune', 'comuna'], ['region', 'region'], ['address', 'direccion'], ['email', 'correo'], ['phone', 'telefono'], ['notes', 'observaciones']];
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    const first = text.split(/\r?\n/)[0] || '';
    const delim = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); cur = '';
        if (row.some(c => c.trim() !== '')) rows.push(row);
        row = [];
      } else cur += ch;
    }
    row.push(cur);
    if (row.some(c => c.trim() !== '')) rows.push(row);
    return rows;
  }
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  function exportCourtsCSV() {
    const esc = v => { const s = v == null ? '' : String(v); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [CSV_COLS.map(c => c[1]).join(';')];
    for (const c of listCourts()) lines.push(CSV_COLS.map(([k]) => esc(c[k])).join(';'));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }
  function importCourtsCSV(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('El archivo no tiene filas de datos.');
    const header = rows[0].map(norm);
    const idx = {};
    for (const [key, label] of CSV_COLS) {
      const alt = key === 'name' ? ['nombre', 'name', 'juzgado'] : key === 'email' ? ['correo', 'email', 'mail', 'correo electronico'] : key === 'address' ? ['direccion', 'address'] : key === 'phone' ? ['telefono', 'phone', 'fono'] : key === 'commune' ? ['comuna', 'commune'] : key === 'notes' ? ['observaciones', 'notas', 'notes'] : [label, key];
      idx[key] = header.findIndex(h => alt.includes(h));
    }
    if (idx.name < 0) throw new Error('Falta la columna "nombre".');
    let created = 0, updated = 0;
    const tx = db.transaction(() => {
      for (const r of rows.slice(1)) {
        const get = k => (idx[k] >= 0 ? clean(r[idx[k]]) : null);
        const name = get('name');
        if (!name) continue;
        const ex = db.prepare('SELECT * FROM courts WHERE name = ?').get(name);
        const data = { name, commune: get('commune') ?? ex?.commune ?? '', region: get('region') ?? ex?.region ?? '',
          address: get('address') ?? ex?.address ?? null, email: get('email') ?? ex?.email ?? null,
          phone: get('phone') ?? ex?.phone ?? null, notes: get('notes') ?? ex?.notes ?? null };
        if (ex) { updateCourt(ex.id, data); updated++; } else { createCourt(data); created++; }
      }
    });
    tx();
    return { created, updated };
  }

  // ---------- Exhortos ----------
  const caseSelect = `
    SELECT x.*, c.name AS court_name, c.commune AS court_commune, c.email AS court_email, c.phone AS court_phone, c.address AS court_address,
      (SELECT COUNT(*) FROM documents d WHERE d.case_id = x.id AND d.kind = 'sentencia') AS sentence_docs
    FROM cases x JOIN courts c ON c.id = x.court_id`;

  function decorate(row, settings, t) {
    const stage = L.stageOf(row);
    const alerts = L.alertsFor(row, settings, t);
    const deadline = alerts.find(a => a.kind === 'plazo');
    return {
      ...row,
      resolution_list: L.parseResolution(row.resolution),
      stage, stage_label: L.STAGES[stage],
      alerts,
      next_deadline: deadline ? deadline.due_date : null,
      deadline_severity: deadline ? deadline.severity : null,
      suspension: L.suspensionInfo(row, t),
      resend_due: L.resendDue(row, settings)
    };
  }

  function listCases(filters = {}) {
    const settings = getSettings(), t = today();
    const where = [], params = {};
    const q = clean(filters.q);
    if (q) {
      where.push(`(x.rol LIKE @q OR IFNULL(x.offender_name,'') LIKE @q OR IFNULL(x.offender_rut,'') LIKE @q OR c.name LIKE @q OR IFNULL(x.notes,'') LIKE @q)`);
      params.q = `%${q}%`;
    }
    if (filters.court_id) { where.push('x.court_id = @court'); params.court = Number(filters.court_id); }
    const sql = `${caseSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY x.id DESC`;
    let rows = db.prepare(sql).all(params).map(r => decorate(r, settings, t));
    const f = clean(filters.stage);
    if (f === 'abiertos') rows = rows.filter(r => !r.final_status);
    else if (f === 'cerrados') rows = rows.filter(r => !!r.final_status);
    else if (f === 'con_alerta') rows = rows.filter(r => r.alerts.some(a => a.kind === 'plazo'));
    else if (f === 'revisar') rows = rows.filter(r => r.needs_review);
    else if (f === 'suspension') rows = rows.filter(r => r.suspension && r.suspension.state !== 'cumplida' && !r.final_status);
    else if (f) rows = rows.filter(r => r.stage === f);
    if (filters.sort === 'plazo') {
      rows.sort((a, b) => (a.next_deadline || '9999') < (b.next_deadline || '9999') ? -1 : (a.next_deadline || '9999') > (b.next_deadline || '9999') ? 1 : 0);
    }
    return rows;
  }

  function getCase(id) {
    const row = db.prepare(`${caseSelect} WHERE x.id = ?`).get(Number(id));
    if (!row) throw new Error('Exhorto no encontrado.');
    const d = decorate(row, getSettings(), today());
    d.documents = db.prepare('SELECT * FROM documents WHERE case_id = ? ORDER BY id').all(row.id);
    d.notifications = db.prepare('SELECT * FROM notifications WHERE case_id = ? ORDER BY sent_at DESC, id DESC').all(row.id);
    return d;
  }

  const DATE_FIELDS = ['entry_date', 'letter_sent_date', 'sentence_date', 'notification_date', 'receipt_date', 'return_date', 'permit_delivery_date'];
  const EDITABLE = ['rol', 'court_id', 'offender_name', 'offender_rut', 'offender_email', 'offender_phone', 'offender_gender', 'citation_number', 'tracking_code',
    'entry_date', 'letter_sent_date', 'sentence_date', 'resolution', 'notification_date', 'is_resend', 'receipt_date', 'return_date',
    'final_status', 'suspension_days', 'permit_delivery_date', 'needs_review', 'notes'];

  function normalizeField(k, v) {
    if (k === 'court_id') return Number(v) || null;
    if (k === 'resolution') return L.stringifyResolution(v);
    if (k === 'is_resend' || k === 'needs_review') return v ? 1 : 0;
    if (k === 'suspension_days') {
      const s = clean(v);
      if (s === null) return null;
      const n = Math.round(Number(s));
      if (!Number.isFinite(n) || n < 1 || n > 3650) throw new Error('Los días de suspensión deben ser un número entre 1 y 3650.');
      return n;
    }
    if (k === 'offender_gender') { const s = clean(v); return s === 'M' || s === 'F' ? s : null; }
    if (k === 'final_status') { const s = clean(v); if (s && !['Devuelto', 'Archivado', 'Anulado'].includes(s)) throw new Error('Estado final inválido.'); return s; }
    if (DATE_FIELDS.includes(k)) {
      const s = clean(v);
      if (s && !L.isValidISO(s)) throw new Error('Fecha inválida.');
      return s ? s.slice(0, 10) : null;
    }
    return clean(v);
  }

  // Compara solo los campos que cambian, para no bloquear la edición de causas migradas con fechas antiguas incoherentes.
  const ORDER = [
    ['entry_date', 'letter_sent_date', 'La fecha de envío de la carta no puede ser anterior al ingreso.'],
    ['entry_date', 'sentence_date', 'La fecha de sentencia no puede ser anterior al ingreso.'],
    ['sentence_date', 'notification_date', 'La notificación no puede ser anterior a la sentencia.'],
    ['notification_date', 'receipt_date', 'El comprobante no puede ser anterior a la notificación.']
  ];
  function checkOrder(prev, next) {
    for (const [a, b, msg] of ORDER) {
      if (!next[a] || !next[b]) continue;
      const changed = !prev || prev[a] !== next[a] || prev[b] !== next[b];
      if (changed && next[b] < next[a]) throw new Error(msg);
    }
  }

  function resolveCourt(p) {
    if (p.court_id) {
      if (!db.prepare('SELECT 1 FROM courts WHERE id = ?').get(Number(p.court_id))) throw new Error('Juzgado no encontrado.');
      return Number(p.court_id);
    }
    throw new Error('Debes elegir el juzgado remitente.');
  }

  function createCase(p) {
    const rol = clean(p.rol);
    if (!rol) throw new Error('El rol es obligatorio.');
    const entry = normalizeField('entry_date', p.entry_date);
    if (!entry) throw new Error('La fecha de ingreso es obligatoria.');
    const courtId = resolveCourt(p);
    if (db.prepare('SELECT 1 FROM cases WHERE rol = ? AND court_id = ?').get(rol, courtId) && !p.allow_duplicate) {
      const e = new Error(`Ya existe un exhorto con el rol ${rol} para ese juzgado.`);
      e.code = 'DUPLICATE';
      throw e;
    }
    const data = { rol, court_id: courtId, entry_date: entry };
    for (const k of EDITABLE) if (!(k in data) && k in p) data[k] = normalizeField(k, p[k]);
    checkOrder(null, data);
    const cols = Object.keys(data);
    const r = db.prepare(`INSERT INTO cases (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`).run(data);
    return { id: Number(r.lastInsertRowid) };
  }

  function updateCase(id, patch) {
    const prev = db.prepare('SELECT * FROM cases WHERE id = ?').get(Number(id));
    if (!prev) throw new Error('Exhorto no encontrado.');
    const next = { ...prev };
    for (const k of EDITABLE) if (k in patch) next[k] = normalizeField(k, patch[k]);
    if (!next.rol) throw new Error('El rol es obligatorio.');
    if (!next.entry_date) throw new Error('La fecha de ingreso es obligatoria.');
    if (next.court_id !== prev.court_id) resolveCourt(next);
    checkOrder(prev, next);
    const sets = EDITABLE.filter(k => k in patch).map(k => `${k} = @${k}`);
    if (!sets.length) return { ok: true };
    const params = { id: Number(id) };
    for (const k of EDITABLE) if (k in patch) params[k] = next[k];
    db.prepare(`UPDATE cases SET ${sets.join(', ')}, updated_at = datetime('now','localtime') WHERE id = @id`).run(params);
    return { ok: true };
  }

  function deleteCase(id) {
    const docs = db.prepare('SELECT stored_name FROM documents WHERE case_id = ?').all(Number(id));
    const r = db.prepare('DELETE FROM cases WHERE id = ?').run(Number(id));
    if (!r.changes) throw new Error('Exhorto no encontrado.');
    try { fs.rmSync(path.join(attachmentsDir, String(id)), { recursive: true, force: true }); } catch (_) { /* best effort */ }
    return { ok: true, removed_documents: docs.length };
  }

  // Acciones por etapa
  const reqDate = (v, label) => {
    const s = normalizeField('entry_date', v || today());
    if (!s) throw new Error(`Falta la fecha de ${label}.`);
    return s;
  };
  function markLetterSent(id, { date, tracking_code }) {
    const patch = { letter_sent_date: reqDate(date, 'envío'), needs_review: 0 };
    if (tracking_code !== undefined) patch.tracking_code = tracking_code;
    return updateCase(id, patch);
  }
  function registerSentence(id, { date, resolution, suspension_days }) {
    const patch = { sentence_date: reqDate(date, 'sentencia'), resolution };
    if (suspension_days !== undefined) patch.suspension_days = suspension_days;
    return updateCase(id, patch);
  }
  function registerReceipt(id, { date }) { return updateCase(id, { receipt_date: reqDate(date, 'recepción del comprobante') }); }
  function setPermitDelivery(id, { date, days }) {
    const patch = { permit_delivery_date: reqDate(date, 'entrega del permiso provisorio') };
    if (days !== undefined && clean(days) !== null) patch.suspension_days = days;
    if (!db.prepare('SELECT suspension_days FROM cases WHERE id = ?').get(Number(id))?.suspension_days && !patch.suspension_days) {
      throw new Error('Indica los días de suspensión.');
    }
    return updateCase(id, patch);
  }
  function closeCase(id, { status, date }) {
    if (!['Devuelto', 'Archivado', 'Anulado'].includes(status)) throw new Error('Estado final inválido.');
    const patch = { final_status: status };
    if (status === 'Devuelto') patch.return_date = reqDate(date, 'devolución');
    return updateCase(id, patch);
  }
  function reopenCase(id) { return updateCase(id, { final_status: null, return_date: null }); }
  function markReviewed(id) { return updateCase(id, { needs_review: 0 }); }

  function registerNotification(id, { date, to, subject, body, attachments, kind = 'sentencia', is_resend }) {
    const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(Number(id));
    if (!c) throw new Error('Exhorto no encontrado.');
    const sentAt = reqDate(date, 'notificación');
    const recipient = clean(to);
    if (!recipient) throw new Error('Falta el correo del destinatario.');
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO notifications (case_id, kind, to_email, subject, body, attachments, sent_at) VALUES (?,?,?,?,?,?,?)')
        .run(c.id, kind, recipient, clean(subject), clean(body), attachments && attachments.length ? attachments.join(' | ') : null, sentAt);
      if (kind === 'sentencia') {
        const patch = { notification_date: sentAt };
        if (is_resend !== undefined) patch.is_resend = is_resend;
        if (!c.offender_email) patch.offender_email = recipient;
        updateCase(c.id, patch);
      } else if (kind === 'carta' && !c.letter_sent_date) {
        updateCase(c.id, { letter_sent_date: sentAt });
      }
    });
    tx();
    return { ok: true };
  }

  // ---------- Recordatorios de sentencia (varios exhortos de un mismo juzgado en un solo correo) ----------
  // Causas con la carta enviada, sin sentencia y con el plazo vencido, agrupadas por juzgado remitente.
  function reminderGroups() {
    const settings = getSettings(), t = today();
    const lastRem = db.prepare("SELECT MAX(sent_at) AS d FROM notifications WHERE case_id = ? AND kind = 'recordatorio'");
    const groups = new Map();
    for (const r of listCases({ stage: 'carta' })) {
      const al = r.alerts.find(a => a.code === 'sentencia_atrasada' && a.severity === 'vencido');
      if (!al) continue;
      if (!groups.has(r.court_id)) groups.set(r.court_id, { court_id: r.court_id, court_name: r.court_name, court_email: r.court_email || '', cases: [] });
      groups.get(r.court_id).cases.push({
        id: r.id, rol: r.rol, offender_name: r.offender_name, offender_rut: r.offender_rut,
        citation_number: r.citation_number, tracking_code: r.tracking_code,
        entry_date: r.entry_date, letter_sent_date: r.letter_sent_date, due_date: al.due_date, days_overdue: -al.days_left,
        last_reminder: lastRem.get(r.id).d || null
      });
    }
    const out = [...groups.values()].sort((a, b) => a.court_name.localeCompare(b.court_name, 'es'));
    for (const g of out) g.cases.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
    return out;
  }
  function buildReminder({ court_id, case_ids }) {
    const wanted = new Set((case_ids || []).map(Number));
    const g = reminderGroups().find(x => x.court_id === Number(court_id));
    const cases = g ? g.cases.filter(c => wanted.has(c.id)) : [];
    if (!cases.length) throw new Error('Elige al menos un exhorto con sentencia atrasada de ese juzgado.');
    const s = getSettings();
    const m = L.buildReminderEmail({ courtName: g.court_name, cases, sentenceDays: s.alert_sentence_days, today: today(), signer: s.home_court_name, template: customTemplate('recordatorio'), footer: footerFor(s) });
    return { to: g.court_email, ...m, case_ids: cases.map(c => c.id) };
  }
  function registerReminder({ case_ids, date, to, subject, body }) {
    const ids = [...new Set((case_ids || []).map(Number))];
    if (!ids.length) throw new Error('No hay exhortos para registrar.');
    const tx = db.transaction(() => { for (const id of ids) registerNotification(id, { date, to, subject, body, kind: 'recordatorio' }); });
    tx();
    return { ok: true, count: ids.length };
  }

  // ---------- Documentos ----------
  function safeName(n) { return String(n).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_'); }
  function addDocument(caseId, kind, srcPath) {
    if (!['sentencia', 'comprobante', 'otro'].includes(kind)) throw new Error('Tipo de documento inválido.');
    if (!db.prepare('SELECT 1 FROM cases WHERE id = ?').get(Number(caseId))) throw new Error('Exhorto no encontrado.');
    if (!srcPath || !fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) throw new Error('No se encontró el archivo seleccionado.');
    const original = path.basename(srcPath);
    const dir = path.join(attachmentsDir, String(caseId));
    fs.mkdirSync(dir, { recursive: true });
    const stored = `${Date.now()}_${safeName(original)}`;
    fs.copyFileSync(srcPath, path.join(dir, stored));
    const r = db.prepare('INSERT INTO documents (case_id, kind, original_name, stored_name) VALUES (?,?,?,?)').run(Number(caseId), kind, original, stored);
    return { id: Number(r.lastInsertRowid), original_name: original };
  }
  function documentPath(id) {
    const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(id));
    if (!d) throw new Error('Documento no encontrado.');
    const p = path.join(attachmentsDir, String(d.case_id), d.stored_name);
    if (!fs.existsSync(p)) throw new Error('El archivo ya no está en la carpeta de documentos.');
    return p;
  }
  function removeDocument(id) {
    const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(id));
    if (!d) throw new Error('Documento no encontrado.');
    db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
    try { fs.rmSync(path.join(attachmentsDir, String(d.case_id), d.stored_name), { force: true }); } catch (_) { /* best effort */ }
    return { ok: true };
  }

  // ---------- Correos ----------
  // Con Outlook clásico la firma la agrega Outlook; con los demás, la que se define en Ajustes.
  const footerFor = st => (st.mail_client === 'classic' ? '' : st.email_signature || '');
  function buildEmail({ case_id, kind = 'sentencia', is_resend = false, include_suspension }) {
    const c = getCase(case_id);
    const s = getSettings();
    const signer = s.home_court_name;
    if (kind === 'carta') {
      const m = L.buildCourtLetterEmail({ rol: c.rol, courtName: c.court_name, entryDate: c.entry_date, signer, template: customTemplate('carta'), footer: footerFor(s) });
      return { to: c.court_email || '', ...m, attachments: [] };
    }
    const inc = include_suspension === undefined ? !!(Number(c.suspension_days) > 0) : !!include_suspension;
    const m = L.buildSentenceEmail({
      rol: c.rol, gender: c.offender_gender, offenderName: c.offender_name, greetingName: s.greeting_name, courtName: c.court_name, resolution: c.resolution,
      suspensionDays: c.suspension_days, includeSuspension: inc, isResend: !!is_resend, signer,
      paymentDays: Number(s.alert_payment_days) || 30, template: customTemplate('sentencia'), footer: footerFor(s)
    });
    return { to: c.offender_email || '', ...m, attachments: c.documents.filter(d => d.kind === 'sentencia').map(d => ({ id: d.id, name: d.original_name })) };
  }

  // ---------- Panel ----------
  function dashboard() {
    const rows = listCases({});
    const open = rows.filter(r => !r.final_status);
    const flat = [];
    for (const r of open) for (const a of r.alerts) flat.push({ ...a, case_id: r.id, rol: r.rol, court_name: r.court_name, offender_name: r.offender_name });
    const by = fn => flat.filter(fn);
    const overdue = by(a => a.severity === 'vencido').sort((a, b) => a.days_left - b.days_left);
    const soon = by(a => a.severity === 'proximo').sort((a, b) => a.days_left - b.days_left);
    const actions = by(a => a.kind === 'accion');
    const suspensions = by(a => a.kind === 'suspension').sort((a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999));
    const review = by(a => a.kind === 'revisar');
    const t = today();
    const month = t.slice(0, 7);
    return {
      today: t,
      counts: {
        overdue: overdue.length, soon: soon.length,
        notify: actions.filter(a => a.code === 'notificar').length,
        letter: actions.filter(a => a.code === 'enviar_carta').length,
        suspensions: suspensions.length, review: review.length,
        open: open.length, total: rows.length,
        closed_month: rows.filter(r => r.final_status && String(r.updated_at || r.created_at || '').startsWith(month)).length
      },
      overdue, soon, actions, suspensions, review
    };
  }

  // Respaldo en una carpeta elegida por el usuario (por ejemplo, la de OneDrive o Google Drive de escritorio).
  // Deja una copia de la base por día y espeja los documentos. Nunca se trabaja con la base "en vivo" dentro de esa carpeta,
  // para que la sincronización de la nube no pueda corromperla.
  function copyNewFiles(src, dst) {
    if (!fs.existsSync(src)) return 0;
    fs.mkdirSync(dst, { recursive: true });
    let n = 0;
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const a = path.join(src, e.name), b = path.join(dst, e.name);
      if (e.isDirectory()) n += copyNewFiles(a, b);
      else if (!fs.existsSync(b) || fs.statSync(b).size !== fs.statSync(a).size) { fs.copyFileSync(a, b); n++; }
    }
    return n;
  }
  function runBackup() {
    const s = getSettings();
    const base = clean(s.backup_dir);
    if (!base) throw new Error('Primero elige la carpeta de respaldo.');
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) throw new Error('No se encuentra la carpeta de respaldo. Revisa que la unidad o la nube estén disponibles.');
    const dir = path.join(base, 'SIGEX-respaldo');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `sigex2_${today()}.sqlite`);
    const tmp = file + '.tmp';
    fs.rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    fs.renameSync(tmp, file);
    const documents = copyNewFiles(attachmentsDir, path.join(dir, 'documentos'));
    const keep = Math.max(1, Number(s.backup_keep) || 14);
    const old = fs.readdirSync(dir).filter(f => /^sigex2_\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().reverse().slice(keep);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    const stamp = `${today()} ${String(now().getHours()).padStart(2, '0')}:${String(now().getMinutes()).padStart(2, '0')}`;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('backup_last', stamp);
    return { ok: true, path: file, documents, removed: old.length, at: stamp };
  }

  function backupTo(destPath) {
    return db.backup(destPath).then(() => ({ ok: true }));
  }

  return {
    getSettings, saveSettings, getTemplates, saveTemplate, resetTemplate, previewTemplate,
    listCourts, createCourt, updateCourt, deleteCourt, exportCourtsCSV, importCourtsCSV,
    listCases, getCase, createCase, updateCase, deleteCase,
    markLetterSent, registerSentence, registerReceipt, setPermitDelivery, closeCase, reopenCase, markReviewed, registerNotification,
    addDocument, documentPath, removeDocument,
    buildEmail, reminderGroups, buildReminder, registerReminder, dashboard, backupTo, runBackup,
    meta: () => ({ regions: REGIONS, resolution_types: L.COMPLIANCE_TYPES, stages: L.STAGES, today: today() })
  };
}

module.exports = { createService, REGIONS };
