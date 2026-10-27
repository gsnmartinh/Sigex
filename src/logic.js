'use strict';
// Lógica pura (sin Electron ni base de datos): fechas, etapas, plazos, suspensión y textos.

const COMPLIANCE_TYPES = ['Transferencia', 'Vale Vista', 'Página Web', 'Absolución', 'Amonestación'];
const NO_PAYMENT_TYPES = ['Absolución', 'Amonestación'];
const WARN_DAYS = 7; // "próximo a vencer" = dentro de 7 días

const STAGES = {
  ingresado: 'Ingresado · falta enviar carta',
  carta: 'Carta enviada · espera sentencia',
  sentencia: 'Sentencia recibida · por notificar',
  notificado: 'Notificado · espera comprobante',
  comprobante: 'Comprobante recibido',
  devuelto: 'Devuelto',
  archivado: 'Archivado',
  anulado: 'Anulado'
};

function parseISO(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}
function fmtISO(ms) { return new Date(ms).toISOString().slice(0, 10); }
function addDays(s, n) {
  const t = parseISO(s);
  return t == null ? null : fmtISO(t + n * 86400000);
}
// días desde a hasta b (b - a)
function diffDays(a, b) {
  const ta = parseISO(a), tb = parseISO(b);
  if (ta == null || tb == null) return null;
  return Math.round((tb - ta) / 86400000);
}
function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function isValidISO(s) {
  const t = parseISO(s);
  return t != null && fmtISO(t) === String(s).slice(0, 10);
}

function parseResolution(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : String(value).split('|');
  return arr.map(v => String(v).trim()).filter(v => COMPLIANCE_TYPES.includes(v));
}
function stringifyResolution(value) {
  const items = parseResolution(value);
  return items.length ? items.join('|') : null;
}
// ¿esta causa exige pago/comprobante? (no, si fue absolución o amonestación)
function needsPayment(resolution) {
  const items = parseResolution(resolution);
  return !items.some(i => NO_PAYMENT_TYPES.includes(i));
}

function stageOf(c) {
  if (c.final_status === 'Devuelto') return 'devuelto';
  if (c.final_status === 'Archivado') return 'archivado';
  if (c.final_status === 'Anulado') return 'anulado';
  if (c.receipt_date) return 'comprobante';
  if (c.notification_date) return 'notificado';
  if (c.sentence_date) return 'sentencia';
  if (c.letter_sent_date) return 'carta';
  return 'ingresado';
}

// Suspensión de licencia. Se cuenta de medianoche a medianoche: el día de la entrega del permiso provisorio
// no cuenta; el día siguiente es el día 1.
function suspensionInfo(c, today) {
  const days = Number(c.suspension_days) || 0;
  if (!days) return null;
  if (!c.permit_delivery_date) {
    return { state: 'sin_permiso', days, permit: null, start: null, last_day: null, free_date: null, elapsed: 0, remaining: days };
  }
  const permit = c.permit_delivery_date;
  const start = addDays(permit, 1);       // día 1
  const lastDay = addDays(permit, days);  // día N
  const freeDate = addDays(permit, days + 1);
  let state, elapsed;
  if (today < start) { state = 'por_iniciar'; elapsed = 0; }
  else if (today <= lastDay) { state = 'vigente'; elapsed = diffDays(start, today) + 1; }
  else { state = 'cumplida'; elapsed = days; }
  return { state, days, permit, start, last_day: lastDay, free_date: freeDate, elapsed, remaining: days - elapsed };
}

// ---------- Días hábiles ----------
function parseHolidays(text) {
  const set = new Set();
  for (const m of String(text || '').matchAll(/\d{4}-\d{2}-\d{2}/g)) if (isValidISO(m[0])) set.add(m[0]);
  return set;
}
function isBusinessDay(iso, holidays) {
  const dow = new Date(parseISO(iso)).getUTCDay();
  return dow !== 0 && dow !== 6 && !(holidays && holidays.has(iso));
}
// n días hábiles después de `iso` (el día de partida no cuenta). Lunes a viernes, sin feriados.
function addBusinessDays(iso, n, holidays) {
  let d = iso, left = n;
  while (left > 0) { d = addDays(d, 1); if (isBusinessDay(d, holidays)) left--; }
  return d;
}
const RESEND_DAYS = 5;
function resendDue(c, settings) {
  if (!c.is_resend || !c.notification_date || c.receipt_date) return null;
  return addBusinessDays(c.notification_date, RESEND_DAYS, parseHolidays(settings && settings.holidays));
}

// Alertas y acciones de una causa. kind: 'plazo' | 'accion' | 'suspension' | 'revisar'
function alertsFor(c, settings, today) {
  const out = [];
  const stage = stageOf(c);
  const sentenceDays = Number(settings.alert_sentence_days) || 30;
  const paymentDays = Number(settings.alert_payment_days) || 30;

  if (c.needs_review) {
    out.push({ kind: 'revisar', severity: 'info', code: 'revisar', title: 'Revisar fechas (dato migrado incompleto)', due_date: null, days_left: null });
  }

  const deadline = (code, title, since, span) => {
    const due = addDays(since, span);
    const left = diffDays(today, due);
    if (left < 0) out.push({ kind: 'plazo', severity: 'vencido', code, title, due_date: due, days_left: left });
    else if (left <= WARN_DAYS) out.push({ kind: 'plazo', severity: 'proximo', code, title, due_date: due, days_left: left });
  };

  if (!c.needs_review) {
    if (stage === 'ingresado') {
      out.push({ kind: 'accion', severity: 'info', code: 'enviar_carta', title: 'Enviar carta al juzgado remitente', due_date: null, days_left: null });
    } else if (stage === 'carta') {
      const n = Number(c.reminder_count) || 0;
      const last = c.last_reminder ? String(c.last_reminder).slice(0, 10) : null;
      if (n > 0 && last) {
        // Ya se reclamó al juzgado: la causa queda "esperando respuesta" hasta que pasen los días de espera.
        const waitDays = Number(settings.alert_reminder_wait_days) || 15;
        const until = addDays(last, waitDays);
        const left = diffDays(today, until);
        if (left >= 0) {
          out.push({ kind: 'espera', severity: 'info', code: 'esperando_respuesta', title: `${n}° recordatorio enviado el ${last.split('-').reverse().join('-')}: esperando respuesta del juzgado`,
            due_date: until, days_left: left, reminder_count: n, last_reminder: last, escalate: n >= 3 });
        } else {
          out.push({ kind: 'plazo', severity: 'vencido', code: 'sentencia_atrasada', title: `Sin respuesta al ${n}° recordatorio${n >= 3 ? ': llamar al juzgado' : ''}`,
            due_date: until, days_left: left, reminder_count: n, last_reminder: last, escalate: n >= 3 });
        }
      } else {
        deadline('sentencia_atrasada', `Sin sentencia ${sentenceDays} días después de enviar la carta`, c.letter_sent_date, sentenceDays);
      }
    } else if (stage === 'sentencia') {
      out.push({ kind: 'accion', severity: 'info', code: 'notificar', title: 'Notificar la sentencia al infractor', due_date: null, days_left: null });
    } else if (stage === 'notificado') {
      if (c.is_resend && needsPayment(c.resolution)) {
        const due = resendDue(c, settings);
        const left = diffDays(today, due);
        if (left < 0) out.push({ kind: 'plazo', severity: 'vencido', code: 'reenvio_vencido', title: 'Reenvío sin pago en 5 días hábiles: devolver al tribunal y archivar', due_date: due, days_left: left });
        else if (left <= 2) out.push({ kind: 'plazo', severity: 'proximo', code: 'reenvio_vencido', title: 'Reenvío: vence el plazo de 5 días hábiles para pagar', due_date: due, days_left: left });
      } else if (needsPayment(c.resolution)) {
        deadline('comprobante_atrasado', `Sin comprobante de pago ${paymentDays} días después de notificar`, c.notification_date, paymentDays);
      } else {
        out.push({ kind: 'accion', severity: 'info', code: 'cerrar', title: 'Sin pago: corresponde archivar', due_date: null, days_left: null });
      }
    } else if (stage === 'comprobante') {
      out.push({ kind: 'accion', severity: 'info', code: 'archivar', title: 'Comprobante recibido: archivar la causa', due_date: null, days_left: null });
    }
  }

  const s = suspensionInfo(c, today);
  if (s && !c.final_status) {
    if (s.state === 'sin_permiso') {
      out.push({ kind: 'suspension', severity: 'info', code: 'permiso_pendiente', title: `Suspensión de ${s.days} días: falta la entrega del permiso provisorio`, due_date: null, days_left: null });
    } else if (s.state === 'vigente') {
      out.push({ kind: 'suspension', severity: 'info', code: 'suspension_vigente', title: `Suspensión vigente: día ${s.elapsed} de ${s.days}`, due_date: s.free_date, days_left: diffDays(today, s.free_date) });
    }
  }
  return out;
}

// ---------- Textos ----------
const NAME_PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e']);
function titleCaseName(name) {
  return String(name || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    .map((w, i) => (i > 0 && NAME_PARTICLES.has(w) ? w : w.replace(/(^|[-'])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase()))).join(' ');
}
// "Estimado Jorge:" / "Estimada María:". mode 'first' = primer nombre, 'full' = nombre completo. Sin nombre: "Estimado:".
function greeting(gender, name, mode = 'first') {
  const base = gender === 'M' ? 'Estimado' : gender === 'F' ? 'Estimada' : 'Estimado/a';
  const clean = String(name || '').trim();
  if (!clean) return `${base}:`;
  const shown = mode === 'full' ? titleCaseName(clean) : titleCaseName(clean.split(/\s+/)[0]);
  return `${base} ${shown}:`;
}

function complianceParagraph(types) {
  const set = new Set(types || []);
  if (set.has('Absolución')) return 'según lo resuelto en sentencia, la causa ha concluido por absolución.';
  if (set.has('Amonestación')) return 'según lo resuelto en sentencia, la causa ha concluido con amonestación.';
  const parts = [];
  if (set.has('Vale Vista')) parts.push('mediante la entrega de un Vale Vista a nombre de la Municipalidad');
  if (set.has('Transferencia')) parts.push('vía Transferencia Bancaria');
  if (set.has('Página Web')) parts.push('a través de la página web correspondiente');
  if (!parts.length) return 'conforme a lo resuelto en sentencia.';
  if (parts.length === 1) return `${parts[0]}, haciendo entrega del comprobante en este Juzgado.`;
  const last = parts.pop();
  return `${parts.join(', ')} o ${last}, haciendo entrega del comprobante en este Juzgado.`;
}

// ---------- Plantillas editables ----------
const TEMPLATE_VARS = {
  carta: [['rol', 'Rol del exhorto'], ['juzgado_remitente', 'Juzgado remitente'], ['fecha_ingreso', 'Fecha de ingreso'], ['firma', 'Firma (nombre de tu juzgado)'], ['pie_firma', 'Pie de firma (se define en Ajustes)']],
  recordatorio: [['roles', 'Roles de los exhortos (para el asunto)'], ['juzgado_remitente', 'Juzgado remitente'], ['introduccion', 'Párrafo inicial (automático, singular o plural)'], ['listado', 'Listado de exhortos con sus datos (automático)'], ['solicitud', 'Texto de lo que se solicita (automático)'], ['cierre', 'Texto de cierre de los exhortos (automático)'], ['plazo', 'Días de plazo de la sentencia (de Ajustes)'], ['firma', 'Firma (nombre de tu juzgado)'], ['pie_firma', 'Pie de firma (se define en Ajustes)']],
  sentencia: [['saludo', 'Saludo (Estimado/Estimada)'], ['rol', 'Rol del exhorto'], ['juzgado_remitente', 'Juzgado remitente'], ['cumplimiento', 'Párrafo de forma de pago (automático)'], ['avisos', 'Avisos de suspensión, plazo o reenvío (automático)'], ['firma', 'Firma (nombre de tu juzgado)'], ['pie_firma', 'Pie de firma (se define en Ajustes)']]
};
const DEFAULT_TEMPLATES = {
  carta: {
    subject: 'Solicitud de sentencia - Exhorto Rol {rol}',
    body: `Estimados:

Junto con saludar, solicitamos remitir copia de la sentencia dictada en la causa Rol N.º {rol}, correspondiente al exhorto ingresado en este Juzgado con fecha {fecha_ingreso}, a fin de proceder con la notificación del infractor.

Quedamos atentos a su respuesta.

Saluda atentamente a ustedes,

{firma}`
  },
  recordatorio: {
    subject: 'Reitera solicitud de sentencia - {roles}',
    body: `Señor(a) Juez(a)
{juzgado_remitente}
Presente

De mi consideración:

{introduccion}

{listado}

En virtud de lo anterior, solicito a usted tenga a bien remitir a la brevedad {solicitud}, o bien informar el estado actual de su tramitación, a fin de dar cumplimiento a lo ordenado y poder cerrar {cierre} en este Juzgado.

Sin otro particular, y agradeciendo de antemano su colaboración, saluda atentamente a usted.`
  },
  sentencia: {
    subject: '[Notificación sentencia] - Exhorto Rol {rol}',
    body: `{saludo}

Junto con saludar, se adjunta copia de la sentencia correspondiente al exhorto Rol N.º {rol}, remitido por el {juzgado_remitente}.

{cumplimiento}

{avisos}

Saluda atentamente a usted,

{firma}`
  }
};
// Devuelve los marcadores {x} que no existen para ese tipo de correo.
function unknownPlaceholders(kind, ...texts) {
  const known = new Set((TEMPLATE_VARS[kind] || []).map(v => v[0]));
  const bad = new Set();
  for (const t of texts) for (const m of String(t || '').matchAll(/\{([^{}]*)\}/g)) if (!known.has(m[1])) bad.add(m[0]);
  return [...bad];
}
function renderTemplate(text, vars) {
  return String(text || '')
    .replace(/\{([a-z_]+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Pie de firma: va donde esté {pie_firma}; si la plantilla no lo usa, se agrega al final.
function withFooter(tplBody, vars, footer) {
  const f = String(footer || '').trim();
  const vv = { ...vars, pie_firma: f };
  let body = renderTemplate(tplBody, vv);
  if (f && !String(tplBody).includes('{pie_firma}')) body += '\n\n' + f;
  return body;
}

function buildSentenceEmail({ rol, gender, offenderName, greetingName, courtName, resolution, suspensionDays, includeSuspension, isResend, signer, paymentDays, template, footer }) {
  const types = parseResolution(resolution);
  const noPay = !needsPayment(resolution);
  const extras = [];
  if (includeSuspension) {
    const d = Number(suspensionDays) || 0;
    extras.push(d
      ? `IMPORTANTE: La suspensión de su licencia de conducir por ${d} días comenzará a regir una vez que haga entrega del permiso provisorio en este Juzgado.`
      : 'IMPORTANTE: La suspensión de su licencia comenzará a regir una vez entregado el permiso provisorio en este Juzgado.');
  }
  if (isResend) {
    extras.push('ADVERTENCIA: Al ser reenvío, tiene un plazo de 5 días hábiles para pagar o se devolverán los antecedentes al tribunal remitente.');
  } else if (!noPay && paymentDays) {
    extras.push(`Asimismo, el comprobante de pago debe ser entregado dentro de ${paymentDays} días desde esta notificación.`);
  }
  const cumplimiento = noPay
    ? `Se hace presente que ${complianceParagraph(types)}`
    : `Se hace presente que deberá proceder al pago ${complianceParagraph(types)}`;
  const vars = {
    saludo: greeting(gender, offenderName, greetingName), rol, juzgado_remitente: courtName || 'Juzgado de Policía Local correspondiente',
    cumplimiento, avisos: extras.join('\n\n'), firma: signer
  };
  const t = { ...DEFAULT_TEMPLATES.sentencia, ...(template || {}) };
  return { subject: renderTemplate(t.subject, vars), body: withFooter(t.body, vars, footer) };
}

function buildCourtLetterEmail({ rol, courtName, entryDate, signer, template, footer }) {
  const vars = { rol, juzgado_remitente: courtName || '', fecha_ingreso: entryDate || '—', firma: signer };
  const t = { ...DEFAULT_TEMPLATES.carta, ...(template || {}) };
  return { subject: renderTemplate(t.subject, vars), body: withFooter(t.body, vars, footer) };
}

// "12345678-5" -> "12.345.678-5". Si no parece un RUT, se deja tal cual.
function formatRut(rut) {
  const raw = String(rut || '').trim();
  const m = /^(\d{1,2})\.?(\d{3})\.?(\d{3})\s*-\s*([\dkK])$/.exec(raw);
  return m ? `${m[1]}.${m[2]}.${m[3]}-${m[4].toUpperCase()}` : raw;
}
const fmtDMY = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };

// Un solo correo para un juzgado remitente con una o varias causas sin sentencia.
// cases: [{ rol, offender_name, offender_rut, citation_number, tracking_code, entry_date, letter_sent_date, due_date }]
function buildReminderEmail({ courtName, cases, paymentDays, sentenceDays, today, signer, template, footer }) {
  const many = cases.length > 1;
  const items = cases.map((c, i) => {
    const parts = [`Rol ${c.rol}`];
    if (c.offender_name) parts.push(`infractor ${titleCaseName(c.offender_name)}`);
    if (c.offender_rut) parts.push(`RUT ${formatRut(c.offender_rut)}`);
    let line = parts.join(', ') + '.';
    if (c.citation_number) line += ` Boleta de citación N° ${c.citation_number}.`;
    if (c.entry_date) line += ` Exhorto ingresado el ${fmtDMY(c.entry_date)}.`;
    if (c.letter_sent_date) line += ` Carta enviada el ${fmtDMY(c.letter_sent_date)}`;
    if (c.due_date) line += `${c.letter_sent_date ? ';' : ''} plazo ${today && c.due_date >= today ? 'vence' : 'vencido'} el ${fmtDMY(c.due_date)}`;
    if (c.letter_sent_date || c.due_date) line += '.';
    if (c.tracking_code) line += ` Código de seguimiento de Correos: ${c.tracking_code}.`;
    return many ? `${i + 1}. ${line}` : line;
  });
  const roles = cases.map(c => `Rol ${c.rol}`);
  const rolesTxt = roles.length > 1 ? `${roles.slice(0, -1).join(', ')} y ${roles[roles.length - 1]}` : roles[0] || '';
  const days = Number(sentenceDays) || 30;
  const vars = {
    roles: rolesTxt, juzgado_remitente: courtName || '', plazo: String(days), firma: signer,
    introduccion: many
      ? `Junto con saludar, me dirijo a usted en relación con los exhortos ingresados en este Juzgado y remitidos por ese Tribunal, que a la fecha no registran respuesta con la sentencia respectiva, habiéndose cumplido el plazo de ${days} días desde el envío de nuestras cartas:`
      : `Junto con saludar, me dirijo a usted en relación con el exhorto ingresado en este Juzgado y remitido por ese Tribunal, que a la fecha no registra respuesta con la sentencia respectiva, habiéndose cumplido el plazo de ${days} días desde el envío de nuestra carta:`,
    listado: items.join('\n\n'),
    solicitud: many ? 'copia de la sentencia dictada en cada una de las causas' : 'copia de la sentencia dictada en la causa',
    cierre: many ? 'los exhortos' : 'el exhorto'
  };
  const t = { ...DEFAULT_TEMPLATES.recordatorio, ...(template || {}) };
  return { subject: renderTemplate(t.subject, vars), body: withFooter(t.body, vars, footer) };
}

module.exports = {
  COMPLIANCE_TYPES, NO_PAYMENT_TYPES, STAGES, WARN_DAYS,
  parseISO, fmtISO, addDays, diffDays, todayISO, isValidISO,
  parseResolution, stringifyResolution, needsPayment,
  parseHolidays, isBusinessDay, addBusinessDays, resendDue, RESEND_DAYS,
  stageOf, suspensionInfo, alertsFor,
  buildSentenceEmail, buildCourtLetterEmail, buildReminderEmail, formatRut,
  greeting, TEMPLATE_VARS, DEFAULT_TEMPLATES, unknownPlaceholders, renderTemplate
};
