// HTTP server for the forge. One Store, four surfaces:
//   GET  /healthz                        -> {"ok": true} (public)
//   /api/v3/*                            -> REST v3 (routeRest)
//   POST /api/graphql                    -> GraphQL v4 (single op or JSON-array batch)
//   POST /mcp                            -> MCP (handleMcp)
//   /{owner}/{repo}.git/info/refs       -> git advertisement (v2 or v0)
//   /{owner}/{repo}.git/git-upload-pack -> git fetch / ls-refs
//   /{owner}/{repo}.git/git-receive-pack -> git push
// Everything else is 404 {"message": "Not Found"}.
// Auth: Bearer <MAKEFUN_SHOP_TOKEN> on REST (except the public root/meta),
// GraphQL, MCP and the git endpoints; a missing or wrong token is 401.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { bearerToken, routeRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** Largest request body accepted (packs are the biggest legitimate bodies). */
const MAX_BODY = 64 * 1024 * 1024;

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === undefined || body === null ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_TYPE, ...headers });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        tooBig = true;
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return false;
  return bearerToken(req) === TOKEN;
}

/**
 * Auth for the git smart-HTTP endpoints. The suite's git client sends
 * `Authorization: Bearer <token>`; real git clients send HTTP Basic with the
 * token as the password (the GitHub convention), so both are accepted here.
 */
function gitAuthed(req: IncomingMessage): boolean {
  if (TOKEN === '') return false;
  if (bearerToken(req) === TOKEN) return true;
  const h = req.headers['authorization'];
  const v = Array.isArray(h) ? h[0] : h;
  if (!v || !v.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(v.slice('Basic '.length).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return false;
    return decoded.slice(colon + 1) === TOKEN;
  } catch {
    return false;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  // Public health probe.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- REST v3 ----
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const raw = await readBody(req);
    let body: unknown;
    let bodyMalformed = false;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        bodyMalformed = true;
      }
    }
    const reply = routeRest(
      { store, token: TOKEN },
      { method, url, token: bearerToken(req), body, bodyMalformed },
    );
    if (reply === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (reply.status === 204) {
      res.writeHead(204, reply.headers ?? {});
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body, reply.headers ?? {});
    return;
  }

  // ---- GraphQL v4 ----
  if (method === 'POST' && path === '/api/graphql') {
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
      return;
    }
    const runOne = (entry: unknown): { data: Record<string, unknown> | null; errors?: { message: string; path?: (string | number)[] }[] } => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return { data: null, errors: [{ message: 'Each operation must be a JSON object.' }] };
      }
      const op = entry as Record<string, unknown>;
      if (typeof op.query !== 'string') {
        return { data: null, errors: [{ message: 'Must provide query string.' }] };
      }
      const variables =
        op.variables !== null && typeof op.variables === 'object' && !Array.isArray(op.variables)
          ? (op.variables as Record<string, unknown>)
          : {};
      return executeGraphQL(
        { store },
        op.query,
        variables,
        typeof op.operationName === 'string' ? op.operationName : undefined,
      );
    };
    if (Array.isArray(parsed)) {
      sendJson(res, 200, parsed.map(runOne));
    } else {
      sendJson(res, 200, runOne(parsed));
    }
    return;
  }

  // ---- MCP ----
  if (method === 'POST' && path === '/mcp') {
    const raw = await readBody(req);
    const reply = handleMcp({ store, token: TOKEN }, raw, bearerToken(req));
    sendJson(res, reply.status, reply.body, reply.headers ?? {});
    return;
  }

  // ---- git smart-HTTP ----
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
  if (gitMatch) {
    const [, owner, repoName, service] = gitMatch as unknown as [string, string, string, string];
    if (!gitAuthed(req)) {
      // The WWW-Authenticate challenge is what makes real git clients retry
      // with the credentials from the URL (Basic, token as password).
      res.writeHead(401, {
        'content-type': JSON_TYPE,
        'www-authenticate': 'Basic realm="forge", Bearer',
      });
      res.end(JSON.stringify({ message: 'Unauthorized' }));
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (service === 'info/refs') {
      const svc = url.searchParams.get('service');
      if (svc !== 'git-upload-pack' && svc !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Missing or unknown service parameter' });
        return;
      }
      const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const reply = handleInfoRefs(repo, owner, svc, wantV2);
      sendBuffer(res, reply.status, reply.contentType, reply.body);
      return;
    }
    const raw = await readBody(req);
    if (method === 'POST' && service === 'git-upload-pack') {
      const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const reply = handleUploadPack(repo, owner, raw, wantV2);
      sendBuffer(res, reply.status, reply.contentType, reply.body);
      return;
    }
    if (method === 'POST' && service === 'git-receive-pack') {
      const reply = handleReceivePack(repo, owner, raw);
      sendBuffer(res, reply.status, reply.contentType, reply.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    void handle(req, res, store).catch((err: unknown) => {
      process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is gone; nothing more to do.
        }
      } else {
        try {
          res.end();
        } catch {
          // Already gone.
        }
      }
    });
  });
  return server;
}
