// Git object model + packfile encode/decode. Node stdlib only, no git binary.
// Objects are stored in memory as full object bytes ("<type> <len>\0<payload>").
// Packs we generate carry full objects only (no deltas) — valid and simplest.
// Packs we receive may carry ofs-delta / ref-delta, so decoding applies them.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Full object bytes: "<type> <len>\0" + payload. */
export function objectBytes(type: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${payload.length}\0`, 'ascii'), payload]);
}

export function objectId(type: string, payload: Buffer): string {
  return sha1Hex(objectBytes(type, payload));
}

/** Parse a commit payload. */
export function parseCommit(payload: Buffer): {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
} {
  const text = payload.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit payload. `when` is seconds since epoch; tz is "+0000". */
export function buildCommit(opts: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let s = `tree ${opts.tree}\n`;
  for (const p of opts.parents) s += `parent ${p}\n`;
  s += `author ${opts.author}\ncommitter ${opts.committer}\n\n${opts.message}`;
  return Buffer.from(s, 'utf8');
}

export interface TreeEntry {
  mode: string; // e.g. '100644', '40000', '100755', '120000'
  name: string;
  sha: string; // hex
}

/** Parse a tree payload. */
export function parseTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < payload.length) {
    const sp = payload.indexOf(0x20, i);
    if (sp === -1) break;
    const mode = payload.toString('ascii', i, sp);
    const nul = payload.indexOf(0x00, sp + 1);
    if (nul === -1) break;
    const name = payload.toString('utf8', sp + 1, nul);
    const sha = payload.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

/** Git tree sort: entries sort by name, directories as if named "name/". */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/** Build a tree payload from entries (sorted git-style). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Pack object header varint: type in bits 4-6 of the first byte, size in its low 4 bits, then 7-bit groups. */
function readObjectHeader(buf: Buffer, off: number): { type: number; size: number; next: number } {
  const b0 = buf[off];
  const type = (b0 >> 4) & 0x7;
  let size = b0 & 0x0f;
  let shift = 4;
  let i = off;
  let b = b0;
  while (b & 0x80) {
    i += 1;
    b = buf[i];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, next: i + 1 };
}

/**
 * Inflate exactly one zlib stream starting at `start`, whose uncompressed size is
 * `expectedSize`. Binary-searches the stream end: inflateSync ignores trailing bytes
 * but throws on a truncated stream, so the smallest end offset that inflates to
 * exactly expectedSize bytes is the stream end.
 */
export function inflateOne(buf: Buffer, start: number, expectedSize: number): { data: Buffer; end: number } {
  let lo = start + 1;
  let hi = buf.length;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(start, mid));
      if (out.length === expectedSize) {
        found = mid;
        hi = mid - 1;
      } else if (out.length < expectedSize) {
        // Stream ended early: not the right end; keep looking further right.
        lo = mid + 1;
      } else {
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (found === -1) throw new Error(`inflate: no zlib stream of ${expectedSize} bytes at offset ${start}`);
  return { data: inflateSync(buf.subarray(start, found)), end: found };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off];
      off += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const resultSize = readVarint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      // copy from base: offset/size bytes follow per bitmask
      let cpOff = 0;
      let cpSize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          cpOff |= delta[off] << (8 * bit);
          off += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          cpSize |= delta[off] << (8 * bit);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      chunks.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      // insert literal bytes
      chunks.push(delta.subarray(off, off + op));
      produced += op;
      off += op;
    } else {
      throw new Error('delta: opcode 0');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== resultSize || produced !== resultSize) {
    throw new Error(`delta result size ${out.length} != ${resultSize}`);
  }
  return out;
}

/** Encode a packfile (v2, no deltas) from full objects. */
export function encodePack(objects: { type: string; payload: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    const code = TYPE_CODE[obj.type];
    if (code === undefined) throw new Error(`unknown object type ${obj.type}`);
    const size = obj.payload.length;
    // varint header: type in bits 4-6 of first byte, size low 4 bits, then 7-bit groups
    const headerBytes: number[] = [];
    let s = size;
    let first = (code << 4) | (s & 0x0f);
    s >>= 4;
    while (s > 0) {
      headerBytes.push(first | 0x80);
      first = s & 0x7f;
      s >>= 7;
    }
    headerBytes.push(first);
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.payload));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Decode a packfile into objects keyed by hex sha. Handles ofs-delta and ref-delta.
 * `resolveBase` is consulted for a ref-delta base that is not in the pack
 * itself (a thin pack, e.g. from real git pushing against objects the server
 * already holds); without it such a pack fails as before.
 */
export function decodePack(
  buf: Buffer,
  opts?: { resolveBase?: (sha: string) => { type: string; payload: Buffer } | undefined },
): Map<string, { type: string; payload: Buffer }> {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, { type: string; payload: Buffer }>();
  // Resolved objects by the pack offset where their entry starts (for ofs-delta bases,
  // which always precede the delta in a valid pack).
  const byOffset = new Map<number, { type: string; payload: Buffer }>();
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const entryStart = off;
    const hdr = readObjectHeader(buf, off);
    off = hdr.next;
    if (hdr.type === 6) {
      // ofs-delta: negative offset varint to the base object's entry start.
      let b = buf[off];
      off += 1;
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[off];
        off += 1;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const { data, end } = inflateOne(buf, off, hdr.size);
      const base = byOffset.get(entryStart - baseOff);
      if (!base) throw new Error('ofs-delta base not found');
      const payload = applyDelta(base.payload, data);
      const obj = { type: base.type, payload };
      byOffset.set(entryStart, obj);
      objects.set(objectId(obj.type, obj.payload), obj);
      off = end;
    } else if (hdr.type === 7) {
      // ref-delta: 20-byte base sha follows the header.
      const baseSha = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const { data, end } = inflateOne(buf, off, hdr.size);
      const base = objects.get(baseSha) ?? opts?.resolveBase?.(baseSha);
      if (!base) throw new Error(`ref-delta base ${baseSha} not found`);
      const payload = applyDelta(base.payload, data);
      const obj = { type: base.type, payload };
      byOffset.set(entryStart, obj);
      objects.set(objectId(obj.type, obj.payload), obj);
      off = end;
    } else {
      const typeName = CODE_TYPE[hdr.type];
      if (!typeName) throw new Error(`unknown pack object type ${hdr.type}`);
      const { data, end } = inflateOne(buf, off, hdr.size);
      const obj = { type: typeName, payload: data };
      byOffset.set(entryStart, obj);
      objects.set(objectId(obj.type, obj.payload), obj);
      off = end;
    }
  }
  return objects;
}
