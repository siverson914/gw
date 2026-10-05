#!/usr/bin/env node
/**
 * gw write guard: a Claude Code PreToolUse hook (installed by `gw setup`) that
 * refuses Write/Edit/MultiEdit/NotebookEdit on a file inside a CANONICAL repo
 * checkout of a gw workspace. gw only lands what's in a session worktree, so an
 * edit to the canonical copy is silently never landed (or clobbered by the next
 * fast-forward). Plain JS with no dependencies: it runs on every edit, so it
 * must start fast and can't rely on tsx.
 *
 * Allowed: files outside any configured repo, anything under .worktrees/, and
 * git-ignored files in a canonical checkout (server/.env and friends are linked
 * INTO worktrees, so the canonical copy is the one to edit). GW_ALLOW_MAIN=1
 * bypasses it for a deliberate one-off.
 *
 * Contract: JSON on stdin ({ cwd, tool_input: { file_path | notebook_path } });
 * exit 2 + stderr blocks the tool call and shows the reason to the agent.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CONFIG_NAME = 'gw.config.json';

function findWorkspace(start) {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, CONFIG_NAME))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isIgnored(repoDir, file) {
  try { execFileSync('git', ['-C', repoDir, 'check-ignore', '-q', file], { stdio: 'ignore' }); return true; } catch { return false; }
}

function main(raw) {
  if (process.env.GW_ALLOW_MAIN === '1') return 0;
  let input;
  try { input = JSON.parse(raw); } catch { return 0; }
  const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (typeof target !== 'string' || !target) return 0;
  const file = path.resolve(input.cwd || process.cwd(), target);

  const root = findWorkspace(path.dirname(file));
  if (!root) return 0;
  if (within(file, path.join(root, '.worktrees'))) return 0;
  let repos;
  try { repos = JSON.parse(fs.readFileSync(path.join(root, CONFIG_NAME), 'utf-8')).repos ?? []; } catch { return 0; }

  for (const repo of repos) {
    const repoDir = path.resolve(root, repo.dir ?? repo.key);
    if (!within(file, repoDir)) continue;
    if (isIgnored(repoDir, file)) return 0;
    const rel = path.relative(repoDir, file);
    const sessions = fs.existsSync(path.join(root, '.worktrees'))
      ? fs.readdirSync(path.join(root, '.worktrees')).filter((s) => fs.existsSync(path.join(root, '.worktrees', s, repo.dir ?? repo.key)))
      : [];
    const where = sessions.length
      ? `Edit it in a session worktree instead, e.g. ${path.join(root, '.worktrees', sessions[sessions.length - 1], repo.dir ?? repo.key, rel)}`
      : 'Start a session first (gw start, or the gw-sessions skill) and edit the file under .worktrees/<id>/.';
    process.stderr.write(
      `gw: ${path.relative(root, file)} is in the canonical ${repo.key} checkout, which is read-only: gw lands only session worktrees, so this edit would never ship. ${where} (Deliberate one-off: GW_ALLOW_MAIN=1.)\n`,
    );
    return 2;
  }
  return 0;
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { process.exit(main(raw)); });
