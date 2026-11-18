// The contest's fixed scenario, rebuilt from its published seed.
// The kit publishes the scenario seed (0x6a09e667f3bcc909) and the generator
// functions as the contest's fixed data: every check names its users, repos,
// issue titles, branch names and file paths from this one deterministic
// scenario, the same on every trial. The forge needs it to know the login
// the bearer token names (the viewer), because the token itself is opaque
// (shpat_ + random hex) and carries no identity. This module re-implements
// the published generator (same seed, same xorshift64* stream, same word
// lists) so the forge derives the same scenario the suite drives against.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const SCENARIO_EPOCH_SEC = 1_735_689_600;
const DEFAULT_BRANCH = 'main';

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** Deterministic 64-bit stream (xorshift64*). */
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  fraction(): number {
    return this.nextU32() / 4_294_967_296;
  }
  chance(probability: number): boolean {
    return this.fraction() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const swap = copy[i];
      copy[i] = copy[j];
      copy[j] = swap;
    }
    return copy;
  }
}

function scenarioRng(label: string): Rng {
  return new Rng(mix64(SCENARIO_SEED ^ fnv1a64(label)));
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];
const REPO_DESCRIPTIONS = [
  'a small service with a sharp edge',
  'notes and experiments, kept until they are not',
  'the tooling behind the thing',
  'a reference implementation, for reading',
  'what the prototype became',
  'fixtures, generators and the odd benchmark',
  'the parts that must not break',
  'a sandbox for the next idea',
];
const PATH_SEGMENTS = [
  'src', 'lib', 'docs', 'test', 'scripts', 'api', 'core', 'util', 'config', 'data', 'web', 'cli', 'pkg',
  'internal', 'examples', 'assets', 'build', 'tools', 'server', 'client',
];
const FILE_STEMS = [
  'index', 'request', 'response', 'server', 'client', 'schema', 'parser', 'router', 'config', 'store',
  'clock', 'queue', 'render', 'format', 'validate', 'session', 'token', 'event', 'stream', 'cache',
];
const FILE_EXTENSIONS = ['ts', 'js', 'json', 'md', 'txt', 'yml', 'toml', 'css', 'html', 'sql'];
const BLOB_WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo',
  'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor',
  'whiskey', 'xray', 'yankee', 'zulu', 'amber', 'basalt', 'cobalt', 'drift', 'ember', 'frost', 'granite',
  'hollow', 'ivory', 'jasper', 'kelp', 'lichen', 'moss', 'nickel',
];
const COMMIT_VERBS = [
  'Add', 'Fix', 'Refactor', 'Document', 'Test', 'Tidy', 'Speed up', 'Simplify', 'Handle', 'Extract',
  'Inline', 'Rename', 'Guard', 'Wire', 'Drop',
];
const COMMIT_OBJECTS = [
  'the request parser', 'repo lookup', 'issue pagination', 'the merge path', 'token checks',
  'the clone endpoint', 'packfile handling', 'error bodies', 'branch listing', 'the GraphQL node query',
  'MCP tool dispatch', 'rate limit headers', 'the upload pack', 'the ref advertisement', 'commit ancestry',
];
const ISSUE_ADJECTIVES = [
  'Broken', 'Slow', 'Missing', 'Confusing', 'Unexpected', 'Flaky', 'Incorrect', 'Unclear', 'Stale', 'Noisy',
];
const ISSUE_SUBJECTS = [
  'clone over HTTP', 'push report-status', 'issue pagination', 'merge button', 'GraphQL node ids',
  'MCP tool list', 'shallow fetch', 'tag listing', 'repo creation', 'content update', 'branch deletion',
  'commit listing',
];
const PULL_VERBS = ['Add', 'Fix', 'Improve', 'Simplify', 'Document', 'Refactor', 'Speed up', 'Harden'];
const PULL_SUBJECTS = [
  'shallow fetch support', 'push report status checks', 'issue label validation', 'merge conflict detection',
  'GraphQL cursor pagination', 'MCP tool schemas', 'packfile delta reuse', 'conditional requests',
  'repo pagination', 'branch protection stubs',
];
const SENTENCE_STARTS = [
  'Steps to reproduce are below', 'This showed up after the last change', 'The expected behaviour is clear',
  'A minimal case is attached', 'It works on a fresh repository', 'The same flow works over the API',
];
const SENTENCE_ENDS = [
  'and the server answers with a JSON error', 'but the second request fails', 'and nothing is written to the log',
  'while the reply body stays empty', 'and the status is wrong for the method', 'so the client gives up',
];
const ISSUE_LABELS = ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted'];
const DEFAULT_BRANCHES = ['main', 'develop', 'release/1.0'];

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}
export interface ScenarioRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
}
export interface ScenarioBlob {
  path: string;
  content: string;
  base64: string;
}
export interface ScenarioCommit {
  message: string;
  author: ScenarioUser;
  epochSec: number;
  iso: string;
}
export interface ScenarioIssue {
  title: string;
  body: string;
  labels: string[];
}
export interface ScenarioPull {
  title: string;
  body: string;
  head: string;
  base: string;
}
export interface Scenario {
  viewer: ScenarioUser;
  teammate: ScenarioUser;
  stranger: ScenarioUser;
  users: ScenarioUser[];
  org: string;
  repos: ScenarioRepo[];
  orgRepos: ScenarioRepo[];
  strangerRepos: ScenarioRepo[];
  labels: string[];
  branches: string[];
  filePaths: string[];
  blobs: ScenarioBlob[];
  commits: ScenarioCommit[];
  issues: ScenarioIssue[];
  pulls: ScenarioPull[];
}

function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

function generateRepos(rng: Rng, owner: string, count: number, firstId = 5000): ScenarioRepo[] {
  const used = new Set<string>();
  const repos: ScenarioRepo[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = `${rng.pick(REPO_ADJECTIVES)}-${rng.pick(REPO_NOUNS)}`;
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(name);
    repos.push({
      id: firstId + i,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description: rng.pick(REPO_DESCRIPTIONS),
      private: i % 7 === 3,
      defaultBranch: DEFAULT_BRANCH,
    });
  }
  return repos;
}

function generateFilePaths(rng: Rng, count: number): string[] {
  const used = new Set<string>();
  const paths: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const depth = rng.nextInt(3) === 0 ? 0 : 1 + rng.nextInt(2);
    const dirs = depth === 0 ? [] : rng.shuffle(PATH_SEGMENTS).slice(0, depth);
    const base = [...dirs, `${rng.pick(FILE_STEMS)}.${rng.pick(FILE_EXTENSIONS)}`].join('/');
    let path = base;
    let suffix = 2;
    while (used.has(path)) {
      path = [...dirs, `${suffix}-${base.split('/').pop() ?? base}`].join('/');
      suffix += 1;
    }
    used.add(path);
    paths.push(path);
  }
  return paths;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(triplet >> 18) & 63] ?? '';
    out += BASE64_ALPHABET[(triplet >> 12) & 63] ?? '';
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triplet >> 6) & 63] ?? '' : '=';
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triplet & 63] ?? '' : '=';
  }
  return out;
}

function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

function generateBlobText(rng: Rng, sizeBytes: number): string {
  const size = Math.max(0, Math.trunc(sizeBytes));
  let out = '';
  while (out.length < size) {
    out += rng.pick(BLOB_WORDS);
    if (out.length < size) out += rng.chance(0.14) ? '\n' : ' ';
  }
  return out.slice(0, size);
}

function generateBlob(rng: Rng, path: string, sizeBytes: number): ScenarioBlob {
  const content = generateBlobText(rng, sizeBytes);
  return { path, content, base64: textToBase64(content) };
}

function scenarioDate(rng: Rng): { epochSec: number; iso: string } {
  const epochSec = SCENARIO_EPOCH_SEC + rng.nextInt(90 * 24 * 60 * 60);
  return { epochSec, iso: new Date(epochSec * 1000).toISOString() };
}

function generateSentence(rng: Rng): string {
  return `${rng.pick(SENTENCE_STARTS)} ${rng.pick(SENTENCE_ENDS)}.`;
}

function generateBody(rng: Rng): string {
  const sentences: string[] = [];
  const count = 1 + rng.nextInt(3);
  for (let i = 0; i < count; i += 1) sentences.push(generateSentence(rng));
  return sentences.join(' ');
}

function generateCommitMessage(rng: Rng): string {
  const head = `${rng.pick(COMMIT_VERBS)} ${rng.pick(COMMIT_OBJECTS)}`;
  return rng.chance(0.35) ? `${head}\n\n${generateSentence(rng)}` : head;
}

function generateCommit(rng: Rng, author: ScenarioUser): ScenarioCommit {
  const when = scenarioDate(rng);
  return { message: generateCommitMessage(rng), author, epochSec: when.epochSec, iso: when.iso };
}

function generateIssue(rng: Rng): ScenarioIssue {
  return {
    title: `${rng.pick(ISSUE_ADJECTIVES)} ${rng.pick(ISSUE_SUBJECTS)}`,
    body: generateBody(rng),
    labels: rng.chance(0.5) ? [rng.pick(ISSUE_LABELS)] : [],
  };
}

function generateBranchName(rng: Rng): string {
  const kind = rng.pick(['feature', 'fix', 'perf', 'docs', 'chore']);
  const subject = rng
    .pick(PULL_SUBJECTS)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${kind}/${subject}`;
}

function generatePull(rng: Rng, base: string = DEFAULT_BRANCH): ScenarioPull {
  return {
    title: `${rng.pick(PULL_VERBS)} ${rng.pick(PULL_SUBJECTS)}`,
    body: generateBody(rng),
    head: generateBranchName(rng),
    base,
  };
}

let cached: Scenario | null = null;

/** The fixed scenario, built once from the published seed. */
export function buildScenario(): Scenario {
  if (cached !== null) return cached;
  const users = generateUsers(scenarioRng('users'), 12);
  const viewer = users[0] as ScenarioUser;
  const teammate = users[1] as ScenarioUser;
  const stranger = users[2] as ScenarioUser;
  const orgRng = scenarioRng('org');
  const org = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;
  const branchRng = scenarioRng('branches');
  const branchSet = new Set<string>(DEFAULT_BRANCHES);
  for (let i = 0; i < 8; i += 1) {
    let branch = generateBranchName(branchRng);
    let suffix = 2;
    while (branchSet.has(branch)) {
      branch = `${generateBranchName(branchRng)}-${suffix}`;
      suffix += 1;
    }
    branchSet.add(branch);
  }
  const filePaths = generateFilePaths(scenarioRng('paths'), 60);
  const blobRng = scenarioRng('blobs');
  const blobs = filePaths.slice(0, 24).map((path) => generateBlob(blobRng, path, 64 + blobRng.nextInt(4_033)));
  const commitRng = scenarioRng('commits');
  const commits = Array.from({ length: 60 }, () => generateCommit(commitRng, commitRng.pick(users)));
  const issueRng = scenarioRng('issues');
  const issues = Array.from({ length: 60 }, () => generateIssue(issueRng));
  const pullRng = scenarioRng('pulls');
  const pulls = Array.from({ length: 30 }, () => generatePull(pullRng));
  const repos = generateRepos(scenarioRng('repos.viewer'), viewer.login, 30, 5000);
  const orgRepos = generateRepos(scenarioRng('repos.org'), org, 6, 6000);
  const strangerRepos = generateRepos(scenarioRng('repos.stranger'), stranger.login, 3, 7000);
  cached = {
    viewer,
    teammate,
    stranger,
    users,
    org,
    repos,
    orgRepos,
    strangerRepos,
    labels: [...ISSUE_LABELS],
    branches: [...branchSet],
    filePaths,
    blobs,
    commits,
    issues,
    pulls,
  };
  return cached;
}
