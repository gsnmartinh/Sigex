'use strict';

const { crc32, inflateRawSync } = require('node:zlib');

const MODELS = {
  "x03sin": {
    "title": "X03 · Solicitud sin licencia",
    "stage": "solicitud",
    "fields": [
      {
        "name": "address",
        "label": "Domicilio",
        "required": true
      }
    ]
  },
  "x03con": {
    "title": "X03 · Solicitud con licencia",
    "stage": "solicitud",
    "fields": [
      {
        "name": "address",
        "label": "Domicilio",
        "required": true
      }
    ]
  },
  "x06": {
    "title": "X06 · Permiso provisorio",
    "stage": "solicitud",
    "fields": [
      {
        "name": "address",
        "label": "Domicilio",
        "required": true
      },
      {
        "name": "licenseClass",
        "label": "Clase de licencia",
        "required": true
      },
      {
        "name": "licenseNumber",
        "label": "Número de licencia",
        "required": true
      },
      {
        "name": "municipality",
        "label": "Municipalidad",
        "required": true
      },
      {
        "name": "granted",
        "label": "Fecha de otorgamiento",
        "type": "date",
        "required": false
      },
      {
        "name": "control",
        "label": "Fecha de control",
        "type": "date",
        "required": false
      },
      {
        "name": "expires",
        "label": "Válido hasta",
        "type": "date",
        "required": false
      }
    ]
  },
  "reiterar": {
    "title": "Resolución · Reitera sentencia",
    "stage": "reiteracion",
    "fields": []
  },
  "x08": {
    "title": "X08 · Reitera licencia y concede nuevo permiso",
    "stage": "reiteracion",
    "fields": []
  },
  "x32": {
    "title": "X32 · Oficio de reiteración",
    "stage": "reiteracion",
    "matter": "Reitera solicitud",
    "fields": [
      {
        "name": "requested",
        "label": "Qué se reitera",
        "type": "select",
        "options": [
          [
            "sentencia",
            "Sentencia"
          ],
          [
            "licencia",
            "Licencia"
          ],
          [
            "ambas",
            "Sentencia y licencia"
          ]
        ],
        "required": true
      },
      {
        "name": "dispatch",
        "label": "Fecha del despacho original",
        "type": "date",
        "required": true
      },
      {
        "name": "ord",
        "label": "ORD. registrado",
        "required": true
      }
    ]
  },
  "x26vale": {
    "title": "X26 · Certificación de vale vista",
    "stage": "pago",
    "fields": [
      {
        "name": "received",
        "label": "Recepción del comprobante",
        "type": "date",
        "required": true
      },
      {
        "name": "amount",
        "label": "Monto en pesos",
        "type": "number",
        "required": true
      },
      {
        "name": "bank",
        "label": "Banco",
        "required": true
      },
      {
        "name": "serial",
        "label": "Serie del vale vista",
        "required": true
      }
    ]
  },
  "x26transfer": {
    "title": "X26 · Certificación de transferencia",
    "stage": "pago",
    "fields": [
      {
        "name": "received",
        "label": "Recepción del comprobante",
        "type": "date",
        "required": true
      },
      {
        "name": "amount",
        "label": "Monto en pesos",
        "type": "number",
        "required": true
      },
      {
        "name": "bank",
        "label": "Banco",
        "required": true
      }
    ]
  },
  "x05vale": {
    "title": "X05 · Remite vale vista",
    "stage": "pago",
    "matter": "Remite vale vista",
    "fields": [
      {
        "name": "origin",
        "label": "Rol del tribunal de origen",
        "required": true
      },
      {
        "name": "amount",
        "label": "Monto en pesos",
        "type": "number",
        "required": true
      },
      {
        "name": "bank",
        "label": "Banco",
        "required": true
      },
      {
        "name": "serial",
        "label": "Serie del vale vista",
        "required": true
      },
      {
        "name": "municipality",
        "label": "Municipalidad",
        "required": true
      },
      {
        "name": "ord",
        "label": "ORD. registrado",
        "required": true
      }
    ]
  },
  "x05transfer": {
    "title": "X05 · Remite comprobante de transferencia",
    "stage": "pago",
    "matter": "Remite comprobante de transferencia",
    "fields": [
      {
        "name": "origin",
        "label": "Rol del tribunal de origen",
        "required": true
      },
      {
        "name": "amount",
        "label": "Monto en pesos",
        "type": "number",
        "required": true
      },
      {
        "name": "bank",
        "label": "Banco",
        "required": true
      },
      {
        "name": "municipality",
        "label": "Municipalidad",
        "required": true
      },
      {
        "name": "ord",
        "label": "ORD. registrado",
        "required": true
      }
    ]
  },
  "x30": {
    "title": "X30 · Resolución de devolución",
    "stage": "devolucion",
    "fields": []
  },
  "x31": {
    "title": "X31 · Informa no concurrencia",
    "stage": "devolucion",
    "matter": "Informa no concurrencia",
    "fields": [
      {
        "name": "origin",
        "label": "Rol del tribunal de origen",
        "required": true
      },
      {
        "name": "ord",
        "label": "ORD. registrado",
        "required": true
      }
    ]
  },
  "devolverLicencia": {
    "title": "Oficio · Devuelve licencia por no pago",
    "stage": "devolucion",
    "matter": "Devuelve licencia por no pago",
    "fields": [
      {
        "name": "origin",
        "label": "Rol del tribunal de origen",
        "required": true
      },
      {
        "name": "ord",
        "label": "ORD. registrado",
        "required": true
      }
    ]
  },
  "x09sinLicencia": {
    "title": "X09 · Archivo sin licencia",
    "stage": "archivo",
    "fields": [
      {
        "name": "folio",
        "label": "Foja de la solicitud",
        "required": true
      },
      {
        "name": "method",
        "label": "Medio de pago",
        "type": "select",
        "options": [
          [
            "vale",
            "Vale vista"
          ],
          [
            "transfer",
            "Transferencia"
          ],
          [
            "web",
            "Plataforma municipal"
          ],
          [
            "none",
            "Sin multa que pagar"
          ]
        ],
        "required": true
      }
    ]
  },
  "x09sinSuspension": {
    "title": "X09 · Archivo sin suspensión",
    "stage": "archivo",
    "fields": [
      {
        "name": "folio",
        "label": "Foja de la solicitud",
        "required": true
      },
      {
        "name": "method",
        "label": "Medio de pago",
        "type": "select",
        "options": [
          [
            "vale",
            "Vale vista"
          ],
          [
            "transfer",
            "Transferencia"
          ],
          [
            "web",
            "Plataforma municipal"
          ],
          [
            "none",
            "Sin multa que pagar"
          ]
        ],
        "required": true
      }
    ]
  },
  "x09conSuspension": {
    "title": "X09 · Archivo con suspensión",
    "stage": "archivo",
    "fields": [
      {
        "name": "folio",
        "label": "Foja de la solicitud",
        "required": true
      },
      {
        "name": "method",
        "label": "Medio de pago",
        "type": "select",
        "options": [
          [
            "vale",
            "Vale vista"
          ],
          [
            "transfer",
            "Transferencia"
          ],
          [
            "web",
            "Plataforma municipal"
          ],
          [
            "none",
            "Sin multa que pagar"
          ]
        ],
        "required": true
      }
    ]
  },
  "x10": {
    "title": "X10 · Resolución que remite el recurso",
    "stage": "recurso",
    "fields": []
  },
  "x11": {
    "title": "X11 · Oficio que remite el recurso",
    "stage": "recurso",
    "matter": "Remite recurso",
    "fields": [
      {
        "name": "origin",
        "label": "Rol del tribunal de origen",
        "required": true
      },
      {
        "name": "ord",
        "label": "ORD. registrado",
        "required": true
      }
    ]
  },
  "x26web": {
    "title": "X26 · Certificación de pago web",
    "stage": "pago",
    "fields": [
      {
        "name": "received",
        "label": "Recepción del comprobante",
        "type": "date",
        "required": true
      },
      {
        "name": "amount",
        "label": "Monto en pesos",
        "type": "number",
        "required": true
      },
      {
        "name": "platform",
        "label": "Plataforma municipal",
        "required": true
      }
    ]
  },
  "x05web": {
    "title": "X05 · Oficio que remite el pago web",
    "stage": "pago",
    "matter": "Remite comprobante de pago web",
    "fields": [
      {
        "name": "origin",
        "label": "Rol del tribunal de origen",
        "required": true
      },
      {
        "name": "amount",
        "label": "Monto en pesos",
        "type": "number",
        "required": true
      },
      {
        "name": "platform",
        "label": "Plataforma municipal",
        "required": true
      },
      {
        "name": "ord",
        "label": "ORD. registrado",
        "required": true
      }
    ]
  }
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
  const key = input.model;
  const model = Object.hasOwn(MODELS, key) && MODELS[key];
  if (!model) throw new Error('Modelo de documento desconocido.');
  const issued = 'Valdivia, ' + dateText(input.date, 'la emisión');
  const value = (name, label) => required(input[name], label || model.fields.find(f => f.name === name)?.label || name);
  const local = required(c.rol, 'el rol local');
  const role = 'Causa Rol N.º ' + local;
  const court = required(c.court_name, 'el juzgado destinatario');
  const judge = required(input.judge, 'el nombre del juez');
  const judgeRole = required(input.judgeRole, 'el cargo del juez');
  const provided = 'Proveyó ' + judge + ', ' + judgeRole + ' del ' + homeCourt + '.';
  const secretary = () => [required(input.secretary, 'el nombre de Secretaría'), required(input.secretaryRole, 'el cargo de Secretaría')];
  const signatures = () => [...secretary().map(value => value.toUpperCase()), '', judge.toUpperCase(), judgeRole.toUpperCase()];
  const resolution = text => [issued, '', text, '', role, '', provided];
  const person = () => required(c.offender_name, 'el nombre en la ficha') + ', cédula de identidad N.º ' + required(c.offender_rut, 'el RUT en la ficha');
  const origin = () => 'causa Rol N.º ' + value('origin') + ' de ese tribunal';
  const of = text => ['ORD.: ' + value('ord'), 'ANT.: ' + role, 'MAT.: ' + model.matter, '', issued, '', ('DE: ' + judgeRole + ' del ' + homeCourt).toUpperCase(), ('A: ' + court).toUpperCase(), '', text, '', 'Saluda atentamente a S.S.', '', ...signatures()];
  const money = () => {
    const amount = Number(input.amount);
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Ingresa el monto en pesos.');
    return '$' + new Intl.NumberFormat('es-CL').format(amount);
  };
  const payment = method => {
    if (method === 'web') return 'comprobante de pago por ' + money() + ' a través de ' + value('platform');
    if (method === 'transfer') return 'comprobante de transferencia por ' + money() + ' del banco ' + value('bank');
    return 'vale vista serie N.º ' + value('serial') + ' por ' + money() + ', emitido por el banco ' + value('bank');
  };
  if (model.stage === 'pago') {
    const method = key.slice(3);
    const instrument = payment(method);
    if (model.matter) {
      const treasury = method === 'web' ? '' : ', a nombre de la Tesorería Municipal de ' + value('municipality');
      return of('En el exhorto de referencia se remite ' + instrument + treasury + ', correspondiente a la multa impuesta en la ' + origin() + '.');
    }
    const received = dateText(input.received || c.receipt_date, 'la recepción del comprobante');
    return [issued, '', 'CERTIFICO: Que el ' + received + ' se recibió en este Tribunal el ' + instrument + ', correspondiente a la multa aplicada en la causa de referencia.', '', role, '', ...secretary().map(value => value.toUpperCase()), '', issued, 'Remítase el documento al tribunal correspondiente. Ofíciese.', '', provided];
  }
  if (key === 'x03sin' || key === 'x03con') {
    const retained = key === 'x03con';
    const request = retained ? ' Se solicita asimismo la remisión de su licencia de conducir y el otorgamiento de un permiso provisorio por treinta días.' : '';
    const ruling = retained ? 'Como se pide, exhórtese al tribunal referido. Solicítese la licencia de conducir, que se entregará previo pago de la multa y una vez cumplida la suspensión, en su caso. Otórguese permiso provisorio por treinta días. Sirva la presente resolución de suficiente oficio remisor.' : 'Como se pide, exhórtese al tribunal referido y solicítese que remita copia de la sentencia dictada en autos.';
    return ['EXHORTO N.º ' + local, '', issued, '', 'Comparece ' + person() + ', con domicilio en ' + value('address') + ', quien solicita exhortar al ' + court + ' para la notificación de la resolución dictada en la causa de la boleta de citación que se acompaña, conforme al artículo 5, inciso segundo, de la Ley N.º 18.287.' + request, '', 'Firma de la persona compareciente', '', issued, '', ruling, '', ...signatures(), '', 'AL JUEZ DEL ' + court];
  }
  if (key === 'x06') return [role, '', 'PERMISO PROVISORIO DE CONDUCTOR (ART. 63 DE LA LEY N.º 15.231)', '', issued, person(), 'Domicilio: ' + value('address'), 'Clase: ' + value('licenseClass'), 'Licencia N.º ' + value('licenseNumber'), 'Municipalidad: ' + value('municipality'), 'Otorgada: ' + (input.granted ? dateText(input.granted, 'el otorgamiento') : 'XXXX'), 'Fecha de control: ' + (input.control ? dateText(input.control, 'el control') : 'XXXX'), 'Válido hasta: ' + (input.expires ? dateText(input.expires, 'el vencimiento') : 'XXXX'), '', ...signatures()];
  if (key === 'reiterar') return resolution('No habiéndose recibido la sentencia, reitérese al tribunal exhortado la solicitud de remisión de la sentencia.');
  if (key === 'x08') return resolution('No habiéndose recibido la licencia del denunciado de autos, concédase nuevo permiso provisorio de conducir por treinta días. Reitérese al tribunal exhortado la solicitud de remisión de la licencia.');
  if (key === 'x32') {
    const items = { sentencia: 'la sentencia', licencia: 'la licencia de conducir', ambas: 'la sentencia y la licencia de conducir' };
    const pending = Object.hasOwn(items, input.requested) && items[input.requested];
    if (!pending) throw new Error('Selecciona qué diligencia se reitera.');
    return of('En el exhorto de referencia, seguido respecto de ' + person() + ', se reitera la solicitud de remisión de ' + pending + ', efectuada con fecha ' + dateText(input.dispatch, 'el despacho original') + '.');
  }
  if (key === 'x30') return resolution('VISTOS: El estado de la causa. Ofíciese al ' + court + ' para informar que no se ha acreditado el pago de la multa y devolver el exhorto. Hecho, archívese.');
  if (key === 'x31' || key === 'devolverLicencia') return of('En el exhorto de referencia, se informa que no se ha acreditado el pago de la multa impuesta en la ' + origin() + '.' + (key === 'devolverLicencia' ? ' Se remite adjunta la licencia de conducir original para los fines que correspondan.' : ''));
  if (model.stage === 'archivo') {
    const methods = { vale: 'vale vista del banco', transfer: 'transferencia bancaria del banco', web: 'pago en la plataforma municipal' };
    const method = input.method;
    if (method !== 'none' && !Object.hasOwn(methods, method)) throw new Error('Selecciona el medio de pago.');
    const paid = method === 'none' ? '' : ', el pago acreditado mediante ' + methods[method] + ' ' + value(method === 'web' ? 'platform' : 'bank', method === 'web' ? 'la plataforma municipal' : 'el banco');
    const license = key === 'x09sinLicencia' ? '' : key === 'x09conSuspension' ? ', el cumplimiento de la suspensión y la devolución de la licencia' : ', la devolución de la licencia';
    return resolution('VISTOS: La solicitud de fojas ' + value('folio') + ', la sentencia remitida por el tribunal exhortado' + paid + license + ' y lo dispuesto en el artículo 5 de la Ley N.º 18.287. Archívense estos antecedentes.');
  }
  if (key === 'x10') return resolution('Por interpuesto el recurso, remítase al tribunal exhortado.');
  return of('En el exhorto de referencia, se remite el escrito de recurso interpuesto por ' + person() + ' en la ' + origin() + '.');
}

function escapeXml(value) {
  return value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}

// Un DOCX mínimo contiene el documento y dos archivos de metadatos en un ZIP.
function readDocx(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([80,75,5,6]));
  if (end < 0) throw new Error('La plantilla no es un archivo Word válido.');
  let offset = bytes.readUInt32LE(end + 16);
  const entries = Object.create(null);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Plantilla dañada.');
    const length = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + length);
    const local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
    const method = bytes.readUInt16LE(offset + 10);
    if (method !== 0 && method !== 8) throw new Error('Compresión de plantilla no compatible.');
    entries[name] = method === 8 ? inflateRawSync(data, { maxOutputLength: 32 * 1024 * 1024 }) : data;
    offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return entries;
}

function makeDocx(lines, input, c, custom) {
  const template = require('../data/word-templates/' + input.model + '.json');
  const entries = Object.fromEntries(Object.entries(template).map(([name, bytes]) => [name, Buffer.from(bytes, 'base64')]));
  if (!lines) return packDocx(entries);
  const fields = {
    court: c.court_name.toUpperCase(), origin: 'ROL DE ORIGEN: ' + input.origin, empty: '',
    remit: 'Remítase el documento al tribunal correspondiente.', office: 'Ofíciese.',
    vistos: 'VISTOS: El estado de la causa en el exhorto N.º ' + c.rol + '.',
    x30: lines[2].replace(/^VISTOS: El estado de la causa\. /, ''),
    person: 'Comparece: ' + c.offender_name, rut: 'Cédula de identidad: ' + c.offender_rut,
    request: input.model.startsWith('x03') ? lines[4].replace(/^.*?, con domicilio en /, 'Domicilio: ') : '',
    ruling: input.model.startsWith('x03') ? lines[10].replace(/ Sirva la presente resolución de suficiente oficio remisor\.$/, '') : '',
    remisor: input.model === 'x03con' ? 'Sirva la presente resolución de suficiente oficio remisor.' : '',
    nameUpper: 'NOMBRE: ' + c.offender_name, rutUpper: 'CÉDULA DE IDENTIDAD: ' + c.offender_rut,
    license: [lines[7], lines[8], lines[9]].join('    '),
    licenseDates: [lines[10], lines[11]].join('    ')
  };
  const output = custom ? readDocx(custom) : entries;
  const xml = output['word/document.xml']?.toString('utf8').replace(/<w:p(?:\s[^>]*)?>(?:(?!<w:p(?:\s|>)|<\/w:p>)[\s\S])*?<\/w:p>/g, paragraph => {
    const nodes = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)];
    const joined = nodes.map(node => node[1]).join('');
    const spans = [...joined.matchAll(/\[\[SIGEX:\w+\]\]/g)];
    if (!spans.length) return paragraph;
    let position = 0;
    let index = 0;
    return paragraph.replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g, (_, open, value, close) => {
      const start = position;
      position += value.length;
      let next = '';
      for (let i = 0; i < value.length; i++) {
        const at = start + i;
        while (spans[index] && at >= spans[index].index + spans[index][0].length) index++;
        const span = spans[index];
        if (!span || at < span.index) next += value[i];
        else if (at === span.index) next += span[0];
      }
      return open + next + close;
    });
  });
  const markers = text => (text.match(/\[\[SIGEX:\w+\]\]/g) || []).sort().join(' ');
  if (!xml || markers(xml) !== markers(entries['word/document.xml'].toString('utf8'))) {
    throw Object.assign(new Error('La plantilla perdió o cambió sus marcadores SIGEX. Revísala en Word.'), { code: 'SIGEX_TEMPLATE_MARKERS' });
  }
  // Word can recalculate legacy fields on opening and overwrite the generated text.
  const cleanXml = xml.replace(/<w:p(?:\s[^>]*)?>(?:(?!<w:p(?:\s|>)|<\/w:p>)[\s\S])*?<\/w:p>/g, paragraph => {
    if (!paragraph.includes('[[SIGEX:')) return paragraph;
    return paragraph
      .replace(/<w:fldSimple\b[^>]*>[\s\S]*?<\/w:fldSimple>/g, '')
      .replace(/<w:fldChar\b[^>]*w:fldCharType="begin"[^>]*\/>[\s\S]*?<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>/g, '')
      .replace(/<w:fldChar\b[^>]*\/>|<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '');
  });
  const formatted = input.model.startsWith('x03')
    ? cleanXml.replace(/<w:r(?:\s[^>]*)?>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g, run => {
        const match = run.match(/<w:t(?:\s[^>]*)?>\[\[SIGEX:(2|8|person|rut|request|ruling|remisor)\]\]<\/w:t>/);
        if (!match) return run;
        const labels = { person: 'Comparece:', rut: 'Cédula de identidad:', request: 'Domicilio:' };
        const label = labels[match[1]];
        if (label && fields[match[1]].startsWith(label)) fields[match[1]] = fields[match[1]].slice(label.length);
        const properties = (run.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || '<w:rPr></w:rPr>')
          .replace(/<w:b(?:Cs)?(?:\s[^>]*)?\/>/g, '')
          .replace('</w:rPr>', '<w:b w:val="0"/><w:bCs w:val="0"/></w:rPr>');
        const normal = '<w:r>' + properties + match[0] + '</w:r>';
        return label ? run.replace(match[0], '<w:t>' + label + '</w:t>') + normal : normal;
      })
    : cleanXml;
  output['word/document.xml'] = Buffer.from(formatted.replace(/\[\[SIGEX:(\w+)\]\]/g, (_, key) => {
    const value = /^\d+$/.test(key) ? lines[Number(key)] : fields[key];
    if (typeof value !== 'string') throw new Error('Campo de plantilla sin resolver: ' + key);
    return escapeXml(key === 'license' || key === 'licenseDates' ? value : value.replace(/(\S) {2,}(?=\S)/g, '$1 '));
  }));
  if (output['word/document.xml'].includes('[[SIGEX:')) throw new Error('Quedaron campos sin completar en el documento.');
  for (const [name, bytes] of Object.entries(output)) {
    if (!/^word\/(document|header\d+|footer\d+)\.xml$/.test(name)) continue;
    output[name] = Buffer.from(bytes.toString('utf8').replace(/(<w:r(?:\s[^>]*)?>)((?:(?!<\/?w:r(?:\s|>))[\s\S])*?)(<\/w:r>)/g, (run, open, body, close) => {
      if (!/<w:t(?:\s|>)/.test(body)) return run;
      const pattern = /^<w:rPr(?:\s[^>]*)?\/>|^<w:rPr(?:\s[^>]*)?>([\s\S]*?)<\/w:rPr>/;
      const properties = (body.match(pattern)?.[1] || '')
        .replace(/<w:(?:rFonts|sz|szCs)(?:\s[^>]*)?\/>/g, '')
        .replace(/<w:color(?:\s[^>]*)?\/>/g, color => input.model === 'x06' ? '' : color);
      const color = input.model === 'x06' ? '<w:color w:val="000000"/>' : '';
      const style = '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>' + properties + color + '<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>';
      const content = body.replace(pattern, '');
      if (input.model !== 'x06') return open + style + content + close;
      const match = content.match(/^<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>$/);
      if (!match) return open + style + content + close;
      const labels = /((?:NOMBRE:|CÉDULA DE IDENTIDAD:|Domicilio:|Clase:|Licencia N\.º|Municipalidad:|Otorgada:|Fecha de control:|Válido hasta:) )/g;
      const parts = match[1].split(labels);
      if (parts.length === 1 || parts[0]) return open + style + content + close;
      const bold = style.replace(/<w:b(?:Cs)?(?:\s[^>]*)?\/>/g, '').replace(/(<w:rFonts[^>]*\/>)/, '$1<w:b/><w:bCs/>');
      return parts.slice(1).map((part, index) => {
        const value = index % 2 === 1;
        return open + (value ? bold : style) + '<w:t xml:space="preserve">' + part + '</w:t>' + close;
      }).join('');

    }));
  }
  output['word/document.xml'] = Buffer.from(output['word/document.xml'].toString('utf8').replace(/<w:pgSz\b[^>]*\/>/g, page =>
    /w:orient="landscape"/.test(page)
      ? '<w:pgSz w:w="20160" w:h="12240" w:orient="landscape"/>'
      : '<w:pgSz w:w="12240" w:h="20160"/>'
  ));
  return packDocx(output);
}

function packDocx(entries) {
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
