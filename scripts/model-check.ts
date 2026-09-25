// Daily check for new or retired models on the providers gw launches.
//
// Asks each provider's CLI (or API) which models it serves, compares that with
// the last run's snapshot and with DEFAULT_AGENTS in src/config.ts, and when
// anything changed appends an entry to the log and raises a desktop alert that
// stays until dismissed. Silent when nothing changed. It never edits the presets:
// choosing defaults and what to drop is a judgment call, so a person does that
// (and records it in docs/model-log.md).
//
// Run daily by ~/.config/systemd/user/gw-model-check.timer. By hand:
//   npx tsx scripts/model-check.ts            # check, alert on change
//   npx tsx scripts/model-check.ts --dry-run  # print the diff, touch nothing
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENTS } from '../src/config.js';

const run = promisify(execFile);
const dryRun = process.argv.includes('--dry-run');
const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'gw');
const snapshotFile = join(stateDir, 'models.json');
const logFile = join(stateDir, 'model-check.md');

type Snapshot = Record<string, string[]>;

async function sh(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await run(cmd, args, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// Each fetcher returns the provider's served model ids, or throws. A provider
// that can't be asked is skipped (and keeps its previous snapshot).
const fetchers: Record<string, () => Promise<string[]>> = {
  async claude() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('skipped: no ANTHROPIC_API_KEY (set it in ~/.config/gw/env)');
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) throw new Error(`models API ${res.status}`);
    const body = (await res.json()) as { data: { id: string }[] };
    return body.data.map((m) => m.id);
  },
  async codex() {
    const body = JSON.parse(await sh('codex', ['debug', 'models'])) as { models: { slug: string; visibility: string }[] };
    return body.models.filter((m) => m.visibility === 'list').map((m) => m.slug);
  },
  async grok() {
    // "Available models:" followed by "  * grok-4.6 (default)" / "  - grok-4.5".
    const out = await sh('grok', ['models']);
    const ids = [...out.matchAll(/^\s*[*-]\s+(\S+)/gm)].map((m) => m[1]);
    if (!ids.length) throw new Error('no models in `grok models` output');
    return ids;
  },
  async agy() {
    const out = await sh('agy', ['models']);
    const ids = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!ids.length) throw new Error('no models in `agy models` output');
    return ids;
  },
};

// Claude's API also lists dated snapshots and older generations; the presets
// use undated ids, so a configured id counts as served if any served id
// equals it or starts with it (claude-haiku-4-5 ↔ claude-haiku-4-5-20251001).
const served = (ids: string[], id: string) => ids.some((s) => s === id || s.startsWith(`${id}-`));

async function main() {
  const previous: Snapshot = existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, 'utf8')) : {};
  const current: Snapshot = { ...previous };
  const lines: string[] = [];
  const headline: string[] = [];

  for (const [agent, fetchModels] of Object.entries(fetchers)) {
    let ids: string[];
    try {
      ids = [...new Set(await fetchModels())].sort();
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      console.error(`${agent}: ${err.code === 'ENOENT' ? 'skipped: CLI not installed' : err.message.split('\n')[0]}`);
      continue;
    }
    current[agent] = ids;
    const before = previous[agent];
    if (before) {
      const added = ids.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !ids.includes(id));
      if (added.length) {
        lines.push(`- **${agent}:** new: ${added.map((id) => `\`${id}\``).join(', ')}`);
        headline.push(`${agent}: ${added.join(', ')}`);
      }
      if (removed.length) lines.push(`- **${agent}:** no longer served: ${removed.map((id) => `\`${id}\``).join(', ')}`);
    } else {
      console.error(`${agent}: first snapshot, ${ids.length} models`);
    }
    // A preset pointing at a model the provider stopped serving breaks gw start.
    // Only reported the day it disappears (it shows up in `removed` too), not daily.
    const stale = DEFAULT_AGENTS[agent].models.filter((id) => !served(ids, id) && (!before || served(before, id)));
    if (before && stale.length) {
      lines.push(`- **${agent}:** preset still lists ${stale.map((id) => `\`${id}\``).join(', ')}, which is no longer served`);
      headline.push(`${agent} preset has retired models`);
    }
  }

  if (dryRun) {
    console.log(lines.length ? lines.join('\n') : 'no changes');
    return;
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(snapshotFile, `${JSON.stringify(current, null, 2)}\n`);
  if (!lines.length) return;

  const date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
  if (!existsSync(logFile)) writeFileSync(logFile, '# gw model check\n\nModel changes seen by scripts/model-check.ts, oldest first.\n');
  appendFileSync(logFile, `\n## ${date}\n\n${lines.join('\n')}\n`);

  const summary = headline.length ? headline.join('\n') : 'Models were retired upstream';
  await run('notify-send', [
    '-u', 'critical', '-a', 'gw', 'gw: model lineup changed',
    `${summary}\n\nLog: ${logFile.replace(homedir(), '~')}\nUpdate DEFAULT_AGENTS in ~/Github/gw/src/config.ts`,
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
