/**
 * Shared worktree management for `gw` (Grove Workspace). gw runs many units of work
 * in parallel, each in its OWN namespaced worktree set across every configured repo,
 * identified by a sortable auto-numbered id (`WS-NNNNN`, optionally with a `-<slug>`
 * suffix). This module owns: the work-unit numberer, worktree create/remove,
 * cwd→session resolution, and the locks that make concurrent landing/numbering safe.
 *
 * The repo identity map, base branch, and workspace root come from the loaded
 * `gw.config.json` (see config.ts) via setWorkspace() — call it once at startup
 * before anything else here.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Workspace } from '../config.js';
import { DEFAULT_NAMER } from '../config.js';

export type RepoKey = string;

// The active workspace, installed by gw.ts at startup. Every path/repo lookup below
// reads from it, so a copy of this code running inside a worktree still resolves the
// real root (gw.sh exports GW_ROOT; config discovery walks up to gw.config.json).
let ws: Workspace;
export function setWorkspace(w: Workspace): void { ws = w; }
export function workspace(): Workspace { return ws; }

// ── process / git helpers ────────────────────────────────────────────────────

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; }

// Own process group so a timeout kills the whole tree (gate commands spawn
// grandchildren). Default cwd = process.cwd() (callers pass cwd explicitly).
export function run(cmd: string, args: string[], o: { cwd?: string; timeoutMs?: number; onStdout?: (s: string) => void } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (r: RunResult) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(r); };
    const killTree = (sig: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, sig); return; } catch { /* gone */ } } try { child.kill(sig); } catch { /* dead */ } };
    timer = o.timeoutMs ? setTimeout(() => { timedOut = true; killTree('SIGKILL'); }, o.timeoutMs) : null;
    child.stdout.on('data', (d) => { const s = d.toString('utf-8'); stdout += s; o.onStdout?.(s); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
    child.on('error', (err) => finish({ code: 1, stdout, stderr: stderr + String(err), timedOut }));
  });
}

export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return run('git', ['-C', cwd, ...args], { timeoutMs });
}
export async function gitOut(cwd: string, args: string[]): Promise<string> { return (await git(cwd, args)).stdout.trim(); }

// ── naming + work-unit ids ───────────────────────────────────────────────────

const SLUG_STOPWORDS = new Set('a an and or the of to for in on at with by from as is are be can i we you me my our your it this that these those just really please simply want some simple fun cool nice'.split(' '));
// Lowercase, every non-[a-z0-9] → dash, filler words dropped, truncated at a WORD
// boundary to <=max chars. "I want to add the new dashboard page" → "add-new-dashboard-page".
export function slugify(s: string, max = 40): string {
  const words = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const kept = words.filter(w => !SLUG_STOPWORDS.has(w));
  const pool = kept.length ? kept : words; // never strip away the entire name
  let out = '';
  for (const w of pool) { const next = out ? `${out}-${w}` : w; if (next.length > max) break; out = next; }
  return (out || (pool[0] ?? '').slice(0, max)).replace(/^-+|-+$/g, '');
}

// ── human-facing timestamps (gw ready/prune) ─────────────────────────────────

/** Compact local datetime for console output. */
export function fmtStamp(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Short relative age: minutes under an hour, whole hours under 2 days, whole
 *  days beyond. The 48h hours→days cutover is the at-a-glance staleness cue. */
export function fmtAge(tsSec: number, nowSec: number): string {
  const sec = Math.max(0, nowSec - tsSec);
  const hours = sec / 3600;
  if (hours < 1) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "last active 2026-06-11 08:43 (2d)" — empty string when no timestamp is
 *  available, so callers can append it unconditionally. */
export function lastActiveLabel(tsSec: number | null, nowSec: number): string {
  if (tsSec === null) return '';
  return ` — last active ${fmtStamp(tsSec)} (${fmtAge(tsSec, nowSec)})`;
}

// LLM-assisted session title: ask the configured `namer` command (default
// `claude --model haiku` — already a hard gw dependency since gw launches the agent
// in every session) for a 2-5 word title of the prompt, then slugify it. One-shot,
// a few seconds. Any failure — binary missing, timeout, non-zero exit, prose/refusal
// instead of a title — falls back to slugify(prompt), so naming can never block or
// break a session start. Only the first 1000 chars are sent, in case the prompt is a
// giant pasted log.
export async function smartSlug(prompt: string, opts: { timeoutMs?: number; exec?: typeof run; namer?: string[] } = {}): Promise<string> {
  const { timeoutMs = 20_000, exec = run, namer = DEFAULT_NAMER.split(/\s+/) } = opts;
  const text = prompt.trim().slice(0, 1000);
  if (!text || !namer.length) return slugify(prompt);
  const ask = [
    'Below is the starting prompt of a dev session (possibly truncated). Its git worktree needs a name',
    'that identifies the work at a glance among many other sessions.',
    'Reply with ONLY a 2-5 word descriptive title — name the specific feature/bug/area, not generic',
    'words like "fix", "update", "task". No quotes, no punctuation, no explanation.',
    '',
    '---',
    text,
  ].join('\n');
  try {
    const r = await exec(namer[0], [...namer.slice(1), '-p', ask], { timeoutMs });
    const out = r.stdout.trim();
    const wordCount = out.split(/\s+/).filter(Boolean).length;
    // Accept only what looks like an actual title: one line, 2-6 words. Anything
    // else (multi-line prose, a lone word, an apology) is junk — use the fallback.
    if (r.code === 0 && out && !out.includes('\n') && wordCount >= 2 && wordCount <= 6) {
      const s = slugify(out);
      if (s.includes('-')) return s;
    }
  } catch { /* fall through to the plain slug */ }
  return slugify(prompt);
}

const ID_PREFIX = 'WS';
const ID_WIDTH = 5;
// One shared, durable counter at the workspace root (not inside .worktrees/, so
// per-session cleanup never resets it; the root is not a git repo, so it's never
// committed). Locked so concurrent `gw start`s never collide on a number.
function seqFile(): string { return path.join(ws.root, '.gw-seq'); }

export function parseId(name: string): string | null {
  const m = name.match(new RegExp(`^${ID_PREFIX}-(\\d{${ID_WIDTH},})`));
  return m ? `${ID_PREFIX}-${m[1]}` : null;
}

/** Allocate the next `WS-NNNNN` id, appending `-<slug>` when a slug is given. The
 *  read-increment-write is wrapped in a lock so it's safe under concurrency. */
export async function allocateId(slug?: string): Promise<string> {
  const file = seqFile();
  return withLock(file + '.lock', () => {
    let n = 0;
    try { n = parseInt(fs.readFileSync(file, 'utf-8').trim(), 10) || 0; } catch { /* first run */ }
    n += 1;
    fs.writeFileSync(file, String(n) + '\n');
    const id = `${ID_PREFIX}-${String(n).padStart(ID_WIDTH, '0')}`;
    const s = slug ? slugify(slug) : '';
    return s ? `${id}-${s}` : id;
  });
}

// ── locks (atomic mkdir; pid + mtime for stale-steal) ────────────────────────

/** Run `fn` holding an exclusive lock at `lockDir`. mkdir is atomic, so it's a
 *  cross-process mutex. A lock older than `staleMs` (default 10 min) is assumed
 *  dead and stolen. Always released in `finally`. */
export async function withLock<T>(lockDir: string, fn: () => T | Promise<T>, staleMs = 10 * 60_000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { /* vanished — retry */ }
      if (age > staleMs) { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* race */ } continue; }
      if (attempt >= 600) throw new Error(`could not acquire lock ${lockDir} after 60s (held by another process)`);
      await sleep(100);
    }
  }
  try { fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid)); } catch { /* best-effort */ }
  try { return await fn(); }
  finally { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* already gone */ } }
}

/** Land-step mutex for ONE repo's shared canonical checkout. Two concurrent
 *  `gw done`s landing the same repo would corrupt its index/HEAD; this serializes
 *  them. */
export function withRepoLandLock<T>(repoDir: string, fn: () => T | Promise<T>): Promise<T> {
  return withLock(path.join(repoDir, '.git', 'gw-land.lock'), fn);
}

// ── ephemeral land worktrees ─────────────────────────────────────────────────
// A land builds its squash commit in a DISPOSABLE detached worktree off
// origin/<base>, never in the shared canonical checkout — so that checkout's
// working-tree state can't block a land and a failed land strands nothing.

/** Parent dir for a repo's ephemeral land worktrees. Under `.git/` so they're off
 *  the workspace tree (invisible to `gw status`) and reapable by one prefix. */
export function landTmpRoot(repoDir: string): string { return path.join(repoDir, '.git', 'gw-land-tmp'); }

/** A unique land-worktree path (session + pid + random) so concurrent lands of the
 *  same repo never collide. */
export function landTmpDir(repoDir: string, sessionId: string): string {
  return path.join(landTmpRoot(repoDir), `${sessionId}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
}

/** Reap land worktrees a crashed `gw done` left behind: any older than `staleMs`
 *  (default 10 min — matches the land-lock steal window, so a fresh concurrent land
 *  is never reaped), then prune the registry. */
export async function sweepLandTmp(repoDir: string, staleMs = 10 * 60_000): Promise<void> {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(landTmpRoot(repoDir), { withFileTypes: true }); } catch { /* none yet */ }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(landTmpRoot(repoDir), e.name);
    let age = Infinity;
    try { age = Date.now() - fs.statSync(full).mtimeMs; } catch { /* vanished — let prune handle it */ }
    if (age > staleMs) await git(repoDir, ['worktree', 'remove', '--force', full]);
  }
  await git(repoDir, ['worktree', 'prune']);
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ── session worktrees ────────────────────────────────────────────────────────

export function sessionDir(worktreesRoot: string, sessionId: string): string { return path.join(worktreesRoot, sessionId); }
export function sessionRepoDir(worktreesRoot: string, sessionId: string, repo: RepoKey): string { return path.join(worktreesRoot, sessionId, repo); }

async function fetchBase(dir: string, base: string): Promise<boolean> {
  if ((await git(dir, ['fetch', 'origin', base])).code === 0) return true;
  return (await git(dir, ['fetch', 'origin', base])).code === 0; // one retry — credential helper blips
}

// ── session-worktree validation ──────────────────────────────────────────────
// Isolation is the whole point of a session: edits must hit a throwaway `gw/<id>`
// worktree, never the canonical checkout. The failure that motivated these guards:
// a session path that RESOLVED to the workspace root (a stray symlink) was silently
// adopted as "already provisioned", so a session ran directly on the canonical
// checkout with no branch and no isolation. We refuse that loudly instead.

/** True if `p/.git` exists at all — a linked worktree OR a canonical checkout. */
function hasGitDir(p: string): boolean {
  try { fs.statSync(path.join(p, '.git')); return true; } catch { return false; }
}

/** True ONLY if `wt` is an isolated linked worktree of `canonicalDir` on `branch`.
 *  Decisive signal: a linked worktree's `.git` is a FILE (`gitdir: …/worktrees/<n>`),
 *  while a canonical checkout's `.git` is a DIRECTORY — so a directory here means the
 *  path resolved to a real checkout (classically a symlink to the workspace root) and
 *  must never be treated as a session. We also require it to sit on `branch` and to
 *  share `canonicalDir`'s object store (so it's a worktree OF this repo). */
export async function isSessionWorktree(wt: string, canonicalDir: string, branch: string): Promise<boolean> {
  let st: fs.Stats;
  try { st = fs.statSync(path.join(wt, '.git')); } catch { return false; }
  if (!st.isFile()) return false;                                          // dir `.git` → canonical checkout, not isolated
  if (await gitOut(wt, ['rev-parse', '--abbrev-ref', 'HEAD']) !== branch) return false;
  try { // best-effort object-store match — tolerate rev-parse quirks (FILE+branch already strong)
    let common = await gitOut(wt, ['rev-parse', '--git-common-dir']);
    if (!common) return true;
    if (!path.isAbsolute(common)) common = path.resolve(wt, common);
    if (fs.realpathSync(common) !== fs.realpathSync(path.join(canonicalDir, '.git'))) return false;
  } catch { /* tolerate */ }
  return true;
}

/** Throw unless EVERY repo in `repos` has an isolated `gw/<sessionId>` worktree under
 *  the session dir. Callers use this to refuse launching/landing a session that would
 *  provide no isolation (e.g. a session dir resolving to the canonical checkout). */
export async function assertIsolatedSession(worktreesRoot: string, sessionId: string, repos: RepoKey[] = ws.repoKeys): Promise<void> {
  const bad: string[] = [];
  for (const repo of repos) {
    const wt = sessionRepoDir(worktreesRoot, sessionId, repo);
    if (!(await isSessionWorktree(wt, ws.repos[repo].dir, `gw/${sessionId}`))) bad.push(repo);
  }
  if (bad.length) {
    throw new Error(
      `session ${sessionId} is not isolated: ${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not a 'gw/${sessionId}' worktree ` +
      `(the session path likely resolves to a real checkout — e.g. a stray symlink to the workspace root). ` +
      `Refusing to proceed so edits can't hit the canonical checkout. Run \`gw abort ${sessionId}\` to clear it, then start again.`,
    );
  }
}

/**
 * Link a worktree's node_modules from the canonical checkout. A plain repo gets a
 * single symlink (fast — shares every dep). But when node_modules holds a workspace
 * scope (e.g. `@acme/*`) whose packages are symlinks back into the repo, a blanket
 * symlink makes those resolve to the CANONICAL checkout's `packages/` — so a worktree
 * edit to a local package is invisible to its own typecheck/tests and the `gw done`
 * gate. In that case build a REAL node_modules: symlink every third-party entry to the
 * canonical copy, but recreate the workspace scope preserving each package's ORIGINAL
 * (relative) link target, so it resolves to THIS worktree's packages.
 */
export function linkNodeModules(srcNm: string, dstNm: string, scope?: string): void {
  if (!scope || !fs.existsSync(path.join(srcNm, scope))) { fs.symlinkSync(srcNm, dstNm); return; }
  fs.mkdirSync(dstNm, { recursive: true });
  for (const entry of fs.readdirSync(srcNm)) {
    const dst = path.join(dstNm, entry);
    if (fs.existsSync(dst)) continue;
    if (entry !== scope) { fs.symlinkSync(path.join(srcNm, entry), dst); continue; }
    // Recreate the workspace scope so its packages resolve under THIS worktree.
    const srcScope = path.join(srcNm, entry);
    fs.mkdirSync(dst, { recursive: true });
    for (const pkg of fs.readdirSync(srcScope)) {
      const link = path.join(dst, pkg);
      if (fs.existsSync(link)) continue;
      // A relative workspace link (e.g. ../../packages/shared) recreated here resolves
      // to this worktree; a real dir (non-symlink) falls back to the canonical path.
      let target: string;
      try { target = fs.readlinkSync(path.join(srcScope, pkg)); }
      catch { target = path.join(srcScope, pkg); }
      fs.symlinkSync(target, link);
    }
  }
}

/** Create (or re-enter) a session's worktree set: for each repo, a worktree at
 *  `<worktreesRoot>/<sessionId>/<repo>` on `branch`, with gitignored deps/env
 *  symlinked in so gates can run. Idempotent: an existing isolated worktree is left
 *  as-is. Throws on any git failure (fail loud — no half-made sessions). */
export async function ensureSession(worktreesRoot: string, sessionId: string, branch: string, repos: RepoKey[] = ws.repoKeys): Promise<string> {
  const dir = sessionDir(worktreesRoot, sessionId);
  fs.mkdirSync(worktreesRoot, { recursive: true });
  for (const repo of repos) {
    const cfg = ws.repos[repo];
    const wt = sessionRepoDir(worktreesRoot, sessionId, repo);
    // Re-enter only a GENUINE `gw/<id>` worktree — not merely "a `.git` exists here".
    if (!(await isSessionWorktree(wt, cfg.dir, branch))) {
      // Something is here but it isn't our isolated worktree. If it's ANY git checkout
      // (the canonical repo via a symlink, or a worktree on the wrong branch), REFUSE —
      // never delete it; it may be real work. Only clear a non-git leftover, and unlink
      // a symlink rather than recursing through it (a symlink could point at the root).
      if (fs.existsSync(wt)) {
        if (hasGitDir(wt)) {
          throw new Error(`refusing to use ${repo} worktree at ${wt}: not an isolated '${branch}' worktree (it resolves to a real checkout — likely a stray symlink to the workspace root). Move or remove it, then retry.`);
        }
        if (fs.lstatSync(wt).isSymbolicLink()) fs.unlinkSync(wt);
        else fs.rmSync(wt, { recursive: true, force: true });
      }
      await git(cfg.dir, ['worktree', 'prune']);
      if (!(await fetchBase(cfg.dir, cfg.base))) throw new Error(`fetch origin ${cfg.base} failed in ${repo}`);
      const add = await git(cfg.dir, ['worktree', 'add', '-B', branch, wt, `origin/${cfg.base}`]);
      if (add.code !== 0) throw new Error(`worktree add failed in ${repo}: ${add.stderr.trim().slice(0, 200)}`);
      if (!(await isSessionWorktree(wt, cfg.dir, branch))) {
        throw new Error(`provisioned ${repo} worktree at ${wt} did not come up as an isolated '${branch}' worktree`);
      }
    }
    // ALWAYS (re)link gitignored deps/env — converge, don't just skip — so a
    // half-provisioned worktree (crashed mid-create) or a hand-deleted symlink is
    // restored on the next call instead of silently leaving the gate without deps.
    for (const rel of cfg.linkPaths) {
      const src = path.join(cfg.dir, rel), dst = path.join(wt, rel);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try {
          if (path.basename(rel) === 'node_modules') linkNodeModules(src, dst, cfg.nmScope);
          else fs.symlinkSync(src, dst);
        } catch { /* race / already there */ }
      }
    }
    // Real copies for docker-build inputs (see copyPaths).
    for (const rel of cfg.copyPaths) {
      const src = path.join(cfg.dir, rel), dst = path.join(wt, rel);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try { fs.copyFileSync(src, dst); } catch { /* race / already there */ }
      }
    }
  }
  // When the workspace builds docker images from a session worktree, a .dockerignore
  // keeps the symlinked deps + git metadata out of the build context (otherwise the
  // context tars a dangling node_modules symlink and bakes it into the image). Opt-in
  // via `"docker": true` in gw.config.json.
  if (ws.docker) {
    const dockerignore = path.join(dir, '.dockerignore');
    if (!fs.existsSync(dockerignore)) {
      const lines = ['# generated by gw (ensureSession): keep linked deps/env out of docker build contexts', '.git/', '**/.git'];
      for (const repo of repos) {
        for (const rel of ws.repos[repo].linkPaths) lines.push(`${repo}/${rel}`);
      }
      fs.writeFileSync(dockerignore, lines.join('\n') + '\n');
    }
  }
  return dir;
}

/** Tear a session down: remove each repo's worktree (git-aware), prune, drop the
 *  per-repo `branch` if given, then remove the session dir. Safe to call when some
 *  repos were never created. */
export async function removeSession(worktreesRoot: string, sessionId: string, repos: RepoKey[] = ws.repoKeys, branch?: string): Promise<void> {
  for (const repo of repos) {
    const cfg = ws.repos[repo];
    const wt = sessionRepoDir(worktreesRoot, sessionId, repo);
    if (fs.existsSync(wt)) await git(cfg.dir, ['worktree', 'remove', '--force', wt]);
    await git(cfg.dir, ['worktree', 'prune']);
    if (branch) await git(cfg.dir, ['branch', '-D', branch]); // best-effort; ignore if absent
  }
  const sdir = sessionDir(worktreesRoot, sessionId);
  try {
    // Never recurse THROUGH a symlink — it could point at the workspace root, and a
    // recursive force-delete would then nuke real files. Drop the link itself; only
    // recursively remove a genuine directory.
    if (fs.lstatSync(sdir).isSymbolicLink()) fs.unlinkSync(sdir);
    else fs.rmSync(sdir, { recursive: true, force: true });
  } catch { /* already gone */ }
}

/** All session ids under a worktrees root (dirs that look like a WS id), sorted —
 *  the zero-padded number sorts chronologically. */
export function listSessions(worktreesRoot: string): string[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(worktreesRoot, { withFileTypes: true }); } catch { return []; }
  return entries.filter(e => e.isDirectory() && parseId(e.name)).map(e => e.name).sort();
}

/** Which session a cwd belongs to: the first path segment under `worktreesRoot`.
 *  Returns null when cwd is outside the worktrees root. Both paths are realpath'd
 *  first so a symlinked root (e.g. macOS /var → /private/var, where process.cwd()
 *  reports the real path but GW_ROOT keeps the link) still resolves. */
export function resolveSessionFromCwd(worktreesRoot: string, cwd: string): string | null {
  const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const rel = path.relative(real(worktreesRoot), real(cwd));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const seg = rel.split(path.sep)[0];
  return seg && parseId(seg) ? seg : null;
}

/** Guard against the node_modules-symlink disaster: refuse to proceed if any of a
 *  repo's linked paths is tracked/staged (a worktree-linked symlink must never be
 *  committed). Returns the offending paths, or [] when clean. */
export async function stagedLinkPaths(repoWt: string, repo: RepoKey): Promise<string[]> {
  const bad: string[] = [];
  for (const rel of ws.repos[repo].linkPaths) {
    const r = await git(repoWt, ['ls-files', '--error-unmatch', rel]);
    if (r.code === 0) bad.push(rel); // tracked → would be committed
  }
  return bad;
}
