// GitHub REST v3 API under /api/v3. Every reply is application/json, carries a
// non-empty X-GitHub-Request-Id, and errors carry a JSON body with a string
// message. Bearer auth: the token is MAKEFUN_SHOP_TOKEN; a missing or wrong
// token is 401 (except the public API root and /healthz). A repository belongs
// to the login the token names, so the same name under another owner is 404.

import type { Store, Repo, Issue, Pull, Label } from './store.ts';
import { nodeId } from './store.ts';

export interface RestContext {
  store: Store;
  token: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers: { 'x-github-request-id': requestId(), ...headers } };
}

export function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

/** The bearer token on the request, or '' when absent. */
export function bearerToken(req: { headers: Record<string, string | string[] | undefined> }): string {
  const h = req.headers['authorization'];
  const v = Array.isArray(h) ? h[0] : h;
  if (!v || !v.startsWith('Bearer ')) return '';
  return v.slice('Bearer '.length).trim();
}

export function isAuthed(ctx: RestContext, token: string): boolean {
  return token !== '' && token === ctx.token;
}

// ---- object shapes (GitHub REST v3) ----

export function userJson(store: Store, login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: nodeId('User', id),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: repo.full_name,
    owner: userJson(store, repo.owner.login, repo.owner.id),
    private: repo.private,
    html_url: `https://github.com/${repo.full_name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.full_name}`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url: `git://github.com/${repo.full_name}.git`,
    ssh_url: `git@github.com:${repo.full_name}.git`,
    clone_url: `https://github.com/${repo.full_name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    watchers: 0,
    default_branch: repo.default_branch,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.full_name}`,
    labels_url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.full_name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(store, issue.user.login, issue.user.id),
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return l ? labelJson(l) : { id: 0, node_id: '', name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    url: `/api/v3/repos/${repo.full_name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.full_name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(store, pull.user.login, pull.user.id),
    labels: [],
    milestone: null,
    locked: false,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    merged: pull.merged,
    mergeable: pull.mergeable === 'MERGEABLE',
    mergeable_state: pull.mergeable === 'MERGEABLE' ? 'clean' : pull.mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    head: {
      label: pull.head.label,
      ref: pull.head.ref,
      sha: pull.head.sha,
      user: userJson(store, repo.owner.login, repo.owner.id),
      repo: repoJson(store, repo),
    },
    base: {
      label: pull.base.label,
      ref: pull.base.ref,
      sha: pull.base.sha,
      user: userJson(store, repo.owner.login, repo.owner.id),
      repo: repoJson(store, repo),
    },
    author_association: 'OWNER',
    draft: false,
  };
}

/** Parse ?per_page=&page= ; GitHub defaults per_page 30, page 1. */
export function pageParams(url: URL): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  return { perPage, page };
}

/** Slice a list into one page and build the Link header (rel next/last). */
export function paginate<T>(items: T[], url: URL): { page: T[]; link: string | null } {
  const { perPage, page } = pageParams(url);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const base = `${url.origin}${url.pathname}`;
  const qs = (p: number): string => {
    const q = new URLSearchParams(url.searchParams);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${base}?${q.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${qs(page + 1)}>; rel="next"`);
  if (totalPages > 1) links.push(`<${qs(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${qs(1)}>; rel="first"`);
  if (page > 1) links.push(`<${qs(page - 1)}>; rel="prev"`);
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

export function linkHeader(link: string | null): Record<string, string> {
  return link ? { link } : {};
}

// ---- router ----

import { parseCommit, parseTree } from './gitobj.ts';

export interface RestRequest {
  method: string;
  url: URL;
  token: string;
  body: unknown; // parsed JSON, or undefined when there is no body
  bodyMalformed: boolean;
}

function needRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return null;
  // A repository belongs to the login the token names: the same name under
  // another owner is 404, never 403.
  if (repo.owner.login.toLowerCase() !== owner.toLowerCase()) return null;
  return repo;
}

/** The contents GET shape for one file. */
function contentsFileJson(store: Store, repo: Repo, path: string, blobSha: string): Record<string, unknown> {
  const obj = store.getObject(repo, blobSha);
  const content = obj ? obj.payload : Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name,
    path,
    content: content.toString('base64'),
    sha: blobSha,
    url: `/api/v3/repos/${repo.full_name}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.full_name}/git/blobs/${blobSha}`,
    html_url: `https://github.com/${repo.full_name}/blob/${repo.default_branch}/${path}`,
    download_url: `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${path}`,
  };
}

function decodeBase64Field(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

/** The tree sha at a directory path in a commit's tree; '' when it is not a directory. */
function dirTreeSha(store: Store, repo: Repo, tip: string, dirPath: string): string {
  let treeSha = store.commitTree(repo, tip);
  const segments = dirPath.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (!treeSha) return '';
    const entries = parseTree(store.getObject(repo, treeSha)?.payload ?? Buffer.alloc(0));
    const entry = entries.find((e) => e.name === seg);
    if (!entry || entry.mode !== '40000') return '';
    treeSha = entry.sha;
  }
  return treeSha;
}

function splitLines(buf: Buffer): string[] {
  if (buf.length === 0) return [];
  const lines = buf.toString('utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line additions/deletions between two blobs, via LCS length (files are small). */
function diffLines(a: Buffer, b: Buffer): { additions: number; deletions: number } {
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  const n = bLines.length;
  let prev = new Array<number>(n + 1).fill(0);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= aLines.length; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      cur[j] = aLines[i - 1] === bLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[n];
  return { additions: n - lcs, deletions: aLines.length - lcs };
}

/** Route one REST request. Returns null when the path is not a REST route. */
export function routeRest(ctx: RestContext, req: RestRequest): Reply | null {
  const { store } = ctx;
  const method = req.method;
  const path = req.url.pathname;
  if (!path.startsWith('/api/v3')) return null;

  // Public API root: 200 with scopes, no auth.
  if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    return jsonReply(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // Everything else under /api/v3 needs the bearer token.
  if (!isAuthed(ctx, req.token)) return errorReply(401, 'Bad credentials');
  if (req.bodyMalformed) return errorReply(400, 'Problems parsing JSON');

  const parts = path.split('/').filter((p) => p.length > 0); // ['api','v3',...]
  const rest = parts.slice(2);

  // GET /api/v3/meta
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    return jsonReply(200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_enterprise: false });
  }

  // GET /api/v3/user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    return jsonReply(200, userJson(store, store.viewer.login, store.viewer.id));
  }

  // /api/v3/user/repos
  if (rest.length >= 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET' && rest.length === 2) {
      const { page, link } = paginate(store.listViewerRepos(), req.url);
      return jsonReply(200, page.map((r) => repoJson(store, r)), linkHeader(link));
    }
    if (method === 'POST' && rest.length === 2) {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name) return errorReply(422, 'Validation Failed: name is required');
      if (store.getRepo(store.viewer.login, name)) return errorReply(422, 'Validation Failed: name already exists on this account');
      const repo = store.createRepo(
        name,
        typeof b.description === 'string' ? b.description : '',
        typeof b.default_branch === 'string' && b.default_branch ? (b.default_branch as string) : 'main',
        b.private === true,
      );
      return jsonReply(201, repoJson(store, repo));
    }
    return errorReply(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1] as string);
    const name = decodeURIComponent(rest[2] as string);
    const repo = needRepo(ctx, owner, name);
    const tail = rest.slice(3);

    // GET/PATCH/DELETE /repos/{owner}/{repo}
    if (tail.length === 0) {
      if (method === 'GET') {
        if (!repo) return errorReply(404, 'Not Found');
        return jsonReply(200, repoJson(store, repo));
      }
      if (method === 'PATCH') {
        if (!repo) return errorReply(404, 'Not Found');
        const b = (req.body ?? {}) as Record<string, unknown>;
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.default_branch === 'string' && b.default_branch) repo.default_branch = b.default_branch;
        repo.updated_at = store.nowIso();
        return jsonReply(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        if (!repo) return errorReply(404, 'Not Found');
        store.deleteRepo(owner, name);
        return { status: 204, body: '', headers: { 'x-github-request-id': requestId() } };
      }
      return errorReply(404, 'Not Found');
    }

    // Everything below needs the repo to exist.
    if (!repo) return errorReply(404, 'Not Found');

    // Git references (POST /git/refs creates a branch at a sha).
    if (tail[0] === 'git' && tail[1] === 'refs') {
      const refJson = (ref: string, sha: string): Record<string, unknown> => {
        const obj = store.getObject(repo, sha);
        return {
          ref,
          url: `/api/v3/repos/${repo.full_name}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: obj?.type ?? 'commit', url: `/api/v3/repos/${repo.full_name}/git/commits/${sha}` },
        };
      };
      if (method === 'POST' && tail.length === 2) {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? (b.sha as string).toLowerCase() : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
          return errorReply(422, 'Validation Failed: ref and sha are required');
        }
        if (!store.getObject(repo, sha)) return errorReply(422, 'Validation Failed: Object does not exist');
        if (repo.refs.has(ref)) return errorReply(422, 'Validation Failed: Reference already exists');
        repo.refs.set(ref, sha);
        repo.pushed_at = store.nowIso();
        repo.updated_at = repo.pushed_at;
        return jsonReply(201, refJson(ref, sha));
      }
      if (method === 'GET' && tail.length === 2) {
        const list = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([ref, sha]) => refJson(ref, sha));
        const { page, link } = paginate(list, req.url);
        return jsonReply(200, page, linkHeader(link));
      }
      if (tail.length >= 3) {
        const ref = `refs/${tail.slice(2).map((p) => decodeURIComponent(p)).join('/')}`;
        const sha = repo.refs.get(ref);
        if (method === 'GET' && tail.length >= 3) {
          if (!sha) return errorReply(404, 'Not Found');
          return jsonReply(200, refJson(ref, sha));
        }
        if (method === 'DELETE') {
          if (!sha) return errorReply(404, 'Not Found');
          repo.refs.delete(ref);
          repo.pushed_at = store.nowIso();
          repo.updated_at = repo.pushed_at;
          return { status: 204, body: '', headers: { 'x-github-request-id': requestId() } };
        }
        if (method === 'PATCH') {
          if (!sha) return errorReply(404, 'Not Found');
          const b = (req.body ?? {}) as Record<string, unknown>;
          const newSha = typeof b.sha === 'string' ? (b.sha as string).toLowerCase() : '';
          if (!/^[0-9a-f]{40}$/.test(newSha) || !store.getObject(repo, newSha)) {
            return errorReply(422, 'Validation Failed: Object does not exist');
          }
          if (b.force !== true && !store.isAncestor(repo, sha, newSha)) {
            return errorReply(422, 'Validation Failed: Update is not a fast forward');
          }
          repo.refs.set(ref, newSha);
          repo.pushed_at = store.nowIso();
          repo.updated_at = repo.pushed_at;
          return jsonReply(200, refJson(ref, newSha));
        }
      }
      return errorReply(404, 'Not Found');
    }

    // Branches
    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({
            name: branch,
            commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? '', url: `/api/v3/repos/${repo.full_name}/commits/${repo.refs.get(`refs/heads/${branch}`) ?? ''}` },
            protected: false,
          }));
        const { page, link } = paginate(list, req.url);
        return jsonReply(200, page, linkHeader(link));
      }
      if (method === 'GET' && tail.length === 2) {
        const branch = decodeURIComponent(tail[1] as string);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return errorReply(404, 'Not Found');
        return jsonReply(200, {
          name: branch,
          commit: { sha, url: `/api/v3/repos/${repo.full_name}/commits/${sha}` },
          protected: false,
        });
      }
      return errorReply(404, 'Not Found');
    }

    // Commits
    if (tail[0] === 'commits') {
      if (method === 'GET' && tail.length === 1) {
        const branch = req.url.searchParams.get('sha') ?? repo.default_branch;
        const tip = repo.refs.get(`refs/heads/${branch}`) ?? '';
        const list: Record<string, unknown>[] = [];
        if (tip) {
          const seen = new Set<string>();
          const stack = [tip];
          while (stack.length > 0) {
            const sha = stack.pop() as string;
            if (seen.has(sha)) continue;
            seen.add(sha);
            const obj = store.getObject(repo, sha);
            if (!obj || obj.type !== 'commit') continue;
            const c = parseCommit(obj.payload);
            list.push({
              sha,
              commit: { message: c.message, author: { name: c.author }, committer: { name: c.committer } },
              author: null,
              committer: null,
              parents: c.parents.map((p) => ({ sha: p })),
            });
            for (const p of c.parents) stack.push(p);
          }
        }
        const { page, link } = paginate(list, req.url);
        return jsonReply(200, page, linkHeader(link));
      }
      if (method === 'GET' && tail.length === 2) {
        const sha = decodeURIComponent(tail[1] as string);
        const obj = store.getObject(repo, sha);
        if (!obj || obj.type !== 'commit') return errorReply(404, 'Not Found');
        const c = parseCommit(obj.payload);
        return jsonReply(200, {
          sha,
          commit: { message: c.message, author: { name: c.author }, committer: { name: c.committer } },
          author: null,
          committer: null,
          parents: c.parents.map((p) => ({ sha: p })),
        });
      }
      return errorReply(404, 'Not Found');
    }

    // Contents
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).map((p) => decodeURIComponent(p)).join('/');
      if (method === 'GET' && tail.length >= 1) {
        const branch = req.url.searchParams.get('ref') ?? repo.default_branch;
        const tip = repo.refs.get(`refs/heads/${branch}`) ?? '';
        if (!tip) return errorReply(404, 'Not Found');
        // A directory path lists its entries; a file path returns the file.
        const dirSha = dirTreeSha(store, repo, tip, contentPath);
        if (dirSha) {
          const entries = parseTree(store.getObject(repo, dirSha)?.payload ?? Buffer.alloc(0));
          const out = entries.map((e) => {
            const p = contentPath ? `${contentPath}/${e.name}` : e.name;
            const isDir = e.mode === '40000';
            const blob = isDir ? undefined : store.getObject(repo, e.sha);
            return {
              type: isDir ? 'dir' : 'file',
              name: e.name,
              path: p,
              sha: e.sha,
              ...(isDir ? {} : { size: blob ? blob.payload.length : 0 }),
              url: `/api/v3/repos/${repo.full_name}/contents/${p}`,
              git_url: `/api/v3/repos/${repo.full_name}/git/${isDir ? 'trees' : 'blobs'}/${e.sha}`,
              html_url: `https://github.com/${repo.full_name}/${isDir ? 'tree' : 'blob'}/${repo.default_branch}/${p}`,
              download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${p}`,
            };
          });
          return jsonReply(200, out);
        }
        const blobSha = store.readPath(repo, tip, contentPath);
        if (!blobSha) return errorReply(404, 'Not Found');
        return jsonReply(200, contentsFileJson(store, repo, contentPath, blobSha));
      }
      if ((method === 'PUT' || method === 'DELETE') && tail.length >= 2) {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const branch = typeof b.branch === 'string' && b.branch ? (b.branch as string) : repo.default_branch;
        const message = typeof b.message === 'string' ? (b.message as string) : method === 'PUT' ? 'Update file' : 'Delete file';
        const tip = repo.refs.get(`refs/heads/${branch}`) ?? '';
        if (method === 'PUT') {
          const content = decodeBase64Field(b.content);
          if (content === null) return errorReply(422, 'Validation Failed: content must be base64');
          const existingSha = tip ? store.readPath(repo, tip, contentPath) : '';
          if (existingSha) {
            if (typeof b.sha !== 'string' || b.sha !== existingSha) return errorReply(409, 'Conflict: sha does not match');
            const commitSha = store.writeContents(repo, branch, contentPath, content, message);
            return jsonReply(200, {
              content: contentsFileJson(store, repo, contentPath, store.readPath(repo, commitSha, contentPath)),
              commit: { sha: commitSha, message },
            });
          }
          const commitSha = store.writeContents(repo, branch, contentPath, content, message);
          return jsonReply(201, {
            content: contentsFileJson(store, repo, contentPath, store.readPath(repo, commitSha, contentPath)),
            commit: { sha: commitSha, message },
          });
        }
        // DELETE contents
        if (!tip) return errorReply(404, 'Not Found');
        const existingSha = store.readPath(repo, tip, contentPath);
        if (!existingSha) return errorReply(404, 'Not Found');
        if (typeof b.sha === 'string' && b.sha !== existingSha) return errorReply(409, 'Conflict: sha does not match');
        const commitSha = store.deleteContents(repo, branch, contentPath, message);
        if (!commitSha) return errorReply(404, 'Not Found');
        return jsonReply(200, { commit: { sha: commitSha, message } });
      }
      return errorReply(404, 'Not Found');
    }

    // Labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        const { page, link } = paginate([...repo.labels.values()].map((l) => labelJson(l)), req.url);
        return jsonReply(200, page, linkHeader(link));
      }
      if (method === 'POST' && tail.length === 1) {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (!name) return errorReply(422, 'Validation Failed: name is required');
        const existing = repo.labels.get(name);
        if (existing) return jsonReply(201, labelJson(existing));
        const label: Label = {
          id: repo.nextLabelId,
          name,
          color: typeof b.color === 'string' ? (b.color as string).replace(/^#/, '') : 'ededed',
          description: typeof b.description === 'string' ? (b.description as string) : '',
        };
        repo.nextLabelId += 1;
        repo.labels.set(name, label);
        return jsonReply(201, labelJson(label));
      }
      return errorReply(404, 'Not Found');
    }

    // Issues
    if (tail[0] === 'issues') {
      if (method === 'GET' && tail.length === 1) {
        let list = [...repo.issues.values()];
        const state = req.url.searchParams.get('state');
        if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
        const sort = req.url.searchParams.get('sort') ?? 'created';
        const dir = req.url.searchParams.get('direction') === 'asc' ? 1 : -1;
        const key = (i: Issue): number | string => {
          if (sort === 'updated') return i.updated_at;
          if (sort === 'comments') return i.comments.length;
          return i.created_at;
        };
        list.sort((a, b) => {
          const ka = key(a);
          const kb = key(b);
          if (ka < kb) return -1 * dir;
          if (ka > kb) return 1 * dir;
          return (a.number - b.number) * dir;
        });
        const { page, link } = paginate(list.map((i) => issueJson(store, repo, i)), req.url);
        return jsonReply(200, page, linkHeader(link));
      }
      if (method === 'POST' && tail.length === 1) {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const title = typeof b.title === 'string' ? b.title.trim() : '';
        if (!title) return errorReply(422, 'Validation Failed: title is required');
        const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).map((l) => String(l)) : [];
        for (const l of labels) {
          if (!repo.labels.has(l)) return errorReply(422, `Validation Failed: label "${l}" does not exist`);
        }
        const now = store.nowIso();
        const issue: Issue = {
          id: repo.nextIssueId,
          number: repo.nextIssue,
          title,
          body: typeof b.body === 'string' ? (b.body as string) : '',
          state: 'open',
          labels,
          comments: [],
          user: { ...store.viewer },
          created_at: now,
          updated_at: now,
          closed_at: null,
        };
        repo.nextIssueId += 1;
        repo.nextIssue += 1;
        repo.issues.set(issue.number, issue);
        return jsonReply(201, issueJson(store, repo, issue));
      }
      if (tail.length >= 2) {
        const number = Number(tail[1]);
        if (!Number.isInteger(number)) return errorReply(404, 'Not Found');
        const issue = repo.issues.get(number);
        // Issue comments
        if (tail.length >= 3 && tail[2] === 'comments') {
          if (!issue) return errorReply(404, 'Not Found');
          if (method === 'GET' && tail.length === 3) {
            const { page, link } = paginate(
              issue.comments.map((c) => ({
                id: c.id,
                node_id: nodeId('IssueComment', c.id),
                url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/comments/${c.id}`,
                html_url: `https://github.com/${repo.full_name}/issues/${issue.number}#issuecomment-${c.id}`,
                body: c.body,
                user: userJson(store, c.user.login, c.user.id),
                created_at: c.created_at,
                updated_at: c.updated_at,
              })),
              req.url,
            );
            return jsonReply(200, page, linkHeader(link));
          }
          if (method === 'POST' && tail.length === 3) {
            const b = (req.body ?? {}) as Record<string, unknown>;
            const body = typeof b.body === 'string' ? (b.body as string) : '';
            if (!body) return errorReply(422, 'Validation Failed: body is required');
            const now = store.nowIso();
            const comment = { id: repo.nextCommentId, body, user: { ...store.viewer }, created_at: now, updated_at: now };
            repo.nextCommentId += 1;
            issue.comments.push(comment);
            issue.updated_at = now;
            return jsonReply(201, {
              id: comment.id,
              node_id: nodeId('IssueComment', comment.id),
              url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/comments/${comment.id}`,
              html_url: `https://github.com/${repo.full_name}/issues/${issue.number}#issuecomment-${comment.id}`,
              body: comment.body,
              user: userJson(store, comment.user.login, comment.user.id),
              created_at: comment.created_at,
              updated_at: comment.updated_at,
            });
          }
          return errorReply(404, 'Not Found');
        }
        if (tail.length === 2) {
          if (method === 'GET') {
            if (!issue) return errorReply(404, 'Not Found');
            return jsonReply(200, issueJson(store, repo, issue));
          }
          if (method === 'PATCH') {
            if (!issue) return errorReply(404, 'Not Found');
            const b = (req.body ?? {}) as Record<string, unknown>;
            if (typeof b.title === 'string') issue.title = b.title;
            if (typeof b.body === 'string') issue.body = b.body;
            if (b.state === 'open' || b.state === 'closed') {
              issue.state = b.state;
              issue.closed_at = b.state === 'closed' ? store.nowIso() : null;
            }
            if (Array.isArray(b.labels)) {
              const labels = (b.labels as unknown[]).map((l) => String(l));
              for (const l of labels) {
                if (!repo.labels.has(l)) return errorReply(422, `Validation Failed: label "${l}" does not exist`);
              }
              issue.labels = labels;
            }
            issue.updated_at = store.nowIso();
            return jsonReply(200, issueJson(store, repo, issue));
          }
          return errorReply(404, 'Not Found');
        }
      }
      return errorReply(404, 'Not Found');
    }

    // Pull requests
    if (tail[0] === 'pulls') {
      if (method === 'GET' && tail.length === 1) {
        let list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
        const state = req.url.searchParams.get('state');
        if (state === 'all') {
          // No filter.
        } else if (state === 'closed') {
          list = list.filter((p) => p.state === 'closed');
        } else {
          // GitHub's default: open only.
          list = list.filter((p) => p.state === 'open');
        }
        const { page, link } = paginate(list.map((p) => pullJson(store, repo, p)), req.url);
        return jsonReply(200, page, linkHeader(link));
      }
      if (method === 'POST' && tail.length === 1) {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const title = typeof b.title === 'string' ? b.title.trim() : '';
        const head = typeof b.head === 'string' ? b.head : '';
        const base = typeof b.base === 'string' ? b.base : repo.default_branch;
        if (!title || !head) return errorReply(422, 'Validation Failed: title and head are required');
        const headSha = repo.refs.get(`refs/heads/${head}`) ?? '';
        const baseSha = repo.refs.get(`refs/heads/${base}`) ?? '';
        if (!headSha || !baseSha) return errorReply(422, 'Validation Failed: head or base branch does not exist');
        const now = store.nowIso();
        const pull: Pull = {
          id: repo.nextPullId,
          number: repo.nextPull,
          title,
          body: typeof b.body === 'string' ? (b.body as string) : '',
          state: 'open',
          merged: false,
          head: { ref: head, sha: headSha, label: `${repo.owner.login}:${head}` },
          base: { ref: base, sha: baseSha, label: `${repo.owner.login}:${base}` },
          mergeable: store.isMergeable(repo, headSha, baseSha) ? 'MERGEABLE' : 'CONFLICTING',
          merge_commit_sha: null,
          user: { ...store.viewer },
          created_at: now,
          updated_at: now,
          closed_at: null,
          merged_at: null,
        };
        repo.nextPullId += 1;
        repo.nextPull += 1;
        repo.pulls.set(pull.number, pull);
        return jsonReply(201, pullJson(store, repo, pull));
      }
      if (tail.length >= 2) {
        const number = Number(tail[1]);
        if (!Number.isInteger(number)) return errorReply(404, 'Not Found');
        const pull = repo.pulls.get(number);
        // Merge
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          if (!pull) return errorReply(404, 'Not Found');
          if (pull.merged || pull.state !== 'open') return errorReply(405, 'Pull request is already merged or closed');
          // Re-evaluate against the base branch's current tip: the base may
          // have advanced (and conflicted) since the pull request was opened.
          const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
          const mergeable = store.isMergeable(repo, pull.head.sha, baseTip);
          pull.mergeable = mergeable ? 'MERGEABLE' : 'CONFLICTING';
          if (!mergeable) return errorReply(405, 'Merge conflict');
          const sha = store.squashMerge(repo, pull);
          if (!sha) return errorReply(405, 'Merge conflict');
          return jsonReply(200, { sha, merged: true, message: `Pull Request #${pull.number} merged` });
        }
        // Files
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          if (!pull) return errorReply(404, 'Not Found');
          const baseFiles = new Map(store.listFiles(repo, pull.base.sha).map((f) => [f.path, f.sha]));
          const headFiles = new Map(store.listFiles(repo, pull.head.sha).map((f) => [f.path, f.sha]));
          const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
          const files = [];
          for (const path of paths) {
            const bSha = baseFiles.get(path);
            const hSha = headFiles.get(path);
            if (bSha === hSha) continue;
            const baseBlob = bSha ? (store.getObject(repo, bSha)?.payload ?? Buffer.alloc(0)) : Buffer.alloc(0);
            const headBlob = hSha ? (store.getObject(repo, hSha)?.payload ?? Buffer.alloc(0)) : Buffer.alloc(0);
            const { additions, deletions } = diffLines(baseBlob, headBlob);
            files.push({
              sha: hSha ?? bSha ?? '',
              filename: path,
              status: !bSha ? 'added' : !hSha ? 'removed' : 'modified',
              additions,
              deletions,
              changes: additions + deletions,
            });
          }
          const { page, link } = paginate(files, req.url);
          return jsonReply(200, page, linkHeader(link));
        }
        if (tail.length === 2) {
          if (method === 'GET') {
            if (!pull) return errorReply(404, 'Not Found');
            return jsonReply(200, pullJson(store, repo, pull));
          }
          if (method === 'PATCH') {
            if (!pull) return errorReply(404, 'Not Found');
            const b = (req.body ?? {}) as Record<string, unknown>;
            if (typeof b.title === 'string') pull.title = b.title;
            if (typeof b.body === 'string') pull.body = b.body;
            if (b.state === 'closed' && pull.state === 'open') {
              pull.state = 'closed';
              pull.closed_at = store.nowIso();
            }
            pull.updated_at = store.nowIso();
            return jsonReply(200, pullJson(store, repo, pull));
          }
          return errorReply(404, 'Not Found');
        }
      }
      return errorReply(404, 'Not Found');
    }

    return errorReply(404, 'Not Found');
  }

  return errorReply(404, 'Not Found');
}
