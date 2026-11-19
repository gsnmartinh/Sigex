/* SIGEX: implementar UNA sola aplicación web para todo el tribunal.
 * Propiedades del script: SIGEX_TOKEN (clave larga aleatoria), SIGEX_SPREADSHEET_ID.
 * La pestaña se elige por el año de la fecha; sus columnas A:E son Fecha, ORD, Rol, Tipo, Detalle.
 * Se conservan los números de B. El identificador queda en una nota de A.
 */
function doPost(e) {
  var lock;
  try {
    var input = JSON.parse(e.postData.contents || '{}');
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('SIGEX_TOKEN');
    if (!secret || secret.length < 32 || input.token !== secret) throw new Error('Clave de conexión inválida.');
    var book = SpreadsheetApp.openById(props.getProperty('SIGEX_SPREADSHEET_ID'));
    if (input.action === 'ping') return sigexJson_({ ok: true, name: book.getName() });
    if (input.action !== 'reserve' || !/^[\w-]{16,80}$/.test(input.request_id || '')) throw new Error('Solicitud inválida.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '') || new Date(input.date + 'T12:00:00Z').toISOString().slice(0, 10) !== input.date) throw new Error('Fecha inválida.');
    var sheet = book.getSheetByName(input.date.slice(0, 4));
    if (!sheet) throw new Error('Falta la pestaña del año ' + input.date.slice(0, 4) + '.');
    lock = LockService.getScriptLock();
    lock.waitLock(25000);
    var last = sheet.getLastRow();
    if (last < 2) throw new Error('La planilla no tiene números ORD. disponibles.');
    var range = sheet.getRange(2, 1, last - 1, 5);
    var rows = range.getValues();
    var notes = sheet.getRange(2, 1, last - 1, 1).getNotes();
    var marker = 'SIGEX:' + input.request_id;
    for (var i = 0; i < notes.length; i++) {
      if (notes[i][0] === marker) return sigexJson_({ ok: true, request_id: input.request_id, ord: String(rows[i][1]), row: i + 2, reused: true });
    }
    var index = rows.findIndex(function(row) { return row[0] === '' && /^\d+$/.test(String(row[1])) && row.slice(2).every(function(v) { return v === ''; }); });
    if (index < 0) throw new Error('No hay filas libres con ORD. preasignado. Agrega números a la planilla.');
    var rowIndex = index + 1;
    var ord = String(rows[index][1]);
    var safe = function(value) { return { userEnteredValue: { stringValue: String(value || '').slice(0, 1000) } }; };
    var serialDate = Math.round((Date.parse(input.date + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);
    // Una sola operación atómica guarda fecha, identificador y datos. La columna B no se modifica.
    var body = { requests: [
      { updateCells: { range: { sheetId: sheet.getSheetId(), startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 1 }, rows: [{ values: [{ userEnteredValue: { numberValue: serialDate }, userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/MM/yyyy' } }, note: marker }] }], fields: 'userEnteredValue,userEnteredFormat.numberFormat,note' } },
      { updateCells: { range: { sheetId: sheet.getSheetId(), startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 2, endColumnIndex: 5 }, rows: [{ values: [safe(input.rol), safe(input.matter), safe(input.detail)] }], fields: 'userEnteredValue' } }
    ] };
    var response = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/' + book.getId() + ':batchUpdate', {
      method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, payload: JSON.stringify(body), muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) throw new Error('Google Sheets no confirmó la escritura. Reintenta la misma emisión.');
    return sigexJson_({ ok: true, request_id: input.request_id, ord: ord, row: index + 2 });
  } catch (error) {
    return sigexJson_({ ok: false, error: error.message || 'No fue posible reservar el número.' });
  } finally { if (lock && lock.hasLock()) lock.releaseLock(); }
}
function sigexJson_(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
