/**
 * gw config — discovery + loading of the per-workspace `gw.config.json`.
 *
 * A "workspace" is a directory holding several git repos as siblings, with a
 * `gw.config.json` at its root describing them. Everything Gipity-specific in the
 * original gw (the repo list, the per-repo gates, the brand color, the launcher,
 * the session-level drift gate) now lives in that file, so one gw serves any
 * project. `gw init` writes the file by autodetecting whatever it can.
 *
 * Discovery (runs-from-anywhere, grove-style): GW_ROOT wins; otherwise walk up
 * from the cwd until a `gw.config.json` is found — so commands work from inside a
 * session worktree (`<root>/.worktrees/<id>/<repo>`) just as well as from the root.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CONFIG_NAME = 'gw.config.json';

/** One repo in the workspace. `dir` is resolved relative to the workspace root. */
export interface RepoCfg {
  key: string;                 // short stable name (e.g. "server"); also the worktree subdir
  dir: string;                 // absolute path to the canonical checkout
  slug: string;                // "owner/repo" for `gh` (PRs)
  base: string;                // integration branch (usually "main")
  linkPaths: string[];         // gitignored deps/env to symlink into each worktree (node_modules, .env)
  copyPaths: string[];         // gitignored files a docker build needs as REAL files (not symlinks)
  gate: string[] | null;       // fast pre-merge check, run in the worktree; null = none
  gateQuick: string[] | null;  // optional lighter, diff-scoped gate for `gw done --quick`; null = fall back to gate
  gateQuickDefault: boolean;   // run gateQuick by default (no --quick needed); --full forces the full gate anyway
  nmScope?: string;            // npm workspace scope (e.g. "@acme") needing a per-worktree node_modules farm
}

/** An optional session-level gate: commands run from one repo's worktree to catch
 *  cross-repo drift a per-repo gate misses (e.g. a generated-doc `--check`). Runs
 *  only when that repo itself was NOT changed (its own gate already covers it). */
export interface SessionGate {
  repo: string;                // repo key whose worktree the commands run in
  commands: string[][];        // each is an argv array, e.g. [["npx","tsx","scripts/build-docs.ts","--check"]]
}

/** A directory that's published but not gw-managed — `gw ready` warns (never blocks)
 *  if it's dirty/unpushed, since that usually means a forgotten manual sync. */
export interface WarnDir { dir: string; label: string }

export interface RawConfig {
  base?: string;                       // default integration branch for repos that don't set their own
  launcher?: string;                   // agent launch command for `gw start` (default: claude --permission-mode auto)
  resumeArgs?: string[];               // extra launcher args when RESUMING a session, to continue the prior
                                       // conversation (default: ["--continue"], for the claude launcher). Set
                                       // [] for a launcher with no resume concept; --no-continue skips it per-run.
  namer?: string;                      // command that titles a session from its prompt (default: claude --model haiku)
  defaultAgent?: string;               // agent preselected by gw start (default: "claude")
  agents?: Record<string, RawAgentCfg>;// launch/resume/model presets shown in gw start
  brandColor?: string;                 // hex, for the banner + prompt box (default: Porsche orange #f26522)
  docker?: boolean;                    // write a .dockerignore into session dirs so linked deps stay out of build contexts
  sessionGate?: SessionGate | null;
  warnDirs?: WarnDir[];
  repos: Array<Partial<RepoCfg> & { key: string; dir: string }>;
}

export interface RawAgentCfg {
  launcher?: string;                   // complete command for a fresh interactive session
  resumeLauncher?: string;             // complete command for continuing inside the same worktree
  models?: string[];                   // model ids/aliases shown in the picker; [] = provider default only
  defaultModel?: string | null;         // initially selected model; null = provider default
  modelFlag?: string;                  // flag placed before a selected model (default: --model)
}

export interface AgentCfg {
  key: string;
  launcher: string[];
  resumeLauncher: string[];
  models: string[];
  defaultModel: string | null;
  modelFlag: string;
}

/** Fully-resolved, defaults-applied config the rest of gw runs against. */
export interface Workspace {
  root: string;
  configPath: string;
  base: string;
  launcher: string[];
  resumeArgs: string[];
  namer: string[];
  defaultAgent: string;
  agents: Record<string, AgentCfg>;
  brandColor: string;
  docker: boolean;
  sessionGate: SessionGate | null;
  warnDirs: WarnDir[];
  repos: Record<string, RepoCfg>;
  repoKeys: string[];
}

export const DEFAULT_LAUNCHER = 'claude --permission-mode auto';
export const DEFAULT_RESUME_ARGS = ['--continue']; // claude: continue the worktree's prior conversation
export const DEFAULT_NAMER = 'claude --model haiku';
export const DEFAULT_BRAND = '#f26522'; // Porsche Signal Orange
export const DEFAULT_AGENTS: Record<string, Required<RawAgentCfg>> = {
  claude: {
    launcher: DEFAULT_LAUNCHER,
    resumeLauncher: `${DEFAULT_LAUNCHER} --continue`,
    models: ['fable', 'opus', 'sonnet', 'haiku'],
    defaultModel: 'sonnet',
    modelFlag: '--model',
  },
  codex: {
    launcher: 'codex',
    resumeLauncher: 'codex resume --last',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
    defaultModel: 'gpt-5.6-terra',
    modelFlag: '--model',
  },
};

/** hex "#f26522" → an ANSI 24-bit foreground escape. Falls back to plain orange. */
export function hexAnsi(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xf26522;
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/** Find the workspace root: GW_ROOT env, else the nearest ancestor of `start`
 *  containing gw.config.json. Returns null if neither yields one. */
export function findRoot(start = process.cwd()): string | null {
  const env = process.env.GW_ROOT;
  if (env) {
    const root = path.resolve(env);
    if (fs.existsSync(path.join(root, CONFIG_NAME))) return root;
    // GW_ROOT is set but holds no config. gw.sh falls GW_ROOT back to $PWD when it
    // can't find a workspace, so an unconfigured dir lands here — don't trust it, or
    // we'd mask the helpful "run gw init" message with a raw ENOENT. Fall through to
    // the walk-up from `start` (a real, config-bearing GW_ROOT already returned above).
  }
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_NAME))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null; // hit filesystem root
    dir = up;
  }
}

/** Load + validate the workspace config, applying defaults. Throws (with a helpful
 *  message) if no config is found or it's malformed. */
export function loadWorkspace(start = process.cwd()): Workspace {
  const root = findRoot(start);
  if (!root) {
    throw new Error(
      `no ${CONFIG_NAME} found here or in any parent.\n` +
      `Run \`gw init\` in the directory that holds your repos to create one.`,
    );
  }
  const configPath = path.join(root, CONFIG_NAME);
  let raw: RawConfig;
  try { raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
  catch (e) { throw new Error(`could not read ${configPath}: ${e instanceof Error ? e.message : String(e)}`); }
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) throw new Error(`${configPath}: "repos" must be a non-empty array.`);

  const base = raw.base || 'main';
  const repos: Record<string, RepoCfg> = {};
  for (const r of raw.repos) {
    if (!r.key || !r.dir) throw new Error(`${configPath}: every repo needs a "key" and "dir".`);
    if (repos[r.key]) throw new Error(`${configPath}: duplicate repo key "${r.key}".`);
    repos[r.key] = {
      key: r.key,
      dir: path.isAbsolute(r.dir) ? r.dir : path.join(root, r.dir),
      slug: r.slug ?? '',
      base: r.base ?? base,
      linkPaths: r.linkPaths ?? [],
      copyPaths: r.copyPaths ?? [],
      gate: r.gate ?? null,
      gateQuick: r.gateQuick ?? null,
      gateQuickDefault: r.gateQuickDefault ?? false,
      nmScope: r.nmScope,
    };
  }
  // Word-split the launcher/namer command strings (no shell quoting — these are
  // plain commands like `claude --permission-mode auto`).
  const split = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);
  // Agent presets are deliberately separate from the git/worktree configuration.
  // Preserve the original launcher/resumeArgs fields as Claude overrides so existing
  // gw.config.json files gain Codex without a migration.
  const rawAgents = raw.agents ?? {};
  const agents: Record<string, AgentCfg> = {};
  for (const [key, defaults] of Object.entries(DEFAULT_AGENTS)) {
    const a = rawAgents[key] ?? {};
    const legacyLauncher = key === 'claude' && raw.launcher ? raw.launcher : undefined;
    const launcherText = a.launcher ?? legacyLauncher ?? defaults.launcher;
    let resumeText = a.resumeLauncher;
    if (!resumeText && key === 'claude' && (raw.launcher || raw.resumeArgs)) {
      resumeText = [launcherText, ...(raw.resumeArgs ?? DEFAULT_RESUME_ARGS)].join(' ');
    }
    agents[key] = {
      key,
      launcher: split(launcherText),
      resumeLauncher: split(resumeText ?? defaults.resumeLauncher),
      models: a.models ?? defaults.models,
      defaultModel: a.defaultModel === undefined ? defaults.defaultModel : a.defaultModel,
      modelFlag: a.modelFlag ?? defaults.modelFlag,
    };
  }
  // Allow additional user-defined agent presets too.
  for (const [key, a] of Object.entries(rawAgents)) {
    if (agents[key]) continue;
    if (!a.launcher) throw new Error(`${configPath}: agents.${key}.launcher is required.`);
    agents[key] = {
      key,
      launcher: split(a.launcher),
      resumeLauncher: split(a.resumeLauncher ?? a.launcher),
      models: a.models ?? [],
      defaultModel: a.defaultModel ?? null,
      modelFlag: a.modelFlag ?? '--model',
    };
  }
  const defaultAgent = raw.defaultAgent ?? 'claude';
  if (!agents[defaultAgent]) throw new Error(`${configPath}: defaultAgent "${defaultAgent}" is not configured.`);

  return {
    root,
    configPath,
    base,
    launcher: split(raw.launcher || DEFAULT_LAUNCHER),
    resumeArgs: raw.resumeArgs ?? DEFAULT_RESUME_ARGS,
    namer: split(raw.namer || DEFAULT_NAMER),
    defaultAgent,
    agents,
    brandColor: raw.brandColor || DEFAULT_BRAND,
    docker: raw.docker ?? false,
    sessionGate: raw.sessionGate ?? null,
    warnDirs: raw.warnDirs ?? [],
    repos,
    repoKeys: Object.keys(repos),
  };
}
