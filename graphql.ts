// GitHub GraphQL v4 API at /api/graphql. A small, targeted GraphQL executor
// for the documents gh and github-mcp-server send: queries and mutations over
// repositories, issues, pull requests and comments, plus introspection.
// Transport: POST {"query","variables"} (or a JSON array of those for
// batching); answers are {"data","errors"} per operation, in order. An
// unknown field is HTTP 200 with an errors array naming it; an unknown
// repository is data.repository = null with no errors.

import type { Store, Repo, Issue, Pull } from './store.ts';
import { nodeId, parseNodeId } from './store.ts';

// ---------- lexer ----------

interface Token {
  kind: 'name' | 'string' | 'int' | 'punct' | 'eof';
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && /[0-9]/.test(input[i + 1] ?? '') || /[0-9]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if ('!$():=@[]{}|&.'.includes(ch)) {
      if (ch === '.' && input.slice(i, i + 3) === '...') {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    // Unknown character: skip it.
    i += 1;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------- parser ----------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[];
}
export interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}
export interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}
export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; type: string; defaultValue: ValueNode | null }[];
  selection: SelectionNode[];
}
export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  #tokens: Token[];
  #pos = 0;
  constructor(input: string) {
    this.#tokens = lex(input);
  }
  #peek(): Token {
    return this.#tokens[this.#pos] as Token;
  }
  #next(): Token {
    const t = this.#tokens[this.#pos] as Token;
    this.#pos += 1;
    return t;
  }
  #expectPunct(value: string): void {
    const t = this.#next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
  }
  #expectName(): string {
    const t = this.#next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${t.value}`);
    return t.value;
  }
  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.#peek().kind !== 'eof') {
      const t = this.#peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ kind: 'operation', operation: 'query', name: null, variables: [], selection: this.#parseSelectionSet() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const op = this.#next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.#peek().kind === 'name') name = this.#next().value;
        const variables: OperationNode['variables'] = [];
        if (this.#peek().kind === 'punct' && this.#peek().value === '(') {
          this.#next();
          while (!(this.#peek().kind === 'punct' && this.#peek().value === ')')) {
            this.#expectPunct('$');
            const varName = this.#expectName();
            this.#expectPunct(':');
            const type = this.#parseType();
            let defaultValue: ValueNode | null = null;
            if (this.#peek().kind === 'punct' && this.#peek().value === '=') {
              this.#next();
              defaultValue = this.#parseValue();
            }
            variables.push({ name: varName, type, defaultValue });
          }
          this.#expectPunct(')');
        }
        operations.push({ kind: 'operation', operation: op, name, variables, selection: this.#parseSelectionSet() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.#next();
        const name = this.#expectName();
        const on = this.#expectName();
        if (on !== 'on') throw new Error('expected on');
        const typeCondition = this.#expectName();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selection: this.#parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${t.value}`);
      }
    }
    return { operations, fragments };
  }
  #parseType(): string {
    let type: string;
    if (this.#peek().kind === 'punct' && this.#peek().value === '[') {
      this.#next();
      type = `[${this.#parseType()}]`;
      this.#expectPunct(']');
    } else {
      type = this.#expectName();
    }
    if (this.#peek().kind === 'punct' && this.#peek().value === '!') {
      this.#next();
      type += '!';
    }
    return type;
  }
  #parseSelectionSet(): SelectionNode[] {
    this.#expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!(this.#peek().kind === 'punct' && this.#peek().value === '}')) {
      if (this.#peek().kind === 'eof') throw new Error('unterminated selection set');
      if (this.#peek().kind === 'punct' && this.#peek().value === '...') {
        this.#next();
        if (this.#peek().kind === 'name' && this.#peek().value === 'on') {
          this.#next();
          const typeCondition = this.#expectName();
          sels.push({ kind: 'inlineFragment', typeCondition, selection: this.#parseSelectionSet() });
        } else if (this.#peek().kind === 'name') {
          sels.push({ kind: 'fragmentSpread', name: this.#next().value });
        } else {
          sels.push({ kind: 'inlineFragment', typeCondition: null, selection: this.#parseSelectionSet() });
        }
        continue;
      }
      // field (possibly aliased)
      let name = this.#expectName();
      let alias: string | null = null;
      if (this.#peek().kind === 'punct' && this.#peek().value === ':') {
        this.#next();
        alias = name;
        name = this.#expectName();
      }
      const args: { name: string; value: ValueNode }[] = [];
      if (this.#peek().kind === 'punct' && this.#peek().value === '(') {
        this.#next();
        while (!(this.#peek().kind === 'punct' && this.#peek().value === ')')) {
          const argName = this.#expectName();
          this.#expectPunct(':');
          args.push({ name: argName, value: this.#parseValue() });
        }
        this.#expectPunct(')');
      }
      // directives (skip): @name(args)
      while (this.#peek().kind === 'punct' && this.#peek().value === '@') {
        this.#next();
        this.#expectName();
        if (this.#peek().kind === 'punct' && this.#peek().value === '(') {
          this.#next();
          let depth = 1;
          while (depth > 0) {
            const tk = this.#next();
            if (tk.kind === 'punct' && tk.value === '(') depth += 1;
            if (tk.kind === 'punct' && tk.value === ')') depth -= 1;
          }
        }
      }
      let selection: SelectionNode[] = [];
      if (this.#peek().kind === 'punct' && this.#peek().value === '{') {
        selection = this.#parseSelectionSet();
      }
      sels.push({ kind: 'field', alias, name, args, selection });
    }
    this.#expectPunct('}');
    return sels;
  }
  #parseValue(): ValueNode {
    const t = this.#next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.#expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.#peek().kind === 'punct' && this.#peek().value === ']')) values.push(this.#parseValue());
      this.#expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.#peek().kind === 'punct' && this.#peek().value === '}')) {
        const name = this.#expectName();
        this.#expectPunct(':');
        fields.push({ name, value: this.#parseValue() });
      }
      this.#expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

// ---------- schema (for introspection) ----------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'author'],
  User: ['id', 'login', 'name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'filename'],
  IssueComment: ['id', 'body', 'author'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name'],
  SearchType: [],
};
const TYPE_KINDS: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  User: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  IssueComment: 'OBJECT',
  PageInfo: 'OBJECT',
  Ref: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
};
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------- execution ----------

export interface GraphQLContext {
  store: Store;
}

interface ExecState {
  errors: { message: string; path?: (string | number)[] }[];
  fragments: Map<string, FragmentNode>;
  variables: Record<string, unknown>;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, state: ExecState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = valueOf(a.value, state.variables);
  return out;
}

function cursorForNumber(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}
function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Order issues: CREATED_AT/UPDATED_AT/COMMENTS, ASC/DESC; ties by number. */
function orderIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const ob = (orderBy ?? {}) as Record<string, unknown>;
  const field = typeof ob.field === 'string' ? ob.field : 'CREATED_AT';
  const dir = ob.direction === 'ASC' ? 1 : -1;
  const key = (i: Issue): number | string => {
    if (field === 'UPDATED_AT') return i.updated_at;
    if (field === 'COMMENTS') return i.comments.length;
    return i.created_at;
  };
  return [...issues].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return (a.number - b.number) * dir;
  });
}

function paginateIssues(issues: Issue[], args: Record<string, unknown>): { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const first = typeof args.first === 'number' ? args.first : issues.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after) {
    const afterNum = numberFromCursor(args.after);
    if (afterNum !== null) {
      const idx = issues.findIndex((i) => i.number === afterNum);
      if (idx >= 0) start = idx + 1;
    }
  }
  const nodes = issues.slice(start, start + first);
  const hasNextPage = start + nodes.length < issues.length;
  const endCursor = nodes.length > 0 ? cursorForNumber((nodes[nodes.length - 1] as Issue).number) : null;
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

type Resolver = (ctx: GraphQLContext, parent: unknown, args: Record<string, unknown>, state: ExecState) => unknown;

/** Resolve one field on a typed parent value. Parent values carry __type. */
function resolveField(ctx: GraphQLContext, parentType: string, parent: unknown, field: FieldNode, state: ExecState): unknown {
  const args = argMap(field, state);
  const store = ctx.store;
  const p = parent as Record<string, unknown> & { __type: string };

  if (field.name === '__typename') return parentType;
  if (field.name === '__type') {
    const name = String(args.name ?? '');
    const kind = TYPE_KINDS[name];
    if (!kind) return null;
    return {
      __type: '__Type',
      name,
      kind,
      fields: (TYPE_FIELDS[name] ?? []).map((n) => ({ name: n })),
      enumValues: (ENUM_VALUES[name] ?? []).map((n) => ({ name: n })),
    };
  }
  if (field.name === '__schema') {
    return {
      __type: '__Schema',
      types: Object.keys(TYPE_FIELDS).map((n) => ({ name: n, kind: TYPE_KINDS[n] ?? 'OBJECT' })),
    };
  }

  // Mutation payload objects and edges resolve their children by name.
  if (parentType.endsWith('Payload') || parentType === 'IssueCommentEdge') {
    const child = (parent as Record<string, unknown>)[field.name];
    return child === undefined ? undefined : child;
  }

  switch (parentType) {
    case 'Query': {
      if (field.name === 'viewer') return { __type: 'User', login: store.viewer.login, id: store.viewer.id };
      if (field.name === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (!repo || repo.owner.login.toLowerCase() !== String(args.owner ?? '').toLowerCase()) return null;
        return { __type: 'Repository', repo };
      }
      if (field.name === 'node') {
        const parsed = parseNodeId(String(args.id ?? ''));
        if (!parsed) return null;
        const [kind, id] = parsed;
        if (kind === 'Repository') {
          for (const repo of store.repos.values()) {
            if (repo.id === id) return { __type: 'Repository', repo };
          }
        }
        return null;
      }
      break;
    }
    case 'Repository': {
      const repo = (p.repo as Repo) ?? null;
      if (!repo) return null;
      switch (field.name) {
        case 'id':
          return nodeId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.full_name;
        case 'owner':
          return { __type: 'User', login: repo.owner.login, id: repo.owner.id };
        case 'defaultBranchRef':
          return { __type: 'Ref', name: repo.default_branch };
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'url':
          return `https://github.com/${repo.full_name}`;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? { __type: 'Issue', repo, issue } : null;
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          if (Array.isArray(args.states)) {
            const wanted = new Set((args.states as unknown[]).map((s) => String(s)));
            list = list.filter((i) => wanted.has(issueState(i)));
          }
          list = orderIssues(list, args.orderBy);
          const { nodes, pageInfo } = paginateIssues(list, args);
          return { __type: 'IssueConnection', nodes: nodes.map((i) => ({ __type: 'Issue', repo, issue: i })), pageInfo };
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
          if (Array.isArray(args.states)) {
            const wanted = new Set((args.states as unknown[]).map((s) => String(s)));
            list = list.filter((pr) => wanted.has(pullState(pr)));
          }
          const first = typeof args.first === 'number' ? args.first : list.length;
          const nodes = list.slice(0, first);
          return { __type: 'PullRequestConnection', nodes: nodes.map((pr) => ({ __type: 'PullRequest', repo, pull: pr })), pageInfo: { hasNextPage: list.length > nodes.length, endCursor: null } };
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? { __type: 'PullRequest', repo, pull } : null;
        }
      }
      break;
    }
    case 'Issue': {
      const issue = (p.issue as Issue) ?? null;
      if (!issue) return null;
      switch (field.name) {
        case 'id':
          return nodeId('Issue', issue.id);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
        case 'createdAt':
          return issue.created_at;
        case 'updatedAt':
          return issue.updated_at;
        case 'url':
          return `https://github.com/${(p.repo as Repo).full_name}/issues/${issue.number}`;
        case 'author':
          return { __type: 'User', login: issue.user.login, id: issue.user.id };
        case 'labels':
          return { __type: 'LabelConnection', nodes: issue.labels.map((n) => ({ __type: 'Label', name: n })) };
        case 'comments':
          return { __type: 'IssueCommentConnection', nodes: issue.comments.map((c) => ({ __type: 'IssueComment', comment: c })) };
      }
      break;
    }
    case 'PullRequest': {
      const pull = (p.pull as Pull) ?? null;
      const repo = (p.repo as Repo) ?? null;
      if (!pull || !repo) return null;
      switch (field.name) {
        case 'id':
          return nodeId('PullRequest', pull.id);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pull.mergeable;
        case 'headRefName':
          return pull.head.ref;
        case 'baseRefName':
          return pull.base.ref;
        case 'createdAt':
          return pull.created_at;
        case 'updatedAt':
          return pull.updated_at;
        case 'author':
          return { __type: 'User', login: pull.user.login, id: pull.user.id };
        case 'files': {
          const baseFiles = new Map(store.listFiles(repo, pull.base.sha).map((f) => [f.path, f.sha]));
          const headFiles = store.listFiles(repo, pull.head.sha);
          const changed = headFiles.filter((f) => baseFiles.get(f.path) !== f.sha);
          const first = typeof args.first === 'number' ? args.first : changed.length;
          const nodes = changed.slice(0, first).map((f) => ({ __type: 'PullRequestChangedFile', path: f.path, filename: f.path }));
          return { __type: 'PullRequestChangedFileConnection', nodes, pageInfo: { hasNextPage: changed.length > nodes.length, endCursor: null } };
        }
      }
      break;
    }
    case 'User': {
      if (field.name === 'login') return p.login;
      if (field.name === 'id') return nodeId('User', Number(p.id ?? 0));
      if (field.name === 'name') return p.login;
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection': {
      if (field.name === 'nodes') return p.nodes;
      if (field.name === 'pageInfo') return p.pageInfo ?? { hasNextPage: false, endCursor: null };
      if (field.name === 'totalCount') return Array.isArray(p.nodes) ? (p.nodes as unknown[]).length : 0;
      break;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return p.path;
      if (field.name === 'filename') return p.filename;
      break;
    }
    case 'IssueComment': {
      const comment = p.comment as { id: number; body: string; user: { login: string; id: number } } | undefined;
      if (!comment) return null;
      if (field.name === 'id') return nodeId('IssueComment', comment.id);
      if (field.name === 'body') return comment.body;
      if (field.name === 'author') return { __type: 'User', login: comment.user.login, id: comment.user.id };
      break;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return (p as Record<string, unknown>).hasNextPage ?? false;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'endCursor') return (p as Record<string, unknown>).endCursor ?? null;
      if (field.name === 'startCursor') return null;
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return p.name;
      break;
    }
    case '__Type': {
      if (field.name === 'name') return p.name;
      if (field.name === 'kind') return p.kind;
      if (field.name === 'fields') return p.fields;
      if (field.name === 'enumValues') return p.enumValues;
      break;
    }
    case '__Schema': {
      if (field.name === 'types') return p.types;
      break;
    }
    case 'Mutation': {
      return resolveMutation(ctx, field, state);
    }
  }
  return undefined; // unknown field
}

function resolveMutation(ctx: GraphQLContext, field: FieldNode, state: ExecState): unknown {
  const store = ctx.store;
  const args = argMap(field, state);
  const input = (args.input ?? {}) as Record<string, unknown>;

  if (field.name === 'createIssue') {
    const parsed = parseNodeId(String(input.repositoryId ?? ''));
    if (!parsed || parsed[0] !== 'Repository') {
      state.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return null;
    }
    const repo = [...store.repos.values()].find((r) => r.id === parsed[1]);
    if (!repo) {
      state.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return null;
    }
    const now = store.nowIso();
    const issue: Issue = {
      id: repo.nextIssueId,
      number: repo.nextIssue,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      user: { ...store.viewer },
      created_at: now,
      updated_at: now,
      closed_at: null,
    };
    repo.nextIssueId += 1;
    repo.nextIssue += 1;
    repo.issues.set(issue.number, issue);
    return { __type: 'CreateIssuePayload', issue: { __type: 'Issue', repo, issue } };
  }

  if (field.name === 'closeIssue') {
    const parsed = parseNodeId(String(input.issueId ?? ''));
    if (!parsed || parsed[0] !== 'Issue') {
      state.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return null;
    }
    for (const repo of store.repos.values()) {
      for (const issue of repo.issues.values()) {
        if (issue.id === parsed[1]) {
          issue.state = 'closed';
          issue.closed_at = store.nowIso();
          issue.updated_at = issue.closed_at;
          return { __type: 'CloseIssuePayload', issue: { __type: 'Issue', repo, issue } };
        }
      }
    }
    state.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
    return null;
  }

  if (field.name === 'createPullRequest') {
    const parsed = parseNodeId(String(input.repositoryId ?? ''));
    if (!parsed || parsed[0] !== 'Repository') {
      state.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return null;
    }
    const repo = [...store.repos.values()].find((r) => r.id === parsed[1]);
    if (!repo) {
      state.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return null;
    }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? repo.default_branch);
    const headSha = repo.refs.get(`refs/heads/${head}`) ?? '';
    const baseSha = repo.refs.get(`refs/heads/${base}`) ?? '';
    if (!headSha || !baseSha) {
      state.errors.push({ message: 'Head or base branch does not exist.' });
      return null;
    }
    const now = store.nowIso();
    const pull: Pull = {
      id: repo.nextPullId,
      number: repo.nextPull,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
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
    return { __type: 'CreatePullRequestPayload', pullRequest: { __type: 'PullRequest', repo, pull } };
  }

  if (field.name === 'mergePullRequest') {
    const parsed = parseNodeId(String(input.pullRequestId ?? ''));
    if (!parsed || parsed[0] !== 'PullRequest') {
      state.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
      return null;
    }
    for (const repo of store.repos.values()) {
      for (const pull of repo.pulls.values()) {
        if (pull.id === parsed[1]) {
          if (pull.merged || pull.state !== 'open') {
            state.errors.push({ message: 'Pull request cannot be merged.' });
            return null;
          }
          // Re-evaluate against the base branch's current tip.
          const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
          const mergeable = store.isMergeable(repo, pull.head.sha, baseTip);
          pull.mergeable = mergeable ? 'MERGEABLE' : 'CONFLICTING';
          if (!mergeable) {
            state.errors.push({ message: 'Pull request cannot be merged.' });
            return null;
          }
          const sha = store.squashMerge(repo, pull);
          if (!sha) {
            state.errors.push({ message: 'Pull request cannot be merged.' });
            return null;
          }
          return { __type: 'MergePullRequestPayload', pullRequest: { __type: 'PullRequest', repo, pull } };
        }
      }
    }
    state.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
    return null;
  }

  if (field.name === 'addComment') {
    const parsed = parseNodeId(String(input.subjectId ?? ''));
    if (!parsed || parsed[0] !== 'Issue') {
      state.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return null;
    }
    for (const repo of store.repos.values()) {
      for (const issue of repo.issues.values()) {
        if (issue.id === parsed[1]) {
          const now = store.nowIso();
          const comment = { id: repo.nextCommentId, body: String(input.body ?? ''), user: { ...store.viewer }, created_at: now, updated_at: now };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          issue.updated_at = now;
          return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node: { __type: 'IssueComment', comment } } };
        }
      }
    }
    state.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
    return null;
  }

  return undefined;
}

function executeSelection(
  ctx: GraphQLContext,
  parentType: string,
  parent: unknown,
  selections: SelectionNode[],
  state: ExecState,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      const frag = state.fragments.get(sel.name);
      if (frag) Object.assign(out, executeSelection(ctx, parentType, parent, frag.selection, state, path));
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition === null || sel.typeCondition === parentType) {
        Object.assign(out, executeSelection(ctx, parentType, parent, sel.selection, state, path));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const value = resolveField(ctx, parentType, parent, sel, state);
    if (value === undefined) {
      state.errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".`, path: [...path, key] });
      continue;
    }
    out[key] = completeValue(ctx, parentType, sel, value, state, [...path, key]);
  }
  return out;
}

function completeValue(
  ctx: GraphQLContext,
  parentType: string,
  field: FieldNode,
  value: unknown,
  state: ExecState,
  path: (string | number)[],
): unknown {
  if (value === null || value === undefined) return null;
  if (field.selection.length === 0) return value;
  // A list of objects: complete each element.
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (item !== null && typeof item === 'object' && '__type' in (item as Record<string, unknown>)) {
        const t = (item as Record<string, unknown>).__type as string;
        return executeSelection(ctx, t, item, field.selection, state, [...path, i]);
      }
      return item;
    });
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('__type' in v) {
      return executeSelection(ctx, v.__type as string, value, field.selection, state, path);
    }
    return value;
  }
  return value;
}

/** Execute one operation document. Returns {data, errors?}. */
export function executeGraphQL(ctx: GraphQLContext, query: string, variables: Record<string, unknown>, operationName?: string): { data: Record<string, unknown> | null; errors?: { message: string; path?: (string | number)[] }[] } {
  let doc;
  try {
    doc = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
  }
  if (doc.operations.length === 0) return { data: null, errors: [{ message: 'No operation found.' }] };
  const op = operationName ? doc.operations.find((o) => o.name === operationName) ?? doc.operations[0] : doc.operations[0];
  if (!op) return { data: null, errors: [{ message: 'Unknown operation.' }] };
  const state: ExecState = { errors: [], fragments: doc.fragments, variables: { ...variables } };
  for (const v of op.variables) {
    if (!(v.name in state.variables) && v.defaultValue !== null) {
      state.variables[v.name] = valueOf(v.defaultValue, state.variables);
    }
  }
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, { __type: rootType }, op.selection, state, []);
  const out: { data: Record<string, unknown> | null; errors?: { message: string; path?: (string | number)[] }[] } = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}
