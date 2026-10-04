// Emits a minimal, valid 32x32 32-bit ICO.
//
// tauri-build requires icons/icon.ico to generate the Windows resource file.
// Hand-writing it avoids adding an image toolchain to a repo that deliberately
// has almost no build tooling, and keeps the asset reviewable as code.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SIZE = 32;
const out = process.argv[2];
if (!out) throw new Error('usage: make-icon.mjs <path/to/icon.ico>');

// --- pixels: a flat slab with a lighter diagonal, in BGRA -------------------
const xor = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    // ICO stores rows bottom-up.
    const i = ((SIZE - 1 - y) * SIZE + x) * 4;
    const onBand = Math.abs(x - y) < 5;
    xor[i + 0] = onBand ? 0xd0 : 0x50; // B
    xor[i + 1] = onBand ? 0xa0 : 0x30; // G
    xor[i + 2] = onBand ? 0x40 : 0x18; // R
    xor[i + 3] = 0xff;                 // A — fully opaque
  }
}

// AND mask: one bit per pixel, rows padded to 4 bytes. All zero = opaque.
const andRow = Math.ceil(SIZE / 8 / 4) * 4;
const andMask = Buffer.alloc(andRow * SIZE);

// --- BITMAPINFOHEADER ------------------------------------------------------
const dib = Buffer.alloc(40);
dib.writeUInt32LE(40, 0);          // biSize
dib.writeInt32LE(SIZE, 4);         // biWidth
dib.writeInt32LE(SIZE * 2, 8);     // biHeight — doubled: XOR image + AND mask
dib.writeUInt16LE(1, 12);          // biPlanes
dib.writeUInt16LE(32, 14);         // biBitCount
dib.writeUInt32LE(0, 16);          // biCompression = BI_RGB
dib.writeUInt32LE(xor.length + andMask.length, 20);

const image = Buffer.concat([dib, xor, andMask]);

// --- ICONDIR + ICONDIRENTRY ------------------------------------------------
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);        // reserved
header.writeUInt16LE(1, 2);        // type 1 = icon
header.writeUInt16LE(1, 4);        // one image

const entry = Buffer.alloc(16);
entry[0] = SIZE;                   // width
entry[1] = SIZE;                   // height
entry[2] = 0;                      // palette colours (0 = none)
entry[3] = 0;                      // reserved
entry.writeUInt16LE(1, 4);         // planes
entry.writeUInt16LE(32, 6);        // bit count
entry.writeUInt32LE(image.length, 8);
entry.writeUInt32LE(6 + 16, 12);   // offset to the image data

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, entry, image]));
console.log(`wrote ${out} (${6 + 16 + image.length} bytes)`);
