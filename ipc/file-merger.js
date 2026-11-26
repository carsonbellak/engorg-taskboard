// IPC handlers: File Merger utility — pick PDFs/images and save the merged PDF.
//
// The actual PDF assembly happens in the RENDERER (renderer/file-merger.js) with
// the bundled pdf-lib global, because it needs a <canvas> to normalize arbitrary
// image formats (webp/gif/bmp…) into embeddable bytes — which the main process
// has no DOM for. This module owns what requires Node/Electron: the native open
// dialog (with PDF+image filters), writing the final bytes to a user-chosen path
// via a save dialog, and decoding TIFFs (Chromium has no TIFF decoder, so
// fileMerger:decodeTiff runs Windows' own WIC codec through PowerShell — every
// compression scanners use: none/PackBits/LZW/Deflate/CCITT G3+G4/JPEG — and
// returns each page as PNG bytes + its DPI). Reading each input file's bytes
// reuses the existing files:readBinary handler. Desktop-only.
const { ipcMain, dialog } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const IMAGE_ONLY_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff'];
const IMAGE_EXTS = ['pdf', ...IMAGE_ONLY_EXTS];

// Decodes $env:FMERGE_SRC (every frame) into p<N>.png files under $env:FMERGE_OUT and
// prints a JSON array of { file, w, h, dpiX, dpiY }. Paths go through env vars, never
// the command line, so odd filenames can't break out of the script.
const TIFF_PS = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
Add-Type -AssemblyName PresentationCore
$src = $env:FMERGE_SRC; $out = $env:FMERGE_OUT
$opts = [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat -bor [System.Windows.Media.Imaging.BitmapCreateOptions]::IgnoreColorProfile
$fs = [System.IO.File]::OpenRead($src)
try {
  $dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create($fs, $opts, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
  $res = @(); $i = 0
  foreach ($f in $dec.Frames) {
    $p = Join-Path $out ('p{0}.png' -f $i)
    $save = {
      param($bmp)
      $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
      $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bmp))
      $o = [System.IO.File]::Create($p)
      try { $enc.Save($o) } finally { $o.Close() }
    }
    try { & $save $f }
    catch {
      # CMYK and other formats PNG can't hold: convert to 32-bit BGRA first.
      $conv = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($f, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
      & $save $conv
    }
    $res += [pscustomobject]@{ file = $p; w = $f.PixelWidth; h = $f.PixelHeight; dpiX = $f.DpiX; dpiY = $f.DpiY }
    $i++
  }
  ConvertTo-Json -InputObject @($res) -Compress
} finally { $fs.Close() }
`;
const TIFF_PS_ENCODED = Buffer.from(TIFF_PS, 'utf16le').toString('base64');

function runTiffDecode(src, outDir) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', TIFF_PS_ENCODED], {
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, FMERGE_SRC: src, FMERGE_OUT: outDir },
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || err.message;
        reject(new Error(/timed out|ETIMEDOUT/i.test(err.message) || err.killed ? 'TIFF decode timed out' : 'TIFF decode failed: ' + msg));
        return;
      }
      try { resolve(JSON.parse(String(stdout).trim())); }
      catch (_) { reject(new Error('TIFF decode returned no pages')); }
    });
  });
}

module.exports = function register(getMainWindow) {
  ipcMain.handle('fileMerger:selectFiles', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile', 'multiSelections'],
      title: 'Select PDFs and images to merge',
      filters: [
        { name: 'PDFs & Images', extensions: IMAGE_EXTS },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Images', extensions: IMAGE_ONLY_EXTS },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [];
    const out = [];
    for (const fp of result.filePaths) {
      let size = 0;
      try { size = (await fs.promises.stat(fp)).size; } catch (_) {}
      out.push({ name: path.basename(fp), path: fp, ext: path.extname(fp).slice(1).toLowerCase(), size });
    }
    return out;
  });

  // Decode a (possibly multi-page) TIFF → { pages: [{ bytes: PNG, width, height, dpiX, dpiY }] }
  // or { error }. Pages come back in file order.
  ipcMain.handle('fileMerger:decodeTiff', async (event, filePath) => {
    if (process.platform !== 'win32') return { error: 'TIFF decoding needs Windows' };
    let outDir = null;
    try {
      if (typeof filePath !== 'string' || !filePath) throw new Error('no file');
      await fs.promises.access(filePath, fs.constants.R_OK);
      outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'engorg-tiff-'));
      const frames = await runTiffDecode(filePath, outDir);
      if (!Array.isArray(frames) || !frames.length) throw new Error('TIFF has no pages');
      const pages = [];
      for (const f of frames) {
        pages.push({
          bytes: await fs.promises.readFile(f.file),
          width: f.w, height: f.h,
          dpiX: Number(f.dpiX) || 0, dpiY: Number(f.dpiY) || 0,
        });
      }
      return { pages };
    } catch (err) {
      return { error: err.message };
    } finally {
      if (outDir) fs.promises.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Save the merged PDF. `bytes` is a Uint8Array/ArrayBuffer of the assembled PDF.
  ipcMain.handle('fileMerger:save', async (event, bytes, defaultName) => {
    try {
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Save merged PDF',
        defaultPath: defaultName || 'merged.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      const buf = Buffer.from(bytes);
      await fs.promises.writeFile(result.filePath, buf);
      return { path: result.filePath };
    } catch (err) {
      return { error: err.message };
    }
  });
};
