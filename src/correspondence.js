'use strict';
function validateEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || !/^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname) || url.search || url.hash) throw new Error('Usa la URL /exec de la aplicación web de Google Apps Script.');
  return url.href;
}
async function callCorrespondence({ endpoint, token, payload, fetchImpl = fetch }) {
  if (!endpoint) throw new Error('Configura la conexión ORD. en Ajustes o ingresa un número obtenido de la planilla.');
  if (!token) throw new Error('Falta la clave de la conexión ORD. en Ajustes.');
  validateEndpoint(endpoint);
  let response;
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, token }), signal: AbortSignal.timeout(45000) });
  } catch (_) { throw new Error('No se pudo confirmar el ORD. Reintenta la misma emisión desde Documentos; conservará su solicitud y su número.'); }
  if (!response.ok) throw new Error('Google no confirmó la conexión ORD. Revisa la implementación y los permisos.');
  let data;
  try { data = await response.json(); } catch (_) { throw new Error('La conexión ORD. no devolvió JSON. Revisa la URL /exec y el acceso de la aplicación web.'); }
  if (!data.ok) throw new Error(data.error || 'La planilla no confirmó la reserva del ORD.');
  if (payload.action !== 'ping' && (data.request_id !== payload.request_id || !/^\d+$/.test(String(data.ord)))) throw new Error('La confirmación del ORD. no coincide. Reintenta esta misma emisión.');
  return data;
}
module.exports = { callCorrespondence, validateEndpoint };
