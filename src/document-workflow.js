'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const L = require('./logic');
const { MODELS, buildDocument, makeDocx } = require('./exhorto-documents');

function documentDefaults(c, model, today) {
  const licenseMissing = c.license_retained === 'yes' && !c.license_received_date;
  return {
    model, date: today, address: c.offender_address || '', origin: c.origin_rol || '',
    folio: c.request_folio || '', received: c.receipt_date || '', dispatch: c.letter_sent_date || '',
    amount: c.payment_amount || '', bank: c.payment_bank || '', platform: c.payment_platform || '',
    serial: c.payment_serial || '', method: L.needsPayment(c.resolution) ? c.payment_method || '' : 'none',
    municipality: model === 'x06' ? c.license_municipality || '' : c.payment_municipality || c.court_commune || '',
    licenseClass: c.license_class || '', licenseNumber: c.license_number || '',
    granted: c.license_issued_date || '', control: c.license_control_date || '',
    expires: c.provisional_expires_date && c.provisional_expires_date >= today ? c.provisional_expires_date : L.addDays(today, 30),
    requested: licenseMissing ? c.sentence_date ? 'licencia' : 'ambas' : 'sentencia'
  };
}
function recommendedModels(c, stage) {
  if (stage === 'solicitud') return c.license_retained === 'yes' ? ['x03con', 'x06'] : ['x03sin'];
  if (stage === 'pago') return c.payment_method ? ['x26' + c.payment_method, 'x05' + c.payment_method] : [];
  if (stage === 'archivo') return [c.license_retained !== 'yes' && !c.license_received_date && !c.license_delivered_date ? 'x09sinLicencia' : c.suspension_days ? 'x09conSuspension' : 'x09sinSuspension'];
  if (stage === 'devolucion') return ['x30', c.license_received_date && !c.license_delivered_date ? 'devolverLicencia' : 'x31'];
  if (stage === 'recurso') return ['x10', 'x11'];
  if (stage === 'reiteracion') return [c.license_retained === 'yes' && !c.license_received_date ? 'x08' : 'reiterar', 'x32'];
  return [];
}
function saveDocumentData(service, id, input) {
  const model = MODELS[input.model];
  if (!model) throw new Error('Modelo desconocido.');
  const mapping = { address: 'offender_address', origin: 'origin_rol', folio: 'request_folio' };
  if (model.stage === 'pago' || model.stage === 'archivo') Object.assign(mapping, { amount: 'payment_amount', bank: 'payment_bank', serial: 'payment_serial', platform: 'payment_platform' });
  if (model.stage === 'pago') mapping.municipality = 'payment_municipality';
  if (input.model === 'x06') Object.assign(mapping, { licenseClass: 'license_class', licenseNumber: 'license_number', municipality: 'license_municipality', granted: 'license_issued_date', control: 'license_control_date' });
  const patch = {};
  for (const [source, target] of Object.entries(mapping)) if (input[source] !== undefined && input[source] !== '') patch[target] = input[source];
  if (model.stage === 'pago') patch.payment_method = input.model.slice(3);
  if (model.stage === 'archivo' && input.method && input.method !== 'none') patch.payment_method = input.method;
  return service.updateCase(id, patch);
}

// La misma operación se usa desde Electron y desde las pruebas, incluidos los reintentos.
function createDocumentWorkflow({ service, templateDir, outputDir, signers, reserveOrd, openFile = async () => '' }) {
  const running = new Map();
  const templatePath = model => {
    if (!Object.hasOwn(MODELS, model)) throw new Error('Modelo desconocido.');
    return path.join(templateDir, model + '.docx');
  };
  function prepare(id, input, preview = false) {
    const c = service.getCase(id);
    const model = MODELS[input.model];
    if (!model) throw new Error('Modelo desconocido.');
    if (model.stage === 'archivo' && !c.final_status && !c.closure.can_archive) throw new Error('Antes de preparar el archivo: ' + c.closure.archive_pending.join('; ') + '.');
    const filled = { ...documentDefaults(c, input.model, service.meta().today), ...input };
    filled.date ||= service.meta().today;
    if (preview && model.matter && !filled.ord) filled.ord = '(se asignará al emitir)';
    const signature = input.signer_snapshot || signers(filled.date);
    const lines = buildDocument(input.case_snapshot || c, { ...filled, ...signature }, input.home_snapshot || service.getSettings().home_court_name);
    return { c, filled, signature, lines };
  }
  async function exportDocument(id, input) {
    const request = input.request_id || randomUUID();
    if (running.has(request)) return running.get(request);
    const work = (async () => {
      let d;
      try {
        const draft = prepare(id, input, true);
        // Valida el DOCX y la carpeta antes de reservar un número externo.
        const custom = fs.existsSync(templatePath(input.model)) ? fs.readFileSync(templatePath(input.model)) : null;
        let usedDefaultTemplate = false, chosen = custom;
        try { makeDocx(draft.lines, draft.filled, draft.c, custom); }
        catch (e) {
          if (!custom || e.code !== 'SIGEX_TEMPLATE_MARKERS') throw e;
          chosen = null; usedDefaultTemplate = true;
          makeDocx(draft.lines, draft.filled, draft.c);
        }
        const root = service.getSettings().documents_output_dir || outputDir;
        const folder = path.join(root, 'Rol ' + String(draft.c.rol).replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/, ''));
        fs.mkdirSync(folder, { recursive: true });
        fs.accessSync(folder, fs.constants.W_OK);
        d = service.beginGeneratedDocument(id, { request_id: request, model: input.model, title: MODELS[input.model].title,
          input: { ...draft.filled, ord: input.ord || '', signer_snapshot: draft.signature,
            case_snapshot: Object.fromEntries(['rol', 'court_name', 'offender_name', 'offender_rut', 'receipt_date'].map(k => [k, draft.c[k]])),
            home_snapshot: service.getSettings().home_court_name } });
        if (d.state !== 'preparing') {
          const err = await openFile(service.generatedDocumentPath(d.id));
          return { document: d, usedDefaultTemplate, openError: err || null };
        }
        const snapshot = JSON.parse(d.input_json);
        let ord = d.ord;
        if (MODELS[d.model].matter && !ord) {
          ord = await reserveOrd({ request_id: d.request_id, date: d.document_date, rol: draft.c.rol,
            matter: MODELS[d.model].matter, detail: draft.c.court_name + (snapshot.origin ? ' · Rol origen ' + snapshot.origin : '') });
          service.setGeneratedOrd(d.id, ord);
        }
        const finalInput = { ...snapshot, ord: ord || snapshot.ord };
        const final = prepare(id, finalInput);
        const bytes = makeDocx(final.lines, final.filled, finalInput.case_snapshot || final.c, chosen);
        const name = [d.model.toUpperCase(), draft.c.rol, d.document_date, ord ? 'ORD ' + ord : '', 'v' + d.version, d.request_id.slice(0, 8)].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]/g, '_') + '.docx';
        const file = path.join(folder, name);
        const temp = file + '.tmp';
        fs.writeFileSync(temp, bytes);
        fs.renameSync(temp, file);
        d = service.finishGeneratedDocument(d.id, file);
        saveDocumentData(service, id, finalInput);
        if (d.model === 'x06') service.updateCase(id, { provisional_issued_date: finalInput.date, provisional_expires_date: finalInput.expires || null });
        const openError = await openFile(file);
        return { document: d, usedDefaultTemplate, openError: openError || null };
      } catch (e) {
        if (d && d.state === 'preparing') service.failGeneratedDocument(d.id, e.message);
        throw e;
      }
    })();
    running.set(request, work);
    try { return await work; } finally { running.delete(request); }
  }
  return {
    documentPlan: (id, stage) => {
      const c = service.getCase(id);
      return { models: MODELS, recommended: recommendedModels(c, stage), defaults: Object.fromEntries(Object.keys(MODELS).map(k => [k, documentDefaults(c, k, service.meta().today)])), automatic_ord: !!service.getSettings().ord_endpoint };
    },
    previewExhortoDocument: (id, input) => prepare(id, input, true).lines,
    exportExhortoDocument: exportDocument,
    retryGeneratedDocument: id => { const d = service.getGeneratedDocument(id); return exportDocument(d.case_id, { ...JSON.parse(d.input_json), request_id: d.request_id }); },
    saveDocumentData: (id, input) => saveDocumentData(service, id, input),
    validateDocumentTemplate: model => {
      const c = { rol: '1234-26', court_name: 'Juzgado de Policía Local de Ejemplo', court_commune: 'Ejemplo', offender_name: 'Persona de Ejemplo', offender_rut: '11111111-1', license_retained: 'no', receipt_date: '2026-11-18' };
      const input = { ...documentDefaults(c, model, '2026-11-18'), model, address: 'Domicilio de ejemplo', origin: '5678-26', folio: '1', ord: 'EJEMPLO', amount: 10000, bank: 'Banco de ejemplo', serial: '123', platform: 'Plataforma municipal de ejemplo', method: 'web', received: '2026-11-18', dispatch: '2026-10-01', licenseClass: 'B', licenseNumber: 'XXXX', municipality: 'Ejemplo', judge: 'Juez de Ejemplo', judgeRole: 'Juez titular', secretary: 'Secretaría de Ejemplo', secretaryRole: 'Secretaria titular' };
      const file = templatePath(model);
      makeDocx(buildDocument(c, input, 'Segundo Juzgado de Policía Local de Valdivia'), input, c, fs.existsSync(file) ? fs.readFileSync(file) : null);
      return { ok: true, custom: fs.existsSync(file) };
    }
  };
}
module.exports = { createDocumentWorkflow, documentDefaults, recommendedModels, saveDocumentData };
