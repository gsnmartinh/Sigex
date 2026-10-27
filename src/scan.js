'use strict';
// Escaneo de documentos: adquisición con WIA (escáner de Windows) y armado de PDF sin dependencias externas.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// ---------- JPEG -> PDF ----------
function jpegInfo(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('La imagen escaneada no es un JPEG válido.');
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
    }
    i += 2 + len;
  }
  throw new Error('No se pudo leer el tamaño de la imagen escaneada.');
}

// Cada imagen ocupa una página tamaño carta/A4 (orientación según la imagen), ajustada sin deformarla.
function buildPdf(jpegs) {
  if (!jpegs.length) throw new Error('No hay hojas escaneadas.');
  const PW = 595.28, PH = 841.89;
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = b => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); parts.push(buf); size += buf.length; };
  const obj = (n, body) => { offsets[n] = size; push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); };

  const n = jpegs.length;
  // objetos: 1 catálogo, 2 páginas, luego por hoja: página, contenido, imagen
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = jpegs.map((_, k) => `${3 + k * 3} 0 R`).join(' ');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  jpegs.forEach((jpg, k) => {
    const info = jpegInfo(jpg);
    const landscape = info.width > info.height;
    const pw = landscape ? PH : PW, ph = landscape ? PW : PH;
    const scale = Math.min(pw / info.width, ph / info.height);
    const w = info.width * scale, hgt = info.height * scale;
    const x = (pw - w) / 2, y = (ph - hgt) / 2;
    const pageId = 3 + k * 3, contId = pageId + 1, imgId = pageId + 2;
    const content = `q ${w.toFixed(2)} 0 0 ${hgt.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`;
    obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contId} 0 R >>`);
    obj(contId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const cs = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    offsets[imgId] = size;
    push(`${imgId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    push(jpg);
    push('\nendstream\nendobj\n');
  });
  const total = 3 + n * 3;
  const xref = size;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

// ---------- Adquisición con WIA (Windows) ----------
// Dos modos: "flatbed" abre la ventana del escáner y trae una hoja; "feeder" usa el alimentador automático
// (ADF) y escanea todas las hojas puestas, opcionalmente por ambas caras.
const PS_SCRIPT = `
param([string]$Out, [string]$Source = 'feeder', [int]$Duplex = 0, [int]$Dpi = 200, [int]$Minimal = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$jpegFmt = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'
$bmpFmt  = '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}'
$script:log = @()
Add-Type -AssemblyName System.Drawing
function Save-Jpeg($img, $path) {
  $tmp = $path + '.raw'
  $img.SaveFile($tmp)
  $bmp = [System.Drawing.Image]::FromFile($tmp)
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)
  $bmp.Save($path, $codec, $ep)
  $bmp.Dispose()
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
function Set-Prop($props, $id, $value, $label) {
  try {
    foreach ($p in $props) {
      if ($p.PropertyID -eq $id) { $p.Value = $value; $script:log += ($label + '=' + $value + ' ok'); return }
    }
    $script:log += ($label + ' no existe')
  } catch { $script:log += ($label + '=' + $value + ' rechazado') }
}
function Get-Prop($props, $id) {
  try { foreach ($p in $props) { if ($p.PropertyID -eq $id) { return $p.Value } } } catch { }
  return $null
}
# Prueba JPEG, luego BMP y luego el formato por defecto del controlador.
function Transfer-Page($item) {
  $last = $null
  foreach ($f in @($jpegFmt, $bmpFmt, '')) {
    try {
      if ($f -eq '') { $img = $item.Transfer() } else { $img = $item.Transfer($f) }
      if ($f -ne $script:fmt) { $script:log += ('formato ' + $f + ' ok'); $script:fmt = $f }
      return $img
    } catch { $last = $_; $script:log += ('Transfer(' + $f + ') fallo: ' + $_.Exception.Message) }
    if ($script:fmt -ne $null) { break }
  }
  throw $last
}
$script:fmt = $null
$step = 'inicio'
try {
  $dlg = New-Object -ComObject WIA.CommonDialog
  if ($Source -eq 'flatbed') {
    $img = $dlg.ShowAcquireImage(1, 1, 0, $jpegFmt, $false, $true, $false)
    if ($img -eq $null) { exit 3 }
    Save-Jpeg $img $Out
    Write-Output $Out
    exit 0
  }
  # Alimentador automático
  $step = 'elegir escáner'
  $dev = $dlg.ShowSelectDevice(1, $false, $false)
  if ($dev -eq $null) { exit 3 }
  $handling = 1                      # 1 = alimentador, 4 = doble cara
  if ($Duplex -eq 1 -and $Minimal -eq 0) { $handling = 5 }
  Set-Prop $dev.Properties 3088 $handling 'origen'
  $step = 'abrir origen del escáner'
  $item = $dev.Items.Item(1)
  $step = 'ajustes'
  if ($Minimal -eq 0) {
    Set-Prop $dev.Properties 3096 0 'paginas'
    Set-Prop $item.Properties 6146 1 'color'
    Set-Prop $item.Properties 6147 $Dpi 'dpiH'
    Set-Prop $item.Properties 6148 $Dpi 'dpiV'
  }
  $n = 0
  while ($n -lt 300) {
    $step = 'escanear hoja ' + ($n + 1)
    try { $img = Transfer-Page $item }
    catch {
      if ($n -gt 0) { break }
      throw
    }
    $n++
    $step = 'guardar hoja ' + $n
    $f = ($Out -replace '\\.jpg$', '') + '_' + $n + '.jpg'
    Save-Jpeg $img $f
    Write-Output $f
    $st = Get-Prop $dev.Properties 3087     # Document Handling Status
    if ($st -ne $null -and (($st -band 1) -eq 0)) { break }   # sin más hojas en el alimentador
  }
  if ($n -eq 0) { exit 3 }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message + ' (paso: ' + $step + ') [' + ($script:log -join '; ') + ']')
  exit 1
}
`;

function friendlyScanError(msg) {
  const m = String(msg || '');
  if (/0x80210015|no (hay|se encontr)|No WIA|device.*(not|found)/i.test(m)) return 'No se encontró un escáner conectado y encendido. Revisa el cable o la red del escáner e inténtalo de nuevo.';
  if (/0x80210006|busy|ocupad/i.test(m)) return 'El escáner está ocupado. Espera un momento e inténtalo de nuevo.';
  if (/0x80210003|atasc|jam|feeder|alimentador/i.test(m)) return 'El alimentador no tiene hojas o hay un atasco. Coloca las hojas e inténtalo de nuevo.';
  if (/0x80210005|offline|desconect/i.test(m)) return 'El escáner está desconectado.';
  return `No se pudo escanear: ${m.trim().slice(0, 700) || 'error desconocido'}. Si usas el alimentador, prueba con la otra opción de origen.`;
}

let current = null;
function killScan() { if (current) { try { current.kill(); } catch (_) { /* ignorar */ } current = null; } }

// Ejecuta el script de WIA una vez. Devuelve la lista de JPEG, [] si se canceló, o lanza el error técnico.
function runWia(outFile, source, duplex, minimal) {
  return new Promise((resolve, reject) => {
    const ps1 = outFile + (minimal ? '.min' : '') + '.ps1';
    fs.writeFileSync(ps1, '﻿' + PS_SCRIPT, 'utf8');
    // Sin windowsHide: ocultaría también la ventana del escáner (WIA). La consola se oculta con -WindowStyle.
    current = execFile('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-Out', outFile, '-Source', source, '-Duplex', duplex ? '1' : '0', '-Minimal', minimal ? '1' : '0'],
      { timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        const wasKilled = current === null;
        current = null;
        try { fs.unlinkSync(ps1); } catch (_) { /* ignorar */ }
        if (err && (err.code === 3 || err.killed || wasKilled)) return resolve([]);
        if (err) { const e = new Error(String(stderr || err.message)); e.technical = true; return reject(e); }
        resolve(String(stdout).split(/\r?\n/).map(x => x.trim()).filter(f => f && fs.existsSync(f)));
      });
  });
}

// Devuelve la lista de JPEG recién escaneados o [] si el usuario canceló.
async function acquireWithWia(outFile, opts = {}) {
  if (process.platform !== 'win32') throw new Error('El escaneo solo está disponible en Windows.');
  const source = opts.source === 'flatbed' ? 'flatbed' : 'feeder';
  try {
    return await runWia(outFile, source, !!opts.duplex, false);
  } catch (first) {
    if (source !== 'feeder') throw new Error(friendlyScanError(first.message));
    // Segundo intento: sin ajustes opcionales (resolución, páginas, doble cara), por si el controlador los rechaza.
    try {
      return await runWia(outFile, source, false, true);
    } catch (second) {
      throw new Error(friendlyScanError(`${second.message} | primer intento: ${first.message}`));
    }
  }
}

// Sesión de escaneo de varias hojas. `acquire(file)` es reemplazable (pruebas).
function createScanSession({ acquire = acquireWithWia, tmpRoot = path.join(os.tmpdir(), 'sigex-scan') } = {}) {
  let pages = [];
  let seq = 0;
  fs.mkdirSync(tmpRoot, { recursive: true });
  const clear = () => { for (const p of pages) { try { fs.unlinkSync(p); } catch (_) { /* ignorar */ } } pages = []; };
  const dataUrl = f => `data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}`;
  return {
    async scanPage(opts = {}) {
      const file = path.join(tmpRoot, `hoja_${Date.now()}_${seq++}.jpg`);
      const raw = await acquire(file, opts);
      const got = (Array.isArray(raw) ? raw : raw ? [raw] : []);
      if (!got.length) return { canceled: true, count: pages.length, previews: pages.map(dataUrl) };
      for (const f of got) jpegInfo(fs.readFileSync(f)); // valida
      pages.push(...got);
      return { canceled: false, added: got.length, count: pages.length, previews: pages.map(dataUrl) };
    },
    removeAt(i) {
      if (!Number.isInteger(i) || i < 0 || i >= pages.length) throw new Error('Esa hoja no existe.');
      const [p] = pages.splice(i, 1);
      try { fs.unlinkSync(p); } catch (_) { /* ignorar */ }
      return { count: pages.length, previews: pages.map(dataUrl) };
    },
    move(from, to) {
      if (![from, to].every(n => Number.isInteger(n) && n >= 0 && n < pages.length)) throw new Error('Posición de hoja no válida.');
      const [p] = pages.splice(from, 1);
      pages.splice(to, 0, p);
      return { count: pages.length, previews: pages.map(dataUrl) };
    },
    finish(name) {
      if (!pages.length) throw new Error('No hay hojas escaneadas.');
      const safe = String(name || 'Escaneo').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Escaneo';
      const dir = fs.mkdtempSync(path.join(tmpRoot, 'pdf_'));
      const out = path.join(dir, `${safe}.pdf`);
      fs.writeFileSync(out, buildPdf(pages.map(p => fs.readFileSync(p))));
      const count = pages.length;
      clear();
      return { path: out, pages: count };
    },
    cancel() { killScan(); clear(); return { ok: true }; },
    count: () => pages.length
  };
}

module.exports = { jpegInfo, buildPdf, createScanSession, acquireWithWia, friendlyScanError };
