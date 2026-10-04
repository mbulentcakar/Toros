/**
 * Helpers to build malicious tar fixtures byte for byte (tests 19-21).
 *
 * The relay's own `buildTar` would refuse to emit a symlink with a traversal
 * target, which is precisely the point: the import path must defend against
 * archives a hostile node produced. These helpers use the same low-level tar
 * header layout directly so the fixtures carry absolute paths, `..`, and
 * symlink typeflags regardless of what the friendly writer would allow.
 */

import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BLOCK = 512;

function header(name: string, size: number, typeflag: string, linkname = ''): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name.slice(0, 100), 0, 'latin1');
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(typeflag, 156, 'latin1');
  if (linkname) h.write(linkname.slice(0, 100), 157, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  h.write('root', 265, 'latin1');
  h.write('root', 297, 'latin1');
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += h[i]!;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

function pad(content: Buffer): Buffer {
  const rem = content.length % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem, 0);
}

function entry(name: string, content: Buffer, typeflag: string, linkname = ''): Buffer {
  return Buffer.concat([header(name, content.length, typeflag, linkname), content, pad(content)]);
}

/** A gzipped tar containing one entry with an absolute path. */
export function writeAbsolutePathCapsule(outPath: string, absName = '/etc/passwd'): void {
  const content = Buffer.from('pwned\n', 'utf8');
  const tar = Buffer.concat([entry(absName, content, '0'), Buffer.alloc(BLOCK * 2, 0)]);
  writeFileSync(outPath, gzipSync(tar));
}

/** A gzipped tar containing one entry whose path contains `..`. */
export function writeDotDotCapsule(outPath: string, name = '../escape.txt'): void {
  const content = Buffer.from('escaped\n', 'utf8');
  const tar = Buffer.concat([entry(name, content, '0'), Buffer.alloc(BLOCK * 2, 0)]);
  writeFileSync(outPath, gzipSync(tar));
}

/** A gzipped tar containing one symlink entry pointing at an absolute target. */
export function writeSymlinkCapsule(outPath: string, name = 'link', target = '/etc/passwd'): void {
  // A symlink carries no content; its target is in the linkname field.
  const tar = Buffer.concat([entry(name, Buffer.alloc(0), '2', target), Buffer.alloc(BLOCK * 2, 0)]);
  writeFileSync(outPath, gzipSync(tar));
}

/**
 * A gzipped tar that decompresses to more than `bytes` of uncompressed data,
 * used to check that the size limit is enforced WHILE STREAMING rather than
 * after the whole buffer is materialised.
 */
export function writeOversizeCapsule(outPath: string, bytes: number): void {
  // One big regular file whose content is `bytes` of zeros. The size field
  // tells the truth, so a reader that trusted the header would still abort
  // only after decompressing; the relay counts decompressed bytes instead.
  const content = Buffer.alloc(bytes, 0);
  const tar = Buffer.concat([entry('big.bin', content, '0'), Buffer.alloc(BLOCK * 2, 0)]);
  writeFileSync(outPath, gzipSync(tar));
}
