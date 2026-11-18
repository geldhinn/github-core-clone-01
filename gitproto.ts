// Git smart-HTTP for the forge: upload-pack (protocol v2 and v0) and
// receive-pack (v0 only). Node stdlib only; no git binary.
//
// Wire facts (from the kit's git-client.ts, which is what the suite speaks):
// - GET /{owner}/{repo}.git/info/refs?service=<service> with
//   "Git-Protocol: version=2" answers a v2 capability advertisement
//   ("version 2" first line); without it, a v0 ref advertisement behind a
//   "# service=<service>" preamble. Content-Type is
//   application/x-<service>-advertisement. A missing repo is 404.
// - v2 upload-pack: command=ls-refs / command=fetch, args after a delim.
//   ls-refs answers "<oid> <ref>[ symref-target:X][ peeled:Y]" lines and
//   "unborn <ref> symref-target:X" for an unborn HEAD. fetch answers
//   sections (acknowledgments / shallow-info / packfile) separated by delim
//   and closed by a flush; the packfile section carries the pack in
//   side-band-64k frames (one channel byte + data per pkt-line).
// - v0 upload-pack: wants (+capabilities on the first want line), shallow
//   and deepen lines, flush, haves, done, flush. The answer is a bare NAK
//   pkt-line, bare shallow lines, then the pack in side-band-64k.
// - v0 receive-pack: "<old> <new> <ref>" lines (capabilities after NUL on
//   the first), flush, then the raw pack. The answer is a report-status
//   stream ("unpack ok", "ok <ref>" / "ng <ref> <reason>") pkt-lined inside
//   side-band-64k channel 1, closed by a flush. Capabilities advertised:
//   report-status, side-band-64k, delete-refs, ofs-delta, agent.
// - A non-fast-forward update is refused per ref with the exact reason
//   "non-fast-forward" and the ref does not move; a mixed push applies the
//   fast-forward refs and reports one line each. A refused push still
//   unpacks (unpack ok) and its objects are kept.

import { decodePack, encodePack, parseCommit, parseTree } from './gitobj.ts';
import type { Repo } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'forge/1.0.0';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function textReply(status: number, body: string): GitReply {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(body, 'utf8') };
}

export function notFoundReply(): GitReply {
  return textReply(404, JSON.stringify({ message: 'Not Found' }));
}

// ---- pkt-line framing ----

/** One pkt-line: 4 hex digits (total length incl. the 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > 65520) throw new Error(`pkt-line of ${len} bytes exceeds the 65520 limit`);
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim';
export interface Pkt {
  kind: PktKind;
  payload: Buffer; // empty for flush/delim
}

/** Sequential pkt-line reader over a buffer. Throws on malformed framing. */
export class PktReader {
  #buf: Buffer;
  #off = 0;

  constructor(buf: Buffer) {
    this.#buf = buf;
  }

  get offset(): number {
    return this.#off;
  }

  get remaining(): number {
    return this.#buf.length - this.#off;
  }

  /** Read one packet, or null at end of buffer. */
  next(): Pkt | null {
    if (this.#off >= this.#buf.length) return null;
    if (this.#off + 4 > this.#buf.length) throw new Error('pkt-line truncated at the length prefix');
    const lenText = this.#buf.toString('ascii', this.#off, this.#off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`malformed pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      this.#off += 4;
      return { kind: 'flush', payload: Buffer.alloc(0) };
    }
    if (len === 1) {
      this.#off += 4;
      return { kind: 'delim', payload: Buffer.alloc(0) };
    }
    if (len < 4 || len > 65520) throw new Error(`bad pkt-line length ${len}`);
    if (this.#off + len > this.#buf.length) throw new Error('pkt-line truncated at the payload');
    const payload = this.#buf.subarray(this.#off + 4, this.#off + len);
    this.#off += len;
    return { kind: 'data', payload };
  }

  /** Read data packets until a flush/delim/end; returns their payloads as strings. */
  readLines(): string[] {
    const lines: string[] = [];
    for (;;) {
      const pkt = this.next();
      if (pkt === null || pkt.kind !== 'data') return lines;
      lines.push(pkt.payload.toString('utf8'));
    }
  }

  /**
   * Read every data packet in the buffer, skipping delim/flush packets.
   * Protocol v2 puts its arguments after a delim packet, so a reader that
   * stops at the first delim never sees them.
   */
  readAllLines(): string[] {
    const lines: string[] = [];
    for (;;) {
      const pkt = this.next();
      if (pkt === null) return lines;
      if (pkt.kind === 'data') lines.push(pkt.payload.toString('utf8'));
    }
  }
}

/** Wrap bytes into side-band-64k frames (channel byte + <=65515 data bytes). */
export function sideband(data: Buffer, channel = 1): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (data.length === 0) {
    // A zero-length frame keeps the section non-empty for the reader.
    parts.push(pktLine(Buffer.from([channel])));
    return Buffer.concat(parts);
  }
  for (let off = 0; off < data.length; off += CHUNK) {
    const chunk = data.subarray(off, Math.min(data.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([channel]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---- ref helpers ----

function headRefName(repo: Repo): string {
  return `refs/heads/${repo.default_branch}`;
}

/** Follow an annotated tag to the commit it points at (through nested tags). */
function peelToCommit(repo: Repo, sha: string): string {
  let cur = sha.toLowerCase();
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return obj?.type === 'commit' ? cur : '';
    const text = obj.payload.toString('utf8');
    const m = /^object ([0-9a-f]{40})\ntype (\w+)/m.exec(text);
    if (!m) return '';
    cur = m[1];
    if (m[2] === 'commit') return cur;
  }
  return '';
}

/** Sorted refs as [name, oid] pairs (refs/heads/* then refs/tags/*, by name). */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function uploadPackCaps(): string {
  return `side-band-64k thin-pack ofs-delta multi_ack shallow agent=${AGENT}`;
}

function receivePackCaps(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

/** v0 ref-advertisement lines for a repo (first line carries the capabilities). */
function v0RefLines(repo: Repo, caps: string): string[] {
  const refs = sortedRefs(repo);
  const head = headRefName(repo);
  const headTip = repo.refs.get(head) ?? '';
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    return lines;
  }
  const symref = `symref=HEAD:${head}`;
  const firstCaps = caps.includes('symref=') ? caps : `${caps} ${symref}`;
  lines.push(`${headTip || ZERO_OID} HEAD\0${firstCaps}\n`);
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}\n`);
    const obj = repo.objects.get(oid.toLowerCase());
    if (obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  return lines;
}

// ---- info/refs ----

/**
 * GET /{owner}/{repo}.git/info/refs?service=<service>.
 * `wantV2` is true when the request carried "Git-Protocol: version=2".
 */
export function handleInfoRefs(
  repo: Repo | undefined,
  owner: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  wantV2: boolean,
): GitReply {
  if (!repo || repo.owner.login.toLowerCase() !== owner.toLowerCase()) return notFoundReply();
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantV2) {
    const lines = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
    return {
      status: 200,
      contentType,
      body: Buffer.concat([...lines.map((l) => pktLine(l)), flushPkt()]),
    };
  }
  const caps = service === 'git-upload-pack' ? uploadPackCaps() : receivePackCaps();
  const preamble = pktLine(`# service=${service}\n`);
  const refLines = v0RefLines(repo, caps);
  return {
    status: 200,
    contentType,
    body: Buffer.concat([preamble, flushPkt(), ...refLines.map((l) => pktLine(l)), flushPkt()]),
  };
}

// ---- fetch computation ----

/** Full tree closure: the tree, its subtrees and blobs. */
function treeClosure(repo: Repo, treeSha: string, out: Map<string, { type: string; payload: Buffer }>): void {
  const stack = [treeSha.toLowerCase()];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    out.set(sha, obj);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.payload)) stack.push(e.sha.toLowerCase());
    }
  }
}

/** Full closure of one tip: tag objects, commits, trees, blobs. */
function fullClosure(repo: Repo, tip: string, out: Map<string, { type: string; payload: Buffer }>): void {
  const stack = [tip.toLowerCase()];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    out.set(sha, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.payload);
      if (c.tree) treeClosure(repo, c.tree, out);
      for (const p of c.parents) stack.push(p.toLowerCase());
    } else if (obj.type === 'tag') {
      const text = obj.payload.toString('utf8');
      const m = /^object ([0-9a-f]{40})/m.exec(text);
      if (m) stack.push(m[1].toLowerCase());
    } else if (obj.type === 'tree') {
      treeClosure(repo, sha, out);
    }
  }
}

interface FetchPlan {
  objects: Map<string, { type: string; payload: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/**
 * What a fetch sends. wantClosure is the depth-limited closure of the wants
 * (generation < depth when depth is given); haveClosure is what the client
 * already holds (full closure of the haves, minus the closure of the parents
 * of the client's shallow boundaries, which the client does not hold).
 * New shallow boundaries are commits in the want closure whose parents are
 * not in it; old boundaries whose parents are now included are unshallow.
 */
function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  // --- depth-limited commit walk from the wants ---
  const wantCommits = new Map<string, number>(); // sha -> generation
  const wantObjects = new Map<string, { type: string; payload: Buffer }>();
  const queue: Array<{ sha: string; gen: number }> = [];
  for (const want of wants) {
    const obj = repo.objects.get(want.toLowerCase());
    if (!obj) continue;
    if (obj.type === 'tag') {
      wantObjects.set(want.toLowerCase(), obj);
      const target = peelToCommit(repo, want);
      if (target) queue.push({ sha: target, gen: 0 });
      // A tag pointing at a tree/blob: include its target directly.
      if (!target) {
        const text = obj.payload.toString('utf8');
        const m = /^object ([0-9a-f]{40})/m.exec(text);
        if (m) fullClosure(repo, m[1], wantObjects);
      }
    } else if (obj.type === 'commit') {
      queue.push({ sha: want.toLowerCase(), gen: 0 });
    } else {
      fullClosure(repo, want, wantObjects);
    }
  }
  while (queue.length > 0) {
    const { sha, gen } = queue.shift() as { sha: string; gen: number };
    if (wantCommits.has(sha)) continue;
    if (depth !== null && gen >= depth) continue;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    wantCommits.set(sha, gen);
    wantObjects.set(sha, obj);
    const c = parseCommit(obj.payload);
    if (c.tree) treeClosure(repo, c.tree, wantObjects);
    for (const p of c.parents) queue.push({ sha: p.toLowerCase(), gen: gen + 1 });
  }
  // --- what the client already holds ---
  const held = new Map<string, { type: string; payload: Buffer }>();
  for (const have of haves) fullClosure(repo, have, held);
  for (const boundary of clientShallow) {
    const obj = repo.objects.get(boundary.toLowerCase());
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.payload).parents) {
      const drop = new Map<string, { type: string; payload: Buffer }>();
      fullClosure(repo, p, drop);
      for (const key of drop.keys()) held.delete(key);
    }
  }
  // --- pack: wanted minus held ---
  const objects = new Map<string, { type: string; payload: Buffer }>();
  for (const [sha, obj] of wantObjects) {
    if (!held.has(sha)) objects.set(sha, obj);
  }
  // --- shallow boundaries ---
  // A commit is a boundary when the walk stopped at it: either it sits at
  // the requested depth limit (generation == depth-1, roots included — real
  // git marks a root tip shallow for a depth-1 fetch) or it has parents
  // that were not reached. With no depth limit a full walk reaches every
  // ancestor, so no boundary arises.
  const shallow: string[] = [];
  for (const [sha, gen] of wantCommits) {
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    const parents = parseCommit(obj.payload).parents;
    if (depth !== null && gen === depth - 1) {
      shallow.push(sha);
    } else if (parents.length > 0 && parents.every((p) => !wantCommits.has(p.toLowerCase()))) {
      shallow.push(sha);
    }
  }
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    const key = boundary.toLowerCase();
    if (!wantCommits.has(key)) continue;
    const obj = repo.objects.get(key);
    if (!obj) continue;
    const parents = parseCommit(obj.payload).parents;
    if (parents.every((p) => wantCommits.has(p.toLowerCase()))) unshallow.push(key);
  }
  shallow.sort();
  unshallow.sort();
  return { objects, shallow, unshallow };
}

function packFromObjects(objects: Map<string, { type: string; payload: Buffer }>): Buffer {
  const list = [...objects.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, obj]) => ({ type: obj.type, payload: obj.payload }));
  return encodePack(list);
}

// ---- ls-refs (v2) ----

function lsRefsLines(repo: Repo, prefixes: string[]): string[] {
  const lines: string[] = [];
  const head = headRefName(repo);
  const headTip = repo.refs.get(head) ?? '';
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  // HEAD is a ref like any other for prefix matching: a clone asks for
  // ref-prefix HEAD and needs the HEAD line (with its symref-target) back.
  // A refs/heads/ or refs/tags/ prefix does not match HEAD, so it stays out.
  if (matches('HEAD')) {
    if (headTip) lines.push(`${headTip} HEAD symref-target:${head}\n`);
    else lines.push(`unborn HEAD symref-target:${head}\n`);
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    const obj = repo.objects.get(oid.toLowerCase());
    if (obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return lines;
}

// ---- upload-pack ----

export function handleUploadPack(repo: Repo | undefined, owner: string, body: Buffer, wantV2: boolean): GitReply {
  if (!repo || repo.owner.login.toLowerCase() !== owner.toLowerCase()) return notFoundReply();
  const contentType = 'application/x-git-upload-pack-result';
  let reader: PktReader;
  try {
    reader = new PktReader(body);
    if (wantV2) return uploadPackV2(repo, reader, contentType);
    return uploadPackV0(repo, reader, contentType);
  } catch (err) {
    return textReply(400, JSON.stringify({ message: `bad git request: ${err instanceof Error ? err.message : String(err)}` }));
  }
}

function uploadPackV2(repo: Repo, reader: PktReader, contentType: string): GitReply {
  const lines = reader.readAllLines();
  const command = (lines[0] ?? '').trim();
  if (command === 'command=ls-refs') {
    const prefixes: string[] = [];
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
    }
    const out = lsRefsLines(repo, prefixes);
    return {
      status: 200,
      contentType,
      body: Buffer.concat([...out.map((l) => pktLine(l)), flushPkt()]),
    };
  }
  if (command === 'command=fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (t.startsWith('want ')) wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) {
        const n = Number.parseInt(t.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
      // thin-pack / no-progress / ofs-delta / filter / agent / object-format /
      // deepen-since / deepen-not / done: accepted and ignored (we send full
      // objects; a filter is a superset request, so the full pack satisfies it).
    }
    if (wants.length === 0) {
      // No wants: an empty pack. (The kit client never sends this, but stay
      // well-formed: no acknowledgments section without haves.)
      const parts: Buffer[] = [];
      if (haves.length > 0) parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktLine('ready\n'), delimPkt());
      parts.push(pktLine('packfile\n'), sideband(packFromObjects(new Map())), flushPkt());
      return { status: 200, contentType, body: Buffer.concat(parts) };
    }
    const plan = computeFetch(repo, wants, haves, shallow, depth);
    // Section order is strict for real git: acknowledgments only when the
    // client sent haves, shallow-info only for a shallow/unshallow fetch,
    // then the packfile. Sending an acknowledgments section to a client
    // that sent no haves makes git die with "expected 'packfile'".
    // The acknowledgments section must end with "ready" (after NAK/ACK):
    // without it git refuses any further section after the acks.
    const parts: Buffer[] = [];
    if (haves.length > 0) parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktLine('ready\n'), delimPkt());
    if (depth !== null || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(delimPkt());
    }
    parts.push(pktLine('packfile\n'), sideband(packFromObjects(plan.objects)), flushPkt());
    return { status: 200, contentType, body: Buffer.concat(parts) };
  }
  return textReply(400, JSON.stringify({ message: `unknown v2 command ${JSON.stringify(command)}` }));
}

function uploadPackV0(repo: Repo, reader: PktReader, contentType: string): GitReply {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  // Section 1: wants, shallow, deepen — up to the first flush.
  for (;;) {
    const pkt = reader.next();
    if (pkt === null || pkt.kind !== 'data') break;
    const t = pkt.payload.toString('utf8').trim();
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0].trim());
    else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) {
      const n = Number.parseInt(t.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  // Section 2: haves, done — up to the second flush.
  for (;;) {
    const pkt = reader.next();
    if (pkt === null || pkt.kind !== 'data') break;
    const t = pkt.payload.toString('utf8').trim();
    if (t.startsWith('have ')) haves.push(t.slice(5).trim());
  }
  if (wants.length === 0) {
    return { status: 200, contentType, body: Buffer.concat([pktLine('NAK\n'), sideband(packFromObjects(new Map())), flushPkt()]) };
  }
  const plan = computeFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(sideband(packFromObjects(plan.objects)), flushPkt());
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// ---- receive-pack (v0) ----

export function handleReceivePack(repo: Repo | undefined, owner: string, body: Buffer): GitReply {
  if (!repo || repo.owner.login.toLowerCase() !== owner.toLowerCase()) return notFoundReply();
  const contentType = 'application/x-git-receive-pack-result';
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  try {
    const reader = new PktReader(body);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (;;) {
      const pkt = reader.next();
      if (pkt === null || pkt.kind !== 'data') break;
      const text = pkt.payload.toString('utf8');
      const nul = text.indexOf('\0');
      const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
      if (!line) continue;
      const parts = line.split(' ');
      if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(line)}`);
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    // The pack follows the command flush (absent for a delete-only push).
    let packObjects: Map<string, { type: string; payload: Buffer }> | null = null;
    if (reader.remaining > 0) {
      const packBuf = body.subarray(reader.offset);
      try {
        packObjects = decodePack(packBuf, {
          resolveBase: (sha) => repo.objects.get(sha.toLowerCase()),
        });
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : String(err);
      }
    }
    if (packObjects) {
      for (const [sha, obj] of packObjects) repo.objects.set(sha, obj);
    }
    // Apply the commands (only when the pack unpacked).
    for (const cmd of commands) {
      if (!unpackOk) {
        reportLines.push(`ng ${cmd.ref} unpack failed\n`);
        continue;
      }
      reportLines.push(`${applyPushCommand(repo, cmd)}\n`);
    }
    if (!unpackOk) reportLines.unshift(`unpack ${unpackDetail}\n`);
    else reportLines.unshift('unpack ok\n');
  } catch (err) {
    // A malformed command list: report an unpack failure and stay up.
    // The report-status stream is pkt-lined inside sideband channel 1 and
    // ends with a flush pkt-line inside the channel, so the reader sees a
    // proper flush (an outer-only flush reads as EOF and fails the push).
    const detail = err instanceof Error ? err.message : String(err);
    const inner = Buffer.concat([pktLine(`unpack ${detail}\n`), flushPkt()]);
    return {
      status: 200,
      contentType,
      body: Buffer.concat([sideband(inner), flushPkt()]),
    };
  }
  const inner = Buffer.concat([...reportLines.map((l) => pktLine(l)), flushPkt()]);
  return { status: 200, contentType, body: Buffer.concat([sideband(inner), flushPkt()]) };
}

/** Apply one push command; returns the report line ("ok <ref>" / "ng <ref> <reason>"). */
function applyPushCommand(
  repo: Repo,
  cmd: { oldOid: string; newOid: string; ref: string },
): string {
  const { oldOid, newOid, ref } = cmd;
  if (!ref.startsWith('refs/')) return `ng ${ref} invalid refname`;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return `ng ${ref} remote ref does not exist`;
    repo.refs.delete(ref);
    repo.pushed_at = new Date().toISOString();
    repo.updated_at = repo.pushed_at;
    return `ok ${ref}`;
  }
  if (!repo.objects.has(newOid.toLowerCase())) return `ng ${ref} object not found`;
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return `ng ${ref} already exists`;
    repo.refs.set(ref, newOid);
  } else {
    // Update: must be a fast-forward from the advertised old value.
    if (current === undefined) return `ng ${ref} remote ref does not exist`;
    if (current.toLowerCase() !== oldOid.toLowerCase()) return `ng ${ref} non-fast-forward`;
    // isAncestor treats the zero oid as an ancestor of everything; here
    // oldOid is a real commit, so this is the real fast-forward check.
    const obj = repo.objects.get(newOid.toLowerCase());
    if (!obj || obj.type !== 'commit') return `ng ${ref} non-fast-forward`;
    let ok = false;
    // Walk from newOid: the old tip must be reachable (or equal).
    const stack = [newOid.toLowerCase()];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (sha === oldOid.toLowerCase()) {
        ok = true;
        break;
      }
      if (seen.has(sha)) continue;
      seen.add(sha);
      const o = repo.objects.get(sha);
      if (!o || o.type !== 'commit') continue;
      for (const p of parseCommit(o.payload).parents) stack.push(p.toLowerCase());
    }
    if (!ok) return `ng ${ref} non-fast-forward`;
    repo.refs.set(ref, newOid);
  }
  repo.pushed_at = new Date().toISOString();
  repo.updated_at = repo.pushed_at;
  return `ok ${ref}`;
}
