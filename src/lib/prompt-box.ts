/**
 * prompt-box — a tiny, zero-dependency terminal editor used by `gw start`.
 *
 * Draws a bordered multi-line edit box with [Go] / [Cancel] buttons:
 *
 *   Enter starting prompt: (empty = plain session)
 *   ╭──────────────────────────────────────────╮
 *   │ fix the thing where…█                    │
 *   │                                          │
 *   ╰──────────────────────────────────────────╯
 *    [ Go ]  [ Cancel ]
 *    Tab: buttons · Enter: newline · Ctrl+D: Go · Ctrl+C: cancel
 *
 * Editing: arrows / Home / End / PgUp / PgDn move (soft-wrapped display with a
 * scrolling viewport, so huge pastes are fine), Backspace/Delete, Ctrl+A/E
 * (home/end), Ctrl+K (kill to end of line), Ctrl+U (kill to start of line).
 * Tab / Shift+Tab cycle focus edit → Go → Cancel; Enter on a button fires it.
 * Typing while a button is focused jumps back into the editor.
 *
 * Finish signals, newest to oldest: Enter on [Go]; Ctrl+D; a typed line
 * containing only "." (kept for muscle memory from the pre-box reader — raw
 * Ctrl-D delivery is unreliable under WSL/ConPTY, which is why the dot
 * sentinel existed). Cancel: Enter on [Cancel], or Ctrl+C.
 *
 * Paste safety: bracketed paste mode is enabled, so pasted newlines insert
 * literally (they never trigger the dot sentinel or button focus) and a
 * multi-megabyte paste inserts as chunks, capped at maxLen.
 *
 * Why hand-rolled: the only consumers are gw's interactive moments, and gw
 * stays dependency-free. Rendering redraws a fixed-height block in place via
 * relative cursor moves; the real cursor stays hidden and an inverse-video cell
 * marks the edit position. Known cosmetic limit: double-width glyphs (CJK/emoji)
 * count as one column, so lines containing them can wrap a cell early — content
 * is still correct.
 */

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const INV = `${ESC}[7m`;
const DEFAULT_ORANGE = `${ESC}[38;2;242;101;34m`; // Porsche Signal Orange #f26522

const ROWS = 8;            // visible editor rows (content scrolls beyond this)
const BLOCK_H = ROWS + 5;  // header + top border + ROWS + bottom border + buttons + hint
const PASTE_END = `${ESC}[201~`;

type Focus = 'edit' | 'go' | 'cancel';
interface DRow { line: number; start: number; text: string }

export interface PromptBoxOptions { header?: string; maxLen?: number; color?: string }

/** Run the editor. Resolves with the (trimmed) text on Go, or null on Cancel. */
export function promptBox(opts: PromptBoxOptions = {}): Promise<string | null> {
  const header = opts.header ?? 'Enter starting prompt:';
  const maxLen = opts.maxLen ?? 100_000;
  const ORANGE = opts.color ?? DEFAULT_ORANGE;
  const stdin = process.stdin;
  const err = process.stderr;
  const w = (s: string): boolean => err.write(s);
  if (!stdin.isTTY) throw new Error('promptBox needs a TTY — use a piped reader instead.');

  // ── editor state ──
  let lines: string[] = [''];
  let cl = 0, cc = 0;        // cursor: logical line / column (UTF-16 units)
  let top = 0;               // first visible display row
  let focus: Focus = 'edit';
  let truncated = false;
  let pend = '';             // unconsumed input (escape sequences can split across chunks)
  let paste = false;         // inside a bracketed paste
  let drawn = false;
  let done = false;

  const isHigh = (c: string | undefined): boolean => c !== undefined && c >= '\ud800' && c <= '\udbff';
  const isLow = (c: string | undefined): boolean => c !== undefined && c >= '\udc00' && c <= '\udfff';
  const text = (): string => lines.join('\n');

  // ── layout: soft-wrap logical lines into display rows of width W ──
  const innerW = (): number => Math.max(20, Math.min((err.columns || 80) - 4, 96));
  function layout(W: number): DRow[] {
    const rows: DRow[] = [];
    for (let li = 0; li < lines.length; li++) {
      const s = lines[li];
      const n = Math.floor(s.length / W) + 1; // always ≥1; an exactly-full row gets an empty tail row so the cursor can sit past it
      for (let k = 0; k < n; k++) rows.push({ line: li, start: k * W, text: s.slice(k * W, (k + 1) * W) });
    }
    return rows;
  }
  function cursorRC(W: number): [number, number] {
    let base = 0;
    for (let li = 0; li < cl; li++) base += Math.floor(lines[li].length / W) + 1;
    return [base + Math.floor(cc / W), cc % W];
  }

  // ── edits ──
  function insertText(raw: string): void {
    let s = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    s = [...s].filter((ch) => ch === '\n' || ch === '\t' || ch.codePointAt(0)! >= 32).join('');
    const room = maxLen - text().length;
    if (s.length > room) { s = s.slice(0, Math.max(0, room)); truncated = true; }
    if (!s) return;
    const before = lines[cl].slice(0, cc), after = lines[cl].slice(cc);
    const parts = s.split('\n');
    if (parts.length === 1) { lines[cl] = before + parts[0] + after; cc += parts[0].length; }
    else {
      const last = parts[parts.length - 1];
      lines.splice(cl, 1, before + parts[0], ...parts.slice(1, -1), last + after);
      cl += parts.length - 1; cc = last.length;
    }
  }
  function backspace(): void {
    if (cc > 0) { const n = cc > 1 && isLow(lines[cl][cc - 1]) ? 2 : 1; lines[cl] = lines[cl].slice(0, cc - n) + lines[cl].slice(cc); cc -= n; }
    else if (cl > 0) { cc = lines[cl - 1].length; lines[cl - 1] += lines[cl]; lines.splice(cl, 1); cl--; }
  }
  function del(): void {
    const s = lines[cl];
    if (cc < s.length) { const n = isHigh(s[cc]) && cc + 1 < s.length ? 2 : 1; lines[cl] = s.slice(0, cc) + s.slice(cc + n); }
    else if (cl < lines.length - 1) { lines[cl] += lines[cl + 1]; lines.splice(cl + 1, 1); }
  }
  function moveLeft(): void {
    if (cc > 0) cc -= cc > 1 && isLow(lines[cl][cc - 1]) ? 2 : 1;
    else if (cl > 0) { cl--; cc = lines[cl].length; }
  }
  function moveRight(): void {
    const s = lines[cl];
    if (cc < s.length) cc += isHigh(s[cc]) && cc + 1 < s.length ? 2 : 1;
    else if (cl < lines.length - 1) { cl++; cc = 0; }
  }
  function moveVert(dy: number): void {
    const W = innerW(), lay = layout(W), [r, x] = cursorRC(W);
    const row = lay[Math.max(0, Math.min(lay.length - 1, r + dy))];
    cl = row.line;
    cc = Math.min(row.start + x, row.start + row.text.length);
  }
  function rowHome(): void { const W = innerW(); cc = Math.floor(cc / W) * W; }
  function rowEnd(): void { const W = innerW(); cc = Math.min(Math.floor(cc / W) * W + W, lines[cl].length); }

  // ── render: redraw the whole fixed-height block in place ──
  function render(): void {
    const W = innerW(), lay = layout(W), [cr, cx] = cursorRC(W);
    if (cr < top) top = cr;
    if (cr >= top + ROWS) top = cr - ROWS + 1;
    top = Math.max(0, Math.min(top, Math.max(0, lay.length - ROWS)));

    const out: string[] = [];
    out.push(`${BOLD}${header}${RESET} ${DIM}(empty = plain session)${RESET}`);
    out.push(`${ORANGE}╭${'─'.repeat(W + 2)}╮${RESET}`);
    for (let i = 0; i < ROWS; i++) {
      const r = lay[top + i];
      let body: string;
      if (!r) body = ' '.repeat(W + 2);
      else {
        const t = (r.text.replaceAll('\t', ' ') + ' '.repeat(W)).slice(0, W); // tabs render 1 cell; pad to W
        body = focus === 'edit' && top + i === cr
          ? ` ${t.slice(0, cx)}${INV}${t[cx]}${RESET}${t.slice(cx + 1)} `
          : ` ${t} `;
      }
      out.push(`${ORANGE}│${RESET}${body}${ORANGE}│${RESET}`);
    }
    const n = text().length;
    const info = n ? ` ${lay.length > ROWS ? `row ${cr + 1}/${lay.length} · ` : ''}${n.toLocaleString('en-US')} chars${truncated ? ` · TRUNCATED at ${maxLen.toLocaleString('en-US')}` : ''} ` : '';
    out.push(`${ORANGE}╰${'─'.repeat(Math.max(0, W - info.length))}${RESET}${DIM}${info}${RESET}${ORANGE}──╯${RESET}`);
    const btn = (label: string, focused: boolean): string =>
      focused ? `${ORANGE}${INV}${BOLD} ${label} ${RESET}` : `${DIM}[${RESET} ${label} ${DIM}]${RESET}`;
    out.push(`  ${btn('Go', focus === 'go')}  ${btn('Cancel', focus === 'cancel')}`);
    out.push(`${DIM}Tab: buttons · Enter: newline · Ctrl+D: Go · Ctrl+C: cancel${RESET}`);

    w(`${drawn ? `${ESC}[${BLOCK_H}A` : ''}${out.map((l) => `\r${ESC}[2K${l}`).join('\n')}\n`);
    drawn = true;
  }

  // ── input: parse one ESC sequence from the head of buf ──
  // Returns null while the sequence is still incomplete (wait for more bytes);
  // key '' means "recognized and swallowed" (Alt-chords, runaway sequences).
  function parseEsc(buf: string): { consume: number; key: string } | null {
    if (buf.length < 2) return null;
    const c1 = buf[1];
    if (c1 !== '[' && c1 !== 'O') return { consume: 2, key: '' };
    let i = 2, params = '';
    while (i < buf.length) {
      const code = buf.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return { consume: i + 1, key: `[${params}${buf[i]}` };
      params += buf[i]; i++;
      if (i > 32) return { consume: i, key: '' };
    }
    return null;
  }

  return new Promise<string | null>((resolve) => {
    // Restore the terminal on EVERY exit path — including a crash — so a bug here
    // can never leave the user's shell in raw/paste mode with a hidden cursor.
    const restore = (): void => {
      try { stdin.setRawMode(false); } catch { /* already closed */ }
      w(`${ESC}[?2004l${ESC}[?25h`);
    };
    const finish = (result: string | null): void => {
      if (done) return;
      done = true;
      stdin.removeListener('data', onData);
      err.removeListener('resize', onResize);
      process.removeListener('exit', restore);
      restore();
      stdin.pause();
      resolve(result);
    };
    const submit = (): void => finish(text().slice(0, maxLen).trim());

    function key(k: string): void {
      // CSI keys, modifiers ignored: '[1;5C' (Ctrl+→) acts as '[C'.
      if (k.endsWith('~')) {
        switch (k.slice(1, -1).split(';')[0]) {
          case '1': case '7': rowHome(); return;
          case '4': case '8': rowEnd(); return;
          case '3': focus = 'edit'; del(); return;
          case '5': moveVert(-ROWS); return;
          case '6': moveVert(ROWS); return;
          case '200': paste = true; return;
          default: return;
        }
      }
      switch (k[k.length - 1]) {
        case 'A': if (focus === 'edit') moveVert(-1); else focus = 'edit'; return;
        case 'B': if (focus === 'edit') moveVert(1); return;
        case 'C': if (focus === 'edit') moveRight(); else focus = 'cancel'; return;
        case 'D': if (focus === 'edit') moveLeft(); else focus = 'go'; return;
        case 'H': rowHome(); return;
        case 'F': rowEnd(); return;
        case 'Z': focus = focus === 'edit' ? 'cancel' : focus === 'cancel' ? 'go' : 'edit'; return; // Shift+Tab
        default: return;
      }
    }

    function plain(ch: string): void {
      const code = ch.codePointAt(0)!;
      if (code === 3) return finish(null);                              // Ctrl+C
      if (code === 4) return submit();                                  // Ctrl+D
      if (code === 9) { focus = focus === 'edit' ? 'go' : focus === 'go' ? 'cancel' : 'edit'; return; } // Tab
      if (code === 13 || code === 10) {                                 // Enter
        if (focus === 'go') return submit();
        if (focus === 'cancel') return finish(null);
        // Lone "." just typed = finish (compat with the pre-box reader).
        if (lines[cl] === '.' && cc === 1) { lines.splice(cl, 1); if (!lines.length) lines = ['']; cl = Math.max(0, cl - 1); cc = lines[cl].length; return submit(); }
        insertText('\n'); return;
      }
      if (focus !== 'edit' && code >= 32) focus = 'edit';               // typing returns to the editor
      if (code === 127 || code === 8) { backspace(); return; }
      if (code === 1) { rowHome(); return; }                            // Ctrl+A
      if (code === 5) { rowEnd(); return; }                             // Ctrl+E
      if (code === 11) { lines[cl] = lines[cl].slice(0, cc); return; }  // Ctrl+K
      if (code === 21) { lines[cl] = lines[cl].slice(cc); cc = 0; return; } // Ctrl+U
      if (code === 9 || code >= 32) insertText(ch);
    }

    const onData = (chunk: string): void => {
      pend += chunk;
      while (pend && !done) {
        if (paste) {
          const i = pend.indexOf(PASTE_END);
          if (i >= 0) { insertText(pend.slice(0, i)); pend = pend.slice(i + PASTE_END.length); paste = false; continue; }
          // Hold back any suffix that could be the start of the end marker.
          let hold = 0;
          for (let k = Math.min(pend.length, PASTE_END.length - 1); k > 0; k--) {
            if (PASTE_END.startsWith(pend.slice(pend.length - k))) { hold = k; break; }
          }
          insertText(pend.slice(0, pend.length - hold));
          pend = pend.slice(pend.length - hold);
          break;
        }
        if (pend[0] === ESC) {
          const m = parseEsc(pend);
          if (!m) break; // incomplete sequence — wait for the next chunk
          pend = pend.slice(m.consume);
          if (m.key) key(m.key);
          continue;
        }
        const ch = pend[0]; pend = pend.slice(1);
        plain(ch);
      }
      // No redraw while a paste is still streaming in: rendering per chunk floods
      // the pty's output side while its input side is saturated, which can wedge
      // the whole terminal on a very large paste. One render when the end marker
      // lands shows the final state (and is faster anyway).
      if (!done && !paste) render();
    };
    const onResize = (): void => { if (drawn) { w(`${ESC}[${BLOCK_H}A\r${ESC}[0J`); drawn = false; } render(); };

    process.once('exit', restore);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    err.on('resize', onResize);
    w(`${ESC}[?2004h${ESC}[?25l`); // bracketed paste on, real cursor hidden (we draw our own)
    render();
  });
}
