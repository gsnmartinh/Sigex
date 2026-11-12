'use strict';
/* SIGEX 2 · interfaz. Todo el contenido dinámico se arma con nodos DOM (nunca innerHTML) para no interpretar datos como HTML. */

// No se puede llamar "api": Electron ya reserva window.api para el puente del preload.
const rpc = (name, ...args) => window.api.call(name, ...args);
const state = { view: 'panel', caseId: null, meta: null, settings: null, courts: [], filters: { q: '', stage: 'abiertos', sort: 'recientes' }, courtQ: '' };

// ---------- utilidades ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (s, el = document) => el.querySelector(s);
function add(el, ...kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}
function plural(n, one, many) { return `${n} ${Math.abs(n) === 1 ? one : many}`; }
function daysText(left) {
  if (left === null || left === undefined) return '';
  if (left < 0) return `vencido hace ${plural(-left, 'día', 'días')}`;
  if (left === 0) return 'vence hoy';
  return `vence en ${plural(left, 'día', 'días')}`;
}
function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3800);
}
async function run(fn) {
  try { return await fn(); } catch (e) { toast(e.message || String(e), 'err'); return undefined; }
}
function communeFromName(name) {
  const m = String(name || '').match(/Juzgado de Polic[ií]a Local de\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
const tagClass = sev => (sev === 'vencido' ? 'bad' : sev === 'proximo' ? 'warn' : 'info');
const STAGE_TAG = { ingresado: 'gray', carta: 'warn', sentencia: 'info', notificado: 'info', comprobante: 'ok', devuelto: 'gray', archivado: 'gray', anulado: 'gray' };

// ---------- modales ----------
function openDialog(content, { wide = false } = {}) {
  const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}` }, h('div', { class: 'modal-in' }, content));
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return dlg;
}

function confirmBox(message, okLabel = 'Aceptar', { danger = false } = {}) {
  return new Promise(resolve => {
    let result = false;
    const dlg = openDialog([
      h('h3', null, 'Confirmar'),
      h('p', { style: 'margin:0;line-height:1.5' }, message),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancelar'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', id: 'confirm-ok', onclick: () => { result = true; dlg.close(); } }, okLabel))
    ]);
    dlg.addEventListener('close', () => resolve(result));
  });
}

// Escaneo: abre el escáner hoja por hoja y devuelve la ruta del PDF armado (o null si se cancela).
function scanModal(name) {
  return new Promise(resolve => {
    let result = null;
    const thumbs = h('div', { class: 'thumbs' });
    const info = h('div', { class: 'muted small' }, 'Coloca las hojas en el escáner, elige el origen y presiona "Escanear".');
    const err = h('div', { class: 'form-error', role: 'alert' });
    const btnScan = h('button', { type: 'button', class: 'btn primary', id: 'scan-page' }, 'Escanear');
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('sigex-scan') || '{}'); } catch (_) { /* sin almacenamiento */ }
    const source = h('select', { id: 'scan-source', 'aria-label': 'Origen del escaneo' },
      [['feeder', 'Alimentador automático (todas las hojas puestas)'], ['flatbed', 'Una hoja con la ventana del escáner']].map(([v, l]) => h('option', { value: v, selected: v === (saved.source || 'feeder') }, l)));
    const duplex = h('input', { type: 'checkbox', id: 'scan-duplex', checked: !!saved.duplex });
    const duplexLbl = h('label', { class: 'row', style: 'gap:6px' }, duplex, 'Ambas caras');
    const syncSource = () => { duplexLbl.style.display = source.value === 'feeder' ? '' : 'none'; };
    source.addEventListener('change', syncSource); syncSource();
    const remember = () => { try { localStorage.setItem('sigex-scan', JSON.stringify({ source: source.value, duplex: duplex.checked })); } catch (_) { /* ignorar */ } };
    const btnSave = h('button', { type: 'button', class: 'btn primary', id: 'scan-save', disabled: true }, 'Guardar documento');
    let count = 0;
    const show = r => {
      count = r.count;
      const n = r.previews.length;
      const edit = fn => run(async () => show(await fn()));
      thumbs.replaceChildren(...r.previews.map((src, i) => h('figure', { class: 'thumb' },
        h('img', { src, alt: `Hoja ${i + 1}` }),
        h('figcaption', null, `Hoja ${i + 1}`),
        h('div', { class: 'thumb-actions' },
          h('button', { type: 'button', class: 'btn sm', title: 'Mover a la izquierda', 'aria-label': `Mover hoja ${i + 1} a la izquierda`, disabled: i === 0, onclick: () => edit(() => rpc('scanMove', i, i - 1)) }, '←'),
          h('button', { type: 'button', class: 'btn sm danger', title: 'Borrar esta hoja', 'aria-label': `Borrar hoja ${i + 1}`, onclick: () => edit(() => rpc('scanRemoveAt', i)) }, 'Borrar'),
          h('button', { type: 'button', class: 'btn sm', title: 'Mover a la derecha', 'aria-label': `Mover hoja ${i + 1} a la derecha`, disabled: i === n - 1, onclick: () => edit(() => rpc('scanMove', i, i + 1)) }, '→')))));
      btnScan.textContent = count ? 'Escanear más hojas' : 'Escanear';
      btnSave.disabled = !count;
      info.textContent = count ? `${plural(count, 'hoja escaneada', 'hojas escaneadas')}. Puedes reordenarlas o borrar una, escanear otra o guardar el documento.` : 'Coloca las hojas en el escáner, elige el origen y presiona "Escanear".';
    };
    const busy = on => { btnScan.disabled = on; if (on) { btnSave.disabled = true; info.textContent = 'Escaneando… sigue las instrucciones de la ventana del escáner.'; } };
    btnScan.addEventListener('click', async () => {
      err.textContent = ''; busy(true);
      try { remember(); show(await rpc('scanPage', { source: source.value, duplex: duplex.checked })); } catch (e) { err.textContent = e.message || String(e); show({ count, previews: [...thumbs.querySelectorAll('img')].map(i => i.src) }); }
      btnScan.disabled = false;
    });
    btnSave.addEventListener('click', async () => {
      err.textContent = '';
      try { const r = await rpc('scanFinish', name); result = r.path; dlg.close(); } catch (e) { err.textContent = e.message || String(e); }
    });
    const dlg = openDialog([
      h('h3', null, 'Escanear documento'),
      h('div', { class: 'row', style: 'gap:14px;flex-wrap:wrap;margin-bottom:8px' }, source, duplexLbl),
      info, thumbs, err,
      h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancelar'), btnScan, btnSave)
    ], { wide: true });
    dlg.addEventListener('close', () => { if (!result) rpc('scanCancel').catch(() => {}); resolve(result); });
  });
}

// fields: {name,label,type,options,required,hint,full,placeholder,min,max,section}
function formModal({ title, intro, fields, values = {}, submitLabel = 'Guardar', wide = false, onSubmit }) {
  return new Promise(resolve => {
    const controls = {};
    const form = h('form', { class: 'form-grid', novalidate: true });
    const listId = `dl-${Math.random().toString(36).slice(2)}`;

    for (const f of fields) {
      if (f.section) { form.append(h('div', { class: 'section-title' }, f.section)); continue; }
      if (f.note) { form.append(h('div', { class: 'note-box' }, f.note)); continue; }
      const id = `f-${f.name}`;
      let control;
      const val = values[f.name];
      if (f.type === 'textarea') control = h('textarea', { id, rows: f.rows || 3, placeholder: f.placeholder }, val ?? '');
      else if (f.type === 'select') {
        control = h('select', { id }, (f.options || []).map(o => {
          const [v, l] = Array.isArray(o) ? o : [o, o];
          return h('option', { value: v, selected: String(val ?? '') === String(v) }, l);
        }));
      } else if (f.type === 'checks') {
        const chosen = new Set(val || []);
        control = h('div', { class: 'checks', id });
        for (const o of f.options) {
          const [v, l] = Array.isArray(o) ? o : [o, o];
          control.append(h('label', null, h('input', { type: 'checkbox', value: v, checked: chosen.has(v) }), l));
        }
      } else if (f.type === 'file') {
        const label = h('span', { class: 'muted small' }, 'Ningún archivo seleccionado');
        control = h('div', { class: 'row', id });
        control._path = null;
        control.append(
          h('button', { type: 'button', class: 'btn sm', onclick: async () => {
            const p = await run(() => rpc('pickFilePath'));
            if (p) { control._path = p; label.textContent = p.split(/[\\/]/).pop(); }
          } }, 'Elegir archivo…'),
          h('button', { type: 'button', class: 'btn sm', onclick: async () => {
            const p = await scanModal(f.scanName || 'Escaneo');
            if (p) { control._path = p; label.textContent = p.split(/[\\/]/).pop(); }
          } }, 'Escanear…'), label);
      } else if (f.type === 'court') {
        control = h('input', { id, type: 'text', list: listId, value: val ?? '', placeholder: 'Escribe para buscar en el directorio…', autocomplete: 'off' });
      } else {
        control = h('input', { id, type: f.type || 'text', value: val ?? '', placeholder: f.placeholder, min: f.min, max: f.max, step: f.step, inputmode: f.inputmode });
      }
      controls[f.name] = { el: control, def: f };
      form.append(h('div', { class: `field${f.full ? ' full' : ''}` },
        f.type === 'checks' || f.type === 'file' ? h('span', { class: 'lbl' }, f.label + (f.required ? ' *' : '')) : h('label', { for: id }, f.label + (f.required ? ' *' : '')),
        control, f.hint ? h('span', { class: 'hint' }, f.hint) : null));
    }
    if (fields.some(f => f.type === 'court')) {
      form.append(h('datalist', { id: listId }, state.courts.map(c => h('option', { value: c.name }))));
    }

    const err = h('div', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, submitLabel);
    form.append(err, h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancelar'), submit));

    const collect = () => {
      const out = {};
      for (const [name, { el, def }] of Object.entries(controls)) {
        if (def.type === 'checks') out[name] = [...el.querySelectorAll('input:checked')].map(i => i.value);
        else if (def.type === 'file') out[name] = el._path;
        else out[name] = typeof el.value === 'string' ? el.value.trim() : el.value;
      }
      return out;
    };

    let result = null;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      err.textContent = '';
      const vals = collect();
      for (const [name, { def }] of Object.entries(controls)) {
        if (def.required && (vals[name] === '' || vals[name] === null || vals[name] === undefined)) {
          err.textContent = `Falta completar: ${def.label}.`;
          controls[name].el.focus?.();
          return;
        }
      }
      submit.disabled = true;
      try {
        result = (await onSubmit(vals)) ?? true;
        dlg.close();
      } catch (ex) {
        err.textContent = ex.message || String(ex);
        submit.disabled = false;
      }
    });

    const dlg = openDialog([h('h3', null, title), intro ? h('p', { class: 'muted', style: 'margin:0' }, intro) : null, form], { wide });
    dlg.addEventListener('close', () => resolve(result));
    const first = form.querySelector('input:not([type=checkbox]), select, textarea');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

// ---------- datos compartidos ----------
async function loadCourts() { state.courts = await rpc('listCourts'); }
async function loadSettings() { state.settings = await rpc('getSettings'); renderSidebarFoot(); }
function renderSidebarFoot() {
  const el = $('#home-court');
  el.replaceChildren(h('div', null, state.settings?.home_court_name || ''), h('div', null, `Hoy: ${fmtDate(state.meta?.today)}`));
}

async function courtIdFromName(name) {
  const clean = String(name || '').trim();
  const found = state.courts.find(c => c.name.toLowerCase() === clean.toLowerCase());
  if (found) return found.id;
  const ok = await confirmBox(`"${clean}" no está en el directorio de juzgados. ¿Quieres crearlo ahora?`, 'Crear juzgado');
  if (!ok) throw new Error('Elige un juzgado del directorio o permite crearlo.');
  const r = await rpc('createCourt', { name: clean, commune: communeFromName(clean) });
  await loadCourts();
  return r.id;
}

// ---------- navegación ----------
function setNav(view) {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}
async function go(view, param) {
  state.view = view;
  state.caseId = view === 'case' ? param : null;
  setNav(view === 'case' ? 'cases' : view);
  const main = $('#main');
  main.replaceChildren();
  await run(async () => {
    if (view === 'panel') await renderPanel(main);
    else if (view === 'cases') await renderCases(main);
    else if (view === 'case') await renderCase(main, param);
    else if (view === 'courts') await renderCourts(main);
    else if (view === 'settings') await renderSettings(main);
  });
  main.scrollTop = 0;
}
const refresh = () => go(state.view, state.caseId);

async function updateBadge() {
  const d = await rpc('dashboard');
  const badge = $('#nav-badge-panel');
  const n = d.counts.overdue;
  badge.textContent = n;
  badge.classList.toggle('hidden', !n);
  return d;
}

// ---------- Panel ----------
function alertRow(a) {
  return h('div', { class: `aitem${a.escalate ? ' escalate' : ''}`, role: 'button', tabindex: 0, onclick: () => go('case', a.case_id), onkeydown: e => { if (e.key === 'Enter') go('case', a.case_id); } },
    h('div', null,
      h('div', null, h('span', { class: 'arol' }, `Rol ${a.rol}`), ' · ', h('span', { class: 'atitle' }, a.title)),
      h('div', { class: 'ameta' }, [a.court_name, a.offender_name].filter(Boolean).join(' · '))),
    a.due_date
      ? h('div', { style: 'text-align:right' }, h('span', { class: `tag ${tagClass(a.severity)}` }, daysText(a.days_left)), h('div', { class: 'ameta' }, fmtDate(a.due_date)))
      : null);
}
function alertCard(title, items, emptyText, { limit = 8 } = {}) {
  const shown = items.slice(0, limit);
  return h('section', { class: 'card' },
    h('h3', null, title, h('span', { class: 'muted small' }, items.length ? String(items.length) : '')),
    items.length ? h('div', { class: 'alist' }, shown.map(alertRow), items.length > limit ? h('div', { class: 'ameta', style: 'padding-top:8px' }, `y ${items.length - limit} más…`) : null) : h('div', { class: 'empty' }, emptyText));
}

async function renderPanel(main) {
  const d = await updateBadge();
  await loadSettings();
  const kpi = (n, label, cls, filter) => h('button', { class: `kpi ${n === 0 ? 'zero' : cls}`, onclick: () => { state.filters = { q: '', stage: filter, sort: filter === 'con_alerta' ? 'plazo' : 'recientes' }; go('cases'); } }, h('strong', null, n), h('span', null, label));
  add(main,
    h('div', { class: 'page-head' }, h('div', null, h('h2', null, 'Panel'), h('p', null, `Hoy es ${fmtDate(d.today)} · ${plural(d.counts.open, 'exhorto abierto', 'exhortos abiertos')}`)),
      h('button', { class: 'btn', id: 'btn-reminders', onclick: () => reminderModal() }, 'Recordatorios de sentencia…')),
    h('div', { class: 'kpis' },
      kpi(d.counts.overdue, 'Plazos vencidos', 'bad', 'con_alerta'),
      kpi(d.counts.soon, 'Vencen en 7 días', 'warn', 'con_alerta'),
      kpi(d.counts.waiting, 'Esperando respuesta del juzgado', '', 'esperando_juzgado'),
      kpi(d.counts.notify, 'Sentencias por notificar', 'warn', 'sentencia'),
      kpi(d.counts.letter, 'Cartas por enviar', '', 'ingresado'),
      kpi(d.counts.suspensions, 'Suspensiones en curso', '', 'suspension'),
      kpi(d.counts.review, 'Por revisar (migrados)', '', 'revisar')),
    h('div', { class: 'cols' },
      alertCard('Plazos vencidos', d.overdue, 'No hay plazos vencidos.'),
      alertCard('Por vencer en 7 días', d.soon, 'Nada vence esta semana.'),
      alertCard('Esperando respuesta del juzgado', d.waiting, 'No hay causas esperando respuesta tras un recordatorio.'),
      alertCard('Acciones pendientes', d.actions, 'No hay acciones pendientes.'),
      alertCard('Suspensiones de licencia', d.suspensions, 'No hay suspensiones registradas.'),
      d.review.length ? alertCard('Exhortos por revisar', d.review, '') : null));
}

// ---------- Lista de exhortos ----------
const STAGE_FILTERS = [
  ['abiertos', 'Abiertos'], ['con_alerta', 'Con plazo vencido o por vencer'], ['ingresado', 'Falta enviar carta'], ['carta', 'Esperando sentencia'], ['esperando_juzgado', 'Recordatorio enviado: esperando respuesta del juzgado'],
  ['sentencia', 'Por notificar'], ['notificado', 'Esperando comprobante'], ['comprobante', 'Comprobante recibido'], ['suspension', 'Con suspensión en curso'],
  ['revisar', 'Por revisar (migrados)'], ['cerrados', 'Cerrados'], ['', 'Todos']
];

async function renderCases(main) {
  const f = state.filters;
  const q = h('input', { type: 'search', placeholder: 'Buscar por rol, infractor, RUT o juzgado…', value: f.q, 'aria-label': 'Buscar' });
  const stage = h('select', { 'aria-label': 'Filtrar por etapa' }, STAGE_FILTERS.map(([v, l]) => h('option', { value: v, selected: f.stage === v }, l)));
  const sort = h('select', { 'aria-label': 'Ordenar' }, [['recientes', 'Más recientes primero'], ['plazo', 'Plazo más próximo primero']].map(([v, l]) => h('option', { value: v, selected: f.sort === v }, l)));
  const body = h('div');
  const load = async () => {
    state.filters = { q: q.value, stage: stage.value, sort: sort.value };
    const rows = await run(() => rpc('listCases', state.filters));
    if (!rows) return;
    body.replaceChildren(
      h('p', { class: 'count-line' }, plural(rows.length, 'exhorto', 'exhortos')),
      rows.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Rol', 'Juzgado remitente', 'Infractor', 'Etapa', 'Próximo plazo', 'Licencia'].map(t => h('th', null, t)))),
        h('tbody', null, rows.map(r => {
          const s = r.suspension;
          return h('tr', { class: 'click', tabindex: 0, onclick: () => go('case', r.id), onkeydown: e => { if (e.key === 'Enter') go('case', r.id); } },
            h('td', { class: 'nowrap' }, h('strong', null, r.rol), h('div', { class: 'sub' }, `Ingreso ${fmtDate(r.entry_date)}`)),
            h('td', null, r.court_name),
            h('td', null, r.offender_name || h('span', { class: 'muted' }, 'Sin nombre'), r.offender_email ? null : h('div', { class: 'sub' }, 'sin correo')),
            h('td', null, h('span', { class: `tag ${STAGE_TAG[r.stage]}` }, r.stage_label.split(' · ')[0]), r.needs_review ? h('div', null, h('span', { class: 'tag warn', style: 'margin-top:4px' }, 'Revisar fechas')) : null),
            h('td', { class: 'nowrap' }, r.next_deadline ? [h('span', { class: `tag ${tagClass(r.deadline_severity)}` }, daysText(r.alerts.find(a => a.kind === 'plazo').days_left)), h('div', { class: 'sub' }, fmtDate(r.next_deadline))] : h('span', { class: 'muted' }, '—')),
            h('td', { class: 'nowrap' }, !s ? h('span', { class: 'muted' }, '—') : s.state === 'vigente' ? h('span', { class: 'tag info' }, `Día ${s.elapsed}/${s.days}`) : s.state === 'sin_permiso' ? h('span', { class: 'tag warn' }, 'Falta permiso') : s.state === 'cumplida' ? h('span', { class: 'tag gray' }, 'Cumplida') : h('span', { class: 'tag gray' }, 'Por iniciar')));
        })))) : h('div', { class: 'card empty' }, 'No hay exhortos con estos filtros.'));
  };
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
  stage.addEventListener('change', load); sort.addEventListener('change', load);
  add(main,
    h('div', { class: 'page-head' }, h('div', null, h('h2', null, 'Exhortos')), h('div', { class: 'row' },
      h('button', { class: 'btn', id: 'btn-reminders', onclick: () => reminderModal() }, 'Recordatorios de sentencia…'),
      h('button', { class: 'btn primary', onclick: () => newCaseModal() }, '+ Nuevo exhorto'))),
    h('div', { class: 'toolbar' }, q, stage, sort), body);
  await load();
}

// ---------- Nuevo / editar exhorto ----------
const GENDER_OPTS = [['', 'Sin especificar'], ['M', 'Masculino'], ['F', 'Femenino']];

async function newCaseModal() {
  await loadCourts();
  let createdId = null;
  const ok = await formModal({
    title: 'Nuevo exhorto', submitLabel: 'Guardar exhorto',
    fields: [
      { name: 'rol', label: 'Rol del exhorto', required: true },
      { name: 'entry_date', label: 'Fecha de ingreso', type: 'date', required: true },
      { name: 'court', label: 'Juzgado remitente', type: 'court', required: true, full: true, hint: 'Juzgado que envía el exhorto. Si no existe en el directorio podrás crearlo.' },
      { name: 'offender_name', label: 'Nombre del infractor' },
      { name: 'offender_rut', label: 'RUT' },
      { name: 'offender_email', label: 'Correo del infractor', type: 'email' },
      { name: 'offender_phone', label: 'Teléfono' },
      { name: 'offender_gender', label: 'Género (para el saludo del correo)', type: 'select', options: GENDER_OPTS },
      { name: 'citation_number', label: 'N.º de boleta de citación' },
      { name: 'notes', label: 'Observaciones', type: 'textarea', full: true }
    ],
    values: { entry_date: state.meta.today },
    onSubmit: async v => {
      const court_id = await courtIdFromName(v.court);
      const { court, ...rest } = v;
      try {
        createdId = (await rpc('createCase', { ...rest, court_id })).id;
      } catch (e) {
        if (/Ya existe un exhorto/.test(e.message)) {
          const again = await confirmBox(`${e.message} ¿Guardar de todos modos?`, 'Guardar igual');
          if (!again) throw new Error('No se guardó el exhorto.');
          createdId = (await rpc('createCase', { ...rest, court_id, allow_duplicate: true })).id;
        } else throw e;
      }
    }
  });
  if (ok && createdId) { toast('Exhorto guardado', 'ok'); go('case', createdId); }
}

async function editCaseModal(c) {
  await loadCourts();
  const ok = await formModal({
    title: `Editar exhorto ${c.rol}`, wide: true, submitLabel: 'Guardar cambios',
    fields: [
      { name: 'rol', label: 'Rol', required: true },
      { name: 'entry_date', label: 'Fecha de ingreso', type: 'date', required: true },
      { name: 'court', label: 'Juzgado remitente', type: 'court', required: true, full: true },
      { name: 'offender_name', label: 'Nombre del infractor' },
      { name: 'offender_rut', label: 'RUT' },
      { name: 'offender_email', label: 'Correo del infractor', type: 'email' },
      { name: 'offender_phone', label: 'Teléfono' },
      { name: 'offender_gender', label: 'Género (saludo del correo)', type: 'select', options: GENDER_OPTS },
      { name: 'citation_number', label: 'N.º de boleta de citación' },
      { name: 'tracking_code', label: 'Código de seguimiento de Correos (carta)' },
      { name: 'notes', label: 'Observaciones', type: 'textarea', full: true },
      { section: 'Fechas y resolución (úsalo para corregir datos; las acciones de la ficha ya las registran)' },
      { name: 'letter_sent_date', label: 'Carta enviada al juzgado', type: 'date' },
      { name: 'sentence_date', label: 'Sentencia recibida', type: 'date' },
      { name: 'resolution', label: 'Forma de cumplimiento / resolución', type: 'checks', options: state.meta.resolution_types, full: true },
      { name: 'notification_date', label: 'Notificación al infractor', type: 'date' },
      { name: 'receipt_date', label: 'Comprobante de pago recibido', type: 'date' },
      { name: 'suspension_days', label: 'Días de suspensión de licencia', type: 'number', min: 1, step: 1, inputmode: 'numeric' },
      { name: 'permit_delivery_date', label: 'Entrega de permiso provisorio', type: 'date' },
      { name: 'return_date', label: 'Fecha de devolución al tribunal', type: 'date' }
    ],
    values: { ...c, court: c.court_name, resolution: c.resolution_list },
    onSubmit: async v => {
      const court_id = await courtIdFromName(v.court);
      const { court, ...rest } = v;
      await rpc('updateCase', c.id, { ...rest, court_id, resolution: v.resolution });
    }
  });
  if (ok) { toast('Cambios guardados', 'ok'); refresh(); }
}

// ---------- Ficha del exhorto ----------
async function exhortoDocumentModal(c) {
  const models = await rpc('documentModels');
  let key;
  const selected = await formModal({
    title: 'Generar documento',
    submitLabel: 'Continuar',
    fields: [{ name: 'model', label: 'Modelo', type: 'select', required: true,
      options: Object.entries(models).map(([value, model]) => [value, model.title]) }],
    values: { model: c.receipt_date ? 'x26web' : 'x10' },
    onSubmit: v => { key = v.model; }
  });
  if (!selected) return;
  const model = models[key];
  const fields = [
    { name: 'date', label: 'Fecha del documento', type: 'date', required: true },
    { name: 'judge', label: 'Nombre de quien ejerce como juez', required: true },
    { name: 'judgeRole', label: 'Cargo de quien ejerce como juez', required: true }
  ];
  if (key !== 'x10') fields.push(
    { name: 'secretary', label: 'Nombre de Secretaría', required: true },
    { name: 'secretaryRole', label: 'Cargo de Secretaría', required: true });
  if (model.matter) fields.push(
    { name: 'origin', label: 'Rol del tribunal de origen', required: true },
    { name: 'ord', label: 'ORD. registrado en el libro de correspondencia', required: true });
  if (model.payment) fields.push(
    { name: 'amount', label: 'Monto pagado en pesos', type: 'number', required: true },
    { name: 'platform', label: 'Plataforma municipal', required: true });
  if (key === 'x26web') fields.push({ name: 'received', label: 'Recepción del comprobante', type: 'date', required: true });
  let input, preview;
  const ready = await formModal({
    title: model.title, submitLabel: 'Vista previa', fields,
    values: { date: state.meta.today, received: c.receipt_date },
    onSubmit: async v => {
      input = { ...v, model: key };
      preview = await rpc('previewExhortoDocument', c.id, input);
    }
  });
  if (!ready) return;
  const accepted = await confirmBox(preview.filter(Boolean).join('\n\n'), 'Guardar Word');
  if (!accepted) return;
  const result = await rpc('exportExhortoDocument', c.id, input);
  if (!result.canceled) toast('Documento Word guardado', 'ok');
}

async function renderCase(main, id) {
  const c = await rpc('getCase', id);
  const s = c.suspension;
  const today = state.meta.today;

  const act = (label, fn, primary = false) => h('button', { class: `btn sm${primary ? ' primary' : ''}`, onclick: () => run(fn) }, label);

  const plazoAlert = code => c.alerts.find(a => a.code === code);
  const stageIdx = ['ingresado', 'carta', 'sentencia', 'notificado', 'comprobante'].indexOf(c.stage);
  const closed = !!c.final_status;
  const noPay = c.resolution_list.includes('Absolución') || c.resolution_list.includes('Amonestación');

  const step = ({ n, title, date, sub, done, current, na, button, deadline }) => h('li', { class: `step ${done ? 'done' : current ? 'current' : na ? 'na' : 'pending'}` },
    h('div', { class: 'dot' }, done ? '✓' : na ? '–' : n),
    h('div', null, h('div', { class: 'step-title' }, title, date ? h('span', { class: 'muted', style: 'font-weight:400' }, ` · ${fmtDate(date)}`) : null),
      sub ? h('div', { class: 'step-sub' }, sub) : null,
      deadline ? h('div', { style: 'margin-top:6px' }, h('span', { class: `tag ${tagClass(deadline.severity)}` }, `${deadline.title.split(' después')[0]} · ${daysText(deadline.days_left)} (${fmtDate(deadline.due_date)})`)) : null),
    h('div', null, button));

  const letterAlert = plazoAlert('sentencia_atrasada');
  const payAlert = plazoAlert('comprobante_atrasado') || plazoAlert('reenvio_vencido');
  const steps = h('ol', { class: 'steps' },
    step({ n: 1, title: 'Exhorto ingresado', date: c.entry_date, done: true }),
    step({ n: 2, title: 'Carta enviada al juzgado remitente', date: c.letter_sent_date, done: !!c.letter_sent_date, current: !c.letter_sent_date && !closed && stageIdx === 0,
      sub: c.letter_sent_date ? `Plazo de respuesta: ${state.settings.alert_sentence_days} días${c.tracking_code ? ` · Correos: ${c.tracking_code}` : ''}` : 'Pendiente',
      deadline: !c.sentence_date ? letterAlert : null,
      button: closed ? null : act(c.letter_sent_date ? 'Cambiar fecha' : 'Registrar envío', () => letterModal(c), !c.letter_sent_date) }),
    step({ n: 3, title: 'Sentencia recibida', date: c.sentence_date, done: !!c.sentence_date, current: !c.sentence_date && !closed && stageIdx === 1,
      sub: c.sentence_date ? [c.resolution_list.join(' · ') || 'Sin forma de cumplimiento indicada', c.sentence_docs ? `${plural(c.sentence_docs, 'PDF adjunto', 'PDF adjuntos')}` : 'sin PDF adjunto'].join(' — ') : 'Esperando que el juzgado remita la sentencia',
      button: closed ? null : act(c.sentence_date ? 'Editar' : 'Registrar sentencia', () => sentenceModal(c), !c.sentence_date && !!c.letter_sent_date) }),
    step({ n: 4, title: 'Notificado al infractor', date: c.notification_date, done: !!c.notification_date, current: !!c.sentence_date && !c.notification_date && !closed,
      sub: c.notification_date ? ((c.notifications.length ? `Correo registrado a ${c.notifications[0].to_email}` : 'Sin correo registrado') + (c.is_resend ? ' · reenvío' : '')) : (c.sentence_date ? 'Listo para notificar por correo' : 'Requiere la sentencia'),
      button: closed || !c.sentence_date ? null
        : c.notification_date && !c.receipt_date && !noPay ? act('Reenviar sentencia', () => notifyModal(c, { resend: true }))
        : act(c.notification_date ? 'Notificar de nuevo' : 'Notificar por correo', () => notifyModal(c), !c.notification_date) }),
    step({ n: 5, title: 'Comprobante de pago', date: c.receipt_date, done: !!c.receipt_date, na: noPay && !!c.notification_date, current: !!c.notification_date && !c.receipt_date && !noPay && !closed,
      sub: noPay ? 'No aplica: la causa terminó sin pago' : c.receipt_date ? 'Recibido' : c.notification_date ? (c.is_resend ? `Reenvío: 5 días hábiles para pagar (hasta el ${fmtDate(c.resend_due)}); si no, se devuelve el exhorto` : `Plazo: ${state.settings.alert_payment_days} días desde la notificación`) : 'Después de notificar',
      deadline: payAlert,
      button: closed || !c.notification_date || noPay ? null : act(c.receipt_date ? 'Cambiar fecha' : 'Registrar comprobante', () => receiptModal(c), !c.receipt_date) }),
    step({ n: 6, title: closed ? c.final_status : 'Cierre', date: c.final_status === 'Devuelto' ? c.return_date : null, done: closed,
      sub: closed ? (c.final_status === 'Devuelto' ? 'Devuelto al tribunal de origen' : c.final_status === 'Archivado' ? 'Causa archivada' : 'Exhorto anulado') : 'Devolver al tribunal, archivar o anular',
      button: closed ? act('Reabrir', async () => { await rpc('reopenCase', c.id); toast('Exhorto reabierto', 'ok'); refresh(); })
        : h('div', { class: 'row' },
          c.receipt_date ? act('Archivar causa', async () => { await rpc('closeCase', c.id, { status: 'Archivado' }); toast('Causa archivada', 'ok'); refresh(); }, true) : null,
          act(c.receipt_date ? 'Otro cierre…' : 'Cerrar exhorto', () => closeModal(c), !c.receipt_date && !!plazoAlert('reenvio_vencido'))) }));

  // Suspensión de licencia
  let susBody;
  if (!s) {
    susBody = h('div', null, h('p', { class: 'muted', style: 'margin:0 0 10px' }, 'Sin suspensión de licencia registrada.'), act('Registrar suspensión', () => suspensionModal(c)));
  } else if (s.state === 'sin_permiso') {
    susBody = h('div', null, h('p', { style: 'margin:0 0 4px' }, h('strong', null, `${s.days} días de suspensión`)),
      h('p', { class: 'muted', style: 'margin:0 0 10px' }, 'Comienza a contar cuando el infractor entregue el permiso provisorio.'), h('div', { class: 'row' }, act('Registrar entrega del permiso', () => suspensionModal(c), true)));
  } else {
    const pct = Math.min(100, Math.round((s.elapsed / s.days) * 100));
    const label = s.state === 'vigente' ? `Vigente · día ${s.elapsed} de ${s.days}` : s.state === 'cumplida' ? 'Cumplida' : 'Comienza mañana';
    susBody = h('div', null,
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('strong', null, label), h('span', { class: 'muted' }, s.state === 'vigente' ? `Restan ${plural(s.remaining, 'día', 'días')}` : '')),
      h('div', { class: `progress${s.state === 'cumplida' ? ' done' : ''}`, role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${pct}%` })),
      h('dl', { class: 'kv', style: 'margin-top:10px' },
        h('dt', null, 'Permiso entregado'), h('dd', null, fmtDate(s.permit)),
        h('dt', null, 'Primer día de suspensión'), h('dd', null, fmtDate(s.start)),
        h('dt', null, 'Último día suspendido'), h('dd', null, fmtDate(s.last_day)),
        h('dt', null, 'Puede conducir desde'), h('dd', null, h('strong', null, fmtDate(s.free_date)))),
      h('div', { class: 'row', style: 'margin-top:12px' }, act('Editar', () => suspensionModal(c))));
  }

  // Documentos
  const defaultKind = 'sentencia';
  const kindSel = h('select', { 'aria-label': 'Tipo de documento', class: 'btn sm' }, [['sentencia', 'Sentencia'], ['comprobante', 'Comprobante'], ['otro', 'Otro']].map(([v, l]) => h('option', { value: v, selected: v === defaultKind }, l)));
  const docList = c.documents.length ? c.documents.map(d => h('div', { class: 'doc' },
    h('div', null, h('div', { class: 'doc-name' }, d.original_name), h('div', { class: 'sub' }, `${d.kind} · ${fmtDate(d.added_at)}`)),
    h('div', { class: 'row' }, act('Abrir', () => rpc('openDocument', d.id)), h('button', { class: 'btn sm danger', onclick: () => run(async () => { if (await confirmBox(`¿Quitar "${d.original_name}" del exhorto?`, 'Quitar', { danger: true })) { await rpc('removeDocument', d.id); refresh(); } }) }, 'Quitar')))) : [h('div', { class: 'empty' }, 'Aún no hay documentos.')];
  const drop = h('div', { class: 'drop' }, 'Escanea con el botón de arriba o arrastra aquí un PDF');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    run(async () => {
      const paths = [...e.dataTransfer.files].map(f => window.api.pathForFile(f)).filter(Boolean);
      if (!paths.length) throw new Error('No se pudo leer el archivo arrastrado. Usa el botón "Adjuntar".');
      await rpc('attachPaths', c.id, kindSel.value, paths);
      toast(`${plural(paths.length, 'documento adjuntado', 'documentos adjuntados')}`, 'ok'); refresh();
    });
  });

  const mails = c.notifications.length ? c.notifications.map(n => h('div', { class: 'mail-item' },
    h('div', null, h('strong', null, n.kind === 'carta' ? 'Carta al juzgado' : n.kind === 'recordatorio' ? 'Recordatorio de sentencia al juzgado' : 'Notificación'), ` · ${fmtDate(n.sent_at)}`),
    h('div', { class: 'sub' }, `Para: ${n.to_email}`), n.attachments ? h('div', { class: 'sub' }, `Adjuntos: ${n.attachments}`) : null)) : [h('div', { class: 'empty' }, 'No se han registrado correos.')];

  add(main,
    h('button', { class: 'link back', onclick: () => go('cases') }, '← Volver a exhortos'),
    h('div', { class: 'page-head' },
      h('div', null, h('h2', null, `Rol ${c.rol}`, ' ', h('span', { class: `tag ${STAGE_TAG[c.stage]}`, style: 'vertical-align:middle;font-size:13px' }, c.stage_label)), h('p', null, c.court_name)),
      h('div', { class: 'row' }, act('Generar documento', () => exhortoDocumentModal(c)), h('button', { class: 'btn', onclick: () => editCaseModal(c) }, 'Editar datos'),
        h('button', { class: 'btn danger', onclick: () => run(async () => { if (await confirmBox(`Se eliminará el exhorto ${c.rol} con sus documentos y correos registrados. Esta acción no se puede deshacer.`, 'Eliminar', { danger: true })) { await rpc('deleteCase', c.id); toast('Exhorto eliminado', 'ok'); go('cases'); } }) }, 'Eliminar'))),
    c.needs_review ? h('div', { class: 'banner warn' }, h('span', null, 'Este exhorto viene de la versión anterior y le faltan fechas (por ejemplo, cuándo se envió la carta o cuándo se notificó). Complétalas con "Editar datos" o con los botones de abajo, y luego márcalo como revisado.'), act('Marcar como revisado', async () => { await rpc('markReviewed', c.id); refresh(); })) : null,
    h('div', { class: 'detail' },
      h('div', null,
        h('section', { class: 'card' }, h('h3', null, 'Avance del exhorto'), steps),
        h('section', { class: 'card' }, h('h3', null, 'Suspensión de licencia'), susBody),
        c.notes ? h('section', { class: 'card' }, h('h3', null, 'Observaciones'), h('div', { class: 'notes' }, c.notes)) : null),
      h('div', null,
        h('section', { class: 'card' }, h('h3', null, 'Infractor'),
          h('dl', { class: 'kv' },
            h('dt', null, 'Nombre'), h('dd', null, c.offender_name || '—'),
            h('dt', null, 'RUT'), h('dd', null, c.offender_rut || '—'),
            h('dt', null, 'Correo'), h('dd', null, c.offender_email || '—'),
            h('dt', null, 'Teléfono'), h('dd', null, c.offender_phone || '—'),
            h('dt', null, 'Boleta de citación'), h('dd', null, c.citation_number || '—'))),
        h('section', { class: 'card' }, h('h3', null, 'Juzgado remitente'),
          h('dl', { class: 'kv' },
            h('dt', null, 'Juzgado'), h('dd', null, c.court_name),
            h('dt', null, 'Dirección'), h('dd', null, c.court_address || '—'),
            h('dt', null, 'Correo'), h('dd', null, c.court_email || '—'),
            h('dt', null, 'Teléfono'), h('dd', null, c.court_phone || '—'))),
        h('section', { class: 'card' }, h('h3', null, 'Documentos', h('span', { class: 'row' }, kindSel, act('Escanear…', () => scanAndAttach(c, kindSel.value), true), act('Adjuntar…', async () => { const r = await rpc('pickAndAttach', c.id, kindSel.value); if (!r.canceled) { toast(`${plural(r.count, 'documento adjuntado', 'documentos adjuntados')}`, 'ok'); refresh(); } }))), docList, drop),
        h('section', { class: 'card' }, h('h3', null, 'Correos registrados'), mails))));
}

async function scanAndAttach(c, kind) {
  const labels = { sentencia: 'Sentencia', comprobante: 'Comprobante', otro: 'Documento' };
  const p = await scanModal(`${labels[kind] || 'Documento'} Rol ${c.rol} ${state.meta.today}`);
  if (!p) return;
  await rpc('attachPaths', c.id, kind, [p]);
  toast('Documento escaneado y adjuntado', 'ok'); refresh();
}

// ---------- Acciones de la ficha ----------
async function letterModal(c) {
  const ok = await formModal({
    title: 'Carta enviada al juzgado remitente',
    intro: `Se avisará si no llega la sentencia dentro de ${state.settings.alert_sentence_days} días.`,
    fields: [
      { name: 'date', label: 'Fecha de envío', type: 'date', required: true },
      { name: 'tracking_code', label: 'Código de seguimiento de Correos', hint: 'Opcional. Se incluye en los recordatorios al juzgado.' },
      ...(c.court_email ? [{ name: 'draft', label: 'Correo al juzgado', type: 'select', options: [['no', 'No preparar correo'], ['si', `Abrir borrador en Outlook para ${c.court_email}`]], full: true }] : [])
    ],
    values: { date: c.letter_sent_date || state.meta.today, tracking_code: c.tracking_code || '', draft: 'no' },
    onSubmit: async v => {
      await rpc('markLetterSent', c.id, { date: v.date, tracking_code: v.tracking_code });
      if (v.draft === 'si') {
        const m = await rpc('buildEmail', { case_id: c.id, kind: 'carta' });
        await rpc('openEmailDraft', { to: m.to, subject: m.subject, body: m.body, document_ids: [] });
      }
    }
  });
  if (ok) { toast('Envío de carta registrado', 'ok'); refresh(); }
}

async function sentenceModal(c) {
  const ok = await formModal({
    title: 'Sentencia recibida', wide: true,
    fields: [
      { name: 'date', label: 'Fecha de la sentencia', type: 'date', required: true },
      { name: 'suspension_days', label: 'Días de suspensión de licencia', type: 'number', min: 1, step: 1, inputmode: 'numeric', hint: 'Déjalo vacío si la sentencia no suspende la licencia.' },
      { name: 'resolution', label: 'Forma de cumplimiento / resolución', type: 'checks', options: state.meta.resolution_types, full: true, hint: 'Marca todas las formas de pago que acepta la sentencia. Absolución o amonestación cierran la causa sin pago.' },
      { name: 'file', label: 'Documento de la sentencia (opcional)', type: 'file', full: true, scanName: `Sentencia Rol ${c.rol} ${state.meta.today}` }
    ],
    values: { date: c.sentence_date || state.meta.today, suspension_days: c.suspension_days ?? '', resolution: c.resolution_list },
    onSubmit: async v => {
      await rpc('registerSentence', c.id, { date: v.date, resolution: v.resolution, suspension_days: v.suspension_days });
      if (v.file) await rpc('attachPaths', c.id, 'sentencia', [v.file]);
    }
  });
  if (ok) { toast('Sentencia registrada', 'ok'); refresh(); }
}

async function receiptModal(c) {
  const ok = await formModal({
    title: 'Comprobante de pago recibido',
    fields: [
      { name: 'date', label: 'Fecha en que entregó el comprobante', type: 'date', required: true }
    ],
    values: { date: c.receipt_date || state.meta.today },
    onSubmit: async v => {
      await rpc('registerReceipt', c.id, { date: v.date });
    }
  });
  if (ok) { toast('Comprobante registrado', 'ok'); refresh(); }
}

async function suspensionModal(c) {
  const ok = await formModal({
    title: 'Suspensión de licencia',
    intro: 'Se cuenta de medianoche a medianoche: el día siguiente a la entrega del permiso provisorio es el día 1.',
    fields: [
      { name: 'days', label: 'Días de suspensión', type: 'number', min: 1, step: 1, inputmode: 'numeric', required: true },
      { name: 'date', label: 'Fecha de entrega del permiso provisorio', type: 'date', hint: 'Déjala vacía si aún no lo entrega.' }
    ],
    values: { days: c.suspension_days ?? '', date: c.permit_delivery_date || '' },
    onSubmit: async v => {
      if (v.date) await rpc('setPermitDelivery', c.id, { date: v.date, days: v.days });
      else await rpc('updateCase', c.id, { suspension_days: v.days, permit_delivery_date: null });
    }
  });
  if (ok) { toast('Suspensión actualizada', 'ok'); refresh(); }
}

async function closeModal(c) {
  const ok = await formModal({
    title: 'Cerrar exhorto',
    fields: [
      { name: 'status', label: 'Resultado', type: 'select', required: true, options: [['Devuelto', 'Devuelto al tribunal de origen'], ['Archivado', 'Archivado'], ['Anulado', 'Anulado']], full: true },
      { name: 'date', label: 'Fecha de devolución', type: 'date', hint: 'Solo se usa cuando el resultado es "Devuelto".' }
    ],
    values: { status: c.receipt_date ? 'Archivado' : 'Devuelto', date: state.meta.today },
    onSubmit: async v => { await rpc('closeCase', c.id, { status: v.status, date: v.date }); }
  });
  if (ok) { toast('Exhorto cerrado', 'ok'); refresh(); }
}

async function notifyModal(c, { resend = false } = {}) {
  const resendBox = h('input', { type: 'checkbox', id: 'n-resend', checked: resend || !!c.is_resend });
  const susBox = h('input', { type: 'checkbox', id: 'n-sus', checked: Number(c.suspension_days) > 0 });
  const to = h('input', { type: 'email', id: 'n-to', value: c.offender_email || '', placeholder: 'correo@ejemplo.cl' });
  const subject = h('input', { type: 'text', id: 'n-subject' });
  const body = h('textarea', { id: 'n-body', rows: 12 });
  const docs = c.documents.filter(d => d.kind === 'sentencia');
  const docChecks = docs.map(d => h('label', null, h('input', { type: 'checkbox', value: d.id, checked: true }), d.original_name));
  const err = h('div', { class: 'form-error', role: 'alert' });
  const step2 = h('div', { class: 'note-box hidden', style: 'display:none' });
  let touched = false;

  const regenerate = async () => {
    const m = await rpc('buildEmail', { case_id: c.id, kind: 'sentencia', is_resend: resendBox.checked, include_suspension: susBox.checked });
    subject.value = m.subject; body.value = m.body; touched = false;
  };
  body.addEventListener('input', () => { touched = true; });
  const regen = async () => {
    if (touched && !(await confirmBox('Cambiaste el texto a mano. ¿Reemplazarlo por el texto generado?', 'Reemplazar'))) return;
    await run(regenerate);
  };
  resendBox.addEventListener('change', regen); susBox.addEventListener('change', regen);
  await run(regenerate);

  const selectedDocIds = () => [...docChecks.map(l => l.querySelector('input'))].filter(i => i.checked).map(i => Number(i.value));
  const dateInput = h('input', { type: 'date', id: 'n-date', value: state.meta.today });

  const register = async dlg => {
    err.textContent = '';
    try {
      await rpc('registerNotification', c.id, {
        date: dateInput.value, to: to.value, subject: subject.value, body: body.value,
        attachments: docs.filter(d => selectedDocIds().includes(d.id)).map(d => d.original_name), is_resend: resendBox.checked ? 1 : 0
      });
      dlg.close();
      toast('Notificación registrada', 'ok'); refresh();
    } catch (e) { err.textContent = e.message; }
  };

  let dlg;
  const openBtn = h('button', { class: 'btn primary', type: 'button', id: 'n-open', onclick: async () => {
    err.textContent = '';
    if (!to.value.trim()) { err.textContent = 'Falta el correo del infractor.'; to.focus(); return; }
    if (!docs.length && !(await confirmBox('No hay una sentencia adjunta en este exhorto, así que el correo saldrá sin adjunto. ¿Continuar?', 'Continuar'))) return;
    try {
      const r = await rpc('openEmailDraft', { to: to.value.trim(), subject: subject.value, body: body.value, document_ids: selectedDocIds() });
      step2.style.display = 'block'; step2.classList.remove('hidden');
      step2.textContent = r.method === 'outlook'
        ? 'Se abrió el borrador en Outlook con la sentencia adjunta. Revísalo y envíalo; después confirma aquí para registrar la notificación.'
        : r.method === 'gmail'
          ? `Se abrió Gmail en el navegador${r.attachments && r.attachments.length ? ` y la carpeta con ${r.attachments.join(', ')}: arrastra el archivo al correo` : ''}. Envíalo y después confirma aquí.`
          : 'Se abrió el borrador con tu programa de correo predeterminado. Revísalo y envíalo; después confirma aquí.';
      confirmBtn.classList.remove('hidden');
    } catch (e) { err.textContent = e.message; }
  } }, 'Abrir borrador de correo');
  const confirmBtn = h('button', { class: 'btn primary hidden', type: 'button', id: 'n-confirm', onclick: () => register(dlg) }, 'Ya lo envié: registrar notificación');
  const onlyRegister = h('button', { class: 'btn', type: 'button', id: 'n-register', onclick: () => register(dlg) }, 'Solo registrar (sin abrir el correo)');

  dlg = openDialog([
    h('h3', null, `${resend ? 'Reenviar' : 'Notificar'} sentencia · Rol ${c.rol}`),
    resend ? h('div', { class: 'note-box' }, 'Al reenviar, el infractor tiene 5 días hábiles para pagar. Si no lo hace, vence el plazo, la app te avisará y podrás devolver el exhorto al tribunal y archivar la causa.') : null,
    h('div', { class: 'form-grid' },
      h('div', { class: 'field' }, h('label', { for: 'n-to' }, 'Para *'), to),
      h('div', { class: 'field' }, h('label', { for: 'n-date' }, 'Fecha de notificación'), dateInput),
      h('div', { class: 'field full' }, h('span', { class: 'lbl' }, 'Opciones'), h('div', { class: 'checks' },
        h('label', null, susBox, 'Mencionar suspensión de licencia'), h('label', null, resendBox, 'Es reenvío (5 días hábiles para pagar)'))),
      h('div', { class: 'field full' }, h('span', { class: 'lbl' }, 'Adjuntar sentencia'), docs.length ? h('div', { class: 'checks' }, docChecks) : h('span', { class: 'hint', style: 'color:var(--warn)' }, 'No hay sentencia adjunta. Cierra esta ventana y adjunta el PDF en "Documentos" para que viaje en el correo.')),
      h('div', { class: 'field full' }, h('label', { for: 'n-subject' }, 'Asunto'), subject),
      h('div', { class: 'field full mail-preview' }, h('label', { for: 'n-body' }, 'Mensaje'), body),
      step2, err,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancelar'), onlyRegister, openBtn, confirmBtn)),
  ], { wide: true });
}

// ---------- Recordatorios de sentencia (un correo por juzgado) ----------
async function reminderModal() {
  const groups = await run(() => rpc('reminderGroups'));
  if (!groups) return;
  const total = groups.reduce((n, g) => n + g.cases.length, 0);
  const picks = new Map(); // case id -> checkbox
  let dlg;
  const groupCard = g => {
    const boxes = g.cases.map(c => {
      const box = h('input', { type: 'checkbox', value: c.id, checked: true });
      picks.set(c.id, { box, court_id: g.court_id });
      return h('label', { class: 'rem-case' }, box, h('span', null,
        h('strong', null, `Rol ${c.rol}`), c.offender_name ? ` · ${c.offender_name}` : '',
        h('span', { class: 'sub' }, ` Carta enviada ${fmtDate(c.letter_sent_date)} · plazo vencido hace ${plural(c.days_overdue, 'día', 'días')}`
          + (c.last_reminder ? ` · ${c.reminder_count}° recordatorio enviado ${fmtDate(c.last_reminder)}` : '')
          + (c.citation_number ? '' : ' · sin boleta de citación') + (c.tracking_code ? '' : ' · sin código de Correos'))));
    });
    return h('section', { class: 'card rem-group' },
      h('h3', null, g.court_name, h('span', { class: 'muted small' }, plural(g.cases.length, 'exhorto', 'exhortos'))),
      h('div', { class: 'sub', style: 'margin-bottom:6px' }, g.court_email ? `Correo: ${g.court_email}` : 'Este juzgado no tiene correo en el directorio: podrás escribirlo en el paso siguiente.'),
      h('div', { class: 'checks rem-list' }, boxes),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => {
        const ids = g.cases.map(c => c.id).filter(id => picks.get(id).box.checked);
        if (!ids.length) { toast('Marca al menos un exhorto de este juzgado', 'err'); return; }
        dlg.close(); reminderMailModal(g, ids);
      } }, 'Preparar correo…')));
  };
  dlg = openDialog([
    h('h3', null, 'Recordatorios de sentencia'),
    h('p', { class: 'muted', style: 'margin:0' }, total
      ? `Exhortos con la carta enviada y el plazo de ${state.settings.alert_sentence_days} días vencido, sin sentencia. Se arma un solo correo por juzgado con las causas que marques.`
      : 'No hay exhortos con la sentencia atrasada. Aquí aparecerán los que pasen el plazo sin que el juzgado remitente envíe la sentencia.'),
    groups.map(groupCard),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cerrar'))
  ], { wide: true });
}

async function reminderMailModal(g, caseIds) {
  const m = await run(() => rpc('buildReminder', { court_id: g.court_id, case_ids: caseIds }));
  if (!m) return;
  const to = h('input', { type: 'text', id: 'r-to', value: m.to, placeholder: 'correo@juzgado.cl' });
  const subject = h('input', { type: 'text', id: 'r-subject', value: m.subject });
  const body = h('textarea', { id: 'r-body', rows: 16 }, m.body);
  const dateInput = h('input', { type: 'date', id: 'r-date', value: state.meta.today });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const step2 = h('div', { class: 'note-box', style: 'display:none' });
  let dlg;
  const register = async () => {
    err.textContent = '';
    try {
      const r = await rpc('registerReminder', { case_ids: m.case_ids, date: dateInput.value, to: to.value, subject: subject.value, body: body.value });
      dlg.close(); toast(`Recordatorio registrado en ${plural(r.count, 'exhorto', 'exhortos')}`, 'ok'); refresh();
    } catch (e) { err.textContent = e.message; }
  };
  const confirmBtn = h('button', { class: 'btn primary hidden', type: 'button', id: 'r-confirm', onclick: register }, 'Ya lo envié: registrar recordatorio');
  const openBtn = h('button', { class: 'btn primary', type: 'button', id: 'r-open', onclick: async () => {
    err.textContent = '';
    if (!to.value.trim()) { err.textContent = 'Falta el correo del juzgado.'; to.focus(); return; }
    try {
      const r = await rpc('openEmailDraft', { to: to.value.trim(), subject: subject.value, body: body.value, document_ids: [] });
      step2.style.display = 'block';
      step2.textContent = r.method === 'gmail'
        ? 'Se abrió Gmail en el navegador. Envíalo y después confirma aquí.'
        : 'Se abrió el borrador en tu programa de correo. Revísalo y envíalo; después confirma aquí para dejar anotado el recordatorio en cada exhorto.';
      confirmBtn.classList.remove('hidden');
    } catch (e) { err.textContent = e.message; }
  } }, 'Abrir borrador de correo');
  dlg = openDialog([
    h('h3', null, `Recordatorio a ${g.court_name}`),
    h('p', { class: 'muted', style: 'margin:0' }, `Un solo correo con ${plural(m.case_ids.length, 'exhorto', 'exhortos')}. Al registrarlo se anota en la ficha de cada uno.`),
    h('div', { class: 'form-grid' },
      h('div', { class: 'field' }, h('label', { for: 'r-to' }, 'Para *'), to),
      h('div', { class: 'field' }, h('label', { for: 'r-date' }, 'Fecha de envío'), dateInput),
      h('div', { class: 'field full' }, h('label', { for: 'r-subject' }, 'Asunto'), subject),
      h('div', { class: 'field full mail-preview' }, h('label', { for: 'r-body' }, 'Mensaje'), body),
      step2, err,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancelar'),
        h('button', { class: 'btn', type: 'button', id: 'r-register', onclick: register }, 'Solo registrar (sin abrir el correo)'), openBtn, confirmBtn))
  ], { wide: true });
}

// ---------- Directorio de juzgados ----------
const COURT_FIELDS = () => [
  { name: 'name', label: 'Nombre del juzgado', required: true, full: true, placeholder: 'Ej.: Primer Juzgado de Policía Local de Osorno' },
  { name: 'commune', label: 'Comuna' },
  { name: 'region', label: 'Región', type: 'select', options: [['', 'Sin región'], ...state.meta.regions] },
  { name: 'address', label: 'Dirección', full: true },
  { name: 'email', label: 'Correo(s)', hint: 'Varios correos separados por punto y coma.' },
  { name: 'phone', label: 'Teléfono(s)' },
  { name: 'notes', label: 'Observaciones', type: 'textarea', full: true }
];

async function courtModal(court) {
  const editing = !!court;
  const ok = await formModal({
    title: editing ? 'Editar juzgado' : 'Nuevo juzgado', wide: true, submitLabel: editing ? 'Guardar cambios' : 'Crear juzgado',
    fields: COURT_FIELDS(), values: court || {},
    onSubmit: async v => { if (editing) await rpc('updateCourt', court.id, v); else await rpc('createCourt', v); }
  });
  if (ok) { toast(editing ? 'Juzgado actualizado' : 'Juzgado creado', 'ok'); await loadCourts(); refresh(); }
}

async function renderCourts(main) {
  const q = h('input', { type: 'search', placeholder: 'Buscar por nombre, comuna, región, correo o teléfono…', value: state.courtQ, 'aria-label': 'Buscar juzgados' });
  const body = h('div');
  const load = async () => {
    state.courtQ = q.value;
    const rows = await run(() => rpc('listCourts', q.value));
    if (!rows) return;
    state.courts = q.value ? state.courts : rows;
    body.replaceChildren(
      h('p', { class: 'count-line' }, plural(rows.length, 'juzgado', 'juzgados')),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Juzgado', 'Dirección', 'Contacto', 'Exhortos', ''].map(t => h('th', null, t)))),
        h('tbody', null, rows.length ? rows.map(c => h('tr', null,
          h('td', null, h('strong', null, c.name), h('div', { class: 'sub' }, [c.commune, c.region].filter(Boolean).join(' · '))),
          h('td', null, c.address || h('span', { class: 'muted' }, '—')),
          h('td', null, c.email ? h('div', null, c.email) : null, c.phone ? h('div', { class: 'sub' }, c.phone) : null, !c.email && !c.phone ? h('span', { class: 'muted' }, 'Sin datos') : null),
          h('td', { class: 'nowrap' }, c.case_count),
          h('td', { class: 'nowrap' }, h('div', { class: 'row' },
            h('button', { class: 'btn sm', onclick: () => courtModal(c) }, 'Editar'),
            h('button', { class: 'btn sm danger', onclick: () => run(async () => { if (await confirmBox(`¿Borrar "${c.name}" del directorio?`, 'Borrar', { danger: true })) { await rpc('deleteCourt', c.id); toast('Juzgado borrado', 'ok'); await loadCourts(); refresh(); } }) }, 'Borrar'))))) : h('tr', null, h('td', { colspan: 5, class: 'empty' }, 'Sin resultados.'))))));
  };
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
  add(main,
    h('div', { class: 'page-head' }, h('div', null, h('h2', null, 'Directorio de juzgados'), h('p', null, 'Direcciones, teléfonos y correos. Puedes editar, agregar o importar desde Excel (CSV).')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => run(async () => { const r = await rpc('importCourtsFile'); if (!r.canceled) { toast(`Importación lista: ${r.created} nuevos, ${r.updated} actualizados`, 'ok'); await loadCourts(); refresh(); } }) }, 'Importar CSV'),
        h('button', { class: 'btn', onclick: () => run(async () => { const r = await rpc('exportCourts'); if (!r.canceled) toast('Directorio exportado', 'ok'); }) }, 'Exportar CSV'),
        h('button', { class: 'btn primary', onclick: () => courtModal(null) }, '+ Nuevo juzgado'))),
    h('div', { class: 'toolbar' }, q), body);
  await load();
}

// ---------- Ajustes ----------
async function templatesCard() {
  let tpls = await rpc('getTemplates');
  let kind = 'sentencia';
  const card = h('section', { class: 'card' });
  const draw = () => {
    const t = tpls[kind];
    const kindSel = h('select', { id: 'tpl-kind', 'aria-label': 'Plantilla' }, [['sentencia', 'Notificación de sentencia (al infractor)'], ['carta', 'Carta al juzgado remitente'], ['recordatorio', 'Recordatorio de sentencia atrasada (al juzgado)']].map(([v, l]) => h('option', { value: v, selected: v === kind }, l)));
    const subject = h('input', { type: 'text', id: 'tpl-subject', value: t.subject });
    const body = h('textarea', { id: 'tpl-body', class: 'tpl-body' }, t.body);
    const preview = h('div', { class: 'tpl-preview', 'aria-live': 'polite' });
    let last = body;
    subject.addEventListener('focus', () => { last = subject; });
    body.addEventListener('focus', () => { last = body; });
    let timer = null;
    const refreshPreview = async () => {
      try { const m = await rpc('previewTemplate', kind, { subject: subject.value, body: body.value }); preview.textContent = `Asunto: ${m.subject}\n\n${m.body}`; }
      catch (e) { preview.textContent = e.message; }
    };
    const later = () => { clearTimeout(timer); timer = setTimeout(refreshPreview, 250); };
    subject.addEventListener('input', later); body.addEventListener('input', later);
    const chips = t.vars.map(([k, label]) => h('button', { type: 'button', class: 'btn sm', title: label, onclick: () => {
      const el = last, a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
      el.value = el.value.slice(0, a) + `{${k}}` + el.value.slice(b);
      el.focus(); el.setSelectionRange(a + k.length + 2, a + k.length + 2); later();
    } }, `{${k}}`));
    kindSel.addEventListener('change', () => { kind = kindSel.value; draw(); });
    const flash = h('div', { class: 'form-error', role: 'alert' });
    card.replaceChildren(
      h('h3', null, 'Plantillas de correo', t.custom ? h('span', { class: 'tag info' }, 'personalizada') : h('span', { class: 'muted small' }, 'texto original')),
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Edita el texto de los correos. Los marcadores entre llaves se reemplazan solos con los datos de cada exhorto. Toca un marcador para insertarlo donde está el cursor.'),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field full' }, h('label', { for: 'tpl-kind' }, 'Correo a editar'), kindSel),
        h('div', { class: 'field full' }, h('label', { for: 'tpl-subject' }, 'Asunto'), subject),
        h('div', { class: 'field full' }, h('label', { for: 'tpl-body' }, 'Mensaje'), body, h('div', { class: 'tpl-vars' }, chips)),
        h('div', { class: 'field full' }, h('span', { class: 'lbl' }, 'Vista previa con datos de ejemplo'), preview)),
      flash,
      h('div', { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => run(async () => {
          if (!(await confirmBox('Se volverá al texto original de esta plantilla y se perderán tus cambios.', 'Restablecer'))) return;
          tpls = await rpc('resetTemplate', kind); toast('Plantilla restablecida', 'ok'); draw();
        }) }, 'Restablecer texto original'),
        h('button', { type: 'button', class: 'btn primary', onclick: async () => {
          flash.textContent = '';
          try { tpls = await rpc('saveTemplate', kind, { subject: subject.value, body: body.value }); toast('Plantilla guardada', 'ok'); draw(); }
          catch (e) { flash.textContent = e.message; }
        } }, 'Guardar plantilla')));
    refreshPreview();
  };
  draw();
  return card;
}

// Respaldo automático a una carpeta (OneDrive, Google Drive de escritorio, pendrive, carpeta de red).
function backupBox(s) {
  const box = h('div', { class: 'note-box', id: 'backup-box' });
  const keep = h('input', { type: 'number', id: 's-keep', min: 1, max: 365, value: s.backup_keep || '14', style: 'width:90px' });
  const draw = st => {
    const dir = st.backup_dir;
    box.replaceChildren(
      h('strong', null, 'Respaldo automático en la nube o en otra carpeta'),
      h('p', { class: 'muted', style: 'margin:6px 0 10px' }, 'Elige una carpeta que tu OneDrive o Google Drive de escritorio ya sincronice. Al cerrar SIGEX se guarda ahí una copia por día de la base de datos y de los documentos. La base que usas sigue siendo local, así que la sincronización no puede dañarla. Usa solo la cuenta institucional: contiene datos personales de infractores.'),
      h('dl', { class: 'kv', style: 'margin-bottom:10px' },
        h('dt', null, 'Carpeta'), h('dd', null, dir || 'Sin configurar'),
        h('dt', null, 'Último respaldo'), h('dd', null, st.backup_last || '—')),
      h('div', { class: 'row', style: 'align-items:center;flex-wrap:wrap' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => run(async () => { const r = await rpc('pickBackupFolder'); if (!r.canceled) { toast('Carpeta de respaldo guardada', 'ok'); draw(await rpc('getSettings')); } }) }, dir ? 'Cambiar carpeta…' : 'Elegir carpeta…'),
        dir ? h('button', { class: 'btn sm primary', type: 'button', onclick: () => run(async () => { const r = await rpc('runBackup'); toast(`Respaldo listo (${plural(r.documents, 'documento nuevo', 'documentos nuevos')})`, 'ok'); draw(await rpc('getSettings')); }) }, 'Respaldar ahora') : null,
        dir ? h('button', { class: 'btn sm danger', type: 'button', onclick: () => run(async () => { await rpc('saveSettings', { backup_dir: '' }); draw(await rpc('getSettings')); }) }, 'Desactivar') : null,
        dir ? h('label', { class: 'muted small', for: 's-keep' }, 'Conservar los últimos ', keep, ' días') : null));
  };
  keep.addEventListener('change', () => run(async () => { await rpc('saveSettings', { backup_keep: keep.value }); toast('Guardado', 'ok'); }));
  draw(s);
  return box;
}

async function renderSettings(main) {
  await loadSettings();
  const info = await rpc('appInfo').catch(() => null);
  const s = state.settings;
  const sentence = h('input', { type: 'number', id: 's-sentence', min: 1, max: 365, value: s.alert_sentence_days });
  const remWait = h('input', { type: 'number', id: 's-remwait', min: 1, max: 365, value: s.alert_reminder_wait_days || 15 });
  const payment = h('input', { type: 'number', id: 's-payment', min: 1, max: 365, value: s.alert_payment_days });
  const home = h('input', { type: 'text', id: 's-home', value: s.home_court_name });
  const osn = h('input', { type: 'checkbox', id: 's-os', checked: s.os_notifications === '1' });
  const hol = h('textarea', { id: 's-hol', rows: 6 }, s.holidays || '');
  const mailClient = h('select', { id: 's-mail' }, [['new', 'Programa predeterminado de Windows (Outlook nuevo, Correo, Thunderbird…)'], ['classic', 'Outlook clásico (usa su propia firma)'], ['gmail', 'Gmail en el navegador (el adjunto lo arrastras tú)']].map(([v, l]) => h('option', { value: v, selected: (s.mail_client || 'new') === v }, l)));
  const greetSel = h('select', { id: 's-greet' }, [['first', 'Solo el primer nombre (Estimado Jorge:)'], ['full', 'Nombre completo (Estimado Jorge Pérez Soto:)']].map(([v, l]) => h('option', { value: v, selected: (s.greeting_name || 'first') === v }, l)));
  const sigImgBox = h('div', { class: 'row', style: 'gap:10px;align-items:center;flex-wrap:wrap' });
  const drawSigImg = async () => {
    const url = await rpc('getSignatureImage').catch(() => null);
    sigImgBox.replaceChildren(
      url ? h('img', { src: url, alt: 'Imagen de firma', style: 'max-height:90px;max-width:320px;border:1px solid var(--line);border-radius:6px;background:#fff' }) : h('span', { class: 'muted small' }, 'Sin imagen de firma'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => run(async () => { const r = await rpc('pickSignatureImage'); if (!r.canceled) { toast('Imagen de firma guardada', 'ok'); drawSigImg(); } }) }, url ? 'Cambiar imagen…' : 'Elegir imagen…'),
      url ? h('button', { type: 'button', class: 'btn sm danger', onclick: () => run(async () => { await rpc('removeSignatureImage'); drawSigImg(); }) }, 'Quitar') : null);
  };
  drawSigImg();
  const sig = h('textarea', { id: 's-sig', rows: 5, placeholder: 'Nombre\nCargo\nJuzgado de Policía Local de …\nTeléfono · correo' }, s.email_signature || '');
  add(main,
    h('div', { class: 'page-head' }, h('div', null, h('h2', null, 'Ajustes'), h('p', null, 'Plazos de alerta y datos del juzgado.'))),
    h('section', { class: 'card' }, h('h3', null, 'Plazos y alertas'),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', { for: 's-sentence' }, 'Esperar sentencia (días desde el envío de la carta)'), sentence),
        h('div', { class: 'field' }, h('label', { for: 's-remwait' }, 'Esperar respuesta tras un recordatorio (días)'), remWait, h('span', { class: 'hint' }, 'Después de registrar un recordatorio, la causa sale de "vencidos" y espera este tiempo. Si no hay sentencia, vuelve a vencidos para el siguiente recordatorio.')),
        h('div', { class: 'field' }, h('label', { for: 's-payment' }, 'Esperar comprobante (días desde la notificación)'), payment),
        h('div', { class: 'field full' }, h('label', { for: 's-home' }, 'Nombre de tu juzgado (firma de los correos)'), home),
        h('div', { class: 'field full' }, h('label', { for: 's-greet' }, 'Nombre del infractor en el saludo'), greetSel, h('span', { class: 'hint' }, 'Se toma del nombre registrado en el exhorto. Con "primer nombre" se usa la primera palabra, así que escríbelo como Nombre Apellido. Si el exhorto no tiene nombre, el saludo queda como "Estimado:".')),
        h('div', { class: 'field full' }, h('label', { for: 's-mail' }, 'Programa de correo para los borradores'), mailClient, h('span', { class: 'hint' }, 'El programa predeterminado es el que Windows asocia a los archivos .eml (cámbialo en Windows > Aplicaciones predeterminadas). Con Outlook clásico se usa la firma de Outlook y el pie de abajo se ignora. Gmail no admite adjuntos automáticos: se abre la carpeta con el archivo para que lo arrastres.')),
        h('div', { class: 'field full' }, h('label', { for: 's-sig' }, 'Pie de firma de los correos'), sig, h('span', { class: 'hint' }, 'Se agrega al final de cada correo (texto simple). Déjalo vacío si no lo necesitas.')),
        h('div', { class: 'field full' }, h('span', { class: 'lbl' }, 'Imagen de firma (opcional)'), sigImgBox, h('span', { class: 'hint' }, 'Si tu firma es una imagen, elígela aquí y saldrá al final de cada correo (con Outlook nuevo). Se guarda en este computador.')),
        h('div', { class: 'field full' }, h('label', { for: 's-hol' }, 'Feriados (no se cuentan como días hábiles en el plazo de reenvío)'), hol, h('span', { class: 'hint' }, 'Un día por línea, formato AAAA-MM-DD. Sábados y domingos ya se descuentan. Revisa esta lista y agrega los feriados que falten.')),
        h('div', { class: 'field full' }, h('div', { class: 'checks' }, h('label', null, osn, 'Avisar con una notificación de Windows cuando haya plazos vencidos'))),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: () => run(async () => {
          await rpc('saveSettings', { alert_sentence_days: sentence.value, alert_reminder_wait_days: remWait.value, alert_payment_days: payment.value, home_court_name: home.value, os_notifications: osn.checked ? '1' : '0', holidays: hol.value, mail_client: mailClient.value, greeting_name: greetSel.value, email_signature: sig.value });
          toast('Ajustes guardados', 'ok'); await loadSettings(); updateBadge();
        }) }, 'Guardar ajustes')))),
    await templatesCard(),
    h('section', { class: 'card' }, h('h3', null, 'Datos y respaldo'),
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Tu información se guarda solo en este computador. Haz respaldos de vez en cuando y guárdalos en otra ubicación (pendrive o carpeta de red).'),
      backupBox(s),
      info ? h('dl', { class: 'kv', style: 'margin-bottom:14px' }, h('dt', null, 'Base de datos'), h('dd', null, info.dbPath), h('dt', null, 'Documentos'), h('dd', null, info.attachmentsDir)) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => run(async () => { const r = await rpc('backupDatabase'); if (!r.canceled) toast('Respaldo guardado', 'ok'); }) }, 'Respaldar base de datos'),
        h('button', { class: 'btn', onclick: () => run(() => rpc('openDataFolder')) }, 'Abrir carpeta de datos'),
        h('button', { class: 'btn', onclick: () => run(async () => {
          const r = await rpc('importLegacyNow');
          toast(r.ok ? `Versión anterior: ${r.cases} exhortos nuevos importados (${r.skipped} ya existían)` : r.reason, r.ok ? 'ok' : 'err'); await loadCourts();
        }) }, 'Importar de la versión anterior'))));
}

// ---------- arranque ----------
async function init() {
  document.querySelectorAll('#nav button').forEach(b => b.addEventListener('click', () => { if (b.dataset.view === 'cases') state.filters = { q: '', stage: 'abiertos', sort: 'recientes' }; go(b.dataset.view); }));
  $('#btn-new-case').addEventListener('click', () => run(newCaseModal));
  window.api.onStartup?.(r => {
    if (r?.legacy?.ok) toast(`Se importaron ${r.legacy.cases} exhortos y ${r.legacy.notifications} notificaciones de la versión anterior`, 'ok');
    if (r?.legacyError) toast(`No se pudo importar la versión anterior: ${r.legacyError}`, 'err');
    refresh();
  });
  window.api.onGoto?.(v => go(v));
  await run(async () => {
    state.meta = await rpc('meta');
    await Promise.all([loadCourts(), loadSettings()]);
    // Aviso si hay respaldo configurado pero lleva días sin hacerse (por ejemplo, la nube no estaba disponible).
    const st = state.settings;
    if (st.backup_dir) {
      const last = /^(\d{4}-\d{2}-\d{2})/.exec(st.backup_last || '');
      const gap = last ? Math.round((Date.parse(state.meta.today) - Date.parse(last[1])) / 86400000) : null;
      if (gap === null || gap > 3) toast(gap === null ? 'Aún no se ha hecho ningún respaldo en la carpeta elegida.' : `Hace ${gap} días que no se respalda. Revisa la carpeta de respaldo en Ajustes.`, 'err');
    }
  });
  await go('panel');
}
init();
