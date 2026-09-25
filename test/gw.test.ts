/**
 * gw end-to-end suite. Every test drives the REAL CLI against a disposable
 * fixture workspace (local bare origins, real worktrees, real pushes).
 *
 * Several tests pin invariants that exist because they were once violated —
 * the scar tissue encoded in gw.ts comments:
 *   - a TRACKED linkPath must never land as a deletion (the .env wipe)
 *   - a session path resolving to a real checkout must never be staged/removed
 *     through (the stray-symlink near-disaster)
 *   - a gate timeout must be reported as a TIMEOUT, not "exit null"
 *   - abort must never silently discard unlanded work in --in-claude mode
 */
import { test, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixture, gw, git, startSession, cleanupFixtures } from './fixture.js';
import { parseId, slugify } from '../src/lib/worktrees.js';

after(cleanupFixtures);

// ── units (in-process; no fixture) ───────────────────────────────────────────

test('parseId accepts WT- and legacy WS- ids, rejects noise', () => {
  assert.equal(parseId('WT-123-some-slug'), 'WT-123');
  assert.equal(parseId('WS-042-old-session'), 'WS-042'); // legacy prefix stays resolvable
  assert.equal(parseId('WS-042'), 'WS-042');             // and is NOT normalized to WT-
  assert.equal(parseId('WT-12'), null);                  // needs >= 3 digits
  assert.equal(parseId('feature-branch'), null);
});

test('slugify drops filler words and truncates at word boundaries', () => {
  assert.equal(slugify('I want to add the new dashboard page'), 'add-new-dashboard-page');
  assert.equal(slugify(''), '');
});

test('slash-command templates never bake a workspace path (one install serves every workspace)', () => {
  const dir = path.join(import.meta.dirname, '..', 'commands');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const body = fs.readFileSync(path.join(dir, f), 'utf-8');
    assert.ok(!body.includes('__GW_ROOT__'), `${f} bakes the workspace root`);
    for (const line of body.split('\n').filter((l) => l.includes('__GW_TS__'))) {
      assert.match(line, /env -u GW_ROOT /, `${f}: gw must discover the workspace, not inherit GW_ROOT`);
    }
  }
});

test('post-land fallback cd resolves the workspace root from a worktree path', () => {
  const out = execFileSync('bash', ['-c', 'PWD=/home/me/work/Acme/.worktrees/WT-007-x/server; echo "${PWD%%/.worktrees/*}"']).toString().trim();
  assert.equal(out, '/home/me/work/Acme');
});

// ── session lifecycle ────────────────────────────────────────────────────────

test('start provisions an isolated worktree per repo and allocates WT-001', async () => {
  const fx = makeFixture();
  const id = await startSession(fx);
  assert.equal(id, 'WT-001');
  for (const k of fx.repoKeys) {
    const wt = fx.wt(id, k);
    assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), `${k}: .git must be a FILE (linked worktree)`);
    assert.equal(git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']), `gw/${id}`);
  }
  assert.equal(fs.readFileSync(path.join(fx.root, '.gw-seq'), 'utf8').trim(), '1');
});

test('start can launch Codex and resume the same agent for that worktree', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const started = await gw(fx, ['start', '--agent', 'codex'], { stdin: 'add a codex path\n' });
  assert.equal(started.code, 0, started.stderr);
  const id = path.basename(started.directive[1]);
  assert.match(Buffer.from(started.directive[3], 'base64').toString('utf8'), /^codex\n--ask-for-approval\nnever\n--sandbox\ndanger-full-access$/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(fx.sessionDir(id), '.gw-agent.json'), 'utf8')),
    { agent: 'codex', model: null, effort: null },
  );

  const resumed = await gw(fx, ['start', id]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(Buffer.from(resumed.directive[3], 'base64').toString('utf8'), 'codex\nresume\n--last\n--ask-for-approval\nnever\n--sandbox\ndanger-full-access');

  const clean = await gw(fx, ['start', id, '--no-continue']);
  assert.equal(clean.code, 0, clean.stderr);
  assert.equal(Buffer.from(clean.directive[3], 'base64').toString('utf8'), 'codex\n--ask-for-approval\nnever\n--sandbox\ndanger-full-access');
});

test('a model name containing spaces/parens (agy) survives the launcher argv intact', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const started = await gw(fx, ['start', '--agent', 'agy', '--model', 'Gemini 3.1 Pro (High)'], { stdin: 'add an agy path\n' });
  assert.equal(started.code, 0, started.stderr);
  const id = path.basename(started.directive[1]);
  assert.equal(
    Buffer.from(started.directive[3], 'base64').toString('utf8'),
    'agy\n--dangerously-skip-permissions\n--model\nGemini 3.1 Pro (High)',
  );

  const resumed = await gw(fx, ['start', id]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(
    Buffer.from(resumed.directive[3], 'base64').toString('utf8'),
    'agy\n--dangerously-skip-permissions\n--continue\n--model\nGemini 3.1 Pro (High)',
  );
});

test('start can launch Grok with model + effort axes and resume the same selection', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const started = await gw(fx, ['start', '--agent', 'grok', '--model', 'grok-4.5', '--effort', 'medium'], { stdin: 'add a grok path\n' });
  assert.equal(started.code, 0, started.stderr);
  const id = path.basename(started.directive[1]);
  assert.equal(
    Buffer.from(started.directive[3], 'base64').toString('utf8'),
    'grok\n--permission-mode\nauto\n--model\ngrok-4.5\n--reasoning-effort\nmedium',
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(fx.sessionDir(id), '.gw-agent.json'), 'utf8')),
    { agent: 'grok', model: 'grok-4.5', effort: 'medium' },
  );

  const resumed = await gw(fx, ['start', id]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(
    Buffer.from(resumed.directive[3], 'base64').toString('utf8'),
    'grok\n--permission-mode\nauto\n--continue\n--model\ngrok-4.5\n--reasoning-effort\nmedium',
  );
});

test('--effort with a config-key effort flag (codex) glues the value onto the override', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const started = await gw(fx, ['start', '--agent', 'codex', '--effort', 'xhigh'], { stdin: 'tune effort\n' });
  assert.equal(started.code, 0, started.stderr);
  const id = path.basename(started.directive[1]);
  assert.equal(
    Buffer.from(started.directive[3], 'base64').toString('utf8'),
    'codex\n--ask-for-approval\nnever\n--sandbox\ndanger-full-access\n-c\nmodel_reasoning_effort=xhigh',
  );

  const resumed = await gw(fx, ['start', id]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(
    Buffer.from(resumed.directive[3], 'base64').toString('utf8'),
    'codex\nresume\n--last\n--ask-for-approval\nnever\n--sandbox\ndanger-full-access\n-c\nmodel_reasoning_effort=xhigh',
  );
});

test('legacy sessions without agent metadata resume with the configured default agent', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const id = await startSession(fx);
  fs.rmSync(path.join(fx.sessionDir(id), '.gw-agent.json'));
  const resumed = await gw(fx, ['start', id]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(Buffer.from(resumed.directive[3], 'base64').toString('utf8'), /^claude\n[\s\S]*--continue/);
});

test('done with no changes reports nothing to merge and removes the session', async () => {
  const fx = makeFixture();
  const id = await startSession(fx);
  const r = await gw(fx, ['done', id, '-m', 'unused']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /nothing to merge/);
  assert.ok(!fs.existsSync(fx.sessionDir(id)), 'session dir should be gone');
});

test('done lands a change: squash on origin/main with -m message, other repo untouched, canonical fast-forwarded', async () => {
  const fx = makeFixture();
  const id = await startSession(fx);
  fs.writeFileSync(path.join(fx.wt(id, 'a'), 'feature.txt'), 'hello\n');
  const r = await gw(fx, ['done', id, '-m', 'feat: add feature\n\n- adds feature.txt']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /merged \+ pushed: a/);
  assert.equal(git(fx.origin('a'), ['log', '-1', '--format=%s', 'main']), 'feat: add feature');
  assert.match(git(fx.origin('a'), ['log', '-1', '--format=%b', 'main']), /adds feature\.txt/);
  assert.match(git(fx.origin('a'), ['ls-tree', '-r', '--name-only', 'main']), /feature\.txt/);
  assert.equal(git(fx.origin('b'), ['rev-list', '--count', 'main']), '1', 'untouched repo must not gain commits');
  assert.equal(git(fx.co('a'), ['rev-parse', 'main']), git(fx.origin('a'), ['rev-parse', 'main']), 'canonical should be fast-forwarded');
  assert.ok(!fs.existsSync(fx.sessionDir(id)));
});

test('done is recoverable: push race (simulated reject) is retried and lands', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const id = await startSession(fx);
  fs.writeFileSync(path.join(fx.wt(id, 'a'), 'raced.txt'), 'x\n');
  const r = await gw(fx, ['done', id, '--simulate-push-reject', '-m', 'feat: raced']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(git(fx.origin('a'), ['log', '-1', '--format=%s', 'main']), 'feat: raced');
});

// ── gates ────────────────────────────────────────────────────────────────────

test('one red gate lands NOTHING and keeps the session', async () => {
  const fx = makeFixture({ repos: { a: { gate: ['bash', '-c', 'exit 0'] }, b: { gate: ['bash', '-c', 'exit 1'] } } });
  const id = await startSession(fx);
  fs.writeFileSync(path.join(fx.wt(id, 'a'), 'ok.txt'), 'x\n');
  fs.writeFileSync(path.join(fx.wt(id, 'b'), 'bad.txt'), 'x\n');
  const r = await gw(fx, ['done', id, '-m', 'nope']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /\[b\] gate failed \(exit 1\)/);
  assert.equal(git(fx.origin('a'), ['rev-list', '--count', 'main']), '1', 'a must not land when b is red');
  assert.equal(git(fx.origin('b'), ['rev-list', '--count', 'main']), '1');
  assert.ok(fs.existsSync(fx.sessionDir(id)), 'session must be kept for recovery');
});

test('a hung gate is reported as a TIMEOUT, not "exit null"', async () => {
  const fx = makeFixture({ repos: { a: { gate: ['bash', '-c', 'sleep 30'] } } });
  const id = await startSession(fx);
  fs.writeFileSync(path.join(fx.wt(id, 'a'), 'slow.txt'), 'x\n');
  const r = await gw(fx, ['done', id, '-m', 'nope'], { env: { GW_GATE_TIMEOUT_MS: '700' } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /TIMED OUT after 0\.7s/);
  assert.doesNotMatch(r.stderr, /exit null/);
  assert.ok(fs.existsSync(fx.sessionDir(id)));
});

test('quick tier: gateQuickDefault runs gateQuick with GW_CHANGED_FILES; --full forces the full gate', async () => {
  const mk = (name: string) => ['bash', '-c', `touch "$GW_MARK_DIR/${name}"`];
  const fx = makeFixture({
    repos: {
      a: {
        gate: mk('full'),
        gateQuick: ['bash', '-c', 'touch "$GW_MARK_DIR/quick" && printf %s "$GW_CHANGED_FILES" > "$GW_MARK_DIR/changed"'],
        gateQuickDefault: true,
      },
    },
  });
  const env = { GW_MARK_DIR: fx.root };

  const id1 = await startSession(fx);
  fs.writeFileSync(path.join(fx.wt(id1, 'a'), 'newfile.txt'), 'x\n');
  const r1 = await gw(fx, ['done', id1, '-m', 'feat: one'], { env });
  assert.equal(r1.code, 0, r1.stderr);
  assert.ok(fs.existsSync(path.join(fx.root, 'quick')), 'quick gate should run by default');
  assert.ok(!fs.existsSync(path.join(fx.root, 'full')), 'full gate should NOT run');
  assert.match(fs.readFileSync(path.join(fx.root, 'changed'), 'utf8'), /newfile\.txt/);

  const id2 = await startSession(fx);
  fs.writeFileSync(path.join(fx.wt(id2, 'a'), 'other.txt'), 'x\n');
  const r2 = await gw(fx, ['done', id2, '--full', '-m', 'feat: two'], { env });
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(fs.existsSync(path.join(fx.root, 'full')), '--full must force the full gate');
});

// ── the scar-tissue invariants ───────────────────────────────────────────────

test('a TRACKED linkPath is never landed as a deletion (the .env wipe)', async () => {
  const fx = makeFixture({ repos: { a: { trackedEnv: true, linkPaths: ['.env'] } } });
  const id = await startSession(fx);
  // Simulate the disaster preconditions: the linkPath vanishes from the worktree
  // (deleted / replaced by a dangling symlink) while other work is real.
  fs.rmSync(path.join(fx.wt(id, 'a'), '.env'));
  fs.writeFileSync(path.join(fx.wt(id, 'a'), 'README.md'), '# changed\n');
  const r = await gw(fx, ['done', id, '-m', 'docs: update readme']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /linked path '\.env' is TRACKED/);
  assert.match(git(fx.origin('a'), ['ls-tree', '-r', '--name-only', 'main']), /\.env/, '.env must survive on origin/main');
  assert.equal(git(fx.origin('a'), ['show', 'main:.env']), 'SECRET=1');
  assert.equal(git(fx.origin('a'), ['show', 'main:README.md']), '# changed', 'the real change still lands');
});

test('a session path that resolves to a real checkout is never staged or destroyed through', async () => {
  const fx = makeFixture();
  const id = await startSession(fx);
  // Replace the session's repo-a worktree with a symlink to the CANONICAL checkout.
  fs.rmSync(fx.wt(id, 'a'), { recursive: true, force: true });
  fs.symlinkSync(fx.co('a'), fx.wt(id, 'a'));
  const canonicalHead = git(fx.co('a'), ['rev-parse', 'HEAD']);

  const r = await gw(fx, ['done', id, '-m', 'unused']);
  assert.match(r.stderr, /\[a\] skipped: .* not an isolated/, 'must refuse to stage into the canonical checkout');
  // b had no changes -> session removed; that removal must not follow the symlink.
  assert.ok(fs.existsSync(path.join(fx.co('a'), '.git')), 'canonical .git must survive');
  assert.equal(git(fx.co('a'), ['rev-parse', 'HEAD']), canonicalHead);
  assert.equal(git(fx.co('a'), ['show', 'HEAD:README.md']), '# a');
});

test('done --show on a STALE branch previews only this session\'s work, never a revert of newer base commits', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const id = await startSession(fx);
  fs.writeFileSync(path.join(fx.wt(id, 'a'), 'mine.txt'), 'mine\n'); // this session's work

  // Someone else lands on origin/main AFTER this branch forked. A two-dot diff vs the
  // tip of origin/main would render their commit backwards, as deletions — an agent
  // reading that preview writes a commit message describing a revert that never happened.
  fs.writeFileSync(path.join(fx.co('a'), 'theirs.txt'), 'theirs\n');
  git(fx.co('a'), ['add', '-A']);
  git(fx.co('a'), ['commit', '-q', '-m', 'feat: theirs']);
  git(fx.co('a'), ['push', '-q', 'origin', 'main']);

  const r = await gw(fx, ['done', id, '--show']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mine\.txt/, "the session's own file must appear");
  assert.doesNotMatch(r.stdout, /theirs\.txt/, "a newer base commit must NEVER appear in the preview");
  assert.doesNotMatch(r.stdout, /^-theirs$/m, 'and must never render as a deletion');
  assert.match(r.stderr, /1 commit\(s\) behind origin\/main/, 'staleness must be surfaced, not silent');
  assert.ok(fs.existsSync(fx.sessionDir(id)), '--show must land nothing');
  assert.equal(git(fx.origin('a'), ['log', '-1', '--format=%s', 'main']), 'feat: theirs', '--show must push nothing');
});

test('done fast-forwards the session\'s UNCHANGED sibling repos before the gate', async () => {
  // The gate of the changed repo reads its sibling (like a fixture-parity test). The
  // sibling moved on origin after the session started; gating against the stale copy
  // failed lands for code that no longer existed on main.
  const fx = makeFixture({ repos: { a: { gate: ['bash', '-c', 'test -f ../b/sibling-new.txt'] }, b: {} } });
  const id = await startSession(fx);
  fs.writeFileSync(path.join(fx.wt(id, 'a'), 'mine.txt'), 'mine\n');
  fs.writeFileSync(path.join(fx.co('b'), 'sibling-new.txt'), 'new\n');
  git(fx.co('b'), ['add', '-A']);
  git(fx.co('b'), ['commit', '-q', '-m', 'feat: sibling moved']);
  git(fx.co('b'), ['push', '-q', 'origin', 'main']);

  const r = await gw(fx, ['done', id, '-m', 'feat: mine']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\[b\] unchanged here — fast-forwarded 1 commit/);
  assert.match(r.stderr, /merged \+ pushed: a/);
  assert.doesNotMatch(r.stderr, /merged \+ pushed: .*b/, 'the unchanged sibling must not be landed');
});

// ── abort safety ─────────────────────────────────────────────────────────────

test('abort --in-claude refuses unlanded work without --yes, discards with it', async () => {
  const fx = makeFixture();
  const id = await startSession(fx);
  fs.writeFileSync(path.join(fx.wt(id, 'a'), 'precious.txt'), 'do not lose\n');

  const refuse = await gw(fx, ['abort', id, '--in-claude']);
  assert.notEqual(refuse.code, 0);
  assert.match(refuse.stderr, /UNLANDED work/);
  assert.match(refuse.stderr, /refusing to discard/);
  assert.ok(fs.existsSync(fx.sessionDir(id)), 'session must survive the refusal');

  const discard = await gw(fx, ['abort', id, '--in-claude', '--yes']);
  assert.equal(discard.code, 0, discard.stderr);
  assert.match(discard.stderr, /discarded/);
  assert.ok(!fs.existsSync(fx.sessionDir(id)));
  assert.equal(git(fx.co('a'), ['branch', '--list', `gw/${id}`]), '', 'branch must be deleted');
});

test('abort with NOTHING unlanded proceeds in --in-claude without --yes; interactive "n" keeps', async () => {
  const fx = makeFixture();
  const id1 = await startSession(fx);
  const clean = await gw(fx, ['abort', id1, '--in-claude']);
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stderr, /discarded/);

  const id2 = await startSession(fx);
  fs.writeFileSync(path.join(fx.wt(id2, 'a'), 'keep.txt'), 'x\n');
  const kept = await gw(fx, ['abort', id2], { stdin: 'n\n' });
  assert.equal(kept.code, 0, kept.stderr);
  assert.match(kept.stderr, /UNLANDED work/, 'summary must be shown before the prompt');
  assert.match(kept.stderr, /kept\./);
  assert.ok(fs.existsSync(fx.sessionDir(id2)));
});

// ── ready (done-done) ────────────────────────────────────────────────────────

test('ready fails while work is unlanded and passes after it lands', async () => {
  const fx = makeFixture();
  const id = await startSession(fx);
  fs.writeFileSync(path.join(fx.wt(id, 'a'), 'wip.txt'), 'x\n');

  const notReady = await gw(fx, ['ready']);
  assert.equal(notReady.code, 1);
  assert.match(notReady.stdout, /NOT done-done/);
  assert.match(notReady.stdout, /has unlanded work/);

  const land = await gw(fx, ['done', id, '-m', 'feat: wip']);
  assert.equal(land.code, 0, land.stderr);

  const ready = await gw(fx, ['ready']);
  assert.equal(ready.code, 0, `${ready.stdout}\n${ready.stderr}`);
  assert.match(ready.stdout, /READY/);
});

// ── agent orchestration: scripted starts + JSON reports ──────────────────────

test('start --prompt --name --json makes a session without cd/launch and prints one JSON record', async () => {
  const fx = makeFixture();
  const r = await gw(fx, ['start', '--prompt', 'add the widget api', '--name', 'widget api', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.directive[0], 'NONE', 'a --json start must not ask the shell to cd or launch');
  const info = JSON.parse(r.stdout); // stdout is ONLY the record
  assert.equal(info.id, 'WT-001-widget-api', '--name is used verbatim (slugified), no namer');
  assert.equal(info.dir, fx.sessionDir(info.id));
  assert.equal(info.branch, `gw/${info.id}`);
  assert.equal(info.resumed, false);
  assert.deepEqual(info.repos.map((x: { key: string }) => x.key), fx.repoKeys);
  for (const repo of info.repos) {
    assert.equal(repo.dir, fx.wt(info.id, repo.key));
    assert.equal(git(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD']), `gw/${info.id}`);
  }
  assert.equal(info.agent, 'claude');
  assert.ok(Array.isArray(info.launcher) && info.launcher[0] === 'claude');
});

test('start --no-launch prints just the session dir; a scripted start inside a worktree makes a NEW session', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const first = await gw(fx, ['start', '--prompt', 'first', '--name', 'first', '--no-launch']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.directive[0], 'NONE');
  const dir = first.stdout.trim();
  assert.equal(dir, fx.sessionDir('WT-001-first'));

  // An orchestrating agent whose shell sits inside WT-001 must not re-enter it.
  const second = await gw(fx, ['start', '--prompt', 'second', '--name', 'second', '--json'], { cwd: fx.wt('WT-001-first', 'a') });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).id, 'WT-002-second');

  // An explicit id with --json reports the existing session instead of launching it.
  const resumed = await gw(fx, ['start', 'WT-001', '--json']);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.directive[0], 'NONE');
  const info = JSON.parse(resumed.stdout);
  assert.equal(info.id, 'WT-001-first');
  assert.equal(info.resumed, true);
});

test('status --json and ready --json report unlanded work; done by id from the root lands it', async () => {
  const fx = makeFixture();
  const id = JSON.parse((await gw(fx, ['start', '--prompt', 'x', '--name', 'orch', '--json'])).stdout).id;
  fs.writeFileSync(path.join(fx.wt(id, 'a'), 'new.txt'), 'hello\n');

  const st = await gw(fx, ['status', '--json']);
  assert.equal(st.code, 0, st.stderr);
  const status = JSON.parse(st.stdout);
  assert.equal(status.root, fx.root);
  const s = status.sessions.find((x: { id: string }) => x.id === id);
  assert.ok(s, 'session listed');
  assert.equal(s.hasUnlandedWork, true);
  const a = s.repos.find((x: { key: string }) => x.key === 'a');
  assert.equal(a.untracked, 1);
  assert.equal(s.repos.find((x: { key: string }) => x.key === 'b').untracked, 0);

  const notReady = await gw(fx, ['ready', '--json']);
  assert.equal(notReady.code, 1, 'unlanded work blocks ready');
  const nr = JSON.parse(notReady.stdout);
  assert.equal(nr.ready, false);
  assert.ok(nr.sessions.some((x: { id: string; blocking: boolean }) => x.id === id && x.blocking));
  assert.ok(nr.problems.length >= 1);

  // Land it from the workspace root (not from inside the session), as an orchestrator would.
  const done = await gw(fx, ['done', id, '--in-agent', '-m', 'feat(a): add new.txt']);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.directive[0], 'NONE');
  assert.equal(git(fx.origin('a'), ['log', '-1', '--format=%s', 'main']), 'feat(a): add new.txt');

  const ready = await gw(fx, ['ready', '--json']);
  assert.equal(ready.code, 0, ready.stdout + ready.stderr);
  const rr = JSON.parse(ready.stdout);
  assert.equal(rr.ready, true);
  assert.deepEqual(rr.sessions, []);
  assert.ok(rr.repos.every((x: { blocking: boolean }) => !x.blocking));
});

test('gw.sh: a non-TTY start never moves the caller shell, and GW_HOME is exported at source time', () => {
  const fx = makeFixture({ repos: { a: {} } });
  const gwSh = path.join(import.meta.dirname, '..', 'gw.sh');
  const script = `source "${gwSh}"; echo "HOME=$GW_HOME"; gw start --prompt t --name shell >/dev/null 2>&1; echo "RC=$?"; echo "PWD=$(pwd -P)"`;
  const { GW_HOME: _h, ...env } = process.env;
  const out = execFileSync('bash', ['--norc', '-c', script], {
    cwd: fx.root, encoding: 'utf8', input: '',
    env: { ...env, GW_ROOT: fx.root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  assert.match(out, new RegExp(`HOME=${path.resolve(import.meta.dirname, '..').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
  assert.match(out, /RC=0\n/);
  assert.equal(out.match(/PWD=(.*)/)![1], fs.realpathSync(fx.root));
  assert.ok(fs.existsSync(fx.wt('WT-001-shell', 'a')), 'the session was still created');
});

// zsh's `pwd -P` succeeds on a deleted cwd, so the old guard never fired there and
// node died with `uv_cwd ENOENT` before gw.ts ran.
for (const sh of ['zsh', 'bash']) {
  test(`gw.sh (${sh}): a deleted cwd is left for the workspace root before node starts`, (t) => {
    try { execFileSync(sh, ['-c', 'true']); } catch { t.skip(`${sh} not installed`); return; }
    const fx = makeFixture({ repos: { a: {} } });
    const gwSh = path.join(import.meta.dirname, '..', 'gw.sh');
    const dead = path.join(fx.root, '.worktrees', 'WT-009-gone');
    fs.mkdirSync(dead, { recursive: true });
    const script = `source "${gwSh}"; cd "${dead}" && rmdir "${dead}" && gw ready >/dev/null 2>&1; echo "RC=$?"; echo "PWD=$(pwd -P)"`;
    const { GW_ROOT: _r, ...env } = process.env;
    const out = execFileSync(sh, sh === 'zsh' ? ['-f', '-c', script] : ['--norc', '-c', script], {
      cwd: fx.root, encoding: 'utf8', input: '',
      env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    assert.match(out, /RC=0\n/);
    assert.equal(out.match(/PWD=(.*)/)![1], fs.realpathSync(fx.root));
  });
}

test('setup maintains ONE gw guidance block in the workspace CLAUDE.md/AGENTS.md without touching the rest', async () => {
  const fx = makeFixture();
  const home = fs.mkdtempSync(path.join(fx.root, 'home-'));
  fs.writeFileSync(path.join(fx.root, 'CLAUDE.md'), '# My project\n\nHand-written notes.\n');

  const first = await gw(fx, ['setup'], { env: { HOME: home, CODEX_HOME: path.join(home, '.codex') } });
  assert.equal(first.code, 0, first.stderr);
  const claude = fs.readFileSync(path.join(fx.root, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith('# My project\n\nHand-written notes.\n'), 'existing content kept');
  assert.match(claude, /<!-- gw:begin[^\n]*-->\n## gw \(Grove Workspace\)/);
  assert.match(claude, /canonical checkouts \(`a\/`, `b\/`\) are READ-ONLY/);
  assert.match(claude, /\/gw-sessions/);
  const agents = fs.readFileSync(path.join(fx.root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('<!-- gw:begin'), 'AGENTS.md created with just the block');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'commands', 'gw-sessions.md')));

  // Edit inside the block is replaced; a second run is idempotent (one block, same bytes).
  fs.writeFileSync(path.join(fx.root, 'CLAUDE.md'), claude.replace('Rule #1', 'STALE') + '\nTrailing notes.\n');
  const second = await gw(fx, ['setup'], { env: { HOME: home, CODEX_HOME: path.join(home, '.codex') } });
  assert.equal(second.code, 0, second.stderr);
  const after2 = fs.readFileSync(path.join(fx.root, 'CLAUDE.md'), 'utf8');
  assert.equal(after2.match(/gw:begin/g)!.length, 1);
  assert.ok(!after2.includes('STALE') && after2.includes('Rule #1'));
  assert.ok(after2.endsWith('\nTrailing notes.\n'), 'content after the block kept');
  await gw(fx, ['setup'], { env: { HOME: home, CODEX_HOME: path.join(home, '.codex') } });
  assert.equal(fs.readFileSync(path.join(fx.root, 'CLAUDE.md'), 'utf8'), after2);
});

// ── herdr: start --herdr opens the session in a new Herdr tab ────────────────
// A fake `herdr` (GW_HERDR_BIN) records each call and answers with herdr-shaped JSON,
// so the whole plan (tab create args, the command typed into the pane) is checked
// without a live Herdr. The recorded pane command is then run for real against a fake
// agent, proving the prompt reaches the agent's argv intact.

function fakeHerdr(root: string): { bin: string; calls: () => string[][] } {
  const log = path.join(root, 'herdr-calls.jsonl');
  const bin = path.join(root, 'fake-herdr');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
// FAKE_BUSY_POLLS: the shell reports an rc child in the foreground for that many polls.
const polls = fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter((l) => l.includes('process-info')).length;
const busy = polls <= Number(process.env.FAKE_BUSY_POLLS || 0);
if (args[1] === 'process-info') {
  console.log(JSON.stringify({ result: { process_info: { shell_pid: 10, foreground_process_group_id: busy ? 11 : 10 } } }));
} else if (args[1] === 'read') {
  console.log(busy ? '' : '~/x $ ');
} else if (args[1] === 'get' && process.env.FAKE_CLOSED) {
  console.error('{"error":"pane not found"}'); process.exit(1);
} else if (args[0] === 'tab' && args[1] === 'create') {
  console.log(JSON.stringify({ id: 'cli:tab:create', result: { tab: { tab_id: 'wT:t42' }, root_pane: { pane_id: 'wT:p7' } } }));
} else console.log(JSON.stringify({ id: 'cli:' + args.slice(0, 2).join(':'), result: {} }));
`, { mode: 0o755 });
  return { bin, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}
const HERDR_ENV = (bin: string) => ({ GW_HERDR_BIN: bin, HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'wT' });

test('start --herdr outside Herdr fails loudly before making any session', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const r = await gw(fx, ['start', '--herdr', '--prompt', 'x', '--name', 'x'], { env: { HERDR_ENV: '', HERDR_WORKSPACE_ID: '' } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--herdr needs a shell inside Herdr/);
  assert.ok(!fs.existsSync(path.join(fx.root, '.worktrees', 'WT-001-x')), 'no session on a refused --herdr');
  const both = await gw(fx, ['start', '--herdr', '--no-launch', '--prompt', 'x', '--name', 'x'], { env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'wT' } });
  assert.notEqual(both.code, 0);
  assert.match(both.stderr, /drop --no-launch/);
});

test('start --herdr opens a tab at the session dir and hands the exact launch + prompt to it', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const herdr = fakeHerdr(fx.root);
  // A fake agent that records its argv, so we see exactly what the tab would launch.
  const argvOut = path.join(fx.root, 'agent-argv.json');
  const agentBin = path.join(fx.root, 'fake-agent');
  fs.writeFileSync(agentBin, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`, { mode: 0o755 });
  const cfg = JSON.parse(fs.readFileSync(path.join(fx.root, 'gw.config.json'), 'utf8'));
  cfg.agents = { fake: { launcher: `${agentBin} --mode auto`, models: ['Big Model (High)'] } };
  fs.writeFileSync(path.join(fx.root, 'gw.config.json'), JSON.stringify(cfg));

  const prompt = `line one\nit's "quoted" with $HOME, \`ticks\` and $(whoami)\n--- trailing rule`;
  const r = await gw(fx, ['start', '--herdr', '--agent', 'fake', '--model', 'Big Model (High)', '--prompt', prompt, '--name', 'hd', '--json'], { env: HERDR_ENV(herdr.bin) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.directive[0], 'NONE', 'the caller shell must not cd or launch');
  const info = JSON.parse(r.stdout);
  assert.equal(info.id, 'WT-001-hd');
  assert.deepEqual(info.herdr, { workspace: 'wT', tab: 'wT:t42', pane: 'wT:p7' });

  const calls = herdr.calls();
  assert.deepEqual(calls[0], ['tab', 'create', '--workspace', 'wT', '--cwd', fx.sessionDir(info.id), '--label', info.id, '--no-focus']);
  const runCall = calls.find((c) => c[1] === 'run')!;
  assert.deepEqual(runCall.slice(0, 3), ['pane', 'run', 'wT:p7']);
  const cmd = runCall[3];
  assert.match(cmd, /^sh '.*\/gw-launch\.sh' '.*\/\.gw-launch'$/);
  assert.ok(!cmd.includes('quoted'), 'the prompt is never typed into the pane');
  const launchFile = path.join(fx.sessionDir(info.id), '.gw-launch');
  assert.equal(fs.statSync(launchFile).mode & 0o777, 0o600);

  // Run what the tab's shell would run, with no gw function around.
  execFileSync('bash', ['--norc', '-c', cmd], { cwd: fx.sessionDir(info.id), env: { PATH: process.env.PATH } });
  const got = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
  assert.deepEqual(got.argv.slice(0, 5), ['--mode', 'auto', '--model', 'Big Model (High)', '--']);
  assert.equal(got.argv.length, 6, 'the prompt is ONE argv word');
  assert.ok(got.argv[5].endsWith(`─── task ───\n${prompt}`), 'same wrapped prompt as an in-place launch, byte for byte');
  assert.ok(!fs.existsSync(launchFile), 'the launch file is consumed so it can never replay');

  // Resume in a tab: same session, resume launcher, no prompt; plain output is "<id>\t<tab>".
  const resumed = await gw(fx, ['start', info.id, '--herdr'], { env: HERDR_ENV(herdr.bin) });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.stdout.trim(), `${info.id}\twT:t42`);
  assert.equal(fs.readFileSync(path.join(fx.sessionDir(info.id), '.gw-launch'), 'utf8').split('\n')[1], '', 'a resume carries no prompt');
});

test('"herdr": true in config makes tabs the default inside Herdr only; --no-herdr and --json opt out', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const herdr = fakeHerdr(fx.root);
  const cfg = JSON.parse(fs.readFileSync(path.join(fx.root, 'gw.config.json'), 'utf8'));
  fs.writeFileSync(path.join(fx.root, 'gw.config.json'), JSON.stringify({ ...cfg, herdr: true }));

  const inTab = await gw(fx, ['start', '--prompt', 'x', '--name', 'one'], { env: HERDR_ENV(herdr.bin) });
  assert.equal(inTab.code, 0, inTab.stderr);
  assert.equal(inTab.directive[0], 'NONE');
  assert.equal(inTab.stdout.trim(), 'WT-001-one\twT:t42');

  const here = await gw(fx, ['start', '--no-herdr', '--prompt', 'x', '--name', 'two'], { env: HERDR_ENV(herdr.bin) });
  assert.equal(here.directive[0], 'CD_AND_LAUNCH', '--no-herdr launches in place');
  const outside = await gw(fx, ['start', '--prompt', 'x', '--name', 'three'], { env: { GW_HERDR_BIN: herdr.bin, HERDR_ENV: '', HERDR_WORKSPACE_ID: '' } });
  assert.equal(outside.directive[0], 'CD_AND_LAUNCH', 'the config default is ignored outside Herdr');
  const json = await gw(fx, ['start', '--prompt', 'x', '--name', 'four', '--json'], { env: HERDR_ENV(herdr.bin) });
  assert.equal(JSON.parse(json.stdout).herdr, undefined, 'a --json orchestrator keeps driving; no tab');
  assert.equal(herdr.calls().filter((c) => c[1] === 'create').length, 1, 'only the first start opened a tab');
});

test('start --herdr: a failed pane run closes the new tab and keeps the session', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const herdr = fakeHerdr(fx.root);
  const src = fs.readFileSync(herdr.bin, 'utf8').replace("} else console.log", "} else if (args[1] === 'run') { console.error('{\"error\":\"pane gone\"}'); process.exit(1); } else console.log");
  fs.writeFileSync(herdr.bin, src);
  const r = await gw(fx, ['start', '--herdr', '--prompt', 'x', '--name', 'bad'], { env: HERDR_ENV(herdr.bin) });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /pane gone/);
  assert.match(r.stderr, /gw start WT-001-bad/);
  assert.deepEqual(herdr.calls().at(-1), ['tab', 'close', 'wT:t42']);
  assert.ok(fs.existsSync(fx.wt('WT-001-bad', 'a')), 'the session survives');
  assert.ok(!fs.existsSync(path.join(fx.sessionDir('WT-001-bad'), '.gw-launch')));
});

test('start --herdr waits for the new shell to reach its prompt before typing, and gives up after the timeout', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const herdr = fakeHerdr(fx.root);
  // The shell's rc keeps a child in the foreground for 3 polls, then a prompt shows.
  const r = await gw(fx, ['start', '--herdr', '--prompt', 'x', '--name', 'slow'], { env: { ...HERDR_ENV(herdr.bin), FAKE_BUSY_POLLS: '3' } });
  assert.equal(r.code, 0, r.stderr);
  const kinds = herdr.calls().map((c) => c[1]);
  const run = kinds.indexOf('run');
  assert.equal(kinds.slice(0, run).filter((k) => k === 'process-info').length, 5, '3 busy polls, then 2 ready ones in a row');
  assert.doesNotMatch(r.stderr, /isn't at a prompt/);

  // A shell that never settles: type anyway after GW_HERDR_READY_MS, and say so.
  const stuck = await gw(fx, ['start', '--herdr', '--prompt', 'x', '--name', 'stuck'], { env: { ...HERDR_ENV(herdr.bin), FAKE_BUSY_POLLS: '1000', GW_HERDR_READY_MS: '300' } });
  assert.equal(stuck.code, 0, stuck.stderr);
  assert.match(stuck.stderr, /isn't at a prompt yet; sending the launch anyway/);
  assert.equal(herdr.calls().filter((c) => c[1] === 'run').length, 2);
});

test('status records the Herdr tab a session was opened in, and whether its pane is still open', async () => {
  const fx = makeFixture({ repos: { a: {} } });
  const herdr = fakeHerdr(fx.root);
  await gw(fx, ['start', '--prompt', 'x', '--name', 'plain', '--json']);
  const r = await gw(fx, ['start', '--herdr', '--prompt', 'x', '--name', 'tabbed'], { env: HERDR_ENV(herdr.bin) });
  assert.equal(r.code, 0, r.stderr);

  const status = async (env: Record<string, string>) => {
    const s = await gw(fx, ['status', '--json'], { env });
    assert.equal(s.code, 0, s.stderr);
    return Object.fromEntries(JSON.parse(s.stdout).sessions.map((x: { id: string; herdr: unknown }) => [x.id, x.herdr]));
  };
  const live = await status(HERDR_ENV(herdr.bin));
  assert.equal(live['WT-001-plain'], null);
  const rec = live['WT-002-tabbed'] as { tab: string; pane: string; workspace: string; openedAt: number; open: boolean };
  assert.deepEqual({ ...rec, openedAt: 0 }, { workspace: 'wT', tab: 'wT:t42', pane: 'wT:p7', openedAt: 0, open: true });
  assert.ok(rec.openedAt > 0);
  assert.equal((await status({ ...HERDR_ENV(herdr.bin), FAKE_CLOSED: '1' }))['WT-002-tabbed'].open, false);
  assert.equal((await status({ HERDR_ENV: '', HERDR_WORKSPACE_ID: '' }))['WT-002-tabbed'].open, null, 'outside Herdr it cannot tell');

  const human = await gw(fx, ['status'], { env: { ...HERDR_ENV(herdr.bin), FAKE_CLOSED: '1' } });
  assert.match(human.stdout, /WT-002-tabbed {2}\(herdr tab wT:t42, pane wT:p7, closed\)/);
});
