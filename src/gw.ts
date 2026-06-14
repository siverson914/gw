/**
 * gw — Grove Workspace: parallel, isolated agent work-sessions across many git repos,
 * with a safe one-shot land and a deploy-readiness check.
 *
 * Subcommands, all driven by the `gw()` shell function in gw.sh (which does the
 * things a child process can't: cd the shell and launch the interactive agent). This
 * script does ALL the git/gh/gate work and writes ONE directive line to the file
 * named by $GW_OUT for the shell to act on.
 *
 *   gw init             scaffold a workspace: detect sibling repos (or clone the
 *                       ones named with --repo), write gw.config.json, install the
 *                       /done, /abort, /donedone slash commands.
 *   gw start [prompt]   put EVERY repo on a fresh `gw/<name>` branch off origin/<base>,
 *                       then the shell cd's into <root>/.worktrees/<id> and launches
 *                       the configured agent — so every repo sits side-by-side and you
 *                       edit any of them in one session. Resumes unfinished work.
 *   gw done   [--pr]    for EVERY repo you actually changed: gate -> squash-merge to
 *                       <base> + push (default), or push a branch + open a PR (--pr).
 *                       Untouched repos are skipped. All gates run before any merge,
 *                       so one red gate lands nothing.
 *   gw abort            discard every repo's branch work; <base> is never touched.
 *   gw status           one-glance check of EVERY repo + worktree: branch,
 *                       uncommitted/untracked, ahead/behind upstream.
 *   gw ready            the "done-done" check: verifies NO session still holds unlanded
 *                       work, fast-forwards each canonical checkout to origin/<base>
 *                       (--ff-only), prints a READY / NOT-ready verdict. Exit 0 = safe
 *                       to deploy.
 *   gw prune            remove fully-landed, idle sessions (nothing a /done would land).
 *                       --older-than <dur>, --dry-run, --yes.
 *   gw setup            (re)install the slash commands and sanity-check tools/repos.
 *
 * Config (gw.config.json at the workspace root) defines the repos, per-repo gates,
 * base branch, launcher, namer, brand color, and optional session gate / warn dirs.
 * See config.ts. GW_ROOT overrides discovery; GW_BASE overrides the integration
 * branch (tests run against a disposable branch); GW_OUT names the directive file.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  setWorkspace,
  run, git, gitOut, slugify, smartSlug, allocateId, parseId,
  ensureSession, removeSession, listSessions, resolveSessionFromCwd,
  assertIsolatedSession, isSessionWorktree, type RepoKey,
  sessionDir, sessionRepoDir, withRepoLandLock, stagedLinkPaths,
  landTmpRoot, landTmpDir, sweepLandTmp, lastActiveLabel,
} from './lib/worktrees.js';
import { promptBox } from './lib/prompt-box.js';
import {
  loadWorkspace, hexAnsi, CONFIG_NAME,
  DEFAULT_LAUNCHER, DEFAULT_NAMER, DEFAULT_BRAND,
  type Workspace, type RawConfig, type RepoCfg,
} from './config.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url)); // .../gw/src
const GW_HOME = path.resolve(SCRIPT_DIR, '..');                  // the gw install root

// ── workspace binding ── set once at startup (after loadWorkspace), so the rest of
// this file reads paths/repos from module locals exactly like the original did.
let WS: Workspace;
let REPO_ROOT: string;
let REPOS: Record<string, RepoCfg>;
let REPO_KEYS: string[];
let WORKTREES_DIR: string;
let ORANGE = hexAnsi(DEFAULT_BRAND);

function bind(w: Workspace): void {
  // GW_BASE overrides every repo's integration branch (tests run the whole loop
  // against a disposable sandbox branch). Per-repo bases otherwise come from config.
  if (process.env.GW_BASE) { w.base = process.env.GW_BASE; for (const k of w.repoKeys) w.repos[k].base = process.env.GW_BASE; }
  WS = w; REPO_ROOT = w.root; REPOS = w.repos; REPO_KEYS = w.repoKeys;
  WORKTREES_DIR = path.join(w.root, '.worktrees');
  ORANGE = hexAnsi(w.brandColor);
  setWorkspace(w);
}

function log(s: string): void { process.stderr.write(`gw: ${s}\n`); }
function die(msg: string): never { process.stderr.write(`gw: ${msg}\n`); process.exit(1); }

// ── pretty output ── color only on a real TTY, so piped/CI output stays clean.
const TTY = process.stderr.isTTY;
const orange = (s: string): string => (TTY ? `${ORANGE}${s}\x1b[0m` : s);
const GW_BANNER = [
  '  ██████╗ ██╗    ██╗',
  ' ██╔════╝ ██║    ██║',
  ' ██║  ███╗██║ █╗ ██║',
  ' ██║   ██║██║███╗██║',
  ' ╚██████╔╝╚███╔███╔╝',
  '  ╚═════╝  ╚══╝╚══╝ ',
].join('\n');
function banner(): void { if (TTY) process.stderr.write(`\n${orange(GW_BANNER)}\n\n`); }

// The ONE machine-readable line the shell wrapper reads (from $GW_OUT, never stdout —
// so git/gh noise can't be mistaken for a directive). For CD_AND_LAUNCH the launcher
// argv (b64) and prompt (b64) ride along so the shell can cd + exec the agent.
function emit(kind: 'CD' | 'CD_AND_LAUNCH' | 'NONE', dir = '', b64prompt = '', b64launcher = ''): void {
  const out = process.env.GW_OUT;
  if (out) fs.writeFileSync(out, [kind, dir, b64prompt, b64launcher].join('\t') + '\n');
}
const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');

// Agents record MCP-server approval per absolute project path, so every fresh session
// worktree (a brand-new path it's never seen) would re-prompt to approve servers on
// launch. Pre-seed the session's local settings with the servers declared in the root
// .mcp.json so the launch is silent. Merge, never clobber. (Claude-specific, but inert
// when there's no .mcp.json or no .claude consumer.)
function seedMcpApproval(dir: string): void {
  let servers: string[];
  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.mcp.json'), 'utf-8'));
    servers = Object.keys(mcp.mcpServers ?? {});
  } catch { return; }  // no/unreadable .mcp.json → nothing to approve
  if (!servers.length) return;
  const dotClaude = path.join(dir, '.claude');
  const file = path.join(dotClaude, 'settings.local.json');
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* none yet */ }
  const enabled = new Set(Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers as string[] : []);
  for (const s of servers) enabled.add(s);
  settings.enabledMcpjsonServers = [...enabled];
  fs.mkdirSync(dotClaude, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

// ── interactive input ────────────────────────────────────────────────────────

// Read the seed prompt HERE, never through a shell — so quotes/$/!/backticks in the
// prompt are taken literally. On a TTY this is the promptBox editor (lib/prompt-box).
// Returns null if the user cancels; empty text = a plain session.
const PROMPT_MAX = 100_000;
async function readPrompt(): Promise<string | null> {
  const stdin = process.stdin;
  // Piped / heredoc (`gw start < file`, self-tests): consume ALL of stdin.
  if (!stdin.isTTY) {
    stdin.setEncoding('utf8');
    let data = '';
    for await (const chunk of stdin) { data += chunk; if (data.length > PROMPT_MAX) break; }
    return data.slice(0, PROMPT_MAX).trim();
  }
  return promptBox({ header: 'Enter starting prompt:', maxLen: PROMPT_MAX, color: ORANGE });
}
async function confirm(q: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const a = await new Promise<string>((res) => rl.question(q, res));
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

// ── start ────────────────────────────────────────────────────────────────────

async function cmdStart(flags: Flags): Promise<void> {
  // --echo-prompt: self-test the prompt base64 round-trip, touch nothing else.
  if (flags.echoPrompt) {
    const p = await readPrompt();
    if (p === null) { process.stdout.write('CANCELLED\n'); return; }
    const back = Buffer.from(Buffer.from(p, 'utf-8').toString('base64'), 'base64').toString('utf-8');
    process.stdout.write(`MATCH=${back === p}\nPROMPT<<<${p}>>>\n`);
    return;
  }

  banner();
  const launcher = b64(WS.launcher.join(' '));

  // Resume: an existing session given as the positional arg re-enters it.
  const want = flags.session ? parseId(flags.session) : null;
  const resumeId = want ? (listSessions(WORKTREES_DIR).find(s => parseId(s) === want) ?? null) : null;
  if (resumeId) {
    await assertIsolatedSession(WORKTREES_DIR, resumeId, REPO_KEYS);
    log(`resuming ${resumeId}`);
    seedMcpApproval(sessionDir(WORKTREES_DIR, resumeId));
    emit('CD_AND_LAUNCH', sessionDir(WORKTREES_DIR, resumeId), '', launcher);
    return;
  }

  // Fresh: allocate a sortable WS id (+ slug from the prompt) and branch every repo
  // onto gw/<id> inside its own worktree set, so several sessions run side by side.
  const prompt = await readPrompt();
  if (prompt === null) { log('cancelled — no session started.'); emit('NONE'); return; }
  if (prompt) log('naming session ...');
  const id = await allocateId(await smartSlug(prompt, { namer: WS.namer }));
  await ensureSession(WORKTREES_DIR, id, `gw/${id}`, REPO_KEYS);
  await assertIsolatedSession(WORKTREES_DIR, id, REPO_KEYS);
  log(`started ${id} (gw/${id}) across ${REPO_KEYS.join(', ')}`);
  seedMcpApproval(sessionDir(WORKTREES_DIR, id));
  emit('CD_AND_LAUNCH', sessionDir(WORKTREES_DIR, id), prompt ? b64(prompt) : '', launcher);
}

// Resolve which session a `done`/`abort` acts on: an explicit positional WS-id wins,
// else infer from cwd (the agent runs inside the session dir). null = can't tell.
function resolveSession(flags: Flags): string | null {
  if (flags.session) { const id = parseId(flags.session); if (id) return listSessions(WORKTREES_DIR).find(s => parseId(s) === id) ?? flags.session; }
  return resolveSessionFromCwd(WORKTREES_DIR, process.cwd());
}

// ── done (shared by `gw done` and the /done slash command) ───────────────────

interface Pending { repo: RepoKey; wt: string; branch: string; name: string; }

async function cmdDone(flags: Flags): Promise<void> {
  const session = resolveSession(flags);
  if (!session) die('no gw session: run /done from inside a session worktree, or pass the WS id (gw done WS-NNNNN).');
  const branch = `gw/${session}`;

  // Reap any ephemeral land worktrees a crashed `gw done` left behind, in every repo.
  for (const repo of REPO_KEYS) await sweepLandTmp(REPOS[repo].dir);

  // 1. For THIS session's repos: stage + commit pending edits, keep the ones ahead
  // of origin/<base> — those are what we'll land.
  const pending: Pending[] = [];
  for (const repo of REPO_KEYS) {
    const wt = sessionRepoDir(WORKTREES_DIR, session, repo);
    if (!fs.existsSync(path.join(wt, '.git'))) continue;
    if (!(await isSessionWorktree(wt, REPOS[repo].dir, branch))) {
      log(`[${repo}] skipped: ${wt} is not an isolated '${branch}' worktree — refusing to stage/commit there.`);
      continue;
    }
    await git(wt, ['add', '-A']);
    // A worktree-linked dep/env path must NEVER appear in a commit — neither added
    // NOR deleted. Reset the index entry back to HEAD: for a path that is tracked in
    // the base this restores it (commit records no change); for an untracked path it
    // simply unstages. NEVER `git rm --cached` here — for a TRACKED linkPath that
    // stages a DELETION that then lands on the base branch (this is how a tracked
    // `.env` got wiped from origin/main). Self-healing + loud, since a tracked
    // linkPath is a repo-hygiene bug the user should fix.
    for (const rel of await stagedLinkPaths(wt, repo)) {
      await git(wt, ['reset', '-q', 'HEAD', '--', rel]);
      log(`[${repo}] linked path '${rel}' is TRACKED in ${repo} — left untouched (NOT committed/deleted). Fix: add it to ${repo}/.gitignore and \`git rm --cached ${rel}\` in a deliberate commit so gw can symlink it cleanly.`);
    }
    if ((await git(wt, ['diff', '--cached', '--quiet'])).code !== 0) await git(wt, ['commit', '-m', `wip: ${session}`]);
    if (parseInt(await gitOut(wt, ['rev-list', '--count', `origin/${REPOS[repo].base}..HEAD`]) || '0', 10) > 0) {
      pending.push({ repo, wt, branch, name: session });
    }
  }
  // Safety net for the "edited the wrong copy" mistake: a repo whose CANONICAL
  // checkout has uncommitted edits while THIS session's worktree has none. gw lands
  // only the worktree, so those edits would be silently left behind. Warn loudly —
  // non-fatal (the canonical tree may hold unrelated work), just surface it.
  for (const repo of REPO_KEYS) {
    if (pending.some((p) => p.repo === repo)) continue;
    const dirty = (await gitOut(REPOS[repo].dir, ['status', '--porcelain'])).trim();
    if (dirty) {
      log(`[${repo}] WARNING: uncommitted changes in the CANONICAL checkout (${REPOS[repo].dir}) but nothing in this session's worktree — did you edit the wrong copy? gw will NOT land these.`);
    }
  }

  if (!pending.length) { log(`nothing to merge in ${session}.`); await removeSession(WORKTREES_DIR, session, REPO_KEYS, branch); return finishCd(flags); }
  log(`${session} changed: ${pending.map((p) => p.repo).join(', ')}`);

  // 2. Gate ALL changed repos first — one red gate stops everything, nothing merged.
  if (!flags.noCheck) {
    for (const p of pending) {
      const gate = REPOS[p.repo].gate;
      if (!gate) continue;
      log(`[${p.repo}] gate: ${gate.join(' ')} ...`);
      const g = await run(gate[0], gate.slice(1), { cwd: p.wt, timeoutMs: 12 * 60_000, onStdout: (s) => process.stderr.write(s) });
      if (g.code !== 0) die(`[${p.repo}] gate failed (exit ${g.code}). Fix and re-run, or skip with --no-check. Nothing was merged.`);
      log(`[${p.repo}] gate passed.`);
    }

    // Optional session-level gate: catches cross-repo drift a per-repo gate misses
    // (e.g. a generated-doc `--check`). Runs from the configured repo's worktree only
    // when that repo itself was NOT changed (its own gate already covers it).
    const sg = WS.sessionGate;
    if (sg && !pending.some((p) => p.repo === sg.repo)) {
      const wt = sessionRepoDir(WORKTREES_DIR, session, sg.repo);
      if (fs.existsSync(wt)) {
        for (const cmd of sg.commands) {
          log(`[${sg.repo}] session gate: ${cmd.join(' ')} ...`);
          const d = await run(cmd[0], cmd.slice(1), { cwd: wt, timeoutMs: 5 * 60_000, onStdout: (s) => process.stderr.write(s) });
          if (d.code !== 0) die(`session gate failed (${cmd.join(' ')}). Fix, commit any regenerated files, then re-run gw done. Nothing was merged.`);
        }
        log(`[${sg.repo}] session gate passed.`);
      }
    }
  }

  if (flags.dryRun) {
    for (const p of pending) log(`[dry-run] would ${flags.pr ? 'open a PR for' : `squash-merge ${p.branch} -> ${REPOS[p.repo].base} in`} ${p.repo}`);
    return finishCd(flags);
  }

  // 3. Land each changed repo independently (separate git repos can't be atomic);
  // report per repo. Only tear the session down if EVERY repo landed.
  const landed: string[] = [], failed: string[] = [];
  for (const p of pending) {
    const r = await landRepo(p, flags);
    (r.ok ? landed : failed).push(r.ok ? p.repo : `${p.repo}: ${r.reason}`);
  }
  if (!failed.length) await removeSession(WORKTREES_DIR, session, REPO_KEYS, branch);
  if (landed.length) log(flags.pr ? `PR opened: ${landed.join(', ')}` : `merged + pushed: ${landed.join(', ')}`);
  if (failed.length) die(`did NOT land:\n  ${failed.join('\n  ')}\n(any repos listed above as landed are already done; ${session} kept for the rest.)`);
  return finishCd(flags);
}

// Land ONE repo: build a squash commit in a disposable worktree off origin/<base> and
// push it (default), or push a namespaced branch + open a PR (--pr). On any failure
// the session is left intact and the reason is returned.
async function landRepo(p: Pending, flags: Flags): Promise<{ ok: boolean; reason?: string }> {
  const mainDir = REPOS[p.repo].dir;
  const base = REPOS[p.repo].base;
  let msg = flags.message;
  if (!msg) {
    const subj = (await gitOut(p.wt, ['log', `origin/${base}..HEAD`, '--format=%s', '--reverse'])).split('\n')[0] || '';
    msg = subj && !subj.startsWith('wip:') ? subj : p.name;
  }

  if (flags.pr) {
    const remote = `gw/${await ghHandle(mainDir)}/${p.name}`;
    if ((await git(p.wt, ['push', '-f', 'origin', `HEAD:refs/heads/${remote}`])).code !== 0) return { ok: false, reason: `push to origin/${remote} failed` };
    if (!REPOS[p.repo].slug) return { ok: false, reason: `no "slug" configured for ${p.repo} — needed to open a PR (add it to ${CONFIG_NAME})` };
    const pr = await run('gh', ['pr', 'create', '--repo', REPOS[p.repo].slug, '--head', remote, '--base', base, '--title', msg, '--body', `Opened by \`gw\`. Gate: ${flags.noCheck ? 'skipped' : 'passed'}.`], { cwd: mainDir });
    process.stdout.write(pr.stdout); if (pr.stderr) process.stderr.write(pr.stderr);
    return pr.code === 0 ? { ok: true } : { ok: false, reason: 'gh pr create failed' };
  }

  // Land via a DISPOSABLE detached worktree built from origin/<base>, so the shared
  // canonical checkout is NEVER the merge surface: its working-tree state can't block
  // a land, and a failed land strands nothing — the temp tree is always removed.
  const tmp = landTmpDir(mainDir, p.name);
  try {
    await git(mainDir, ['fetch', 'origin', base]);
    fs.mkdirSync(landTmpRoot(mainDir), { recursive: true });
    const add = await git(mainDir, ['worktree', 'add', '--detach', tmp, `origin/${base}`]);
    if (add.code !== 0) return { ok: false, reason: `could not stage land worktree: ${add.stderr.trim().split('\n').pop()}` };

    const sq = await git(tmp, ['merge', '--squash', p.branch]);
    if (sq.code !== 0) return { ok: false, reason: `squash conflict — rebase the worktree: cd ${p.wt}; git fetch origin ${base}; git rebase origin/${base}` };

    // Empty squash = branch already on <base> / no net change. Nothing to land — success.
    if (!(await gitOut(tmp, ['status', '--porcelain']))) { log(`[${p.repo}] already up to date with origin/${base} — nothing to land.`); return { ok: true }; }

    if ((await git(tmp, ['commit', '-m', msg])).code !== 0) return { ok: false, reason: 'commit failed after squash (tree had changes — unexpected)' };

    return await withRepoLandLock(mainDir, async () => {
      const pushed = await pushWithRetry(tmp, flags, base);
      if (!pushed.ok) return { ok: false, reason: pushed.reason };
      await fastForwardCanonical(mainDir, base); // keep the shared checkout current; best-effort
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    await git(mainDir, ['worktree', 'remove', '--force', tmp]);
    await git(mainDir, ['worktree', 'prune']);
  }
}

// Push the temp tree's squash commit to origin/<base>. On reject (origin advanced
// between fetch and push) fetch + rebase once + retry. Never loop.
// --simulate-push-reject forces the first attempt to fail.
async function pushWithRetry(tmp: string, flags: Flags, base: string): Promise<{ ok: boolean; reason?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(attempt === 0 && flags.simulatePushReject)) {
      if ((await git(tmp, ['push', 'origin', `HEAD:${base}`])).code === 0) return { ok: true };
    }
    if (attempt === 1) return { ok: false, reason: `push to origin/${base} rejected twice — rerun gw done.` };
    await git(tmp, ['fetch', 'origin', base]);
    if ((await git(tmp, ['rebase', `origin/${base}`])).code !== 0) { await git(tmp, ['rebase', '--abort']); return { ok: false, reason: `${base} moved under us and the rebase conflicted — rerun gw done.` }; }
  }
  return { ok: false, reason: 'push failed.' };
}

// After a successful land, advance the shared canonical checkout's local <base> to
// origin/<base> so `gw start` and humans browsing it see fresh code. Best-effort:
// `--ff-only` can never clobber uncommitted work, and the whole thing is swallowed so
// it can never fail a land.
async function fastForwardCanonical(mainDir: string, base: string): Promise<void> {
  try {
    if (await gitOut(mainDir, ['status', '--porcelain'])) return;
    if ((await gitOut(mainDir, ['symbolic-ref', '--short', 'HEAD'])) !== base) return;
    await git(mainDir, ['fetch', 'origin', base]);
    await git(mainDir, ['merge', '--ff-only', `origin/${base}`]);
  } catch { /* best-effort; never block a land */ }
}

// After done/abort, cd the shell back to the workspace root — unless we're inside the
// agent (--in-claude), where there's nothing to cd.
function finishCd(flags: Flags): void { if (!flags.inClaude) emit('CD', REPO_ROOT); else emit('NONE'); }

// ── abort ────────────────────────────────────────────────────────────────────

async function cmdAbort(flags: Flags): Promise<void> {
  const session = resolveSession(flags);
  if (!session) { log('no gw session here — run from inside a session, or pass the WS id (gw abort WS-NNNNN).'); return finishCd(flags); }
  if (!flags.yes && !flags.inClaude && !(await confirm(`discard session ${session} (all repos)? [y/N] `))) { log('kept.'); return; }
  await removeSession(WORKTREES_DIR, session, REPO_KEYS, `gw/${session}`);
  log(`discarded ${session}`);
  return finishCd(flags);
}

// ── setup ────────────────────────────────────────────────────────────────────

function tsxCmd(): string {
  const tsxBin = path.join(GW_HOME, 'node_modules', '.bin', 'tsx');
  return fs.existsSync(tsxBin) ? `"${tsxBin}"` : 'npx --yes tsx';
}

async function cmdSetup(): Promise<void> {
  const srcDir = path.join(GW_HOME, 'commands');
  const dstDir = path.join(os.homedir(), '.claude', 'commands');
  fs.mkdirSync(dstDir, { recursive: true });
  // Bake absolute paths into the installed slash commands so /done works from ANY
  // repo's worktree (which has no gw checkout of its own — it must call gw by path).
  const gwTs = fileURLToPath(import.meta.url);
  for (const f of ['done.md', 'abort.md', 'donedone.md']) {
    const src = path.join(srcDir, f);
    if (!fs.existsSync(src)) { log(`MISSING command source ${src}`); continue; }
    const body = fs.readFileSync(src, 'utf-8').replaceAll('__GW_ROOT__', REPO_ROOT).replaceAll('__GW_TS__', gwTs).replaceAll('__GW_TSX__', tsxCmd());
    fs.writeFileSync(path.join(dstDir, f), body);
    log(`installed /${f.replace('.md', '')} -> ~/.claude/commands/${f}`);
  }
  for (const k of REPO_KEYS) log(`${fs.existsSync(path.join(REPOS[k].dir, '.git')) ? 'ok' : '!!'}  ${k} repo at ${REPOS[k].dir}`);
  for (const bin of ['git', 'gh', 'claude', 'node']) log(`${(await run('bash', ['-lc', `command -v ${bin}`])).code === 0 ? 'ok' : '!!'}  ${bin}`);
  log(`add to your shell rc:  source ${path.join(GW_HOME, 'gw.sh')}`);
}

async function ghHandle(dir: string): Promise<string> {
  const email = await gitOut(dir, ['config', 'user.email']);
  if (email.includes('@')) return slugify(email.split('@')[0]) || 'dev';
  return slugify(await gitOut(dir, ['config', 'user.name'])) || 'dev';
}

// ── status: one glance at every repo + worktree ──────────────────────────────

interface WtStatus { dir: string; branch: string; uncommitted: number; untracked: number; ahead: number; behind: number; hasUpstream: boolean; }

async function worktreeStatus(wt: string): Promise<WtStatus> {
  const porcelain = (await gitOut(wt, ['status', '--porcelain'])).split('\n').filter(Boolean);
  const untracked = porcelain.filter(l => l.startsWith('??')).length;
  const head = await gitOut(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const hasUpstream = (await git(wt, ['rev-parse', '--abbrev-ref', '@{u}'])).code === 0;
  let ahead = 0, behind = 0;
  if (hasUpstream) {
    const [b, a] = (await gitOut(wt, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])).split(/\s+/).map(Number);
    behind = b || 0; ahead = a || 0;
  }
  return { dir: wt, branch: head === 'HEAD' ? '(detached)' : head, uncommitted: porcelain.length - untracked, untracked, ahead, behind, hasUpstream };
}

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length);

async function cmdStatus(): Promise<void> {
  const sessions = listSessions(WORKTREES_DIR);
  if (!sessions.length) { console.log('\nNo active gw sessions. `gw start` to begin one.'); emit('NONE'); return; }
  let dirty = 0;
  for (const session of sessions) {
    console.log(`\n${session}`);
    for (const repo of REPO_KEYS) {
      const wt = sessionRepoDir(WORKTREES_DIR, session, repo);
      if (!fs.existsSync(path.join(wt, '.git'))) continue;
      const s = await worktreeStatus(wt);
      if (s.uncommitted || s.ahead) dirty++;
      const notes: string[] = [];
      if (s.uncommitted) notes.push(`${s.uncommitted} uncommitted`);
      if (s.untracked) notes.push(`${s.untracked} untracked`);
      if (s.ahead) notes.push(`${s.ahead} unpushed`);
      console.log(`  ${s.uncommitted === 0 && s.ahead === 0 ? 'ok ' : '!! '}${pad(repo, 12)} ${pad(s.branch, 26)} ${notes.join(', ') || 'clean'}`);
    }
  }
  console.log(dirty === 0
    ? '\nAll sessions clean (committed or empty). (untracked-only entries are fine.)'
    : `\n${dirty} worktree(s) have uncommitted or unpushed work — see the !! lines above.`);
  emit('NONE');
}

// ── ready: the "done-done" check ─────────────────────────────────────────────

/** Most recent moment anything happened on a session's branch, as a unix timestamp
 *  (seconds) — the max across its repo worktrees. Returns null if no repo has a
 *  readable reflog. The session branch tip COMMIT date is the wrong signal (an
 *  unchanged session points at the base commit, which can predate the session). */
async function sessionLastActivity(session: string): Promise<number | null> {
  let newest: number | null = null;
  for (const repo of REPO_KEYS) {
    const wt = sessionRepoDir(WORKTREES_DIR, session, repo);
    if (!fs.existsSync(path.join(wt, '.git'))) continue;
    const reflog = await gitOut(wt, ['reflog', 'show', '--date=unix', `gw/${session}`]);
    const m = reflog.split('\n').find(Boolean)?.match(/@\{(\d+)\}/);
    if (m) { const ts = parseInt(m[1], 10); if (newest === null || ts > newest) newest = ts; }
  }
  return newest;
}

/** Per-session unlanded summary: untracked counts here (unlike `status`) because a
 *  /done would `git add -A` them. Returns the notes per repo (empty = nothing to land). */
async function sessionUnlanded(session: string): Promise<string[]> {
  const unlanded: string[] = [];
  for (const repo of REPO_KEYS) {
    const wt = sessionRepoDir(WORKTREES_DIR, session, repo);
    if (!fs.existsSync(path.join(wt, '.git'))) continue;
    const s = await worktreeStatus(wt);
    const ahead = parseInt(await gitOut(wt, ['rev-list', '--count', `origin/${REPOS[repo].base}..HEAD`]) || '0', 10);
    const notes: string[] = [];
    if (s.uncommitted) notes.push(`${s.uncommitted} uncommitted`);
    if (s.untracked) notes.push(`${s.untracked} untracked`);
    if (ahead) notes.push(`${ahead} unlanded commit(s)`);
    if (notes.length) unlanded.push(`${repo}: ${notes.join(', ')}`);
  }
  return unlanded;
}

async function cmdReady(): Promise<void> {
  const problems: string[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  const sessions = listSessions(WORKTREES_DIR);
  for (const session of sessions) {
    const unlanded = await sessionUnlanded(session);
    const age = lastActiveLabel(await sessionLastActivity(session), nowSec);
    if (unlanded.length) {
      console.log(`!! ${session} — ${unlanded.join('; ')}${age}`);
      problems.push(`${session} has unlanded work — finish it (gw start ${session}, then /done) or discard it (gw abort ${session}).`);
    } else {
      console.log(`ok ${session} — open but unchanged${age}; idle, not blocking — gw abort ${session} (or gw prune) to tidy up`);
    }
  }
  if (!sessions.length) console.log('ok no open gw sessions');

  // Canonical checkouts: fetch, fast-forward where safe, then require each to sit
  // exactly on origin/<base> with no uncommitted tracked changes.
  for (const repo of REPO_KEYS) {
    const dir = REPOS[repo].dir, base = REPOS[repo].base;
    await git(dir, ['fetch', 'origin', base]);
    const branch = (await gitOut(dir, ['symbolic-ref', '--short', 'HEAD'])) || '(detached)';
    const porcelain = (await gitOut(dir, ['status', '--porcelain'])).split('\n').filter(Boolean);
    const untracked = porcelain.filter((l) => l.startsWith('??')).length;
    const modified = porcelain.length - untracked;
    let [behind, ahead] = (await gitOut(dir, ['rev-list', '--left-right', '--count', `origin/${base}...HEAD`])).split(/\s+/).map(Number);
    behind = behind || 0; ahead = ahead || 0;

    let ffNote = '';
    if (branch === base && behind > 0 && ahead === 0) {
      if ((await git(dir, ['merge', '--ff-only', `origin/${base}`])).code === 0) { ffNote = `fast-forwarded ${behind} commit(s)`; behind = 0; }
    }

    const notes: string[] = [];
    if (ffNote) notes.push(ffNote);
    if (branch !== base) notes.push(`on '${branch}', not ${base}`);
    if (modified) notes.push(`${modified} uncommitted change(s)`);
    if (ahead) notes.push(`${ahead} local commit(s) not on origin/${base}`);
    if (behind) notes.push(`${behind} commit(s) behind origin/${base}`);
    if (untracked) notes.push(`${untracked} untracked (not blocking)`);
    const blocking = branch !== base || modified > 0 || ahead > 0 || behind > 0;
    console.log(`${blocking ? '!! ' : 'ok '}${pad(repo, 12)} ${notes.join(', ') || `exactly origin/${base}`}`);
    if (blocking) problems.push(`${repo} checkout (${dir}) is not origin/${base} — a deploy from it would not ship what landed.`);
  }

  // Warn dirs: published-but-not-gw-managed checkouts. Warn, never block.
  for (const wd of WS.warnDirs) {
    const dir = path.isAbsolute(wd.dir) ? wd.dir : path.join(REPO_ROOT, wd.dir);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const s = await worktreeStatus(dir);
    const notes: string[] = [];
    if (s.uncommitted) notes.push(`${s.uncommitted} uncommitted`);
    if (s.ahead) notes.push(`${s.ahead} unpushed`);
    if (notes.length) console.log(`.. ${wd.label} — ${notes.join(', ')} (not gw-managed; commit/push it directly — warning only)`);
  }

  if (problems.length) {
    console.log('\nNOT done-done:');
    for (const p of problems) console.log(`  - ${p}`);
    emit('NONE');
    process.exit(1);
  }
  console.log(`\nREADY — nothing unlanded; ${REPO_KEYS.join(', ')} are exactly origin/<base>.`);
  emit('NONE');
}

// ── prune: remove fully-landed, idle sessions ────────────────────────────────

/** "2d" / "12h" / "30m" / "90s" → seconds. Bare number = seconds. NaN-safe → 0. */
function parseDuration(s: string): number {
  if (!s) return 0;
  const m = /^(\d+)\s*([smhd]?)$/i.exec(s.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()] ?? 1);
}

async function cmdPrune(flags: Flags): Promise<void> {
  const minAge = parseDuration(flags.olderThan);
  const nowSec = Math.floor(Date.now() / 1000);
  const sessions = listSessions(WORKTREES_DIR);
  if (!sessions.length) { console.log('No gw sessions.'); emit('NONE'); return; }

  const removable: string[] = [];
  for (const session of sessions) {
    const unlanded = await sessionUnlanded(session);
    const last = await sessionLastActivity(session);
    const age = lastActiveLabel(last, nowSec);
    if (unlanded.length) { console.log(`keep ${session} — has unlanded work: ${unlanded.join('; ')}${age}`); continue; }
    const ageSec = last === null ? Infinity : nowSec - last;
    if (ageSec < minAge) { console.log(`keep ${session} — landed/idle but too recent${age}`); continue; }
    removable.push(session);
    console.log(`${flags.dryRun ? 'would remove' : 'remove'} ${session} — landed/idle${age}`);
  }

  if (!removable.length) { console.log('\nNothing to prune.'); emit('NONE'); return; }
  if (flags.dryRun) { console.log(`\n${removable.length} session(s) would be pruned (dry run).`); emit('NONE'); return; }
  if (!flags.yes && !(await confirm(`\nprune ${removable.length} idle session(s)? [y/N] `))) { console.log('kept.'); emit('NONE'); return; }
  for (const session of removable) { await removeSession(WORKTREES_DIR, session, REPO_KEYS, `gw/${session}`); console.log(`pruned ${session}`); }
  emit('NONE');
}

// ── init: scaffold a workspace ───────────────────────────────────────────────

/** Normalize a git remote URL to "owner/repo". "" if it can't. */
function slugFromRemote(url: string): string {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : '';
}

/** Autodetect a repo's gw config from its checkout. */
async function detectRepo(root: string, dir: string): Promise<RawConfig['repos'][number]> {
  const key = path.basename(dir);
  const slug = slugFromRemote(await gitOut(dir, ['remote', 'get-url', 'origin']));
  // base = origin's default branch, else current branch, else main.
  let base = '';
  const head = await gitOut(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD']); // refs/remotes/origin/main
  if (head) base = head.split('/').pop() || '';
  if (!base) base = (await gitOut(dir, ['symbolic-ref', '--short', 'HEAD'])) || 'main';

  const linkPaths: string[] = [];
  if (fs.existsSync(path.join(dir, 'node_modules'))) linkPaths.push('node_modules');
  if (fs.existsSync(path.join(dir, '.env'))) linkPaths.push('.env');

  // gate: prefer an npm script, else a justfile recipe, else none.
  let gate: string[] | null = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    const scripts = pkg.scripts ?? {};
    const pick = ['test:fast', 'test:smoke', 'test:ci', 'test'].find((s) => scripts[s]);
    if (pick) gate = ['npm', 'run', pick];
  } catch { /* no package.json */ }
  if (!gate && fs.existsSync(path.join(dir, 'justfile'))) {
    const jf = fs.readFileSync(path.join(dir, 'justfile'), 'utf-8');
    const recipe = ['test-fast', 'test'].find((r) => new RegExp(`^${r}:`, 'm').test(jf));
    if (recipe) gate = ['just', recipe];
  }

  const out: RawConfig['repos'][number] = { key, dir: path.relative(root, dir) || '.', slug, base, linkPaths };
  if (gate) out.gate = gate;
  return out;
}

async function cmdInit(flags: Flags): Promise<void> {
  const root = process.env.GW_ROOT ? path.resolve(process.env.GW_ROOT) : process.cwd();
  const configPath = path.join(root, CONFIG_NAME);
  if (fs.existsSync(configPath) && !flags.force) die(`${configPath} already exists. Edit it, or re-run with --force to regenerate.`);

  // Clone any repos named with --repo owner/name (skips ones already present).
  for (const spec of flags.repoFlags) {
    const name = spec.split('/').pop() || spec;
    const dest = path.join(root, name);
    if (fs.existsSync(dest)) { log(`${name} already present — skipping clone`); continue; }
    log(`cloning ${spec} -> ${name} ...`);
    const c = await run('gh', ['repo', 'clone', spec, dest], { onStdout: (s) => process.stderr.write(s) });
    if (c.code !== 0) die(`clone failed for ${spec}: ${c.stderr.trim().split('\n').pop()}`);
  }

  // Discover sibling git checkouts directly under root (skip the worktrees dir).
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '.worktrees' && !e.name.startsWith('.'))
    .filter((e) => fs.existsSync(path.join(root, e.name, '.git')))
    .map((e) => path.join(root, e.name))
    .sort();
  if (!entries.length) die(`no git repos found under ${root}. Clone them here first (or pass --repo owner/name), then re-run gw init.`);

  const repos = [];
  for (const dir of entries) { const r = await detectRepo(root, dir); repos.push(r); log(`detected ${r.key} (${r.slug || 'no remote'}, base ${r.base}, gate ${r.gate ? r.gate.join(' ') : 'none'})`); }

  const config: RawConfig = {
    base: 'main',
    launcher: DEFAULT_LAUNCHER,
    namer: DEFAULT_NAMER,
    brandColor: DEFAULT_BRAND,
    repos,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  log(`wrote ${configPath}`);

  // Bind the fresh config and install slash commands.
  bind(loadWorkspace(root));
  await cmdSetup();

  log('');
  log('next:');
  log(`  1. review ${CONFIG_NAME} (gates are best-guesses — fix any that are wrong)`);
  log(`  2. add to your shell rc:  source ${path.join(GW_HOME, 'gw.sh')}`);
  log(`  3. open a new shell, then run \`gw start\` from ${root}`);
}

// ── flags + dispatch ─────────────────────────────────────────────────────────

interface Flags {
  dryRun: boolean; noCheck: boolean; pr: boolean; inClaude: boolean; yes: boolean;
  echoPrompt: boolean; simulatePushReject: boolean; force: boolean;
  message: string; session: string; olderThan: string; repoFlags: string[];
}
function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    dryRun: false, noCheck: false, pr: false, inClaude: false, yes: false,
    echoPrompt: false, simulatePushReject: false, force: false,
    message: '', session: '', olderThan: '', repoFlags: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') f.dryRun = true;
    else if (a === '--no-check') f.noCheck = true;
    else if (a === '--pr') f.pr = true;
    else if (a === '--in-claude') f.inClaude = true;
    else if (a === '--yes' || a === '-y') f.yes = true;
    else if (a === '--force') f.force = true;
    else if (a === '--echo-prompt') f.echoPrompt = true;
    else if (a === '--simulate-push-reject') f.simulatePushReject = true;
    else if (a === '--older-than') f.olderThan = argv[++i] ?? '';
    else if (a === '--repo') f.repoFlags.push(argv[++i] ?? '');
    else if (a === '-m' || a === '--message') f.message = argv[++i] ?? '';
    else if (!a.startsWith('-') && !f.session) f.session = a; // positional: WS-id for start(resume)/done/abort
  }
  return f;
}

const HELP = `gw — Grove Workspace

  gw init [--repo owner/name ...] [--force]   scaffold gw.config.json + slash commands
  gw start [WS-id]                            branch every repo, launch the agent
  gw done [--pr] [--no-check] [-m msg]        gate + squash-merge each changed repo
  gw abort [WS-id]                            discard a session's work
  gw status                                   cross-repo + worktree status
  gw ready                                    done-done check (safe to deploy?)
  gw prune [--older-than 2d] [--dry-run]      remove landed, idle sessions
  gw setup                                    (re)install slash commands

Config: ${CONFIG_NAME} at the workspace root (GW_ROOT overrides discovery).`;

const [, , sub, ...rest] = process.argv;
const flags = parseFlags(rest);
(async () => {
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') { console.log(HELP); return; }
  if (sub === 'init') return cmdInit(flags);

  bind(loadWorkspace());
  switch (sub) {
    case 'start': return cmdStart(flags);
    case 'done': return cmdDone(flags);
    case 'abort': return cmdAbort(flags);
    case 'status': return cmdStatus();
    case 'ready': return cmdReady();
    case 'prune': return cmdPrune(flags);
    case 'setup': return cmdSetup();
    default: die(`unknown subcommand "${sub}". use: init | start | done | abort | status | ready | prune | setup`);
  }
})().catch((e) => die(e instanceof Error ? e.message : String(e)));
