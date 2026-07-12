/**
 * prompt-box — a tiny, zero-dependency terminal editor used by `gw start`.
 *
 * Draws a bordered multi-line edit box, optional aligned choice rows (the
 * agent/model picker), and [Go] / [Cancel] buttons:
 *
 *   Enter starting prompt: (empty = plain session)
 *   ╭──────────────────────────────────────────╮
 *   │ fix the thing where…█                    │
 *   │                                          │
 *   ╰──────────────────────────────────────────╯
 *    Claude:  fable       opus          ▐sonnet▌       haiku
 *    Codex:   gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna  gpt-5.5  gpt-5.4  gpt-5.4-mini
 *    [ Go ]  [ Cancel ]
 *    Tab: move · Enter: newline · Ctrl+D: Go · Ctrl+C: cancel
 *
 * Tab / Shift+Tab cycle focus edit → model → Go → Cancel; on the model row ←/→
 * (or a letter, or 1-9) pick and Enter advances to [Go]. So the flow reads top to
 * bottom: write the prompt, choose the model, Go. Typing while a button is focused
 * jumps back into the editor.
 *
 * Editing: soft word wrap at spaces (a word only splits when it can't fit a row),
 * arrows / Home / End / PgUp / PgDn move, Ctrl/Alt+←/→ (and Alt+B/F) move by word,
 * Ctrl+Home/End jump to start/end of the whole prompt, Backspace/Delete,
 * Ctrl+W / Alt+Backspace (kill word left), Ctrl+A/E (row home/end), Ctrl+K (kill to
 * end of line), Ctrl+U (kill to start of line), Ctrl+Z / Ctrl+Y (undo / redo — a run
 * of typing undoes as one). The display viewport scrolls, so huge pastes are fine.
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

const ROWS = 8;             // visible editor rows (content scrolls beyond this)
const BASE_H = ROWS + 5;    // header + top border + ROWS + bottom border + buttons + hint
const PASTE_END = `${ESC}[201~`;
const UNDO_MAX = 200;

type Focus = 'edit' | 'model' | 'go' | 'cancel';
interface DRow { line: number; start: number; text: string; last: boolean } // last = final row of its logical line
interface Snap { lines: string[]; cl: number; cc: number }

export interface PromptBoxChoices {
  header?: string;    // label for a legacy single row, e.g. "Model:"
  options?: string[]; // legacy single-row choices
  rows?: Array<{ header: string; options: string[] }>;
  initial?: number;  // index selected on open (default 0)
}
export interface PromptBoxOptions {
  header?: string;
  maxLen?: number;
  color?: string;
  choices?: PromptBoxChoices; // omit for a plain prompt box with no choice row
}
export interface PromptBoxResult {
  text: string;
  /** The picked option, or null when the box was built without `choices`. */
  choice: string | null;
  /** Flat index across all choice rows. */
  choiceIndex: number | null;
}

/** Run the editor. Resolves with the (trimmed) text + choice on Go, or null on Cancel. */
export function promptBox(opts: PromptBoxOptions = {}): Promise<PromptBoxResult | null> {
  const header = opts.header ?? 'Enter starting prompt:';
  const maxLen = opts.maxLen ?? 100_000;
  const ORANGE = opts.color ?? DEFAULT_ORANGE;
  const choices = opts.choices ?? null;
  const choiceRows = choices?.rows?.length
    ? choices.rows.filter(r => r.options.length)
    : choices?.options?.length ? [{ header: choices.header ?? '', options: choices.options }] : [];
  const flatChoices = choiceRows.flatMap(r => r.options);
  const BLOCK_H = BASE_H + choiceRows.length;
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
  let sel = flatChoices.length ? Math.max(0, Math.min(flatChoices.length - 1, choices?.initial ?? 0)) : 0;
  const undo: Snap[] = [], redo: Snap[] = [];
  let lastKind = '';         // edit kind of the previous mutation, for undo coalescing

  const isHigh = (c: string | undefined): boolean => c !== undefined && c >= '\ud800' && c <= '\udbff';
  const isLow = (c: string | undefined): boolean => c !== undefined && c >= '\udc00' && c <= '\udfff';
  const text = (): string => lines.join('\n');

  // ── undo ──
  // A snapshot per mutation, except that a run of same-kind edits (typing char after
  // char, backspacing over a word) coalesces into one entry — so Ctrl+Z undoes the run,
  // not one keystroke. Snapshots are whole-buffer copies: simple, and at a 100k cap the
  // memory is irrelevant next to the terminal it's drawn in.
  function mark(kind: string): void {
    redo.length = 0;
    if (kind !== '' && kind === lastKind) return;
    lastKind = kind;
    undo.push({ lines: lines.slice(), cl, cc });
    if (undo.length > UNDO_MAX) undo.shift();
  }
  function restoreSnap(from: Snap[], to: Snap[]): void {
    const s = from.pop();
    if (!s) return;
    to.push({ lines: lines.slice(), cl, cc });
    lines = s.lines.slice(); cl = s.cl; cc = s.cc;
    lastKind = ''; // the next edit always starts a fresh coalescing run
  }

  // ── layout: soft-wrap logical lines into display rows of width W, breaking at
  // spaces where possible (a word longer than a row still hard-breaks at W) ──
  const innerW = (): number => Math.max(20, (err.columns || 80) - 4);
  function layout(W: number): DRow[] {
    const rows: DRow[] = [];
    for (let li = 0; li < lines.length; li++) {
      const s = lines[li];
      let pos = 0;
      do {
        let end: number;
        if (s.length - pos <= W) end = s.length;
        else {
          // Break AFTER the last space that still fits, so the space stays on this row
          // and the next row starts on a word. No space in reach → hard break at W.
          end = -1;
          for (let i = pos + W - 1; i > pos; i--) if (s[i] === ' ') { end = i + 1; break; }
          if (end <= pos) end = pos + W;
        }
        rows.push({ line: li, start: pos, text: s.slice(pos, end), last: end >= s.length });
        pos = end;
      } while (pos < s.length);
      // A last row that exactly fills the width leaves the end-of-line cursor with
      // nowhere to sit — give it an empty tail row.
      const tail = rows[rows.length - 1];
      if (tail.text.length === W) { tail.last = false; rows.push({ line: li, start: s.length, text: '', last: true }); }
    }
    return rows;
  }
  /** Display row index of the cursor: the LAST row of its line starting at or before cc. */
  function cursorRow(lay: DRow[]): number {
    let r = 0;
    for (let i = 0; i < lay.length; i++) {
      if (lay[i].line < cl) continue;
      if (lay[i].line > cl) break;
      if (lay[i].start <= cc) r = i;
    }
    return r;
  }
  function cursorRC(lay: DRow[]): [number, number] {
    const r = cursorRow(lay);
    return [r, cc - lay[r].start];
  }
  /** Rightmost column the cursor may occupy on a row: past the text on a line's final
   *  row, else just past its last non-space char (the wrap point IS the next row's col 0). */
  function maxCol(row: DRow): number {
    return row.last ? row.text.length : row.text.replace(/ +$/, '').length;
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
  // Word motion: back over any run of spaces, then over the word itself (and across a
  // line break when already at an edge) — the shell/editor convention.
  function wordLeftCol(): number {
    const s = lines[cl];
    let i = cc;
    while (i > 0 && s[i - 1] === ' ') i--;
    while (i > 0 && s[i - 1] !== ' ') i--;
    return i;
  }
  function wordLeft(): void {
    if (cc === 0) { moveLeft(); return; }
    cc = wordLeftCol();
  }
  function wordRight(): void {
    const s = lines[cl];
    if (cc === s.length) { moveRight(); return; }
    let i = cc;
    while (i < s.length && s[i] === ' ') i++;
    while (i < s.length && s[i] !== ' ') i++;
    cc = i;
  }
  function killWordLeft(): void {
    if (cc === 0) { backspace(); return; }
    const i = wordLeftCol();
    lines[cl] = lines[cl].slice(0, i) + lines[cl].slice(cc);
    cc = i;
  }
  function moveVert(dy: number): void {
    const lay = layout(innerW()), [r, x] = cursorRC(lay);
    const row = lay[Math.max(0, Math.min(lay.length - 1, r + dy))];
    cl = row.line;
    cc = row.start + Math.min(x, maxCol(row));
  }
  function rowHome(): void { const lay = layout(innerW()); cc = lay[cursorRow(lay)].start; }
  function rowEnd(): void { const lay = layout(innerW()), row = lay[cursorRow(lay)]; cc = row.start + maxCol(row); }
  function docHome(): void { cl = 0; cc = 0; }
  function docEnd(): void { cl = lines.length - 1; cc = lines[cl].length; }

  // ── render: redraw the whole fixed-height block in place ──
  function render(): void {
    const W = innerW(), lay = layout(W), [cr, cx] = cursorRC(lay);
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
    if (choiceRows.length) {
      const headerW = Math.max(...choiceRows.map(r => r.header.length));
      const colW = Array.from({ length: Math.max(...choiceRows.map(r => r.options.length)) }, (_, col) =>
        Math.max(...choiceRows.map(r => r.options[col]?.length ?? 0)));
      let offset = 0;
      for (const row of choiceRows) {
        const opts = row.options.map((o, col) => {
          const i = offset + col;
          const padded = o.padEnd(colW[col]);
          return i !== sel ? `${DIM} ${padded} ${RESET}`
            : focus === 'model' ? `${ORANGE}${INV}${BOLD} ${padded} ${RESET}`
              : `${ORANGE}${BOLD} ${padded} ${RESET}`;
        });
        out.push(`  ${focus === 'model' ? BOLD : DIM}${row.header.padEnd(headerW)}${RESET} ${opts.join(' ')}${focus === 'model' && offset <= sel && sel < offset + row.options.length ? `  ${DIM}←/→ · ↑/↓ · Enter${RESET}` : ''}`);
        offset += row.options.length;
      }
    }
    const btn = (label: string, focused: boolean): string =>
      focused ? `${ORANGE}${INV}${BOLD} ${label} ${RESET}` : `${DIM}[${RESET} ${label} ${DIM}]${RESET}`;
    out.push(`  ${btn('Go', focus === 'go')}  ${btn('Cancel', focus === 'cancel')}`);
    out.push(`${DIM}Tab: move · Enter: newline · Ctrl+Z: undo · Ctrl+D: Go · Ctrl+C: cancel${RESET}`);

    w(`${drawn ? `${ESC}[${BLOCK_H}A` : ''}${out.map((l) => `\r${ESC}[2K${l}`).join('\n')}\n`);
    drawn = true;
  }

  // ── input: parse one ESC sequence from the head of buf ──
  // Returns null while the sequence is still incomplete (wait for more bytes);
  // key '' means "recognized and swallowed" (runaway sequences). An ESC followed by a
  // plain char is an Alt-chord and comes back as key "\x1b<char>".
  function parseEsc(buf: string): { consume: number; key: string } | null {
    if (buf.length < 2) return null;
    const c1 = buf[1];
    if (c1 !== '[' && c1 !== 'O') return { consume: 2, key: `${ESC}${c1}` };
    let i = 2, params = '';
    while (i < buf.length) {
      const code = buf.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return { consume: i + 1, key: `[${params}${buf[i]}` };
      params += buf[i]; i++;
      if (i > 32) return { consume: i, key: '' };
    }
    return null;
  }

  const cycle: Focus[] = flatChoices.length ? ['edit', 'model', 'go', 'cancel'] : ['edit', 'go', 'cancel'];
  const step = (d: number): void => { focus = cycle[(cycle.indexOf(focus) + d + cycle.length) % cycle.length]; };
  const selectedRC = (): [number, number] => {
    let offset = 0;
    for (let row = 0; row < choiceRows.length; row++) {
      if (sel < offset + choiceRows[row].options.length) return [row, sel - offset];
      offset += choiceRows[row].options.length;
    }
    return [0, 0];
  };
  const rowOffset = (row: number): number => choiceRows.slice(0, row).reduce((n, r) => n + r.options.length, 0);
  const pick = (d: number): void => {
    if (!flatChoices.length) return;
    const [row, col] = selectedRC(), n = choiceRows[row].options.length;
    sel = rowOffset(row) + (col + d + n) % n;
  };
  const pickRow = (d: number): void => {
    if (choiceRows.length < 2) return;
    const [row, col] = selectedRC();
    const next = (row + d + choiceRows.length) % choiceRows.length;
    sel = rowOffset(next) + Math.min(col, choiceRows[next].options.length - 1);
  };

  return new Promise<PromptBoxResult | null>((resolve) => {
    // Restore the terminal on EVERY exit path — including a crash — so a bug here
    // can never leave the user's shell in raw/paste mode with a hidden cursor.
    const restore = (): void => {
      try { stdin.setRawMode(false); } catch { /* already closed */ }
      w(`${ESC}[?2004l${ESC}[?25h`);
    };
    const finish = (result: PromptBoxResult | null): void => {
      if (done) return;
      done = true;
      stdin.removeListener('data', onData);
      err.removeListener('resize', onResize);
      process.removeListener('exit', restore);
      restore();
      stdin.pause();
      resolve(result);
    };
    const submit = (): void => finish({
      text: text().slice(0, maxLen).trim(),
      choice: flatChoices.length ? flatChoices[sel] : null,
      choiceIndex: flatChoices.length ? sel : null,
    });

    function key(k: string): void {
      // Alt-chords: word motion / word kill, the readline bindings.
      if (k[0] === ESC) {
        const c = k[1].toLowerCase();
        if (focus !== 'edit') return;
        if (c === 'b') { wordLeft(); return; }
        if (c === 'f') { wordRight(); return; }
        if (c === '\x7f' || c === '\b') { mark('killword'); killWordLeft(); return; } // Alt+Backspace
        return;
      }
      // CSI keys. A modifier param (';5' Ctrl, ';3' Alt, ';7' Ctrl+Alt) turns the arrow
      // and Home/End keys into their word / whole-prompt variants.
      const mod = k.slice(1, -1).split(';')[1] ?? '';
      const jump = mod === '3' || mod === '5' || mod === '7';
      if (k.endsWith('~')) {
        switch (k.slice(1, -1).split(';')[0]) {
          case '1': case '7': if (focus === 'edit') { if (jump) docHome(); else rowHome(); } return;
          case '4': case '8': if (focus === 'edit') { if (jump) docEnd(); else rowEnd(); } return;
          case '3': focus = 'edit'; mark('del'); del(); return;
          case '5': if (focus === 'edit') moveVert(-ROWS); return;
          case '6': if (focus === 'edit') moveVert(ROWS); return;
          case '200': paste = true; return;
          default: return;
        }
      }
      switch (k[k.length - 1]) {
        case 'A': if (focus === 'edit') moveVert(-1); else if (focus === 'model') pickRow(-1); else step(-1); return; // ↑
        case 'B': if (focus === 'edit') moveVert(1); else if (focus === 'model') pickRow(1); else step(1); return;   // ↓
        case 'C': if (focus === 'edit') { if (jump) wordRight(); else moveRight(); }             // →
          else if (focus === 'model') pick(1);
          else focus = 'cancel';
          return;
        case 'D': if (focus === 'edit') { if (jump) wordLeft(); else moveLeft(); }               // ←
          else if (focus === 'model') pick(-1);
          else focus = 'go';
          return;
        case 'H': if (focus === 'edit') { if (jump) docHome(); else rowHome(); } return;
        case 'F': if (focus === 'edit') { if (jump) docEnd(); else rowEnd(); } return;
        case 'Z': step(-1); return;                                                              // Shift+Tab
        default: return;
      }
    }

    function plain(ch: string): void {
      const code = ch.codePointAt(0)!;
      if (code === 3) return finish(null);                              // Ctrl+C
      if (code === 4) return submit();                                  // Ctrl+D
      if (code === 9) { step(1); return; }                              // Tab
      if (code === 13 || code === 10) {                                 // Enter
        if (focus === 'go') return submit();
        if (focus === 'cancel') return finish(null);
        if (focus === 'model') { focus = 'go'; return; }                // picked — step to [Go]
        // Lone "." just typed = finish (compat with the pre-box reader).
        if (lines[cl] === '.' && cc === 1) { lines.splice(cl, 1); if (!lines.length) lines = ['']; cl = Math.max(0, cl - 1); cc = lines[cl].length; return submit(); }
        mark('nl'); insertText('\n'); return;
      }
      if (focus === 'model') {                                          // choose without leaving the row
        const opts = flatChoices;
        if (ch >= '1' && ch <= '9') { const i = code - 49; if (i < opts.length) sel = i; return; }
        const c = ch.toLowerCase();
        if (c >= 'a' && c <= 'z') { // jump to the NEXT option with this initial (cycling)
          for (let d = 1; d <= opts.length; d++) {
            const i = (sel + d) % opts.length;
            if (opts[i].toLowerCase().startsWith(c)) { sel = i; return; }
          }
        }
        return;
      }
      if (focus !== 'edit' && code >= 32) focus = 'edit';               // typing returns to the editor
      if (code === 127 || code === 8) { mark('bs'); backspace(); return; }
      if (code === 23) { mark('killword'); killWordLeft(); return; }    // Ctrl+W
      if (code === 26) { restoreSnap(undo, redo); return; }             // Ctrl+Z
      if (code === 25) { restoreSnap(redo, undo); return; }             // Ctrl+Y
      if (code === 1) { rowHome(); return; }                            // Ctrl+A
      if (code === 5) { rowEnd(); return; }                             // Ctrl+E
      if (code === 11) { mark('kill'); lines[cl] = lines[cl].slice(0, cc); return; }  // Ctrl+K
      if (code === 21) { mark('kill'); lines[cl] = lines[cl].slice(cc); cc = 0; return; } // Ctrl+U
      if (code === 9 || code >= 32) { mark('ins'); insertText(ch); }
    }

    const onData = (chunk: string): void => {
      pend += chunk;
      while (pend && !done) {
        if (paste) {
          const i = pend.indexOf(PASTE_END);
          if (i >= 0) { mark('paste'); insertText(pend.slice(0, i)); pend = pend.slice(i + PASTE_END.length); paste = false; continue; }
          // Hold back any suffix that could be the start of the end marker.
          let hold = 0;
          for (let k = Math.min(pend.length, PASTE_END.length - 1); k > 0; k--) {
            if (PASTE_END.startsWith(pend.slice(pend.length - k))) { hold = k; break; }
          }
          mark('paste');
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
