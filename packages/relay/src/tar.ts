/**
 * Hand-rolled USTAR tar writer and reader.
 *
 * No `tar` package, no `archiver`, no zip library — see 00-CONTRACTS §3. The
 * format is small enough to emit and parse directly, and writing it by hand is
 * exactly what lets the malicious-tar tests (19-21) construct absolute paths,
 * `..` segments, and symlink entries byte for byte rather than relying on a
 * third-party writer that would refuse to emit them.
 */

const BLOCK = 512;

/** Octal number field: `len-1` octal digits left-padded with `0`, then a NUL. */
function octalStr(value: number, len: number): string {
  const s = value.toString(8).padStart(len - 1, '0');
  return `${s}\0`;
}

export interface TarEntryInput {
  /** Path stored in the entry, forward-slash separated. */
  readonly name: string;
  readonly content: Buffer;
  /** `'0'` regular file (default). `'2'` symlink (with `linkname`). `'5'` dir. */
  readonly typeflag?: string;
  /** Target of a symlink entry. */
  readonly linkname?: string;
}

/**
 * Build a single tar header block. The checksum is computed with the checksum
 * field filled with ASCII spaces, per POSIX.
 */
function headerBlock(input: TarEntryInput): Buffer {
  const name = input.name;
  const typeflag = input.typeflag ?? '0';
  const linkname = input.linkname ?? '';

  const h = Buffer.alloc(BLOCK, 0);
  // name (0..99) — we only support names that fit; the relay's paths are
  // short workspace-relative names and the malicious fixtures are hand-built.
  h.write(name.slice(0, 100), 0, 'latin1');
  // mode (100..107): 0o644
  h.write('0000644\0', 100, 'latin1');
  // uid / gid (108..123): 0
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  // size (124..135): 11 octal digits + NUL
  h.write(octalStr(input.content.length, 12), 124, 'latin1');
  // mtime (136..147): 0
  h.write('00000000000\0', 136, 'latin1');
  // checksum placeholder (148..155): 8 spaces
  h.write('        ', 148, 'latin1');
  // typeflag (156)
  h.write(typeflag, 156, 'latin1');
  // linkname (157..256)
  if (linkname) h.write(linkname.slice(0, 100), 157, 'latin1');
  // magic + version (257..264): "ustar\0" "00"
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  // uname / gname (265..328): "root"
  h.write('root', 265, 'latin1');
  h.write('root', 297, 'latin1');
  // devmajor / devminor / prefix: left as NULs

  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += h[i]!;
  // checksum field is 8 bytes: 6 octal digits, NUL, space.
  h.write(octalStr(sum, 7).slice(0, 7) + ' ', 148, 'latin1');
  return h;
}

function padToBlock(content: Buffer): Buffer {
  const rem = content.length % BLOCK;
  if (rem === 0) return Buffer.alloc(0);
  return Buffer.alloc(BLOCK - rem, 0);
}

/**
 * Build a complete tar archive (uncompressed) from the given entries, in order,
 * terminated by two zero blocks.
 */
export function buildTar(entries: readonly TarEntryInput[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(headerBlock(e));
    parts.push(e.content);
    parts.push(padToBlock(e.content));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export interface TarReadEntry {
  readonly name: string;
  readonly typeflag: string;
  readonly linkname: string;
  readonly content: Buffer;
}

function readCString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  const end = nul === -1 ? len : nul;
  return slice.subarray(0, end).toString('latin1');
}

function readOctal(buf: Buffer, start: number, len: number): number {
  const s = readCString(buf, start, len).trim();
  if (s.length === 0) return 0;
  const n = parseInt(s, 8);
  return Number.isNaN(n) ? 0 : n;
}

function isZeroBlock(buf: Buffer): boolean {
  for (let i = 0; i < BLOCK; i += 1) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/**
 * Parse a tar archive buffer into entries. Stops at the first all-zero block.
 *
 * The reader is deliberately permissive about fields it does not need (mtime,
 * uname, …) and strict about the ones that matter for safety: it returns the
 * typeflag and linkname so callers can reject symlinks, absolute paths, and
 * `..` traversal.
 */
export function readTar(data: Buffer): TarReadEntry[] {
  const entries: TarReadEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (isZeroBlock(header)) break;

    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]!);
    const linkname = readCString(header, 157, 100);

    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;

    const content = data.subarray(offset, offset + size);
    offset += size;
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    offset += pad;

    entries.push({ name: fullName, typeflag, linkname, content });
  }
  return entries;
}
