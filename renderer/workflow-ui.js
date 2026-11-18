'use strict';

function paymentFields() {
  return [
    { name: 'payment_method', label: 'Medio de pago', type: 'select', required: true, options: [['', 'Selecciona el medio'], ['vale', 'Vale vista'], ['transfer', 'Transferencia'], ['web', 'Plataforma municipal']] },
    { name: 'payment_amount', label: 'Monto en pesos', type: 'number', min: 1, step: 1, required: true },
    { name: 'payment_bank', label: 'Banco', required: true, when: { field: 'payment_method', values: ['vale', 'transfer'] } },
    { name: 'payment_serial', label: 'Serie del vale vista', required: true, when: { field: 'payment_method', values: ['vale'] } },
    { name: 'payment_platform', label: 'Plataforma municipal', required: true, when: { field: 'payment_method', values: ['web'] } },
    { name: 'payment_municipality', label: 'Municipalidad destinataria del pago', when: { field: 'payment_method', values: ['vale', 'transfer'] } }
  ];
}

async function paymentDispatchModal(c) {
  const ok = await formModal({ title: 'Comprobante remitido al tribunal', intro: 'Registra la fecha del despacho efectivo del comprobante.',
    fields: [{ name: 'date', label: 'Fecha del despacho', type: 'date', required: true }], values: { date: c.payment_remitted_date || state.meta.today },
    onSubmit: v => rpc('registerPaymentDispatch', c.id, v) });
  if (ok) { toast('Despacho del comprobante registrado', 'ok'); await refresh(); }
}

async function licenseMovementModal(c, action) {
  const labels = { recibir: 'Recibir licencia original', entregar: 'Entregar licencia al titular', devolver: 'Devolver licencia al tribunal' };
  const ok = await formModal({ title: labels[action],
    intro: action === 'entregar' ? 'Registra la entrega efectiva del original. La constancia y el timbre se mantienen en la causa física.' : 'Registra el movimiento efectivo de la licencia original.',
    fields: [{ name: 'date', label: 'Fecha', type: 'date', required: true }], values: { date: state.meta.today },
    onSubmit: v => rpc('registerLicenseMovement', c.id, { action, ...v }) });
  if (ok) { toast('Movimiento de licencia registrado', 'ok'); await refresh(); }
}

async function appealModal(c, action) {
  const labels = { presentar: 'Registrar reconsideración', remitir: 'Recurso remitido al tribunal', resolver: 'Respuesta al recurso recibida', notificar: 'Resolución del recurso notificada' };
  const fields = [{ name: 'date', label: { presentar: 'Fecha de presentación', remitir: 'Fecha de despacho', resolver: 'Fecha de recepción de la respuesta', notificar: 'Fecha de notificación a la persona' }[action], type: 'date', required: true }];
  if (action === 'resolver') fields.push(
    { name: 'resolution', label: 'Resultado y medios de pago admitidos', type: 'checks', options: state.meta.resolution_types, required: true, full: true },
    { name: 'suspension_days', label: 'Días de suspensión según la respuesta', type: 'number', min: 1, step: 1, hint: 'Déjalo vacío si ya no hay suspensión.' });
  if (action === 'presentar' || action === 'resolver') fields.push({ name: 'file', label: action === 'presentar' ? 'Escrito del recurso' : 'Resolución del recurso', type: 'file', full: true, scanName: 'Reconsideración Rol ' + c.rol });
  fields.push({ name: 'note', label: 'Observación', type: 'textarea', full: true });
  if (action === 'presentar') fields.push({ name: 'next_action', label: 'Al guardar', type: 'select', options: [['preparar', 'Preparar X10 y X11'], ['guardar', 'Solo registrar el recurso']], full: true });
  let prepare = false;
  const ok = await formModal({ title: labels[action], wide: true, draftKey: 'recurso-' + c.id + '-' + action,
    intro: action === 'presentar' ? 'Se detienen los plazos de pago y devolución hasta notificar la respuesta.' : action === 'notificar' ? 'Si queda multa pendiente, el plazo de 30 días corridos comienza de nuevo desde esta notificación.' : '',
    fields, values: { date: state.meta.today, resolution: c.resolution_list, suspension_days: c.suspension_days || '' },
    onSubmit: async v => {
      const { file, next_action, ...data } = v;
      await rpc('registerAppeal', c.id, { action, ...data });
      if (file) await rpc('attachPaths', c.id, action === 'resolver' ? 'sentencia' : 'otro', [file]);
      prepare = next_action === 'preparar';
    } });
  if (ok) {
    toast('Reconsideración actualizada', 'ok'); await refresh();
    if (prepare) await prepareStageDocuments(await rpc('getCase', c.id), 'recurso');
  }
}

function licenseCard(c, act) {
  const info = c.license;
  return h('section', { class: 'card' }, h('h3', null, 'Licencia original y permiso'),
    h('p', null, h('strong', { class: info.state === 'retiro' ? 'text-ok' : '' }, info.label), info.date ? ' · ' + fmtDate(info.date) : ''),
    h('dl', { class: 'kv' },
      h('dt', null, 'Clase / municipalidad'), h('dd', null, [c.license_class, c.license_municipality].filter(Boolean).join(' · ') || '—'),
      h('dt', null, 'Permiso emitido'), h('dd', null, fmtDate(c.provisional_issued_date)),
      h('dt', null, 'Permiso válido hasta'), h('dd', null, fmtDate(c.provisional_expires_date))),
    !c.final_status ? h('div', { class: 'row', style: 'flex-wrap:wrap;margin-top:12px' },
      info.state === 'pendiente' ? act('Recibir original', () => licenseMovementModal(c, 'recibir')) : null,
      info.state === 'retiro' ? act('Registrar entrega al titular', () => licenseMovementModal(c, 'entregar'), true) : null,
      ['custodia', 'retiro'].includes(info.state) ? act('Registrar devolución al tribunal', () => licenseMovementModal(c, 'devolver')) : null,
      act('Editar datos de licencia', () => editCaseModal(c))) : null);
}

function appealCard(c, act) {
  if (!c.sentence_date) return null;
  const labels = { presentado: 'Presentado · pendiente de remisión', remitido: 'Remitido · esperando respuesta', resuelto: 'Respuesta recibida · falta notificar', notificado: 'Respuesta notificada' };
  return h('section', { class: 'card' }, h('h3', null, 'Reconsideración'),
    h('p', null, c.appeal_state ? labels[c.appeal_state] : 'Sin recurso registrado.'),
    c.appeal_paused ? h('p', { class: 'note-box' }, 'Plazos de pago y devolución detenidos.') : null,
    c.appeal_notification_date ? h('p', { class: 'muted' }, 'Notificada el ' + fmtDate(c.appeal_notification_date) + (c.payment_due ? ' · Nuevo vencimiento: ' + fmtDate(c.payment_due) : '')) : null,
    c.final_status ? null : h('div', { class: 'row', style: 'flex-wrap:wrap' },
      !c.appeal_state || c.appeal_state === 'notificado' ? act('Registrar reconsideración', () => appealModal(c, 'presentar')) : null,
      c.appeal_state === 'presentado' ? act('Preparar X10 y X11', () => prepareStageDocuments(c, 'recurso')) : null,
      c.appeal_state === 'presentado' ? act('Registrar remisión', () => appealModal(c, 'remitir'), true) : null,
      ['presentado', 'remitido'].includes(c.appeal_state) ? act('Recibir respuesta', () => appealModal(c, 'resolver'), c.appeal_state === 'remitido') : null,
      c.appeal_state === 'resuelto' ? act('Notificar por correo', () => notifyModal(c, { appeal: true }), true) : null,
      c.appeal_state === 'resuelto' ? act('Registrar notificación', () => appealModal(c, 'notificar')) : null));
}

function nextActionCard(c, act) {
  if (c.final_status) return null;
  const tasks = c.alerts.filter(a => a.kind === 'accion');
  const first = tasks[0];
  let action;
  if (first) {
    if (first.code === 'enviar_carta') action = () => letterModal(c);
    if (first.code === 'notificar') action = () => notifyModal(c);
    if (first.code === 'segundo_aviso') action = () => notifyModal(c, { resend: true });
    if (first.code === 'remitir_pago') action = () => prepareStageDocuments(c, 'pago');
    if (first.code === 'retirar_licencia') action = () => licenseMovementModal(c, 'entregar');
    if (['archivar', 'cerrar'].includes(first.code)) action = () => closeModal(c);
    if (first.code === 'recurso_presentado') action = () => appealModal(c, 'remitir');
    if (first.code === 'recurso_resuelto') action = () => notifyModal(c, { appeal: true });
  }
  return h('section', { class: 'card next-action' }, h('div', null, h('h3', null, 'Próxima diligencia'),
    h('p', null, first?.title || (c.appeal_paused ? 'Esperando respuesta al recurso' : c.payment_due ? 'Esperar pago hasta el ' + fmtDate(c.payment_due) : c.closure.archive_pending[0] || 'Revisar pendientes')),
    tasks.length > 1 ? h('div', { class: 'sub' }, tasks.slice(1).map(a => a.title).join(' · ')) : null),
    action ? act('Continuar trámite', action, true) : null);
}

function generatedDocumentsCard(c, act) {
  const status = { preparing: 'Emisión pendiente', generated: 'Pendiente de firma', signed: 'Firmado', dispatched: 'Despachado' };
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Word generados'), act('Abrir carpeta', () => rpc('openCaseFolder', c.id))),
    c.generated_documents.length ? c.generated_documents.map(d => h('div', { class: 'doc' },
      h('div', null, h('div', { class: 'doc-name' }, d.title),
        h('div', { class: 'sub' }, fmtDate(d.document_date) + ' · v' + d.version + (d.ord ? ' · ORD. ' + d.ord : '') + ' · ' + status[d.state]),
        d.error_message ? h('div', { class: 'form-error' }, d.error_message) : null),
      h('div', { class: 'row', style: 'flex-wrap:wrap' },
        d.state === 'preparing' ? act('Reintentar emisión', async () => { await rpc('retryGeneratedDocument', d.id); await refresh(); }) : act('Abrir / reimprimir', () => rpc('openGeneratedDocument', d.id)),
        d.state === 'generated' ? act('Registrar firma', () => generatedStateModal(d, 'signed')) : null,
        ['generated', 'signed'].includes(d.state) ? act('Registrar despacho', () => generatedStateModal(d, 'dispatched')) : null))) : h('p', { class: 'muted' }, 'Los documentos que emitas aparecerán aquí para abrirlos y reimprimirlos.'));
}

async function generatedStateModal(d, status) {
  const ok = await formModal({ title: status === 'signed' ? 'Firma del documento' : 'Despacho del documento', intro: d.title + (d.ord ? ' · ORD. ' + d.ord : ''),
    fields: [{ name: 'date', label: status === 'signed' ? 'Fecha de firma' : 'Fecha de despacho efectivo', type: 'date', required: true }], values: { date: state.meta.today },
    onSubmit: v => rpc('markGeneratedDocument', d.id, { state: status, ...v }) });
  if (ok) { toast('Estado del documento actualizado', 'ok'); await refresh(); }
}

function correspondenceSettingsCard(settings) {
  const endpoint = h('input', { type: 'url', value: settings.ord_endpoint || '', placeholder: 'https://script.google.com/macros/s/…/exec', 'aria-label': 'URL de conexión ORD.' });
  const token = h('input', { type: 'password', autocomplete: 'new-password', placeholder: settings.ord_secret ? 'Clave guardada; déjala vacía para conservarla' : 'Clave configurada en el script', 'aria-label': 'Clave de conexión ORD.' });
  return h('section', { class: 'card' }, h('h3', null, 'Libro de correspondencia · ORD.'),
    h('p', { class: 'muted' }, 'Conecta una vez la planilla compartida para reservar y registrar cada ORD. al emitir el oficio. Reimprimir conserva el número.'),
    h('div', { class: 'form-grid' }, h('div', { class: 'field full' }, h('label', null, 'URL de la conexión'), endpoint), h('div', { class: 'field full' }, h('label', null, 'Clave'), token)),
    h('div', { class: 'row', style: 'flex-wrap:wrap;margin-top:12px' },
      h('button', { class: 'btn primary', onclick: () => run(async () => { await rpc('saveOrdConnection', { endpoint: endpoint.value.trim(), token: token.value }); token.value = ''; toast('Conexión guardada', 'ok'); await loadSettings(); }) }, 'Guardar conexión'),
      h('button', { class: 'btn', onclick: () => run(async () => { const r = await rpc('testOrdConnection'); toast('Conectado a ' + r.name + '. No se reservó ningún número.', 'ok'); }) }, 'Probar conexión'),
      h('button', { class: 'btn', onclick: () => run(() => rpc('openCorrespondenceSheet')) }, 'Abrir planilla'),
      h('button', { class: 'btn', onclick: () => run(() => rpc('openOrdInstructions')) }, 'Instrucciones y código de conexión')));
}
