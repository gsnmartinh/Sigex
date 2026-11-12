'use strict';

const { crc32 } = require('node:zlib');

const MODELS = {
  x10: { title: 'X10 · Resolución que remite el recurso' },
  x11: { title: 'X11 · Oficio que remite el recurso', matter: 'Remite recurso', person: true },
  x26web: { title: 'X26 · Certificación de pago web', payment: true },
  x05web: { title: 'X05 · Oficio que remite el pago web', matter: 'Remite comprobante de pago web', payment: true }
};

function required(value, label) {
  const cleaned = String(value ?? '').trim();
  if (!cleaned) throw new Error('Completa ' + label + '.');
  return cleaned;
}

function dateText(value, label) {
  const date = new Date(value + 'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Indica una fecha válida para ' + label + '.');
  }
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

function buildDocument(c, input, homeCourt) {
  const model = Object.hasOwn(MODELS, input.model) && MODELS[input.model];
  if (!model) throw new Error('Modelo de documento desconocido.');
  const date = dateText(input.date, 'la emisión');
  const judge = required(input.judge, 'el nombre de quien ejerce como juez');
  const judgeRole = required(input.judgeRole, 'el cargo de quien ejerce como juez');
  const secretary = input.model === 'x10' ? '' : required(input.secretary, 'el nombre de Secretaría');
  const secretaryRole = input.model === 'x10' ? '' : required(input.secretaryRole, 'el cargo de Secretaría');
  const local = required(c.rol, 'el rol local');
  const issued = 'Valdivia, ' + date;
  const provided = 'Proveyó ' + judge + ', ' + judgeRole + ' del ' + homeCourt + '.';
  let payment;
  if (model.payment) {
    const amount = Number(input.amount);
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Ingresa el monto en pesos.');
    payment = '$' + new Intl.NumberFormat('es-CL').format(amount) + ' a través de ' + required(input.platform, 'la plataforma municipal');
  }
  if (input.model === 'x10') {
    return [issued, '', 'Por interpuesto el recurso, remítase al tribunal exhortado.', '', 'Causa Rol N.º ' + local, '', provided];
  }
  if (input.model === 'x26web') {
    const received = dateText(input.received || c.receipt_date, 'la recepción del comprobante');
    return [issued, '', 'CERTIFICO: Que el ' + received + ' se recibió en este Tribunal el comprobante de pago por ' + payment + ', correspondiente a la multa aplicada en la causa de referencia.', '', 'Causa Rol N.º ' + local, '', secretary, secretaryRole, '', issued, '', 'Remítase el comprobante al tribunal correspondiente. Ofíciese.', '', provided];
  }
  const origin = required(input.origin, 'el rol del tribunal de origen');
  const court = required(c.court_name, 'el tribunal destinatario');
  const ord = input.preview ? '[Pendiente de emisión]' : required(input.ord, 'el ORD. registrado');
  const body = model.person
    ? 'En el exhorto Rol N.º ' + local + ', de este Tribunal, se remite el escrito de recurso interpuesto por ' + required(c.offender_name, 'el nombre en la ficha') + ', RUT ' + required(c.offender_rut, 'el RUT en la ficha') + ', en la causa Rol N.º ' + origin + ' de ese Tribunal.'
    : 'En el exhorto Rol N.º ' + local + ', de este Tribunal, se remite el comprobante de pago por ' + payment + ', correspondiente a la multa impuesta en la causa Rol N.º ' + origin + ' de ese Tribunal.';
  return ['ORD.: ' + ord, 'ANT.: Causa Rol N.º ' + local, 'MAT.: ' + model.matter, '', issued, '', 'DE: ' + judgeRole + ' del ' + homeCourt, 'A: Juzgado destinatario — ' + court, '', body, '', 'Saluda atentamente a S.S.', '', secretary, secretaryRole, '', judge, judgeRole];
}

function escapeXml(value) {
  return value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}

// Un DOCX mínimo contiene el documento y dos archivos de metadatos en un ZIP.
function makeDocx(lines) {
  const ns = 'http://schemas.openxmlformats.org';
  const paragraphs = lines.map(line => '<w:p><w:r><w:t xml:space="preserve">' + escapeXml(line) + '</w:t></w:r></w:p>').join('');
  const entries = {
    '[Content_Types].xml': '<Types xmlns="' + ns + '/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="' + ns + '/package/2006/relationships"><Relationship Id="rId1" Type="' + ns + '/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="' + ns + '/wordprocessingml/2006/main"><w:body>' + paragraphs + '</w:body></w:document>'
  };
  const files = [];
  const directory = [];
  let offset = 0;
  for (const [name, xml] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(xml);
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    files.push(local, filename, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + bytes.length;
  }
  const index = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, index, end]);
}

module.exports = { MODELS, buildDocument, makeDocx };
