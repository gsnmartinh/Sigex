'use strict';
// Pruebas de la lógica y del servicio (sin Electron). Ejecutar: node test/run-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/logic');
const { openDatabase, seedCourts, importLegacy } = require('../src/db');
const { createService } = require('../src/service');

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FALLA ' + name + '\n   ' + e.message); process.exitCode = 1; } };

// ---- fechas y suspensión ----
t('addDays / diffDays cruzan fin de mes y año', () => {
  assert.strictEqual(L.addDays('2026-01-31', 1), '2026-02-01');
  assert.strictEqual(L.addDays('2026-12-31', 30), '2027-01-30');
  assert.strictEqual(L.diffDays('2026-10-19', '2026-11-18'), 30);
});
t('suspensión: de medianoche a medianoche; el día siguiente al permiso es el día 1', () => {
  const c = { suspension_days: 30, permit_delivery_date: '2026-10-01' };
  let s = L.suspensionInfo(c, '2026-10-01');
  assert.strictEqual(s.state, 'por_iniciar'); assert.strictEqual(s.start, '2026-10-02'); assert.strictEqual(s.last_day, '2026-10-31'); assert.strictEqual(s.free_date, '2026-11-01');
  s = L.suspensionInfo(c, '2026-10-02'); assert.strictEqual(s.state, 'vigente'); assert.strictEqual(s.elapsed, 1); assert.strictEqual(s.remaining, 29);
  s = L.suspensionInfo(c, '2026-10-31'); assert.strictEqual(s.state, 'vigente'); assert.strictEqual(s.elapsed, 30); assert.strictEqual(s.remaining, 0);
  s = L.suspensionInfo(c, '2026-11-01'); assert.strictEqual(s.state, 'cumplida'); assert.strictEqual(s.remaining, 0);
  s = L.suspensionInfo(c, '2026-09-30'); assert.strictEqual(s.state, 'por_iniciar');
});
t('días hábiles y plazo de reenvío', () => {
  const hol = L.parseHolidays('2026-12-08\n2026-12-25');
  assert.strictEqual(L.addBusinessDays('2026-10-19', 5, hol), '2026-10-26'); // lunes -> lunes siguiente
  assert.strictEqual(L.addBusinessDays('2026-10-23', 5, hol), '2026-10-30'); // viernes
  assert.strictEqual(L.addBusinessDays('2026-12-04', 2, hol), '2026-12-09'); // salta el feriado del 8
  const c = { is_resend: 1, notification_date: '2026-10-19', resolution: 'Transferencia', sentence_date: '2026-10-10', letter_sent_date: '2026-10-05', entry_date: '2026-10-01' };
  const st = { alert_sentence_days: '30', alert_payment_days: '30', holidays: '' };
  assert.strictEqual(L.resendDue(c, st), '2026-10-26');
  assert.ok(!L.alertsFor(c, st, '2026-10-20').some(a => a.kind === 'plazo'));
  assert.ok(L.alertsFor(c, st, '2026-10-24').some(a => a.code === 'reenvio_vencido' && a.severity === 'proximo'));
  assert.ok(L.alertsFor(c, st, '2026-10-27').some(a => a.code === 'reenvio_vencido' && a.severity === 'vencido'));
  assert.ok(!L.alertsFor({ ...c, is_resend: 0 }, st, '2026-10-27').some(a => a.code === 'reenvio_vencido'));
});
t('suspensión sin permiso entregado queda pendiente', () => {
  assert.strictEqual(L.suspensionInfo({ suspension_days: 60 }, '2026-10-19').state, 'sin_permiso');
  assert.strictEqual(L.suspensionInfo({}, '2026-10-19'), null);
});

// ---- etapas y alertas ----
const S = { alert_sentence_days: '30', alert_payment_days: '30' };
t('etapas', () => {
  assert.strictEqual(L.stageOf({}), 'ingresado');
  assert.strictEqual(L.stageOf({ letter_sent_date: 'x' }), 'carta');
  assert.strictEqual(L.stageOf({ letter_sent_date: 'x', sentence_date: 'y' }), 'sentencia');
  assert.strictEqual(L.stageOf({ sentence_date: 'y', notification_date: 'z' }), 'notificado');
  assert.strictEqual(L.stageOf({ notification_date: 'z', receipt_date: 'w' }), 'comprobante');
  assert.strictEqual(L.stageOf({ receipt_date: 'w', final_status: 'Archivado' }), 'archivado');
});
t('alerta: carta enviada hace 31 días sin sentencia = vencida; hace 25 = próxima; hace 10 = sin alerta', () => {
  const mk = d => ({ letter_sent_date: d });
  const a = L.alertsFor(mk('2026-09-18'), S, '2026-10-19'); // 31 días
  assert.strictEqual(a[0].severity, 'vencido'); assert.strictEqual(a[0].days_left, -1);
  const b = L.alertsFor(mk('2026-09-24'), S, '2026-10-19'); // 25 días → vence en 5
  assert.strictEqual(b[0].severity, 'proximo'); assert.strictEqual(b[0].days_left, 5);
  assert.strictEqual(L.alertsFor(mk('2026-10-09'), S, '2026-10-19').filter(x => x.kind === 'plazo').length, 0);
});
t('recordatorios: salen de vencidos, esperan 15 días, vuelven numerados y desde el 3° escalan', () => {
  const c = n => ({ letter_sent_date: '2026-08-01', reminder_count: n, last_reminder: '2026-10-10' });
  const st = { ...S, alert_reminder_wait_days: '15' };
  const w = L.alertsFor(c(1), st, '2026-10-20'); // 10 días después: esperando
  assert.ok(w.some(a => a.kind === 'espera' && a.days_left === 5 && !a.escalate));
  assert.ok(!w.some(a => a.severity === 'vencido'));
  const v = L.alertsFor(c(1), st, '2026-10-26'); // pasaron 16 días: vuelve a vencidos
  assert.ok(v.some(a => a.code === 'sentencia_atrasada' && a.severity === 'vencido' && /1° recordatorio/.test(a.title)) && !v.some(a => a.kind === 'espera'));
  assert.ok(L.alertsFor(c(3), st, '2026-10-20').some(a => a.kind === 'espera' && a.escalate));
  assert.ok(L.alertsFor(c(3), st, '2026-10-26').some(a => a.severity === 'vencido' && a.escalate));
  assert.ok(!L.alertsFor({ letter_sent_date: '2026-10-01' }, st, '2026-10-20').some(a => a.kind === 'espera'));
});
t('alerta: notificado sin comprobante a 30 días vence hoy; absolución no genera plazo', () => {
  const c = { sentence_date: '2026-09-01', notification_date: '2026-09-19', resolution: 'Transferencia' };
  const a = L.alertsFor(c, S, '2026-10-19');
  assert.strictEqual(a[0].severity, 'vencido'.replace('vencido', 'proximo')); // vence hoy (0 días) → próximo
  assert.strictEqual(a[0].days_left, 0);
  const ab = L.alertsFor({ ...c, resolution: 'Absolución', license_retained: 'no' }, S, '2026-11-30');
  assert.strictEqual(ab.filter(x => x.kind === 'plazo').length, 0);
  assert.strictEqual(ab[0].code, 'cerrar');
});
t('causa con needs_review solo muestra "revisar"', () => {
  const a = L.alertsFor({ needs_review: 1 }, S, '2026-10-19');
  assert.deepStrictEqual(a.map(x => x.kind), ['revisar']);
});
t('correo: incluye suspensión y reenvío', () => {
  const m = L.buildSentenceEmail({ rol: '123-26', gender: 'F', courtName: 'Primer JPL de Osorno', resolution: 'Transferencia|Vale Vista', suspensionDays: 45, includeSuspension: true, isResend: true, signer: 'Segundo JPL de Valdivia', paymentDays: 30 });
  assert.match(m.subject, /Rol 123-26/); assert.match(m.body, /^Estimada:/);
  assert.match(m.body, /45 días/); assert.match(m.body, /5 días hábiles/); assert.match(m.body, /Vale Vista.*Transferencia Bancaria/);
});

// ---- servicio ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigex-t-'));
const db = openDatabase(path.join(tmp, 'data', 't.sqlite'));
let fakeNow = new Date(2026, 9, 19);
const svc = createService({ db, attachmentsDir: path.join(tmp, 'docs'), now: () => fakeNow });
assert.ok(seedCourts(db, path.join(__dirname, '..', 'data', 'courts_seed.json')) >= 30);

t('directorio: crear, duplicado, editar, borrar, borrar con exhortos falla', () => {
  const { id } = svc.createCourt({ name: 'Juzgado de Policía Local de Prueba', commune: 'Prueba', region: 'Los Ríos', email: 'a@b.cl' });
  assert.throws(() => svc.createCourt({ name: 'juzgado de policía local de prueba' }), /Ya existe/);
  svc.updateCourt(id, { name: 'Juzgado de Policía Local de Prueba', commune: 'Prueba', region: 'Los Ríos', phone: '123' });
  assert.strictEqual(svc.listCourts('prueba')[0].phone, '123');
  const caseId = svc.createCase({ rol: 'P-1', court_id: id, entry_date: '2026-10-01' }).id;
  assert.throws(() => svc.deleteCourt(id), /exhorto/);
  svc.deleteCase(caseId);
  svc.deleteCourt(id);
  assert.strictEqual(svc.listCourts('Prueba').length, 0);
});

const courtOsorno = svc.listCourts('Osorno')[0];
let caseId;
t('flujo completo de un exhorto', () => {
  caseId = svc.createCase({ rol: '13159-26', court_id: courtOsorno.id, entry_date: '2026-09-01', offender_name: 'Juan Pérez', offender_email: 'jp@mail.cl', offender_gender: 'M' }).id;
  assert.throws(() => svc.createCase({ rol: '13159-26', court_id: courtOsorno.id, entry_date: '2026-09-02' }), /Ya existe/);
  assert.strictEqual(svc.getCase(caseId).stage, 'ingresado');
  assert.ok(svc.dashboard().actions.some(a => a.code === 'enviar_carta' && a.case_id === caseId));

  svc.markLetterSent(caseId, { date: '2026-09-10' });
  assert.strictEqual(svc.getCase(caseId).stage, 'carta');
  fakeNow = new Date(2026, 9, 11); // 31 días después de la carta
  assert.strictEqual(svc.dashboard().overdue.filter(a => a.case_id === caseId)[0].code, 'sentencia_atrasada');

  svc.registerSentence(caseId, { date: '2026-10-12', resolution: ['Transferencia', 'Vale Vista'], suspension_days: 30 });
  let c = svc.getCase(caseId);
  assert.strictEqual(c.stage, 'sentencia'); assert.strictEqual(c.suspension.state, 'sin_permiso');
  assert.strictEqual(svc.dashboard().counts.notify, 1);

  const pdf = path.join(tmp, 'sentencia.pdf'); fs.writeFileSync(pdf, '%PDF-1.4 test');
  const doc = svc.addDocument(caseId, 'sentencia', pdf);
  assert.ok(fs.existsSync(svc.documentPath(doc.id)));
  const mail = svc.buildEmail({ case_id: caseId });
  assert.strictEqual(mail.to, 'jp@mail.cl'); assert.strictEqual(mail.attachments.length, 1); assert.match(mail.body, /30 días/);

  svc.registerNotification(caseId, { date: '2026-10-13', to: 'jp@mail.cl', subject: mail.subject, body: mail.body, attachments: ['sentencia.pdf'] });
  c = svc.getCase(caseId);
  assert.strictEqual(c.stage, 'notificado'); assert.strictEqual(c.notification_date, '2026-10-13'); assert.strictEqual(c.notifications.length, 1);

  svc.setPermitDelivery(caseId, { date: '2026-10-14' });
  fakeNow = new Date(2026, 9, 20);
  c = svc.getCase(caseId);
  assert.strictEqual(c.suspension.state, 'vigente'); assert.strictEqual(c.suspension.elapsed, 6); assert.strictEqual(c.suspension.free_date, '2026-11-14');

  fakeNow = new Date(2026, 10, 13); // 31 días tras notificar
  assert.ok(svc.dashboard().overdue.some(a => a.case_id === caseId && a.code === 'comprobante_atrasado'));

  svc.registerReceipt(caseId, { date: '2026-11-13' });
  assert.strictEqual(svc.getCase(caseId).stage, 'comprobante');
  assert.ok(!svc.dashboard().overdue.some(a => a.case_id === caseId));
  svc.closeCase(caseId, { status: 'Devuelto', date: '2026-11-14' });
  c = svc.getCase(caseId);
  assert.strictEqual(c.stage, 'devuelto'); assert.strictEqual(c.return_date, '2026-11-14');
  svc.reopenCase(caseId);
  assert.strictEqual(svc.getCase(caseId).stage, 'comprobante');
});
t('validaciones de orden de fechas', () => {
  assert.throws(() => svc.updateCase(caseId, { notification_date: '2026-10-01' }), /anterior a la sentencia/);
  assert.throws(() => svc.updateCase(caseId, { sentence_date: '2026-13-45' }), /inválida/);
  assert.throws(() => svc.registerSentence(caseId, { date: '2026-10-12', suspension_days: 'abc' }), /suspensión/);
});
t('borrar exhorto elimina documentos del disco', () => {
  const dir = path.join(tmp, 'docs', String(caseId));
  assert.ok(fs.existsSync(dir));
  svc.deleteCase(caseId);
  assert.ok(!fs.existsSync(dir));
});
t('CSV: exportar e importar (actualiza y crea)', () => {
  const csv = svc.exportCourtsCSV();
  assert.ok(csv.startsWith('﻿nombre;comuna;region'));
  const modified = csv.replace('jpl@muniancud.cl', 'nuevo@muniancud.cl') + 'Juzgado de Policía Local de Nuevo;Nuevo;Los Lagos;"Calle 1; Of. 2";n@n.cl;123;obs\r\n';
  const r = svc.importCourtsCSV(modified);
  assert.strictEqual(r.created, 1);
  assert.strictEqual(svc.listCourts('Ancud')[0].email, 'nuevo@muniancud.cl');
  assert.strictEqual(svc.listCourts('Policía Local de Nuevo')[0].address, 'Calle 1; Of. 2');
  assert.strictEqual(svc.importCourtsCSV('nombre,correo\nJuzgado de Policía Local de Ancud,otro@x.cl\n').updated, 1);
});

// ---- importación desde la versión anterior (solo si existe la copia de la base real) ----
const legacy = process.env.SIGEX_LEGACY || '/tmp/claude-0/db/sigex.sqlite';
if (fs.existsSync(legacy)) {
  t('importa la base anterior sin perder datos y es idempotente', () => {
    const db2 = openDatabase(path.join(tmp, 'data2', 'n.sqlite'));
    const r = importLegacy(db2, legacy);
    assert.ok(r.ok); assert.strictEqual(r.cases, 70);
    const s2 = createService({ db: db2, attachmentsDir: path.join(tmp, 'docs2'), now: () => new Date(2026, 9, 19) });
    assert.strictEqual(db2.prepare('SELECT COUNT(*) n FROM cases').get().n, 70);
    assert.strictEqual(db2.prepare('SELECT COUNT(*) n FROM notifications').get().n, 55);
    assert.ok(s2.listCourts().length >= 36);
    const again = importLegacy(db2, legacy);
    assert.strictEqual(again.cases, 0); assert.strictEqual(again.skipped, 70);
    assert.strictEqual(db2.prepare('SELECT COUNT(*) n FROM notifications').get().n, 55);
    const d = s2.dashboard();
    console.log('       migrado:', JSON.stringify(r), '\n       panel:', JSON.stringify(d.counts));
    // cada causa migrada es consultable y decorada sin errores
    for (const c of s2.listCases({})) assert.ok(c.stage_label);
    db2.close();
  });
}

t('saludo con nombre', () => {
  assert.strictEqual(L.greeting('M', 'JORGE andrés PÉREZ soto'), 'Estimado Jorge:');
  assert.strictEqual(L.greeting('F', 'maría josé de la cruz', 'full'), 'Estimada María José de la Cruz:');
  assert.strictEqual(L.greeting('F', 'ana-luisa  rojas'), 'Estimada Ana-Luisa:');
  assert.strictEqual(L.greeting('M', ''), 'Estimado:');
  assert.strictEqual(L.greeting(null, 'Pat'), 'Estimado/a Pat:');
});
t('plantillas: por defecto igual que antes, editar, validar y restablecer', () => {
  const d2 = openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-')), 'd.sqlite'));
  const sv = createService({ db: d2, attachmentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tplA-')) });
  seedCourts(d2, path.join(__dirname, '..', 'data', 'courts_seed.json'));
  const court = sv.listCourts()[0];
  const c = sv.createCase({ rol: 'T-1', court_id: court.id, entry_date: '2026-10-01', offender_name: 'X', offender_email: 'x@y.cl', offender_gender: 'M' });
  sv.markLetterSent(c.id, { date: '2026-10-02' });
  sv.registerSentence(c.id, { date: '2026-10-05', resolution: ['Transferencia'], suspension_days: 10 });
  const before = sv.buildEmail({ case_id: c.id, kind: 'sentencia' });
  assert.ok(before.body.startsWith('Estimado X:') && before.body.includes('IMPORTANTE') && !before.body.includes('{') && !/\n{3,}/.test(before.body));
  assert.throws(() => sv.saveTemplate('sentencia', { subject: 'a', body: 'hola {inventado}' }), /desconocid/);
  assert.throws(() => sv.saveTemplate('sentencia', { subject: '', body: 'x' }));
  sv.saveTemplate('sentencia', { subject: 'Sentencia {rol}', body: 'Hola {saludo}\n\n{avisos}\n\n{firma}' });
  const m = sv.buildEmail({ case_id: c.id, kind: 'sentencia' });
  assert.strictEqual(m.subject, 'Sentencia T-1'); assert.ok(m.body.startsWith('Hola Estimado X:') && m.body.includes('IMPORTANTE'));
  assert.ok(sv.getTemplates().sentencia.custom);
  assert.ok(sv.previewTemplate('carta', { subject: 'S {rol}', body: '{firma}' }).subject === 'S 1234-2026');
  sv.saveSettings({ email_signature: 'Guillermo San Martín\nFuncionario JPL\nFono 63-2000000' });
  const withSig = sv.buildEmail({ case_id: c.id, kind: 'sentencia' }).body;
  assert.ok(withSig.endsWith('Fono 63-2000000'), 'el pie va al final');
  sv.saveSettings({ mail_client: 'classic' });
  assert.ok(!sv.buildEmail({ case_id: c.id, kind: 'sentencia' }).body.includes('Fono 63'), 'con Outlook clásico no se duplica la firma');
  assert.throws(() => sv.saveSettings({ mail_client: 'otro' }));
  sv.saveSettings({ mail_client: 'new', email_signature: '' });
  sv.resetTemplate('sentencia');
  assert.deepStrictEqual(sv.buildEmail({ case_id: c.id, kind: 'sentencia' }), before);
  d2.close();
});

t('recordatorios: agrupa por juzgado, un correo por tribunal, registra y migra la base antigua', () => {
  const d3 = openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rem-')), 'r.sqlite'));
  const sv = createService({ db: d3, attachmentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'remA-')), now: () => new Date(2026, 9, 27) });
  const A = sv.createCourt({ name: 'Juzgado de Policía Local de Ancud', commune: 'Ancud', email: 'jpl@ancud.cl' }).id;
  const B = sv.createCourt({ name: 'Juzgado de Policía Local de Osorno', commune: 'Osorno' }).id;
  const mk = (rol, court, entry, letter, extra = {}) => { const c = sv.createCase({ rol, court_id: court, entry_date: entry, ...extra }); if (letter) sv.markLetterSent(c.id, { date: letter, tracking_code: extra.code }); return c.id; };
  const c1 = mk('1001-26', A, '2026-09-08', '2026-09-08', { offender_name: 'PEDRO ANTONIO MUÑOZ SOTO', offender_rut: '11111111-1', citation_number: '1000001', code: '1100000000001' });
  const c2 = mk('1002-26', A, '2026-09-16', '2026-09-16', { offender_name: 'Ana Maria Rojas Vera', offender_rut: '22.222.222-2', citation_number: '1000002', code: '1100000000002' });
  const c3 = mk('18000-26', A, '2026-10-20', '2026-10-20');          // aún en plazo
  const c4 = mk('99-26', B, '2026-08-01', '2026-08-01');             // vencida, otro juzgado
  mk('77-26', A, '2026-08-01', null);                                // sin carta enviada: no aplica
  const g = sv.reminderGroups();
  assert.deepStrictEqual(g.map(x => [x.court_name, x.cases.map(c => c.rol)]), [['Juzgado de Policía Local de Ancud', ['1001-26', '1002-26']], ['Juzgado de Policía Local de Osorno', ['99-26']]]);
  assert.strictEqual(g[0].cases[0].days_overdue, 19);
  assert.strictEqual(sv.getCase(c1).tracking_code, '1100000000001');
  const m = sv.buildReminder({ court_id: A, case_ids: [c1, c2, c3, c4] });   // c3 y c4 se ignoran: no son de ese juzgado vencido
  assert.deepStrictEqual(m.case_ids, [c1, c2]); assert.strictEqual(m.to, 'jpl@ancud.cl');
  assert.strictEqual(m.subject, 'Reitera solicitud de sentencia - Rol 1001-26 y Rol 1002-26');
  for (const x of ['1. Rol 1001-26, infractor Pedro Antonio Muñoz Soto, RUT 11.111.111-1. Boleta de citación N° 1000001. Exhorto ingresado el 08-09-2026. Carta enviada el 08-09-2026; plazo vencido el 08-10-2026. Código de seguimiento de Correos: 1100000000001.',
    '2. Rol 1002-26', 'RUT 22.222.222-2', 'Código de seguimiento de Correos: 1100000000002.', 'los exhortos ingresados en este Juzgado', 'cada una de las causas', 'Presente']) assert.ok(m.body.includes(x), x);
  assert.ok(!m.body.includes('{') && !/\n{3,}/.test(m.body));
  const one = sv.buildReminder({ court_id: B, case_ids: [c4] });
  assert.ok(one.body.includes('el exhorto ingresado') && one.body.includes('la sentencia dictada en la causa') && !one.body.includes('1. Rol') && one.to === '');
  assert.throws(() => sv.buildReminder({ court_id: A, case_ids: [c3] }), /al menos un exhorto/);
  assert.throws(() => sv.registerReminder({ case_ids: [c1, c2], date: '2026-10-27', to: '' }), /destinatario/);
  assert.strictEqual(sv.getCase(c1).notifications.length, 0, 'si falla, no se registra nada');
  sv.registerReminder({ case_ids: m.case_ids, date: '2026-10-27', to: m.to, subject: m.subject, body: m.body });
  assert.strictEqual(sv.getCase(c2).notifications[0].kind, 'recordatorio');
  assert.strictEqual(sv.getCase(c2).stage, 'carta', 'el recordatorio no cambia la etapa');
  // tras registrar, esas causas salen de vencidos y quedan "esperando respuesta del juzgado"
  assert.deepStrictEqual(sv.reminderGroups().map(x => x.cases.map(c => c.rol)), [['99-26']]);
  const dsh = sv.dashboard();
  assert.strictEqual(dsh.counts.waiting, 2);
  assert.ok(dsh.waiting.every(a => a.code === 'esperando_respuesta' && a.days_left === 15) && !dsh.overdue.some(a => a.case_id === c1 || a.case_id === c2));
  assert.strictEqual(sv.listCases({ stage: 'esperando_juzgado' }).length, 2);
  sv.saveTemplate('recordatorio', { subject: 'R {roles}', body: '{listado}\n\n{firma}' });
  assert.ok(sv.buildReminder({ court_id: B, case_ids: [c4] }).body.startsWith('Rol 99-26'));
  assert.throws(() => sv.saveTemplate('recordatorio', { subject: 'x', body: '{saludo}' }), /desconocid/);
  sv.resetTemplate('recordatorio');
  assert.ok(sv.previewTemplate('recordatorio', sv.getTemplates().recordatorio).body.includes('1. Rol 1234-2026'));
  assert.strictEqual(L.formatRut('9876543-2'), '9.876.543-2'); assert.strictEqual(L.formatRut('abc'), 'abc');
  d3.close();
});
t('respaldo en carpeta: copia por día, documentos, rotación y errores claros', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const docs = path.join(root, 'docs'), dest = path.join(root, 'OneDrive');
  fs.mkdirSync(dest);
  let clock = new Date(2026, 9, 1, 9, 5);
  const d5 = openDatabase(path.join(root, 'live.sqlite'));
  const sv = createService({ db: d5, attachmentsDir: docs, now: () => clock });
  const court = sv.createCourt({ name: 'Juzgado de Policía Local de Prueba' }).id;
  const c = sv.createCase({ rol: 'B-1', court_id: court, entry_date: '2026-10-01' }).id;
  assert.throws(() => sv.runBackup(), /carpeta de respaldo/);
  assert.throws(() => sv.saveSettings({ backup_dir: path.join(root, 'no-existe') }), /No se encuentra/);
  assert.throws(() => sv.saveSettings({ backup_keep: 0 }));
  sv.saveSettings({ backup_dir: dest, backup_keep: 3 });
  const pdf = path.join(root, 's.pdf'); fs.writeFileSync(pdf, '%PDF-1.4 x');
  sv.addDocument(c, 'sentencia', pdf);
  let r = sv.runBackup();
  assert.strictEqual(r.documents, 1); assert.ok(r.path.endsWith('sigex2_2026-10-01.sqlite'));
  const Database = require('better-sqlite3');
  const copy = new Database(r.path, { readonly: true });
  assert.strictEqual(copy.prepare('SELECT rol FROM cases').get().rol, 'B-1'); copy.close();
  assert.strictEqual(sv.getSettings().backup_last, '2026-10-01 09:05');
  assert.strictEqual(sv.runBackup().documents, 0, 'no vuelve a copiar documentos ya respaldados');
  for (let day = 2; day <= 5; day++) { clock = new Date(2026, 9, day, 18, 0); sv.runBackup(); }
  const kept = fs.readdirSync(path.join(dest, 'SIGEX-respaldo')).filter(f => f.endsWith('.sqlite')).sort();
  assert.deepStrictEqual(kept, ['sigex2_2026-10-03.sqlite', 'sigex2_2026-10-04.sqlite', 'sigex2_2026-10-05.sqlite']);
  assert.ok(!fs.readdirSync(path.join(dest, 'SIGEX-respaldo')).some(f => f.endsWith('.tmp')));
  fs.rmSync(dest, { recursive: true, force: true });
  assert.throws(() => sv.runBackup(), /No se encuentra la carpeta/);
  d5.close();
});
t('migración: una base creada sin las columnas nuevas las recibe al abrirse', () => {
  const Database = require('better-sqlite3');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'old.sqlite');
  const old = new Database(f);
  old.exec("CREATE TABLE courts (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, commune TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', address TEXT, email TEXT, phone TEXT, notes TEXT, created_at TEXT, updated_at TEXT);" +
    "CREATE TABLE cases (id INTEGER PRIMARY KEY, rol TEXT NOT NULL, court_id INTEGER NOT NULL, offender_name TEXT, offender_rut TEXT, offender_email TEXT, offender_phone TEXT, offender_gender TEXT, entry_date TEXT NOT NULL, letter_sent_date TEXT, sentence_date TEXT, resolution TEXT, notification_date TEXT, is_resend INTEGER NOT NULL DEFAULT 0, receipt_date TEXT, return_date TEXT, final_status TEXT, suspension_days INTEGER, permit_delivery_date TEXT, needs_review INTEGER NOT NULL DEFAULT 0, notes TEXT, legacy_id INTEGER, created_at TEXT, updated_at TEXT);" +
    "INSERT INTO courts (id, name) VALUES (1, 'J'); INSERT INTO cases (rol, court_id, entry_date) VALUES ('X-1', 1, '2026-10-01');");
  old.close();
  const d4 = openDatabase(f);
  const cols = d4.prepare('PRAGMA table_info(cases)').all().map(c => c.name);
  assert.ok(cols.includes('citation_number') && cols.includes('tracking_code'));
  assert.strictEqual(d4.prepare('SELECT rol FROM cases').get().rol, 'X-1');
  d4.close(); openDatabase(f).close();   // abrir otra vez no falla
});

t('escaneo: PDF válido', () => {
  const { buildPdf, createScanSession } = require('../src/scan');
  const fs2 = require('fs'), os2 = require('os'), path2 = require('path');
  const a = fs2.readFileSync(path2.join(__dirname, 'hoja.jpg'));
  const pdf = buildPdf([a, a]);
  const f = path2.join(os2.tmpdir(), 'sigex_scan_test.pdf'); fs2.writeFileSync(f, pdf);
  assert.ok(pdf.slice(0, 5).toString() === '%PDF-' && pdf.slice(-6).toString().includes('%%EOF'));
});

(async () => {
  const { createScanSession } = require('../src/scan');
  const fs2 = require('fs'), os2 = require('os'), path2 = require('path');
  const a = fs2.readFileSync(path2.join(__dirname, 'hoja.jpg'));
  try {
  const sess = createScanSession({ tmpRoot: fs2.mkdtempSync(path2.join(os2.tmpdir(), 'sc-')), acquire: async o => { fs2.writeFileSync(o, a); return o; } });
    await sess.scanPage(); const r2 = await sess.scanPage(); assert.strictEqual(r2.count, 2);
    assert.strictEqual(sess.move(0, 1).count, 2); assert.strictEqual(sess.removeAt(0).count, 1); assert.throws(() => sess.removeAt(5)); await sess.scanPage();
    const out = sess.finish('Sentencia: Rol 1/2'); assert.strictEqual(out.pages, 2); assert.ok(out.path.endsWith('Sentencia Rol 1 2.pdf'));
    assert.strictEqual(sess.count(), 0);
    assert.throws(() => sess.finish('x'));
    console.log('  ok  escaneo: sesión multi-hoja');
  } catch (e) { console.error('FALLA escaneo sesión ' + e.message); process.exitCode = 1; }
})();

db.close();
console.log(`\n${passed} pruebas OK`);
