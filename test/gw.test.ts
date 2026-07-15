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
  assert.match(Buffer.from(started.directive[3], 'base64').toString('utf8'), /^codex$/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(fx.sessionDir(id), '.gw-agent.json'), 'utf8')),
    { agent: 'codex', model: null },
  );

  const resumed = await gw(fx, ['start', id]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(Buffer.from(resumed.directive[3], 'base64').toString('utf8'), 'codex\nresume\n--last');

  const clean = await gw(fx, ['start', id, '--no-continue']);
  assert.equal(clean.code, 0, clean.stderr);
  assert.equal(Buffer.from(clean.directive[3], 'base64').toString('utf8'), 'codex');
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
