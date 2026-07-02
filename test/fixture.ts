/**
 * Test fixture for gw: a disposable multi-repo workspace with LOCAL bare repos
 * as "origins", driven through the REAL CLI (one subprocess per invocation) —
 * the same entry point users hit, directive file and all. Nothing is mocked:
 * every test exercises real git worktrees, real fetches/pushes (file transport),
 * real locks.
 *
 * Layout per fixture (under a mkdtemp root):
 *   origins/<key>.git   bare repo standing in for GitHub
 *   <key>/              canonical checkout (clone of the bare)
 *   gw.config.json      generated from the per-repo overrides
 *   .worktrees/         created by gw itself
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GW_TS = path.join(HERE, '..', 'src', 'gw.ts');
const TSX = path.join(HERE, '..', 'node_modules', '.bin', 'tsx');

// Isolate from the developer's git config (gpg signing, hooks, odd defaults).
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

export function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}
export const git = (cwd: string, args: string[]): string => sh('git', ['-C', cwd, ...args]);

export interface RepoOverrides {
  gate?: string[] | null;
  gateQuick?: string[];
  gateQuickDefault?: boolean;
  linkPaths?: string[];
  trackedEnv?: boolean; // seed a TRACKED .env in the initial commit (the linkPath scar case)
}

export interface Fixture {
  root: string;
  repoKeys: string[];
  origin(repo: string): string;   // bare "GitHub" repo
  co(repo: string): string;       // canonical checkout
  wt(session: string, repo: string): string; // a session's worktree for repo
  sessionDir(session: string): string;
}

const roots: string[] = [];
/** Remove every fixture created this run — call from a global after() hook. */
export function cleanupFixtures(): void {
  for (const r of roots.splice(0)) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* busy/gone */ } }
}

export function makeFixture(opts: { repos?: Record<string, RepoOverrides> } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-fx-'));
  roots.push(root);
  const repoDefs = opts.repos ?? { a: {}, b: {} };
  for (const [key, o] of Object.entries(repoDefs)) {
    const bare = path.join(root, 'origins', `${key}.git`);
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    sh('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    const co = path.join(root, key);
    sh('git', ['clone', '-q', bare, co]);
    git(co, ['config', 'user.email', 'gw-test@example.com']);
    git(co, ['config', 'user.name', 'gw test']);
    fs.writeFileSync(path.join(co, 'README.md'), `# ${key}\n`);
    if (o.trackedEnv) fs.writeFileSync(path.join(co, '.env'), 'SECRET=1\n');
    git(co, ['add', '-A']);
    git(co, ['commit', '-q', '-m', 'init']);
    git(co, ['push', '-q', '-u', 'origin', 'main']);
  }
  writeConfig(root, repoDefs);
  return {
    root,
    repoKeys: Object.keys(repoDefs),
    origin: (r) => path.join(root, 'origins', `${r}.git`),
    co: (r) => path.join(root, r),
    wt: (s, r) => path.join(root, '.worktrees', s, r),
    sessionDir: (s) => path.join(root, '.worktrees', s),
  };
}

export function writeConfig(root: string, repos: Record<string, RepoOverrides>): void {
  const cfg = {
    base: 'main',
    repos: Object.entries(repos).map(([key, o]) => ({
      key,
      dir: key,
      slug: '',
      base: 'main',
      linkPaths: o.linkPaths ?? [],
      gate: o.gate ?? null,
      ...(o.gateQuick ? { gateQuick: o.gateQuick } : {}),
      ...(o.gateQuickDefault ? { gateQuickDefault: true } : {}),
    })),
  };
  fs.writeFileSync(path.join(root, 'gw.config.json'), JSON.stringify(cfg, null, 2) + '\n');
}

export interface GwResult { code: number; stdout: string; stderr: string; directive: string[] }

/** Run the real CLI once. stdin defaults to closed-empty (a promptless start). */
export function gw(fx: Fixture, args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}): Promise<GwResult> {
  const out = path.join(fx.root, `.gw-out-${Math.random().toString(36).slice(2)}`);
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [GW_TS, ...args], {
      cwd: opts.cwd ?? fx.root,
      env: { ...process.env, ...GIT_ENV, GW_ROOT: fx.root, GW_OUT: out, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      let directive: string[] = [];
      try { directive = fs.readFileSync(out, 'utf8').trimEnd().split('\t'); fs.rmSync(out); } catch { /* command emitted nothing */ }
      resolve({ code: code ?? 1, stdout, stderr, directive });
    });
    child.stdin.end(opts.stdin ?? '');
  });
}

/** `gw start` with an empty prompt; returns the new session id (WT-NNN). */
export async function startSession(fx: Fixture): Promise<string> {
  const r = await gw(fx, ['start']);
  if (r.code !== 0) throw new Error(`gw start failed (exit ${r.code}):\n${r.stderr}`);
  const dir = r.directive[1];
  if (!dir) throw new Error(`gw start emitted no session dir:\n${r.stderr}\n${r.stdout}`);
  return path.basename(dir);
}
