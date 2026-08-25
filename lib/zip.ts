/**
 * Minimal, dependency-free ZIP writer (deflate) using Node's built-in zlib.
 * Enough to bundle a handful of generated files (e.g. a batch of vouchers) into
 * a single downloadable archive. Not a general-purpose zip library.
 */
import { deflateRawSync } from 'zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  content: string | Buffer;
}

/** Build a ZIP archive (deflate-compressed) from the given entries. */
export function createZip(entries: ZipEntry[]): Buffer {
  const files = entries.map((e) => ({
    name: e.name,
    data: Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8'),
  }));

  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const comp = deflateRawSync(f.data);
    const method = 8; // deflate

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4);         // version needed to extract
    lfh.writeUInt16LE(0, 6);          // general purpose flags
    lfh.writeUInt16LE(method, 8);     // compression method
    lfh.writeUInt16LE(0, 10);         // mod time
    lfh.writeUInt16LE(0, 12);         // mod date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(f.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);         // extra field length
    localChunks.push(lfh, nameBuf, comp);

    const cdr = Buffer.alloc(46);
    cdr.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cdr.writeUInt16LE(20, 4);         // version made by
    cdr.writeUInt16LE(20, 6);         // version needed
    cdr.writeUInt16LE(0, 8);          // flags
    cdr.writeUInt16LE(method, 10);
    cdr.writeUInt16LE(0, 12);         // mod time
    cdr.writeUInt16LE(0, 14);         // mod date
    cdr.writeUInt32LE(crc, 16);
    cdr.writeUInt32LE(comp.length, 20);
    cdr.writeUInt32LE(f.data.length, 24);
    cdr.writeUInt16LE(nameBuf.length, 28);
    cdr.writeUInt16LE(0, 30);         // extra len
    cdr.writeUInt16LE(0, 32);         // comment len
    cdr.writeUInt16LE(0, 34);         // disk number start
    cdr.writeUInt16LE(0, 36);         // internal attributes
    cdr.writeUInt32LE(0, 38);         // external attributes
    cdr.writeUInt32LE(offset, 42);    // local header offset
    centralChunks.push(Buffer.concat([cdr, nameBuf]));

    offset += lfh.length + nameBuf.length + comp.length;
  }

  const central = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // central dir start disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);         // comment length

  return Buffer.concat([...localChunks, central, eocd]);
}
