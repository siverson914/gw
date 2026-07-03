/**
 * gw — Grove Workspace: parallel, isolated agent work-sessions across many git repos,
 * with a safe one-shot land and a deploy-readiness check.
 *
 * Subcommands, all driven by the `gw()` shell function in gw.sh (which does the
 * things a child process can't: cd the shell and launch the interactive agent). This
 * script does ALL the git/gh/gate work and writes ONE directive line to the file
 * named by $GW_OUT for the shell to act on.
 *
 *   gw install          wire the `gw` shell function into your rc (~/.bashrc or
 *                       ~/.zshrc), idempotently — the one first-run step a child
 *                       process can't do for you. Run once as `npm run gw install`.
 *   gw doctor           preflight: git/gh/node/tsx/claude + whether the shell is
 *                       wired up + whether you're in a workspace. Run this first.
 *   gw init             scaffold a workspace: detect sibling repos (or clone the
 *                       ones named with --repo), write gw.config.json, install the
 *                       /done, /abort, /donedone slash commands.
 *   gw start [prompt]   put EVERY repo on a fresh `gw/<name>` branch off origin/<base>,
 *                       then the shell cd's into <root>/.worktrees/<id> and launches
 *                       the configured agent — so every repo sits side-by-side and you
 *                       edit any of them in one session. Resuming (an explicit session-id, or
 *                       a bare `gw start` from inside a session worktree) re-enters that
 *                       session and CONTINUES the prior agent conversation by default
 *                       (--no-continue for a clean one; --new forces a brand-new session).
 *   gw done   [--pr]    for EVERY repo you actually changed: merge origin/<base> in
 *                       (so the gate sees the integrated result, not the stale branch;
 *                       --no-sync opts out) -> gate -> squash-merge to <base> + push
 *                       (default), or push a branch + open a PR (--pr). Untouched repos
 *                       are skipped. All gates run before any merge, so one red gate
 *                       lands nothing. Only one gate runs at a time per workspace (a
 *                       lock serializes concurrent `gw done`s so their suites don't
 *                       starve shared test resources); --no-lock opts out.
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
  assertIsolatedSession, isSessionWorktree, type RepoKey, type RunResult,
  sessionDir, sessionRepoDir, withRepoLandLock, withGateLock, stagedLinkPaths,
  landTmpRoot, landTmpDir, sweepLandTmp, activityLabel,
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

// Prepend a short preamble to the seed prompt so the agent treats the session name as a
// LABEL, not a task. The worktree/tab name (`id`, e.g. WT-007-cli-parser-flags) is derived
// FROM the prompt and shown in the agent's terminal tab; without this framing, agents
// sometimes read the name (say "fix-login-bug") as an instruction ("fix it") and skip the
// scoping in the real message (which might be "investigate, only fix if it's a real bug").
// The user's text rides verbatim below a fence so it's unmistakably THE task. Only used when
// there's a seed prompt — a plain (promptless) session is launched without any wrapper.
function wrapPrompt(id: string, prompt: string): string {
  return [
    `You're in an isolated git worktree for one of several parallel sessions, labeled "${id}".`,
    'That label is only a short tag to tell sessions apart at a glance. It was auto-generated',
    "from the task and is NOT an instruction — it may be vague, narrow, or wrong, so don't act",
    'on it. Your task is exactly the message below the line: follow its wording and scope (if it',
    "says investigate, investigate — don't assume a fix is wanted unless it asks for one).",
    '',
    '─── task ───',
    prompt,
  ].join('\n');
}

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

  // Resume target: an explicit session-id positional, else (unless --new) the session whose
  // worktree we're standing in — so `gw start` from inside a session re-enters it rather
  // than forking a new one. An unmatched explicit id falls through to a fresh start.
  let resumeId: string | null = null;
  const want = flags.session ? parseId(flags.session) : null;
  if (want) resumeId = listSessions(WORKTREES_DIR).find(s => parseId(s) === want) ?? null;
  else if (!flags.new) resumeId = resolveSessionFromCwd(WORKTREES_DIR, process.cwd());

  if (resumeId) {
    await assertIsolatedSession(WORKTREES_DIR, resumeId, REPO_KEYS);
    log(`resuming ${resumeId}`);
    seedMcpApproval(sessionDir(WORKTREES_DIR, resumeId));
    // Continue the prior agent conversation in this worktree by default — the launcher's
    // resumeArgs (claude `--continue`, which harmlessly starts fresh when there's nothing
    // to continue) ride along. --no-continue launches a clean conversation instead.
    const argv = flags.noContinue ? WS.launcher : [...WS.launcher, ...WS.resumeArgs];
    emit('CD_AND_LAUNCH', sessionDir(WORKTREES_DIR, resumeId), '', b64(argv.join(' ')));
    return;
  }

  // Fresh: allocate a sortable WS id (+ slug from the prompt) and branch every repo
  // onto gw/<id> inside its own worktree set, so several sessions run side by side.
  const prompt = await readPrompt();
  if (prompt === null) { log('cancelled — no session started.'); emit('NONE'); return; }
  if (prompt) log('naming session ...');
  // The namer's one Haiku call also infers a model when the prompt explicitly names
  // one (opus/sonnet/haiku/fable) — thread it into the launcher as `--model <x>`.
  // Absent → launch on the default model.
  const { slug, model } = await smartSlug(prompt, { namer: WS.namer });
  const id = await allocateId(slug);
  await ensureSession(WORKTREES_DIR, id, `gw/${id}`, REPO_KEYS);
  await assertIsolatedSession(WORKTREES_DIR, id, REPO_KEYS);
  log(`started ${id} (gw/${id}) across ${REPO_KEYS.join(', ')}${model ? ` on ${model}` : ''}`);
  seedMcpApproval(sessionDir(WORKTREES_DIR, id));
  const launcher = model ? [...WS.launcher, '--model', model] : WS.launcher;
  emit('CD_AND_LAUNCH', sessionDir(WORKTREES_DIR, id), prompt ? b64(wrapPrompt(id, prompt)) : '', b64(launcher.join(' ')));
}

// Resolve which session a `done`/`abort` acts on: an explicit positional session-id wins,
// else infer from cwd (the agent runs inside the session dir). null = can't tell.
function resolveSession(flags: Flags): string | null {
  if (flags.session) { const id = parseId(flags.session); if (id) return listSessions(WORKTREES_DIR).find(s => parseId(s) === id) ?? flags.session; }
  return resolveSessionFromCwd(WORKTREES_DIR, process.cwd());
}

// ── done (shared by `gw done` and the /done slash command) ───────────────────

interface Pending { repo: RepoKey; wt: string; branch: string; name: string; }

// Gate timeout: 12 min default. GW_GATE_TIMEOUT_MS overrides — primarily so the test
// harness can exercise the timeout path in milliseconds instead of minutes.
function gateTimeoutMs(): number {
  const v = parseInt(process.env.GW_GATE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 12 * 60_000;
}
/** "90000" → "1.5m", "2000" → "2s" — for timeout messages. */
function fmtMs(ms: number): string {
  return ms >= 60_000 ? `${+(ms / 60_000).toFixed(1)}m` : `${+(ms / 1000).toFixed(1)}s`;
}

async function cmdDone(flags: Flags): Promise<void> {
  const session = resolveSession(flags);
  if (!session) die('no gw session: run /done from inside a session worktree, or pass the session id (gw done WT-NNN).');
  const branch = `gw/${session}`;

  // `--show`: read-only preview of what would land, per repo, so the /done skill can
  // compose a real commit message. Nothing is staged permanently, gated, or merged.
  if (flags.show) return showSessionDiff(session, branch);

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
    // the base this restores it (commit records no change — this covers the staged
    // DELETION that once wiped a tracked `.env` from origin/main); for an untracked
    // path it simply unstages. NEVER `git rm --cached` here — that STAGES the very
    // deletion we're guarding against. Self-healing + loud, since a tracked linkPath
    // is a repo-hygiene bug the user should fix.
    for (const { rel, trackedInHead } of await stagedLinkPaths(wt, repo)) {
      await git(wt, ['reset', '-q', 'HEAD', '--', rel]);
      if (trackedInHead) log(`[${repo}] linked path '${rel}' is TRACKED in ${repo} — staged change dropped (NOT committed or deleted). Fix: add it to ${repo}/.gitignore and \`git rm --cached ${rel}\` in a deliberate commit so gw can symlink it cleanly.`);
      else log(`[${repo}] linked path '${rel}' was staged — unstaged (linked deps/env never land).`);
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

  // 2. Bring origin/<base> INTO each changed worktree before gating, so the gate (and
  // the land) act on the integrated result, not the stale branch in isolation. This is
  // the guardrail that makes staleness deterministic instead of something an agent has
  // to happen to notice. Default on; --no-sync opts out.
  if (!flags.noSync) await syncPending(pending);

  // 3. Gate ALL changed repos first — one red gate stops everything, nothing merged.
  // The whole gate phase runs under a workspace-wide lock (unless --no-lock) so only
  // one `gw done` exercises the shared test resources (DB/Redis/sandbox) at a time;
  // concurrent suites used to starve each other into OOM-kills ("gate failed (exit
  // null)"). Landing is NOT locked — it's seconds and already concurrency-safe.
  if (!flags.noCheck) {
    const runGates = async () => {
      for (const p of pending) {
        const base = REPOS[p.repo].base;
        // Run the repo's lighter, diff-scoped gate when --quick is passed OR the repo
        // opts in via gateQuickDefault (safe only where something downstream re-runs the
        // full suite — e.g. a deploy gate). --full forces the complete gate regardless.
        // Missing gateQuick safely falls back to the full gate, so quick is never LESS
        // safe than a plain done — at worst it's identical.
        const useQuick = (flags.quick || REPOS[p.repo].gateQuickDefault) && !flags.full;
        const scoped = useQuick ? REPOS[p.repo].gateQuick : null;
        const gate = scoped ?? REPOS[p.repo].gate;
        if (!gate) continue;
        if (useQuick && !scoped) log(`[${p.repo}] no gateQuick configured — running the full gate.`);
        // Hand every gate the base ref and the files this branch changed vs it (via env),
        // so a diff-scoped gate can run only the affected tests. Harmless to a gate that
        // ignores them. `origin/<base>...HEAD` is the branch's own changes (origin/<base>
        // was already merged into the worktree above, so this is the net diff to land).
        const changed = await gitOut(p.wt, ['diff', '--name-only', `origin/${base}...HEAD`]);
        const gateEnv = { GW_BASE: `origin/${base}`, GW_CHANGED_FILES: changed.split('\n').filter(Boolean).join('\n') };
        const label = scoped ? 'quick gate' : 'gate';
        log(`[${p.repo}] ${label}: ${gate.join(' ')} ...`);
        const g = await run(gate[0], gate.slice(1), { cwd: p.wt, timeoutMs: gateTimeoutMs(), env: gateEnv, onStdout: (s) => process.stderr.write(s) });
        // A timeout SIGKILLs the process tree and surfaces as `code: null` — say so
        // explicitly instead of the cryptic "gate failed (exit null)" (which historically
        // meant an OOM-killed or hung suite and sent people down the wrong path).
        if (g.timedOut) die(`[${p.repo}] ${label} TIMED OUT after ${fmtMs(gateTimeoutMs())} and was killed. A hung suite or starved test resource, not a test failure. Re-run, or skip with --no-check. Nothing was merged.`);
        if (g.code !== 0) die(`[${p.repo}] ${label} failed (exit ${g.code}). Fix and re-run, or skip with --no-check. Nothing was merged.`);
        log(`[${p.repo}] ${label} passed.`);
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
            const d = await run(cmd[0], cmd.slice(1), { cwd: wt, timeoutMs: Math.min(gateTimeoutMs(), 5 * 60_000), onStdout: (s) => process.stderr.write(s) });
            if (d.timedOut) die(`session gate TIMED OUT after ${fmtMs(Math.min(gateTimeoutMs(), 5 * 60_000))} and was killed (${cmd.join(' ')}). Re-run gw done. Nothing was merged.`);
            if (d.code !== 0) die(`session gate failed (${cmd.join(' ')}). Fix, commit any regenerated files, then re-run gw done. Nothing was merged.`);
          }
          log(`[${sg.repo}] session gate passed.`);
        }
      }
    };
    if (flags.noLock) await runGates();
    else await withGateLock(path.join(WORKTREES_DIR, 'gw-gate.lock'), runGates,
      { onWait: () => log('another gw gate is running — waiting for it to finish before starting this one (use --no-lock to skip)...') });
  }

  if (flags.dryRun) {
    for (const p of pending) log(`[dry-run] would ${flags.pr ? 'open a PR for' : `squash-merge ${p.branch} -> ${REPOS[p.repo].base} in`} ${p.repo}`);
    return finishCd(flags);
  }

  // 4. Land each changed repo independently (separate git repos can't be atomic);
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

// Read-only: print, per changed repo, the net diff `gw done` would land (committed
// work plus any uncommitted edits, vs origin/<base>) so the /done skill can compose a
// descriptive commit message before re-running with `-m`. Stages nothing permanently,
// gates nothing, lands nothing. stdout = diffs (machine-readable), stderr = notes.
async function showSessionDiff(session: string, branch: string): Promise<void> {
  let any = false;
  for (const repo of REPO_KEYS) {
    const wt = sessionRepoDir(WORKTREES_DIR, session, repo);
    if (!fs.existsSync(path.join(wt, '.git'))) continue;
    if (!(await isSessionWorktree(wt, REPOS[repo].dir, branch))) continue;
    const base = REPOS[repo].base;
    await git(wt, ['fetch', 'origin', base]); // refresh origin/<base> so the diff is current
    // Intent-to-add (-N) makes new untracked files show up in the diff; the mixed reset
    // afterward clears the index entries again, leaving the working tree untouched.
    await git(wt, ['add', '-AN']);
    const stat = await gitOut(wt, ['diff', '--stat', `origin/${base}`]);
    const full = await gitOut(wt, ['diff', `origin/${base}`]);
    await git(wt, ['reset', '-q']);
    if (!stat) continue;
    any = true;
    process.stdout.write(`\n=== ${repo} (base ${base}) ===\n${stat}\n\n${full}\n`);
  }
  if (!any) log(`no changes to land in ${session}.`);
}

// Build the squash message when no -m was passed — i.e. a manual `gw done`, NOT the
// /done skill (which composes a real, descriptive message). Prefer the branch's own
// non-`wip:` commit subjects (subject = first, body = the rest as bullets); if the
// branch is all wip commits, summarize the diff so the message is still scannable
// rather than a bare session id.
async function fallbackMessage(wt: string, base: string, name: string): Promise<string> {
  const subjects = (await gitOut(wt, ['log', `origin/${base}..HEAD`, '--format=%s', '--reverse']))
    .split('\n').map((s) => s.trim()).filter(Boolean);
  // Drop gw's own noise: `wip:` auto-commits AND the sync-merge commit gw creates
  // when it pulls origin/<base> into the worktree before gating (`Merge
  // remote-tracking branch 'origin/main' into gw/…`). Without the merge filter, a
  // branch whose only real commit is a wip auto-commit would land under the
  // meaningless merge subject instead of falling through to the file-list summary.
  const NOISE = /^(wip:|Merge (remote-tracking )?branch )/;
  const meaningful = [...new Set(subjects.filter((s) => !NOISE.test(s)))];
  if (meaningful.length === 1) return meaningful[0];
  if (meaningful.length > 1) return `${meaningful[0]}\n\n${meaningful.slice(1).map((s) => `- ${s}`).join('\n')}`;

  const files = (await gitOut(wt, ['diff', '--name-only', `origin/${base}..HEAD`])).split('\n').filter(Boolean);
  if (!files.length) return name;
  const dirs = [...new Set(files.map((f) => f.split('/')[0]))];
  const where = dirs.length === 1 ? dirs[0] : `${dirs.length} areas`;
  const subject = `update ${files.length} file${files.length === 1 ? '' : 's'} in ${where} (${name})`;
  const shown = files.slice(0, 20).map((f) => `- ${f}`).join('\n');
  return `${subject}\n\n${shown}${files.length > 20 ? `\n- …and ${files.length - 20} more` : ''}`;
}

// Merge origin/<base> into each changed worktree BEFORE the gate runs, so the gate
// validates the code exactly as it will land — not the stale branch on its own. gw
// squash-merges at land time, so the merge commit created here is harmless (it's
// squashed away); its whole value is that staleness is resolved every time, on every
// land, rather than depending on someone noticing the branch is behind. The worktree is
// already clean at this point (pending edits were committed above), so the merge has a
// clean tree to work from. A conflict stops the land early — pointing at the exact
// worktree to fix — which is strictly better than a green gate on code that no longer
// integrates cleanly with <base>.
async function syncPending(pending: Pending[]): Promise<void> {
  for (const p of pending) {
    const base = REPOS[p.repo].base;
    await git(p.wt, ['fetch', 'origin', base]);
    const behind = parseInt(await gitOut(p.wt, ['rev-list', '--count', `HEAD..origin/${base}`]) || '0', 10);
    if (behind === 0) continue;
    log(`[${p.repo}] ${behind} commit(s) behind origin/${base} — merging it in before the gate ...`);
    const m = await git(p.wt, ['merge', '--no-edit', `origin/${base}`]);
    if (m.code !== 0) {
      await git(p.wt, ['merge', '--abort']);
      die(`[${p.repo}] origin/${base} advanced and conflicts with this branch. Resolve it, then re-run gw done:\n  cd ${p.wt}\n  git merge origin/${base}   # fix the conflicts, then commit\nNothing was gated or merged. (Skip this integration with --no-sync — the land still three-way merges, but the gate then runs against the un-integrated branch.)`);
    }
  }
}

// Land ONE repo: build a squash commit in a disposable worktree off origin/<base> and
// push it (default), or push a namespaced branch + open a PR (--pr). On any failure
// the session is left intact and the reason is returned.
async function landRepo(p: Pending, flags: Flags): Promise<{ ok: boolean; reason?: string }> {
  const mainDir = REPOS[p.repo].dir;
  const base = REPOS[p.repo].base;
  const msg = flags.message || await fallbackMessage(p.wt, base, p.name);

  if (flags.pr) {
    const remote = `gw/${await ghHandle(mainDir)}/${p.name}`;
    if ((await git(p.wt, ['push', '-f', 'origin', `HEAD:refs/heads/${remote}`])).code !== 0) return { ok: false, reason: `push to origin/${remote} failed` };
    if (!REPOS[p.repo].slug) return { ok: false, reason: `no "slug" configured for ${p.repo} — needed to open a PR (add it to ${CONFIG_NAME})` };
    // Split the (possibly multi-line) message: first line is the PR title, the rest is
    // the body — otherwise a descriptive body lands verbatim in the PR title.
    const [subject, ...bodyLines] = msg.split('\n');
    const body = bodyLines.join('\n').trim();
    const prBody = `${body ? `${body}\n\n` : ''}Opened by \`gw\`. Gate: ${flags.noCheck ? 'skipped' : 'passed'}.`;
    const pr = await run('gh', ['pr', 'create', '--repo', REPOS[p.repo].slug, '--head', remote, '--base', base, '--title', subject, '--body', prBody], { cwd: mainDir });
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
// A fetch+rebase+retry only helps a NON-FAST-FORWARD (origin/<base> advanced under
// us). Every other push rejection — secret-scanning push protection (GH013), a
// pre-receive hook, permission/SSO denial — fails identically on a rerun, so telling
// the user to "rerun gw done" is actively misleading. Detect the fast-forward case
// narrowly; for anything else, surface git's real stderr so the cause is visible.
function isNonFastForward(out: string): boolean {
  return /fetch first|non-fast-forward|\(fetch first\)|tip of your current branch is behind|Updates were rejected because/i.test(out);
}
function pushErrTail(r: { stdout: string; stderr: string }): string {
  const msg = (r.stderr || r.stdout || '').trim();
  if (!msg) return '';
  // Keep it readable but complete enough to show a GH013 secret-scanning block
  // (which spans many `remote:` lines including the unblock URL).
  return '\n' + msg.split('\n').map((l) => `    ${l}`).join('\n');
}

async function pushWithRetry(tmp: string, flags: Flags, base: string): Promise<{ ok: boolean; reason?: string }> {
  let last: RunResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(attempt === 0 && flags.simulatePushReject)) {
      const r = await git(tmp, ['push', 'origin', `HEAD:${base}`]);
      if (r.code === 0) return { ok: true };
      last = r;
      // Only a non-fast-forward is worth a fetch+rebase+retry. Bail immediately on
      // anything else with the real remote message — a rerun cannot fix it.
      if (!isNonFastForward(`${r.stderr}\n${r.stdout}`)) {
        return { ok: false, reason: `push to origin/${base} was REJECTED (a rerun will NOT fix this — resolve the cause below):${pushErrTail(r)}` };
      }
    }
    if (attempt === 1) return { ok: false, reason: `push to origin/${base} rejected twice — origin/${base} kept advancing under us. Rerun gw done.${last ? pushErrTail(last) : ''}` };
    await git(tmp, ['fetch', 'origin', base]);
    if ((await git(tmp, ['rebase', `origin/${base}`])).code !== 0) { await git(tmp, ['rebase', '--abort']); return { ok: false, reason: `${base} moved under us and the rebase conflicted — rerun gw done.` }; }
  }
  return { ok: false, reason: `push failed.${last ? pushErrTail(last) : ''}` };
}

// After a successful land, advance the shared canonical checkout's local <base> to
// origin/<base> so `gw start` and humans browsing it see fresh code. Best-effort: it
// can never fail or block a land. But when it CAN'T advance, warn loudly instead of
// skipping silently — a canonical checkout left behind origin/<base> ships stale code
// to anything that deploys from it.
async function fastForwardCanonical(mainDir: string, base: string): Promise<void> {
  try {
    await git(mainDir, ['fetch', 'origin', base]);
    const behind = parseInt(await gitOut(mainDir, ['rev-list', '--count', `${base}..origin/${base}`]) || '0', 10);
    if (behind === 0) return; // already current — nothing to advance

    // Test CONTENT-level dirtiness, not stat-level. `git status --porcelain` flags a file
    // as modified when only its mtime changed (e.g. a sync hook rewrites a tracked file
    // byte-for-byte) — which left a canonical checkout permanently "dirty" and silently
    // un-advanceable, so a deploy shipped stale code for hours. First refresh the stat
    // cache, then ask git whether the TREE actually differs from HEAD (diff-index, exit
    // code) plus whether any untracked files exist (ls-files --others).
    await git(mainDir, ['update-index', '-q', '--refresh']); // best-effort: drop stale mtime entries
    const onBase = (await gitOut(mainDir, ['symbolic-ref', '--short', 'HEAD'])) === base;
    const dirty = (await git(mainDir, ['diff-index', '--quiet', 'HEAD'])).code !== 0
      || !!(await gitOut(mainDir, ['ls-files', '--others', '--exclude-standard']));
    if (onBase && !dirty && (await git(mainDir, ['merge', '--ff-only', `origin/${base}`])).code === 0) return;

    const why = !onBase ? `HEAD is on a different branch (not ${base})`
      : dirty ? `${base} has real uncommitted changes`
      : `local ${base} has diverged from origin/${base}`;
    log(`WARNING: canonical checkout ${mainDir} left ${behind} commit(s) behind origin/${base} — ${why}. Deploys from here ship STALE code; reconcile with \`git -C ${mainDir} pull --rebase\`.`);
  } catch { /* best-effort; never block a land */ }
}

// After done/abort, cd the shell back to the workspace root — unless we're inside the
// agent (--in-claude), where we can't cd the agent's shell. In that case, if the
// removal just deleted the worktree that IS the agent's cwd, warn it explicitly:
// otherwise its NEXT Bash call dies with `uv_cwd ENOENT` from the now-deleted dir
// (the same failure the gw.sh wrapper guards against for the user's own shell).
function finishCd(flags: Flags): void {
  if (!flags.inClaude) { emit('CD', REPO_ROOT); return; }
  emit('NONE');
  let cwdGone = false;
  try { if (!fs.existsSync(process.cwd())) cwdGone = true; } catch { cwdGone = true; }
  if (cwdGone) log(`this session's worktree is gone — run \`cd ${REPO_ROOT}\` before any further commands (the shell is now in a deleted directory).`);
}

// ── abort ────────────────────────────────────────────────────────────────────

async function cmdAbort(flags: Flags): Promise<void> {
  const session = resolveSession(flags);
  if (!session) { log('no gw session here — run from inside a session, or pass the session id (gw abort WT-NNN).'); return finishCd(flags); }
  // Show exactly what would be discarded BEFORE any decision, so neither a human nor
  // an agent throws away work sight-unseen.
  const unlanded = await sessionUnlanded(session);
  if (unlanded.length) log(`${session} has UNLANDED work:\n  ${unlanded.join('\n  ')}`);
  if (!flags.yes) {
    if (flags.inClaude) {
      // An agent can't answer an interactive prompt — historically we just proceeded,
      // which let /abort silently destroy real work. Now: discarding NOTHING is safe to
      // do unprompted; discarding unlanded work requires an explicit --yes (the /abort
      // skill confirms with the user, then re-runs with --yes).
      if (unlanded.length) {
        die(`refusing to discard ${session}: it has unlanded work (above) and no --yes was given.\nIf the user really wants it gone, re-run: gw abort ${session} --yes\nTo keep the work instead, land it with /done.`);
      }
    } else if (!(await confirm(`discard session ${session} (all repos${unlanded.length ? ', INCLUDING the unlanded work above' : ''})? [y/N] `))) { log('kept.'); return; }
  }
  await removeSession(WORKTREES_DIR, session, REPO_KEYS, `gw/${session}`);
  log(`discarded ${session}`);
  return finishCd(flags);
}

// ── install / doctor: first-run shell wiring + environment check ──────────────

// The exact line a shell rc needs so the `gw` function exists in every new shell.
// Always an ABSOLUTE path to THIS checkout's gw.sh — never a hardcoded ~/gw — so gw
// works no matter where it was cloned.
function sourceLine(): string { return `source ${path.join(GW_HOME, 'gw.sh')}`; }

// rc files (that exist) already sourcing THIS gw.sh — so install is idempotent and
// doctor can report whether the shell is wired up.
function rcFilesSourcing(): string[] {
  const marker = path.join(GW_HOME, 'gw.sh');
  const out: string[] = [];
  for (const name of ['.bashrc', '.zshrc', '.bash_profile', '.profile']) {
    const p = path.join(os.homedir(), name);
    try { if (fs.readFileSync(p, 'utf-8').includes(marker)) out.push(p); } catch { /* absent */ }
  }
  return out;
}

// Best-guess rc for the user's login shell; overridable with --rc.
function defaultRc(): string {
  return path.join(os.homedir(), (process.env.SHELL || '').includes('zsh') ? '.zshrc' : '.bashrc');
}

// `gw install` — wire `gw` into the shell rc, idempotently. This is the ONE step a
// child process normally can't do for you, so we make it a first-class command (run it
// once as `npm run gw install` before the function exists). --print just emits the line
// (for piping/manual setups); --rc <path> targets a specific rc.
async function cmdInstall(flags: Flags): Promise<void> {
  const line = sourceLine();
  if (flags.print) { console.log(line); emit('NONE'); return; }

  const rc = flags.rc ? path.resolve(flags.rc) : defaultRc();
  const already = rcFilesSourcing();
  if (already.includes(rc)) { log(`already installed in ${rc} — nothing to do.`); emit('NONE'); return; }
  if (already.length) log(`note: gw.sh is also sourced from ${already.join(', ')}`);

  try {
    fs.appendFileSync(rc, `\n# gw — Grove Workspace\n${line}\n`);
  } catch (e) {
    log(`could not write ${rc}: ${e instanceof Error ? e.message : String(e)}`);
    log(`add this line to your shell rc by hand:\n  ${line}`);
    emit('NONE'); return;
  }
  log(`added to ${rc}:  ${line}`);
  log(`open a new shell (or: source ${rc}), then \`gw doctor\` to verify, and \`gw init\` in the dir that holds your repos.`);
  emit('NONE');
}

// `gw doctor` — preflight the environment so the next person sees ✓/✗ up front instead
// of discovering each gap mid-command. Exits non-zero only on a MISSING REQUIRED tool.
async function cmdDoctor(): Promise<void> {
  const tick = (ok: boolean) => (ok ? 'ok ' : '!! ');
  let missingRequired = false;

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  const nodeOk = nodeMajor >= 18;
  if (!nodeOk) missingRequired = true;
  log(`${tick(nodeOk)}node ${process.versions.node}${nodeOk ? '' : ' — gw needs node >= 18'}`);

  // gw.sh prefers the local tsx; npx is a slow fallback. Treat a missing local tsx as
  // a required gap — it means `npm install` wasn't run here.
  const tsxOk = fs.existsSync(path.join(GW_HOME, 'node_modules', '.bin', 'tsx'));
  if (!tsxOk) missingRequired = true;
  log(`${tick(tsxOk)}tsx (local)${tsxOk ? '' : ` — run 'npm install' in ${GW_HOME}`}`);

  const tools: Array<[string, boolean, string]> = [
    ['git', true, 'required for everything'],
    ['gh', false, 'only for --pr and `gw init --repo`'],
    ['claude', false, 'the default launcher/namer (configurable in gw.config.json)'],
  ];
  for (const [bin, required, note] of tools) {
    const found = (await run('bash', ['-lc', `command -v ${bin}`])).code === 0;
    if (required && !found) missingRequired = true;
    log(`${tick(found || !required)}${pad(bin, 8)}${found ? '' : ` missing — ${note}`}`);
  }

  const sourced = rcFilesSourcing();
  log(sourced.length
    ? `ok shell: gw.sh sourced from ${sourced.join(', ')}`
    : `!! shell: gw.sh not sourced in any rc — run \`gw install\` (or add: ${sourceLine()})`);

  // Workspace is optional — doctor runs anywhere. Report it if we're in one.
  try {
    const w = loadWorkspace();
    log(`ok workspace: ${w.root} (${w.repoKeys.length} repo(s): ${w.repoKeys.join(', ')})`);
  } catch {
    log(`.. workspace: no ${CONFIG_NAME} here — run \`gw init\` in the dir that holds your repos`);
  }

  if (missingRequired) { die('doctor: missing required tools above.'); }
  log('doctor: all required tools present.');
  emit('NONE');
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
  for (const f of ['done.md', 'df.md', 'abort.md', 'donedone.md']) {
    const src = path.join(srcDir, f);
    if (!fs.existsSync(src)) { log(`MISSING command source ${src}`); continue; }
    const body = fs.readFileSync(src, 'utf-8').replaceAll('__GW_ROOT__', REPO_ROOT).replaceAll('__GW_TS__', gwTs).replaceAll('__GW_TSX__', tsxCmd());
    fs.writeFileSync(path.join(dstDir, f), body);
    log(`installed /${f.replace('.md', '')} -> ~/.claude/commands/${f}`);
  }
  for (const k of REPO_KEYS) log(`${fs.existsSync(path.join(REPOS[k].dir, '.git')) ? 'ok' : '!!'}  ${k} repo at ${REPOS[k].dir}`);
  for (const bin of ['git', 'gh', 'claude', 'node']) log(`${(await run('bash', ['-lc', `command -v ${bin}`])).code === 0 ? 'ok' : '!!'}  ${bin}`);
  log(rcFilesSourcing().length ? `shell: gw.sh already sourced (gw doctor to verify).` : `enable the gw command:  gw install   (adds '${sourceLine()}' to your shell rc)`);
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

/** When a session started and when anything last happened in it, as unix timestamps
 *  (seconds), across its repo worktrees. Start = the OLDEST branch-reflog entry
 *  (branch creation). Last = the newest reflog entry OR the newest mtime of a
 *  dirty/untracked file, whichever is later — the reflog alone only moves on
 *  commits/resets, so a session with purely uncommitted edits would otherwise
 *  report its creation time as its last activity. Nulls when no repo has a
 *  readable reflog. The session branch tip COMMIT date is the wrong signal (an
 *  unchanged session points at the base commit, which can predate the session). */
async function sessionActivity(session: string): Promise<{ start: number | null; last: number | null }> {
  let start: number | null = null, last: number | null = null;
  const bump = (ts: number) => { if (last === null || ts > last) last = ts; };
  for (const repo of REPO_KEYS) {
    const wt = sessionRepoDir(WORKTREES_DIR, session, repo);
    if (!fs.existsSync(path.join(wt, '.git'))) continue;
    const reflog = (await gitOut(wt, ['reflog', 'show', '--date=unix', `gw/${session}`])).split('\n').filter(Boolean);
    const newest = reflog[0]?.match(/@\{(\d+)\}/);
    const oldest = reflog[reflog.length - 1]?.match(/@\{(\d+)\}/);
    if (newest) bump(parseInt(newest[1], 10));
    if (oldest) { const ts = parseInt(oldest[1], 10); if (start === null || ts < start) start = ts; }
    // Uncommitted work: the newest mtime among dirty/untracked paths. -z so paths
    // with spaces parse; a rename entry carries a second (origin) path — skip it.
    const porcelain = (await gitOut(wt, ['status', '--porcelain', '-z'])).split('\0').filter(Boolean);
    for (let i = 0; i < porcelain.length; i++) {
      const entry = porcelain[i];
      if (entry.length < 4) continue;
      if (entry[0] === 'R' || entry[0] === 'C') i++; // consume the rename/copy origin path
      try { bump(Math.floor(fs.lstatSync(path.join(wt, entry.slice(3))).mtimeMs / 1000)); } catch { /* vanished mid-scan */ }
    }
  }
  return { start, last };
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
    const act = await sessionActivity(session);
    const age = activityLabel(act.start, act.last, nowSec);
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
    const { start, last } = await sessionActivity(session);
    const age = activityLabel(start, last, nowSec);
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
  log(`  2. enable the gw command:  gw install   (or add by hand: ${sourceLine()})`);
  log(`  3. open a new shell, \`gw doctor\` to verify, then \`gw start\` from ${root}`);
}

// ── flags + dispatch ─────────────────────────────────────────────────────────

interface Flags {
  dryRun: boolean; noCheck: boolean; noLock: boolean; noSync: boolean; quick: boolean; full: boolean; pr: boolean; inClaude: boolean; yes: boolean;
  echoPrompt: boolean; simulatePushReject: boolean; force: boolean; print: boolean;
  noContinue: boolean; new: boolean; show: boolean; help: boolean;
  message: string; session: string; olderThan: string; repoFlags: string[]; rc: string;
  unknown: string[];
}
function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    dryRun: false, noCheck: false, noLock: false, noSync: false, quick: false, full: false, pr: false, inClaude: false, yes: false,
    echoPrompt: false, simulatePushReject: false, force: false, print: false,
    noContinue: false, new: false, show: false, help: false,
    message: '', session: '', olderThan: '', repoFlags: [], rc: '', unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') f.dryRun = true;
    else if (a === '--no-check') f.noCheck = true;
    else if (a === '--no-lock') f.noLock = true;
    else if (a === '--no-sync') f.noSync = true;
    else if (a === '--quick') f.quick = true;
    else if (a === '--full') f.full = true;
    else if (a === '--pr') f.pr = true;
    else if (a === '--in-claude') f.inClaude = true;
    else if (a === '--yes' || a === '-y') f.yes = true;
    else if (a === '--force') f.force = true;
    else if (a === '--no-continue') f.noContinue = true;
    else if (a === '--new') f.new = true;
    else if (a === '--show') f.show = true;
    else if (a === '--echo-prompt') f.echoPrompt = true;
    else if (a === '--simulate-push-reject') f.simulatePushReject = true;
    else if (a === '--print') f.print = true;
    else if (a === '--rc') f.rc = argv[++i] ?? '';
    else if (a === '--older-than') f.olderThan = argv[++i] ?? '';
    else if (a === '--repo') f.repoFlags.push(argv[++i] ?? '');
    else if (a === '-m' || a === '--message') f.message = argv[++i] ?? '';
    else if (a === '-h' || a === '--help') f.help = true;
    else if (!a.startsWith('-') && !f.session) f.session = a; // positional: session-id for start(resume)/done/abort
    else if (a.startsWith('-')) f.unknown.push(a); // unrecognized flag — rejected, never silently ignored
  }
  return f;
}

const HELP = `gw — Grove Workspace

  gw install [--rc <file>] [--print]          wire the gw command into your shell rc
  gw doctor                                   check tools + shell wiring (run this first)
  gw init [--repo owner/name ...] [--force]   scaffold gw.config.json + slash commands
  gw start [WT-id] [--no-continue] [--new]    branch every repo, launch the agent
                                              (resume continues the prior conversation;
                                              --no-continue starts fresh, --new forces a
                                              new session even inside a worktree)
  gw done [--pr] [--no-check] [--no-lock]     merge origin/<base> in, gate, then
          [--no-sync] [--quick|--full]        squash-merge each changed repo
          [-m msg]                            (one gate at a time per workspace;
                                              --no-lock runs concurrently anyway;
                                              --no-sync skips the pre-gate merge;
                                              --quick runs each repo's lighter,
                                              diff-scoped gateQuick; --full forces
                                              the full gate even where a repo
                                              defaults to quick via gateQuickDefault)
  gw done --show                              preview per-repo diff to be landed (read-only)
  gw abort [WT-id] [--yes]                    discard a session's work (shows what's
                                              unlanded first; refuses unlanded work
                                              in --in-claude mode without --yes)
  gw status                                   cross-repo + worktree status
  gw ready                                    done-done check (safe to deploy?)
  gw prune [--older-than 2d] [--dry-run]      remove landed, idle sessions
  gw setup                                    (re)install slash commands

Config: ${CONFIG_NAME} at the workspace root (GW_ROOT overrides discovery).`;

const [, , sub, ...rest] = process.argv;
const flags = parseFlags(rest);
(async () => {
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') { console.log(HELP); return; }
  // `gw <sub> --help` prints usage and does NOTHING ELSE — never falls through to the
  // command (a stray `gw start --help` used to create a whole session). Unknown flags are
  // a hard error rather than being silently ignored on a session-mutating command.
  if (flags.help) { console.log(HELP); return; }
  if (flags.unknown.length) die(`unknown flag${flags.unknown.length > 1 ? 's' : ''}: ${flags.unknown.join(', ')}\n\n${HELP}`);
  if (sub === 'init') return cmdInit(flags);
  if (sub === 'install') return cmdInstall(flags);   // no workspace needed — wires the shell
  if (sub === 'doctor') return cmdDoctor();           // no workspace needed — checks the env

  bind(loadWorkspace());
  switch (sub) {
    case 'start': return cmdStart(flags);
    case 'done': return cmdDone(flags);
    case 'abort': return cmdAbort(flags);
    case 'status': return cmdStatus();
    case 'ready': return cmdReady();
    case 'prune': return cmdPrune(flags);
    case 'setup': return cmdSetup();
    default: die(`unknown subcommand "${sub}". use: install | doctor | init | start | done | abort | status | ready | prune | setup`);
  }
})().catch((e) => die(e instanceof Error ? e.message : String(e)));
