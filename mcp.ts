// Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP.
// Speaks revision 2026-07-28 (server/discover with supportedVersions) and the
// 2025-11-25-or-earlier handshake (initialize + notifications/initialized).
// tools/list offers the six tools github-mcp-server uses; tools/call acts on
// the same store as REST, so a repo/issue created over MCP reads back over
// /api/v3 as the same object. No Authorization header is 401.

import type { Store } from './store.ts';
import { nodeId } from './store.ts';

export interface McpContext {
  store: Store;
  token: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
    additionalProperties?: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
      },
      required: [],
      additionalProperties: true,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['title'],
      additionalProperties: true,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        state: { type: 'string', description: 'open, closed, or all' },
      },
      required: [],
      additionalProperties: true,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['title', 'head', 'base'],
      additionalProperties: true,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['pull_number'],
      additionalProperties: true,
    },
  },
];

/** Find a tool by name: exact, or a prefixed name matched as a suffix, case-insensitively. */
function findTool(name: string): ToolDef | undefined {
  const lower = name.toLowerCase();
  for (const t of TOOLS) {
    if (t.name.toLowerCase() === lower) return t;
  }
  for (const t of TOOLS) {
    if (lower.endsWith(`__${t.name.toLowerCase()}`) || lower.endsWith(t.name.toLowerCase())) return t;
  }
  return undefined;
}

/** Split owner/repo out of the arguments (owner+repo, or full_name). */
function repoOf(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = owner || (parts[0] as string);
      repo = repo || (parts[1] as string);
    }
  }
  // Some clients send `repository` instead of `repo`.
  if (!repo && typeof args.repository === 'string') {
    const v = args.repository as string;
    if (v.includes('/')) {
      const parts = v.split('/');
      owner = owner || (parts[0] as string);
      repo = parts[1] as string;
    } else {
      repo = v;
    }
  }
  return { owner, repo };
}

function toolResult(data: unknown): { content: { type: string; text: string }[]; structuredContent: unknown } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(message: string): { content: { type: string; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

export interface McpReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Handle one POST /mcp request. `rawBody` is the request bytes; `auth` is the
 * bearer token presented ('' when absent). Returns the HTTP reply.
 */
export function handleMcp(ctx: McpContext, rawBody: Buffer, auth: string): McpReply {
  if (!auth || auth !== ctx.token) {
    return { status: 401, body: { message: 'Unauthorized' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const req = parsed as Record<string, unknown>;
  const id = (req.id ?? null) as string | number | null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // A notification (no id) gets 202 with an empty body.
  const isNotification = req.id === undefined;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }

  const ok = (result: unknown): McpReply => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result },
    headers: { 'content-type': 'application/json' },
  });
  const err = (code: number, message: string): McpReply => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
    headers: { 'content-type': 'application/json' },
  });

  if (method === 'server/discover') {
    return ok({
      supportedVersions: SUPPORTED_VERSIONS,
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }

  if (method === 'initialize') {
    const requested = typeof (params as Record<string, unknown>).protocolVersion === 'string' ? ((params as Record<string, unknown>).protocolVersion as string) : '2026-07-28';
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return ok({
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }

  if (method === 'tools/list') {
    // The same list, byte for byte, on every call: a frozen constant.
    return ok({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = findTool(name);
    if (!tool) return err(-32601, `Method not found: ${name}`);
    const { store } = ctx;
    try {
      switch (tool.name) {
        case 'create_repo': {
          if (typeof args.name !== 'string' || !args.name.trim()) return ok(toolError('create_repo requires a name'));
          const repo = store.createRepo(
            (args.name as string).trim(),
            typeof args.description === 'string' ? (args.description as string) : '',
          );
          return ok(toolResult({
            id: repo.id,
            node_id: nodeId('Repository', repo.id),
            name: repo.name,
            full_name: repo.full_name,
            owner: { login: repo.owner.login, id: repo.owner.id },
            private: repo.private,
            description: repo.description,
            default_branch: repo.default_branch,
            created_at: repo.created_at,
            updated_at: repo.updated_at,
          }));
        }
        case 'get_repo': {
          const { owner, repo } = repoOf(args);
          if (!owner || !repo) return ok(toolError('get_repo requires owner and repo'));
          const found = store.getRepo(owner, repo);
          if (!found || found.owner.login.toLowerCase() !== owner.toLowerCase()) return ok(toolError(`Repository ${owner}/${repo} not found`));
          return ok(toolResult({
            id: found.id,
            node_id: nodeId('Repository', found.id),
            name: found.name,
            full_name: found.full_name,
            owner: { login: found.owner.login, id: found.owner.id },
            private: found.private,
            description: found.description,
            default_branch: found.default_branch,
            created_at: found.created_at,
            updated_at: found.updated_at,
          }));
        }
        case 'create_issue': {
          const { owner, repo } = repoOf(args);
          if (!owner || !repo) return ok(toolError('create_issue requires owner and repo'));
          if (typeof args.title !== 'string' || !args.title.trim()) return ok(toolError('create_issue requires a title'));
          const found = store.getRepo(owner, repo);
          if (!found) return ok(toolError(`Repository ${owner}/${repo} not found`));
          const now = store.nowIso();
          const issue = {
            id: found.nextIssueId,
            number: found.nextIssue,
            title: (args.title as string).trim(),
            body: typeof args.body === 'string' ? (args.body as string) : '',
            state: 'open' as const,
            labels: [] as string[],
            comments: [],
            user: { ...store.viewer },
            created_at: now,
            updated_at: now,
            closed_at: null,
          };
          found.nextIssueId += 1;
          found.nextIssue += 1;
          found.issues.set(issue.number, issue);
          return ok(toolResult({
            id: issue.id,
            node_id: nodeId('Issue', issue.id),
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            created_at: issue.created_at,
            updated_at: issue.updated_at,
          }));
        }
        case 'list_issues': {
          const { owner, repo } = repoOf(args);
          if (!owner || !repo) return ok(toolError('list_issues requires owner and repo'));
          const found = store.getRepo(owner, repo);
          if (!found) return ok(toolError(`Repository ${owner}/${repo} not found`));
          let list = [...found.issues.values()].sort((a, b) => a.number - b.number);
          const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'all';
          if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
          return ok(toolResult(list.map((i) => ({
            id: i.id,
            node_id: nodeId('Issue', i.id),
            number: i.number,
            title: i.title,
            body: i.body,
            state: i.state,
            created_at: i.created_at,
            updated_at: i.updated_at,
          }))));
        }
        case 'create_pull_request': {
          const { owner, repo } = repoOf(args);
          if (!owner || !repo) return ok(toolError('create_pull_request requires owner and repo'));
          if (typeof args.title !== 'string' || !args.title.trim()) return ok(toolError('create_pull_request requires a title'));
          if (typeof args.head !== 'string' || !args.head) return ok(toolError('create_pull_request requires head'));
          if (typeof args.base !== 'string' || !args.base) return ok(toolError('create_pull_request requires base'));
          const found = store.getRepo(owner, repo);
          if (!found) return ok(toolError(`Repository ${owner}/${repo} not found`));
          const headSha = found.refs.get(`refs/heads/${args.head}`) ?? '';
          const baseSha = found.refs.get(`refs/heads/${args.base}`) ?? '';
          if (!headSha || !baseSha) return ok(toolError('head or base branch does not exist'));
          const now = store.nowIso();
          const pull = {
            id: found.nextPullId,
            number: found.nextPull,
            title: (args.title as string).trim(),
            body: typeof args.body === 'string' ? (args.body as string) : '',
            state: 'open' as const,
            merged: false,
            head: { ref: args.head as string, sha: headSha, label: `${found.owner.login}:${args.head}` },
            base: { ref: args.base as string, sha: baseSha, label: `${found.owner.login}:${args.base}` },
            mergeable: store.isMergeable(found, headSha, baseSha) ? ('MERGEABLE' as const) : ('CONFLICTING' as const),
            merge_commit_sha: null,
            user: { ...store.viewer },
            created_at: now,
            updated_at: now,
            closed_at: null,
            merged_at: null,
          };
          found.nextPullId += 1;
          found.nextPull += 1;
          found.pulls.set(pull.number, pull);
          return ok(toolResult({
            id: pull.id,
            node_id: nodeId('PullRequest', pull.id),
            number: pull.number,
            title: pull.title,
            body: pull.body,
            state: pull.state,
            head: pull.head,
            base: pull.base,
            merged: pull.merged,
            created_at: pull.created_at,
          }));
        }
        case 'merge_pull_request': {
          const { owner, repo } = repoOf(args);
          if (!owner || !repo) return ok(toolError('merge_pull_request requires owner and repo'));
          const num = Number(args.pull_number);
          if (!Number.isInteger(num)) return ok(toolError('merge_pull_request requires pull_number'));
          const found = store.getRepo(owner, repo);
          if (!found) return ok(toolError(`Repository ${owner}/${repo} not found`));
          const pull = found.pulls.get(num);
          if (!pull) return ok(toolError(`Pull request #${num} not found`));
          if (pull.merged || pull.state !== 'open') return ok(toolError('Pull request is already merged or closed'));
          // Re-evaluate against the base branch's current tip.
          const baseTip = found.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
          const mergeable = store.isMergeable(found, pull.head.sha, baseTip);
          pull.mergeable = mergeable ? 'MERGEABLE' : 'CONFLICTING';
          if (!mergeable) return ok(toolError('Merge conflict'));
          const sha = store.squashMerge(found, pull);
          if (!sha) return ok(toolError('Merge conflict'));
          return ok(toolResult({ sha, merged: true, message: `Pull Request #${num} merged`, number: num }));
        }
        default:
          return err(-32601, `Method not found: ${name}`);
      }
    } catch (e) {
      return ok(toolError(e instanceof Error ? e.message : 'tool failed'));
    }
  }

  // Unknown method.
  void isNotification;
  return err(-32601, `Method not found: ${method}`);
}
