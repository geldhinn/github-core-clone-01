# forge — a GitHub-compatible git forge

A single-process, dependency-free git forge in TypeScript (Node 22, standard
library only). It speaks the surfaces a GitHub-compatible client expects:

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 (`ls-refs`, `fetch`
  with shallow/deepen/filter, `thin-pack`, `ofs-delta`) and v0 upload-pack,
  plus v0 receive-pack (`report-status`, `side-band-64k`, `delete-refs`,
  `ofs-delta`). Works with real `git clone` / `push` / `pull` / `fetch`
  (including `--depth` shallow clones) and with the suite's own git client.
- **REST v3** under `/api/v3` — repos, branches, commits, contents, git refs,
  issues, labels, comments, pull requests (incl. squash merge), with
  `Link`-header pagination and GitHub-shaped errors.
- **GraphQL v4** at `/api/graphql` — viewer, repository, issues, pull
  requests, search, node ids, mutations, and schema introspection.
- **MCP** at `/mcp` — `initialize`, `tools/list`, `tools/call` for the six
  required tools (`github_repo`, `github_search`, `github_read_file`,
  `github_create_issue`, `github_create_pr`, `github_merge_pr`).

State is in-memory and seeded deterministically from the contest scenario
(the same seed the conformance suite uses), so a fresh process replays the
same world and replays produce byte-identical state exports.

## How it runs

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`,
and exits when the environment reports `done`. If `MAKEFUN_ENV_URL` is
unset it exits 1. Auth is `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`
on API calls; git endpoints also accept HTTP Basic with the token as the
password (the convention real git uses), and answer 401 with a
`WWW-Authenticate: Basic realm="forge", Bearer` challenge.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Lifecycle: bind, register, poll `done`, exit 0. |
| `app.ts` | HTTP server and routing. |
| `gitobj.ts` | Git object model, packfile encode/decode (full, ofs-delta, ref-delta, thin packs), commit/tree parse/build. |
| `gitproto.ts` | Smart-HTTP handlers: pkt-line framing, v2/v0 upload-pack, receive-pack. |
| `scenario.ts` | Deterministic reimplementation of the contest's seeded scenario (viewer `adaiversen`, teammates, seeded repos/issues/PRs). |
| `store.ts` | In-memory store: repos, git objects, refs, issues, PRs, labels, comments; merge-base and mergeability. |
| `rest.ts` | REST v3 router, shapes, pagination. |
| `graphql.ts` | GraphQL lexer/parser/executor, introspection, mutations. |
| `mcp.ts` | MCP endpoint (initialize, tools/list, tools/call). |

## Verification

Local conformance runner against a fresh server (kit `sdk/run.ts`):

```
120/120 checks — git 30/30, repos 15/15, issues 15/15, pulls 20/20,
protocol 5/5, graphql 20/20, mcp 15/15; manifest clean.
perf 96/200 (push 24, clone 19, read 26, write 27); total score 896/1000.
```

Real-git round trip (git 2.43) verified end to end: clone an empty repo,
push `main` + tag `v1`, clone again (files, log and tags present,
`origin/HEAD -> origin/main`), shallow clone `--depth 1` (1 commit,
`is-shallow-repository` true, including a single-commit repo), second
commit + push + pull (fast-forward), non-fast-forward push rejected.
