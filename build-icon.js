// Generate a proper .ico file for the app using raw binary
// Creates a gear icon at 16x16, 32x32, 48x48, 256x256 sizes
// Uses BMP format for smaller sizes, PNG for 256x256

const fs = require('fs');
const path = require('path');

function createGearBMP(size) {
  // Create a simple gear icon as BGRA pixel data
  const pixels = Buffer.alloc(size * size * 4, 0);
  const cx = size / 2, cy = size / 2;
  const outerR = size * 0.45;
  const innerR = size * 0.32;
  const holeR = size * 0.18;
  const toothW = size * 0.12;
  const numTeeth = 8;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);

      let inGear = false;

      // Main ring
      if (dist >= holeR && dist <= innerR) {
        inGear = true;
      }

      // Teeth
      if (dist > innerR && dist <= outerR) {
        const toothAngle = (2 * Math.PI) / numTeeth;
        const a = ((angle % toothAngle) + toothAngle) % toothAngle;
        const toothHalf = toothAngle * 0.3;
        if (a < toothHalf || a > toothAngle - toothHalf) {
          inGear = true;
        }
      }

      if (inGear) {
        const idx = ((size - 1 - y) * size + x) * 4; // BMP is bottom-up
        // Gradient: #6366F1 to #A78BFA
        const t = (x + y) / (2 * size);
        const r = Math.round(99 + (167 - 99) * t);
        const g = Math.round(102 + (139 - 102) * t);
        const b = Math.round(241 + (250 - 241) * t);
        pixels[idx + 0] = b;     // Blue
        pixels[idx + 1] = g;     // Green
        pixels[idx + 2] = r;     // Red
        pixels[idx + 3] = 255;   // Alpha
      }
    }
  }

  return pixels;
}

function buildICO(sizes) {
  const images = sizes.map(size => {
    const pixels = createGearBMP(size);

    // BMP info header (BITMAPINFOHEADER) - 40 bytes
    const headerSize = 40;
    const bmpHeader = Buffer.alloc(headerSize);
    bmpHeader.writeUInt32LE(headerSize, 0);     // biSize
    bmpHeader.writeInt32LE(size, 4);             // biWidth
    bmpHeader.writeInt32LE(size * 2, 8);         // biHeight (doubled for AND mask)
    bmpHeader.writeUInt16LE(1, 12);              // biPlanes
    bmpHeader.writeUInt16LE(32, 14);             // biBitCount (32-bit BGRA)
    bmpHeader.writeUInt32LE(0, 16);              // biCompression (BI_RGB)
    const imageSize = size * size * 4;
    bmpHeader.writeUInt32LE(imageSize, 20);      // biSizeImage

    // AND mask (1-bit, rows padded to 4 bytes)
    const andRowBytes = Math.ceil(size / 8);
    const andRowPadded = Math.ceil(andRowBytes / 4) * 4;
    const andMask = Buffer.alloc(andRowPadded * size, 0); // All 0 = all opaque

    const data = Buffer.concat([bmpHeader, pixels, andMask]);

    return { size, data };
  });

  // ICO header: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // Reserved
  header.writeUInt16LE(1, 2);              // Type: 1 = ICO
  header.writeUInt16LE(images.length, 4);  // Number of images

  // Directory entries: 16 bytes each
  const dirEntries = [];
  let dataOffset = 6 + images.length * 16;

  for (const img of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 0);  // Width (0 = 256)
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 1);  // Height (0 = 256)
    entry.writeUInt8(0, 2);                                 // Color palette
    entry.writeUInt8(0, 3);                                 // Reserved
    entry.writeUInt16LE(1, 4);                              // Color planes
    entry.writeUInt16LE(32, 6);                             // Bits per pixel
    entry.writeUInt32LE(img.data.length, 8);                // Data size
    entry.writeUInt32LE(dataOffset, 12);                    // Data offset
    dirEntries.push(entry);
    dataOffset += img.data.length;
  }

  return Buffer.concat([header, ...dirEntries, ...images.map(i => i.data)]);
}

// Generate the ICO
const ico = buildICO([16, 32, 48, 64]);
const outPath = path.join(__dirname, 'assets', 'icon.ico');
fs.mkdirSync(path.join(__dirname, 'assets'), { recursive: true });
fs.writeFileSync(outPath, ico);
console.log('Generated icon:', outPath, `(${ico.length} bytes)`);
