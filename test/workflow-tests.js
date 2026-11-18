'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { openDatabase } = require('../src/db');
const { createService } = require('../src/service');
const L = require('../src/logic');
const { MODELS, makeDocx } = require('../src/exhorto-documents');
const { createDocumentWorkflow } = require('../src/document-workflow');
const { callCorrespondence } = require('../src/correspondence');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigex-workflow-'));
const db = openDatabase(path.join(tmp, 'cases.sqlite'));
let now = new Date(2026, 10, 18);
const service = createService({ db, attachmentsDir: path.join(tmp, 'attachments'), now: () => now });
const court = service.createCourt({ name: 'Juzgado de Policía Local de Ejemplo', commune: 'Ejemplo' }).id;
let serial = 1, count = 0;
const test = async (name, fn) => { await fn(); count++; console.log('  ok  ' + name); };
function makeCase(patch = {}) {
  return service.createCase({ rol: serial++ + '-26', court_id: court, entry_date: '2026-09-01',
    offender_name: 'Persona de Ejemplo', offender_rut: '20.017.300-7', offender_address: 'Calle de Ejemplo 123',
    origin_rol: 'ORIGEN-123', request_folio: '1', license_retained: 'no', letter_sent_date: '2026-09-02',
    sentence_date: '2026-10-01', notification_date: '2026-10-02', resolution: 'Transferencia', ...patch }).id;
}
const signers = () => ({ judge: 'Juez de Ejemplo', judgeRole: 'Juez titular', secretary: 'Secretaría de Ejemplo', secretaryRole: 'Secretaria titular' });
const orders = new Map();
let orderCalls = 0;
const controller = createDocumentWorkflow({ service, templateDir: path.join(tmp, 'templates'), outputDir: path.join(tmp, 'word'), signers,
  reserveOrd: async p => { orderCalls++; if (!orders.has(p.request_id)) orders.set(p.request_id, String(1000 + orders.size)); return orders.get(p.request_id); } });

async function main() {
  await test('pago: persiste datos completos, exige monto y plataforma, y permite reutilizarlos', () => {
    const id = makeCase();
    assert.throws(() => service.registerReceipt(id, { date: '2026-11-18', payment_method: 'web', payment_amount: 12000 }), /plataforma/);
    assert.equal(service.getCase(id).receipt_date, null);
    service.registerReceipt(id, { date: '2026-11-18', payment_method: 'web', payment_amount: 12000, payment_platform: 'Pago municipal' });
    const plan = controller.documentPlan(id, 'pago');
    assert.deepEqual(plan.recommended, ['x26web', 'x05web']);
    assert.equal(plan.defaults.x05web.amount, 12000); assert.equal(plan.defaults.x05web.platform, 'Pago municipal');
    assert.equal(plan.defaults.x05web.origin, 'ORIGEN-123');
    assert(service.getCase(id).closure.archive_pending.some(s => /despacho/.test(s)));
  });
  await test('pago y suspensión cumplida no permiten archivar sin entregar la licencia', () => {
    const id = makeCase({ license_retained: 'yes', license_received_date: '2026-11-01', suspension_days: 3, permit_delivery_date: '2026-11-10', receipt_date: '2026-11-13', payment_remitted_date: '2026-11-14' });
    assert.equal(service.getCase(id).license.state, 'retiro');
    assert.throws(() => service.closeCase(id, { status: 'Archivado' }), /licencia original/);
    assert.throws(() => service.updateCase(id, { final_status: 'Archivado' }), /licencia original/);
    assert.throws(() => controller.previewExhortoDocument(id, { model: 'x09conSuspension' }), /Antes de preparar el archivo/);
    service.registerLicenseMovement(id, { action: 'entregar', date: '2026-11-18' });
    assert.equal(service.getCase(id).closure.can_archive, true);
    service.closeCase(id, { status: 'Archivado' });
    assert.equal(service.getCase(id).stage, 'archivado');
  });
  await test('licencia pendiente de llegada y suspensión vigente siguen bloqueando el archivo', () => {
    const id = makeCase({ license_retained: 'yes', receipt_date: '2026-11-10', payment_remitted_date: '2026-11-11' });
    assert.equal(service.getCase(id).license.state, 'pendiente');
    assert.throws(() => service.registerLicenseMovement(id, { action: 'entregar', date: '2026-11-18' }), /no está disponible/);
    service.registerLicenseMovement(id, { action: 'recibir', date: '2026-11-18' });
    service.updateCase(id, { suspension_days: 30, permit_delivery_date: '2026-11-01' });
    assert.equal(service.getCase(id).license.state, 'custodia');
    assert(!service.getCase(id).alerts.some(a => a.code === 'archivar'));
  });
  await test('reconsideración detiene devolución y pago; los 30 días reinician al notificar', () => {
    const id = makeCase({ is_resend: 1 });
    service.registerAppeal(id, { action: 'presentar', date: '2026-11-01' });
    let c = service.getCase(id);
    assert.equal(c.stage, 'recurso'); assert.equal(c.payment_due, null); assert.equal(c.resend_due, null);
    assert(!c.alerts.some(a => /comprobante_atrasado|reenvio_vencido/.test(a.code)));
    assert.throws(() => service.closeCase(id, { status: 'Devuelto', date: '2026-11-18' }), /reconsideración/);
    service.registerAppeal(id, { action: 'remitir', date: '2026-11-02' });
    service.registerAppeal(id, { action: 'resolver', date: '2026-11-10', resolution: ['Transferencia'], suspension_days: '' });
    assert.equal(service.getCase(id).payment_due, null);
    service.registerNotification(id, { kind: 'recurso', date: '2026-11-18', to: 'ejemplo@example.org' });
    c = service.getCase(id);
    assert.equal(c.appeal_state, 'notificado'); assert.equal(c.is_resend, 0);
    assert.equal(c.notification_date, '2026-10-02'); assert.equal(c.payment_due, '2026-12-18');
    assert.equal(c.events.filter(e => e.kind.startsWith('recurso_')).length, 4);
  });
  await test('devolución espera todo el segundo aviso, incluso el día de vencimiento', () => {
    const id = makeCase({ notification_date: '2026-11-11', is_resend: 1 });
    assert.equal(service.getCase(id).resend_due, '2026-11-18');
    assert.throws(() => service.closeCase(id, { status: 'Devuelto', date: '2026-11-18' }), /vencimiento completo/);
    now = new Date(2026, 10, 19);
    service.closeCase(id, { status: 'Devuelto', date: '2026-11-19' });
    now = new Date(2026, 10, 18);
  });
  await test('búsqueda por boleta, seguimiento, rol de origen y RUT con o sin puntuación', () => {
    const id = makeCase({ citation_number: 'BOLETA-UNICA', tracking_code: 'SEGUIMIENTO-UNICO', origin_rol: 'ORIGEN-UNICO' });
    for (const q of ['BOLETA-UNICA', 'SEGUIMIENTO-UNICO', 'ORIGEN-UNICO', '20017300-7', '20.017.300-7']) assert(service.listCases({ q }).some(c => c.id === id));
  });
  await test('los 20 modelos generan Word Legal sin marcadores pendientes y con las plantillas originales', async () => {
    const id = makeCase({ license_retained: 'yes', license_received_date: '2026-11-01', license_delivered_date: '2026-11-15', receipt_date: '2026-11-13', payment_remitted_date: '2026-11-14', license_class: 'B', license_number: 'XXXX', license_municipality: 'Ejemplo' });
    for (const model of Object.keys(MODELS)) {
      assert(controller.validateDocumentTemplate(model).ok);
      const input = { model, request_id: randomUUID(), amount: 15000, bank: 'Banco de Ejemplo', serial: '12345', platform: 'Plataforma municipal', method: 'web', municipality: 'Ejemplo' };
      const r = await controller.exportExhortoDocument(id, input);
      const bytes = fs.readFileSync(service.generatedDocumentPath(r.document.id));
      assert.equal(bytes.readUInt32LE(0), 0x04034b50);
      assert(!bytes.includes('[[SIGEX:'));
      assert(bytes.includes('w:w="12240" w:h="20160"') || bytes.includes('w:w="20160" w:h="12240"'));
      if (model === 'x06') { assert(bytes.includes('XXXX')); assert(bytes.includes('<w:b/>')); assert(bytes.includes('w:val="000000"')); }
    }
    assert.equal(service.getCase(id).generated_documents.length, Object.keys(MODELS).length);
  });
  await test('reimpresión, doble clic y reapertura reutilizan archivo y ORD.; una nueva versión crea otro registro', async () => {
    const id = makeCase(), request_id = randomUUID();
    const input = { model: 'x11', request_id };
    const before = orderCalls;
    const [a, b] = await Promise.all([controller.exportExhortoDocument(id, input), controller.exportExhortoDocument(id, input)]);
    assert.equal(a.document.id, b.document.id); assert.equal(orderCalls, before + 1);
    const oldPath = service.generatedDocumentPath(a.document.id);
    const c = await controller.exportExhortoDocument(id, input);
    assert.equal(c.document.id, a.document.id); assert.equal(service.generatedDocumentPath(c.document.id), oldPath); assert.equal(orderCalls, before + 1);
    const next = await controller.exportExhortoDocument(id, { ...input, request_id: randomUUID() });
    assert.equal(next.document.version, 2); assert.notEqual(next.document.ord, a.document.ord);
    fs.rmSync(oldPath);
    assert(fs.existsSync(service.generatedDocumentPath(a.document.id)), 'copia incluida en respaldo');
  });
  await test('respuesta perdida al reservar ORD.: reintentar conserva la solicitud y recupera el mismo número', async () => {
    const id = makeCase(); let attempts = 0; const reservations = new Map();
    const retry = createDocumentWorkflow({ service, templateDir: path.join(tmp, 'templates'), outputDir: path.join(tmp, 'retry'), signers,
      reserveOrd: async p => { attempts++; reservations.set(p.request_id, '5555'); if (attempts === 1) throw new Error('Respuesta perdida'); return reservations.get(p.request_id); } });
    await assert.rejects(retry.exportExhortoDocument(id, { model: 'x11', request_id: randomUUID() }), /Respuesta perdida/);
    const pending = service.getCase(id).generated_documents[0];
    assert.equal(pending.state, 'preparing');
    const r = await retry.retryGeneratedDocument(pending.id);
    assert.equal(r.document.id, pending.id); assert.equal(r.document.ord, '5555'); assert.equal(reservations.size, 1);
  });
  await test('conexión ORD. rechaza destinos ajenos y confirmaciones de otra emisión', async () => {
    await assert.rejects(callCorrespondence({ endpoint: 'https://example.org', token: 'secret', payload: {} }), /URL/);
    await assert.rejects(callCorrespondence({ endpoint: 'https://script.google.com/macros/s/test/exec', token: 'secret', payload: { request_id: 'correcta' }, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, request_id: 'otra', ord: 1 }) }) }), /no coincide/);
  });
  await test('Apps Script reserva primera fila disponible, conserva B y reintenta sin duplicar', () => {
    const rows = [['12/11/2026', 1, 'ocupada', '', ''], ['', 2, '', '', ''], ['', 3, '', '', '']];
    const notes = [[''], [''], ['']]; let writes = 0, held = false;
    const sheet = { getLastRow: () => 4, getSheetId: () => 42, getRange: () => ({ getValues: () => rows, getNotes: () => notes }) };
    const context = { PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SIGEX_TOKEN' ? 'a'.repeat(32) : 'book' }) },
      SpreadsheetApp: { openById: () => ({ getName: () => 'Libro', getId: () => 'book', getSheetByName: () => sheet }) },
      LockService: { getScriptLock: () => ({ waitLock: () => { assert(!held); held = true; }, hasLock: () => held, releaseLock: () => { held = false; } }) },
      ScriptApp: { getOAuthToken: () => 'oauth' },
      UrlFetchApp: { fetch: (_, options) => { assert(held); writes++; const batch = JSON.parse(options.payload).requests; const at = batch[0].updateCells.range.startRowIndex - 1; rows[at][0] = batch[0].updateCells.rows[0].values[0].userEnteredValue.numberValue; notes[at][0] = batch[0].updateCells.rows[0].values[0].note; return { getResponseCode: () => 200 }; } },
      ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => text }) } };
    vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, '../integrations/google-sheets/Code.gs'), 'utf8'), context);
    const payload = { action: 'reserve', token: 'a'.repeat(32), request_id: randomUUID(), date: '2026-11-18', rol: '1-26', matter: 'Ejemplo' };
    const call = p => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(p) } }));
    assert.equal(call(payload).ord, '2'); assert.equal(call(payload).ord, '2'); assert.equal(writes, 1);
    assert.equal(call({ ...payload, request_id: randomUUID() }).ord, '3'); assert.equal(rows[1][1], 2); assert.equal(held, false);
    assert.equal(call({ ...payload, token: 'mala' }).ok, false);
  });
  console.log('\n' + count + ' pruebas de circuito OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
