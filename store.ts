// In-memory store: repositories, git objects, refs, issues, pull requests,
// labels and comments. One process, one trial: nothing is persisted to disk.
// Git objects live per repository in a Map keyed by hex sha; refs are
// full refnames ("refs/heads/main") mapped to tip shas.

import { objectId, parseCommit, parseTree, buildCommit, buildTree, type TreeEntry } from './gitobj.ts';
import { buildScenario, type ScenarioUser } from './scenario.ts';

export interface User {
  login: string;
  id: number;
  type: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  user: User;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  merge_commit_sha: string | null;
  user: User;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
}

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: User;
  description: string;
  default_branch: string;
  private: boolean;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  refs: Map<string, string>;
  objects: Map<string, { type: string; payload: Buffer }>;
  issues: Map<number, Issue>;
  nextIssue: number;
  nextIssueId: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  nextPullId: number;
  labels: Map<string, Label>;
  nextLabelId: number;
  nextCommentId: number;
}

/** Relay-style global ids: base64 of "<Kind>:<numeric id>". Opaque, stable. */
export function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

/** Parse a global id back to [kind, numeric id]; null when it is not one. */
export function parseNodeId(id: string): [string, number] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (!m) return null;
    return [m[1] as string, Number(m[2])];
  } catch {
    return null;
  }
}

const FORGE_NAME = 'forge';
const FORGE_EMAIL = 'forge@localhost';
/** Deterministic clock for forge-written git commits: fixed epoch + counter. */
const COMMIT_EPOCH = 1_735_689_600;

export class Store {
  readonly viewer: User;
  readonly scenario: ReturnType<typeof buildScenario>;
  readonly repos = new Map<string, Repo>(); // key: lower(owner) + '/' + lower(name)
  nextRepoId = 1;
  #commitCounter = 0;
  #lastIsoMs = 0;

  constructor() {
    this.scenario = buildScenario();
    const v: ScenarioUser = this.scenario.viewer;
    this.viewer = { login: v.login, id: v.id, type: 'User' };
  }

  /** Wall-clock ISO timestamp, strictly increasing (1ms steps) for stable ordering. */
  nowIso(): string {
    const now = Date.now();
    this.#lastIsoMs = Math.max(now, this.#lastIsoMs + 1);
    return new Date(this.#lastIsoMs).toISOString();
  }

  /** Next deterministic timestamp (seconds) for a forge-written git commit. */
  nextCommitTime(): number {
    this.#commitCounter += 1;
    return COMMIT_EPOCH + this.#commitCounter;
  }

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, description = '', defaultBranch = 'main', isPrivate = false): Repo {
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      full_name: `${this.viewer.login}/${name}`,
      owner: { ...this.viewer },
      description,
      default_branch: defaultBranch,
      private: isPrivate,
      created_at: now,
      updated_at: now,
      pushed_at: now,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      nextIssue: 1,
      nextIssueId: 1,
      pulls: new Map(),
      nextPull: 1,
      nextPullId: 1,
      labels: new Map(),
      nextLabelId: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(repo.owner.login, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.login.toLowerCase() === this.viewer.login.toLowerCase()) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // ---- git objects ----

  putObject(repo: Repo, type: string, payload: Buffer): string {
    const sha = objectId(type, payload);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, payload });
    return sha;
  }

  getObject(repo: Repo, sha: string): { type: string; payload: Buffer } | undefined {
    return repo.objects.get(sha.toLowerCase());
  }

  hasObject(repo: Repo, sha: string): boolean {
    return repo.objects.has(sha.toLowerCase());
  }

  /** All objects reachable from the given tip shas (commits, trees, blobs). */
  reachableObjects(repo: Repo, tips: string[]): Map<string, { type: string; payload: Buffer }> {
    const out = new Map<string, { type: string; payload: Buffer }>();
    const stack: string[] = [...tips];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      const key = sha.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const obj = repo.objects.get(key);
      if (!obj) continue;
      out.set(key, obj);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.payload);
        if (c.tree) stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.payload)) stack.push(e.sha);
      }
    }
    return out;
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    const a = ancestor.toLowerCase();
    const t = tip.toLowerCase();
    if (a === t) return true;
    if (a === '0000000000000000000000000000000000000000') return true;
    const stack = [t];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.payload).parents) {
        if (p.toLowerCase() === a) return true;
        stack.push(p.toLowerCase());
      }
    }
    return false;
  }

  /** The tree sha of a commit, or '' when the commit is unknown. */
  commitTree(repo: Repo, commitSha: string): string {
    const obj = repo.objects.get(commitSha.toLowerCase());
    if (!obj || obj.type !== 'commit') return '';
    return parseCommit(obj.payload).tree;
  }

  // ---- contents commits ----

  /**
   * Write `path` (slash-separated, no leading slash) into the tree of `branch`,
   * creating a commit. Returns the new commit sha. `content` is the blob bytes.
   * When the repo has no commit on the branch yet, the commit has no parent.
   */
  writeContents(repo: Repo, branch: string, path: string, content: Buffer, message: string): string {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? '';
    const segments = path.split('/').filter((s) => s.length > 0);
    const blobSha = this.putObject(repo, 'blob', content);
    const rootTree = tip ? this.commitTree(repo, tip) : '';
    const newRoot = this.#writePath(repo, rootTree, segments, blobSha);
    const when = this.nextCommitTime();
    const stamp = `${when} +0000`;
    const commit = buildCommit({
      tree: newRoot,
      parents: tip ? [tip] : [],
      author: `${FORGE_NAME} <${FORGE_EMAIL}> ${stamp}`,
      committer: `${FORGE_NAME} <${FORGE_EMAIL}> ${stamp}`,
      message,
    });
    const commitSha = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitSha);
    repo.pushed_at = this.nowIso();
    repo.updated_at = repo.pushed_at;
    return commitSha;
  }

  /** Replace (or insert) one path in a tree, rebuilding trees bottom-up. */
  #writePath(repo: Repo, treeSha: string, segments: string[], blobSha: string): string {
    const entries: TreeEntry[] = treeSha ? parseTree(repo.objects.get(treeSha)?.payload ?? Buffer.alloc(0)) : [];
    const [head, ...rest] = segments as [string, ...string[]];
    const existing = entries.find((e) => e.name === head);
    if (rest.length === 0) {
      // Leaf: replace or add the blob entry.
      const kept = entries.filter((e) => e.name !== head);
      kept.push({ mode: '100644', name: head, sha: blobSha });
      return this.putObject(repo, 'tree', buildTree(kept));
    }
    // Directory: recurse into the sub-tree (or an empty one).
    const subSha = existing && existing.mode === '40000' ? existing.sha : '';
    const newSub = this.#writePath(repo, subSha, rest, blobSha);
    const kept = entries.filter((e) => e.name !== head);
    kept.push({ mode: '40000', name: head, sha: newSub });
    return this.putObject(repo, 'tree', buildTree(kept));
  }

  /** Read a file's blob sha at a path in a commit's tree; '' when absent. */
  readPath(repo: Repo, commitSha: string, path: string): string {
    const segments = path.split('/').filter((s) => s.length > 0);
    let treeSha = this.commitTree(repo, commitSha);
    for (let i = 0; i < segments.length; i += 1) {
      if (!treeSha) return '';
      const entries = parseTree(repo.objects.get(treeSha)?.payload ?? Buffer.alloc(0));
      const entry = entries.find((e) => e.name === segments[i]);
      if (!entry) return '';
      if (i === segments.length - 1) return entry.mode === '40000' ? '' : entry.sha;
      if (entry.mode !== '40000') return '';
      treeSha = entry.sha;
    }
    return '';
  }

  /** Delete a path from a branch's tree and commit. Returns the new commit sha, or '' when absent. */
  deleteContents(repo: Repo, branch: string, path: string, message: string): string {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? '';
    if (!tip) return '';
    const segments = path.split('/').filter((s) => s.length > 0);
    const rootTree = this.commitTree(repo, tip);
    const newRoot = this.#deletePath(repo, rootTree, segments);
    if (newRoot === null) return '';
    const when = this.nextCommitTime();
    const stamp = `${when} +0000`;
    const commit = buildCommit({
      tree: newRoot,
      parents: [tip],
      author: `${FORGE_NAME} <${FORGE_EMAIL}> ${stamp}`,
      committer: `${FORGE_NAME} <${FORGE_EMAIL}> ${stamp}`,
      message,
    });
    const commitSha = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitSha);
    repo.pushed_at = this.nowIso();
    repo.updated_at = repo.pushed_at;
    return commitSha;
  }

  /** Remove one path from a tree; null when the path does not exist. */
  #deletePath(repo: Repo, treeSha: string, segments: string[]): string | null {
    if (!treeSha) return null;
    const entries = parseTree(repo.objects.get(treeSha)?.payload ?? Buffer.alloc(0));
    const [head, ...rest] = segments as [string, ...string[]];
    const existing = entries.find((e) => e.name === head);
    if (!existing) return null;
    if (rest.length === 0) {
      const kept = entries.filter((e) => e.name !== head);
      return this.putObject(repo, 'tree', buildTree(kept));
    }
    if (existing.mode !== '40000') return null;
    const newSub = this.#deletePath(repo, existing.sha, rest);
    if (newSub === null) return null;
    const kept = entries.filter((e) => e.name !== head);
    kept.push({ mode: '40000', name: head, sha: newSub });
    return this.putObject(repo, 'tree', buildTree(kept));
  }

  /** Best common ancestor (merge base) of two commits; '' when there is none. */
  mergeBase(repo: Repo, a: string, b: string): string {
    const ancA = new Set<string>();
    const qa = [a.toLowerCase()];
    while (qa.length > 0) {
      const sha = qa.shift() as string;
      if (ancA.has(sha)) continue;
      ancA.add(sha);
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.payload).parents) qa.push(p.toLowerCase());
    }
    const seenB = new Set<string>();
    const qb = [b.toLowerCase()];
    while (qb.length > 0) {
      const sha = qb.shift() as string;
      if (seenB.has(sha)) continue;
      seenB.add(sha);
      if (ancA.has(sha)) return sha;
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.payload).parents) qb.push(p.toLowerCase());
    }
    return '';
  }

  /**
   * True when a squash merge of head onto base has no content conflict:
   * a file conflicts only when both sides changed it (relative to the merge
   * base) to different contents. Ancestor checks alone are not enough — a
   * base that advanced without touching the head's files still merges.
   */
  isMergeable(repo: Repo, headSha: string, baseSha: string): boolean {
    const h = headSha.toLowerCase();
    const b = baseSha.toLowerCase();
    if (h === b) return true;
    const mb = this.mergeBase(repo, h, b);
    if (!mb) return true; // Unrelated histories: the squash takes the head tree.
    const baseFiles = new Map(this.listFiles(repo, mb).map((f) => [f.path, f.sha]));
    const headFiles = new Map(this.listFiles(repo, h).map((f) => [f.path, f.sha]));
    const curFiles = new Map(this.listFiles(repo, b).map((f) => [f.path, f.sha]));
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...curFiles.keys()]);
    for (const path of paths) {
      const m = baseFiles.get(path);
      const hf = headFiles.get(path);
      const cf = curFiles.get(path);
      if (hf !== m && cf !== m && hf !== cf) return false;
    }
    return true;
  }

  /** List every file (path -> blob sha) in a commit's tree, recursively. */
  listFiles(repo: Repo, commitSha: string): { path: string; sha: string; mode: string }[] {
    const out: { path: string; sha: string; mode: string }[] = [];
    const walk = (treeSha: string, prefix: string): void => {
      if (!treeSha) return;
      for (const e of parseTree(repo.objects.get(treeSha)?.payload ?? Buffer.alloc(0))) {
        const p = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.sha, p);
        else out.push({ path: p, sha: e.sha, mode: e.mode });
      }
    };
    walk(this.commitTree(repo, commitSha), '');
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit whose tree is
   * the head tip's tree and whose parent is the base tip. Returns the new
   * commit sha, or '' when the head or base tip is missing.
   */
  squashMerge(repo: Repo, pull: Pull): string {
    const baseRef = `refs/heads/${pull.base.ref}`;
    const baseTip = repo.refs.get(baseRef) ?? '';
    const headTip = pull.head.sha;
    if (!baseTip || !headTip) return '';
    const headTree = this.commitTree(repo, headTip);
    if (!headTree) return '';
    const when = this.nextCommitTime();
    const stamp = `${when} +0000`;
    const message = `${pull.title} (#${pull.number})`;
    const commit = buildCommit({
      tree: headTree,
      parents: [baseTip],
      author: `${FORGE_NAME} <${FORGE_EMAIL}> ${stamp}`,
      committer: `${FORGE_NAME} <${FORGE_EMAIL}> ${stamp}`,
      message,
    });
    const commitSha = this.putObject(repo, 'commit', commit);
    repo.refs.set(baseRef, commitSha);
    pull.merged = true;
    pull.state = 'closed';
    pull.merge_commit_sha = commitSha;
    pull.merged_at = this.nowIso();
    pull.closed_at = pull.merged_at;
    pull.updated_at = pull.merged_at;
    repo.pushed_at = pull.merged_at;
    repo.updated_at = pull.merged_at;
    return commitSha;
  }
}
