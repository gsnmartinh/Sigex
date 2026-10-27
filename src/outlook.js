'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Outlook clásico (COM). Se muestra el borrador primero para que Outlook cargue su firma, y el texto se inserta
// al principio del cuerpo, antes de la firma.
const PS_SCRIPT = `
param([string]$JsonPath)
$ErrorActionPreference = 'Stop'
$d = Get-Content -Raw -Encoding UTF8 -LiteralPath $JsonPath | ConvertFrom-Json
$ol = New-Object -ComObject Outlook.Application
$m = $ol.CreateItem(0)
$m.To = [string]$d.to
$m.Subject = [string]$d.subject
foreach ($a in @($d.attachments)) { if ($a) { [void]$m.Attachments.Add([string]$a) } }
$m.Display()
$sig = [string]$m.HTMLBody
$txt = [System.Net.WebUtility]::HtmlEncode([string]$d.body) -replace "\`r?\`n", '<br>'
$html = "<div style='font-family:Calibri,Arial,sans-serif;font-size:11pt'>" + $txt + "</div><br>"
$mt = [regex]::Match($sig, '(?is)<body[^>]*>')
if ($mt.Success) { $m.HTMLBody = $sig.Insert($mt.Index + $mt.Length, $html) } else { $m.HTMLBody = $html + $sig }
`;

function runPowerShell(jsonPath, scriptPath) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-JsonPath', jsonPath], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim() || `PowerShell terminó con código ${code}`))));
  });
}

function encodeHeader(s) { return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`; }
function chunk64(buf) { return buf.toString('base64').replace(/(.{76})/g, '$1\r\n'); }

const escHtml = t => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };

// Borrador .eml (X-Unsent: 1) en HTML, para que el programa de correo lo abra como mensaje con formato
// (así admite firmas con imagen). Si hay imagen de firma, va incrustada al final del mensaje.
function buildEml({ to, subject, body, attachments, signatureImage }) {
  const stamp = Date.now().toString(16);
  const mixed = `----=_SIGEX_M_${stamp}`, alt = `----=_SIGEX_A_${stamp}`, rel = `----=_SIGEX_R_${stamp}`;
  let img = null;
  if (signatureImage && fs.existsSync(signatureImage)) img = { buf: fs.readFileSync(signatureImage), type: MIME[path.extname(signatureImage).toLowerCase()] || 'image/png' };
  const html = `<html><body><div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${escHtml(body).replace(/\r?\n/g, '<br>\r\n')}</div>` +
    (img ? '<br><div><img src="cid:firma-sigex" alt="Firma"></div>' : '') + '</body></html>';
  const lines = [
    'X-Unsent: 1',
    `To: ${to || ''}`,
    `Subject: ${encodeHeader(subject || '')}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    chunk64(Buffer.from(body || '', 'utf8')),
    `--${alt}`,
    `Content-Type: multipart/related; boundary="${rel}"; type="text/html"`,
    '',
    `--${rel}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    chunk64(Buffer.from(html, 'utf8'))
  ];
  if (img) {
    lines.push(`--${rel}`, `Content-Type: ${img.type}; name="firma${path.extname(signatureImage)}"`, 'Content-Transfer-Encoding: base64',
      'Content-ID: <firma-sigex>', 'Content-Disposition: inline; filename="firma' + path.extname(signatureImage) + '"', '', chunk64(img.buf));
  }
  lines.push(`--${rel}--`, `--${alt}--`);
  for (const f of attachments || []) {
    const name = path.basename(f);
    lines.push(`--${mixed}`,
      `Content-Type: ${path.extname(name).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream'}; name="${encodeHeader(name)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodeHeader(name)}"`,
      '', chunk64(fs.readFileSync(f)));
  }
  lines.push(`--${mixed}--`, '');
  return lines.join('\r\n');
}

// mode: 'gmail' (abre Gmail en el navegador; el adjunto se arrastra a mano), 'new', 'classic'. Detalle de 'new' y 'classic':
// mode: 'new' (borrador .eml con el programa de correo predeterminado, p. ej. Outlook nuevo) o 'classic' (Outlook clásico por COM).
async function openDraft(mail, shell, mode = 'new') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigex-mail-'));
  const missing = (mail.attachments || []).filter(f => !fs.existsSync(f));
  if (missing.length) throw new Error(`No se encuentra el archivo adjunto: ${path.basename(missing[0])}`);
  if (mode === 'classic') {
    if (process.platform !== 'win32') throw new Error('Outlook clásico solo está disponible en Windows.');
    const jsonPath = path.join(dir, 'mail.json');
    const psPath = path.join(dir, 'draft.ps1');
    fs.writeFileSync(jsonPath, JSON.stringify({ to: mail.to || '', subject: mail.subject || '', body: mail.body || '', attachments: mail.attachments || [] }), 'utf8');
    fs.writeFileSync(psPath, '﻿' + PS_SCRIPT, 'utf8');
    try { await runPowerShell(jsonPath, psPath); }
    catch (e) { throw new Error(`No se pudo abrir Outlook clásico: ${String(e.message || e).slice(0, 240)}. Cambia el programa de correo en Ajustes.`); }
    return { method: 'outlook' };
  }
  if (mode === 'gmail') {
    const q = t => encodeURIComponent(t || '');
    await shell.openExternal(`https://mail.google.com/mail/?view=cm&fs=1&to=${q(mail.to)}&su=${q(mail.subject)}&body=${q(mail.body)}`);
    if ((mail.attachments || []).length) shell.showItemInFolder(mail.attachments[0]);
    return { method: 'gmail', attachments: (mail.attachments || []).map(f => path.basename(f)) };
  }
  const eml = path.join(dir, 'borrador.eml');
  fs.writeFileSync(eml, buildEml(mail));
  const err = await shell.openPath(eml);
  if (err) throw new Error(`No se pudo abrir el correo: ${err}`);
  return { method: 'eml' };
}

module.exports = { openDraft, buildEml };
