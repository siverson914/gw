/**
 * pick-box — a tiny, zero-dependency one-line horizontal selector, companion to
 * prompt-box. Used by `gw start` to choose the agent model:
 *
 *   Model:  default   opus  ▐sonnet▌  haiku   fable    ←/→ · Enter
 *
 * Keys: ←/→ (or Tab / Shift+Tab) move, Home/End jump, a letter jumps to the next
 * option starting with it, 1-9 pick by position, Enter or Ctrl+D confirms,
 * Ctrl+C cancels (resolves null). Any other input is swallowed.
 *
 * Same conventions as prompt-box: hand-rolled (gw stays dependency-free), draws
 * on stderr, raw mode + hidden cursor are restored on EVERY exit path including
 * a crash, redraws its single line in place with \r + erase-line.
 */

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const INV = `${ESC}[7m`;
const DEFAULT_ORANGE = `${ESC}[38;2;242;101;34m`; // Porsche Signal Orange #f26522

export interface PickBoxOptions {
  header: string;      // label drawn before the options, e.g. "Model:"
  options: string[];   // the choices, in display order
  initial?: number;    // index the cursor starts on (default 0)
  color?: string;      // ANSI color for the selection highlight
  hint?: string;       // trailing dim hint (default "←/→ · Enter")
}

/** Run the selector. Resolves with the chosen option, or null on Ctrl+C. */
export function pickBox(opts: PickBoxOptions): Promise<string | null> {
  const { header, options } = opts;
  const ORANGE = opts.color ?? DEFAULT_ORANGE;
  const hint = opts.hint ?? '←/→ · Enter';
  const stdin = process.stdin;
  const err = process.stderr;
  const w = (s: string): boolean => err.write(s);
  if (!stdin.isTTY) throw new Error('pickBox needs a TTY — decide without a picker instead.');
  if (!options.length) throw new Error('pickBox needs at least one option.');

  let sel = Math.max(0, Math.min(options.length - 1, opts.initial ?? 0));
  let pend = '';
  let done = false;

  function render(final = false): void {
    const parts = options.map((o, i) =>
      i === sel ? `${ORANGE}${INV}${BOLD} ${o} ${RESET}` : `${DIM} ${o} ${RESET}`);
    w(`\r${ESC}[2K${BOLD}${header}${RESET} ${parts.join(' ')}${final ? '' : `  ${DIM}${hint}${RESET}`}${final ? '\n' : ''}`);
  }

  // Same CSI parser as prompt-box: null = incomplete (wait for more bytes),
  // key '' = recognized and swallowed.
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
    const restore = (): void => {
      try { stdin.setRawMode(false); } catch { /* already closed */ }
      w(`${ESC}[?25h`);
    };
    const finish = (result: string | null): void => {
      if (done) return;
      done = true;
      stdin.removeListener('data', onData);
      process.removeListener('exit', restore);
      render(true); // leave the final choice visible, hint dropped
      restore();
      stdin.pause();
      resolve(result);
    };

    function key(k: string): void {
      switch (k[k.length - 1]) {
        case 'D': sel = (sel + options.length - 1) % options.length; return; // ←
        case 'C': sel = (sel + 1) % options.length; return;                  // →
        case 'H': sel = 0; return;                                           // Home
        case 'F': sel = options.length - 1; return;                          // End
        case 'Z': sel = (sel + options.length - 1) % options.length; return; // Shift+Tab
        case '~': { // Home/End also arrive as [1~ / [4~ on some terminals
          const p = k.slice(1, -1).split(';')[0];
          if (p === '1' || p === '7') sel = 0;
          else if (p === '4' || p === '8') sel = options.length - 1;
          return;
        }
        default: return;
      }
    }

    function plain(ch: string): void {
      const code = ch.codePointAt(0)!;
      if (code === 3) return finish(null);                          // Ctrl+C
      if (code === 4 || code === 13 || code === 10) return finish(options[sel]); // Ctrl+D / Enter
      if (code === 9) { sel = (sel + 1) % options.length; return; } // Tab
      if (ch >= '1' && ch <= '9') { const i = code - 49; if (i < options.length) sel = i; return; }
      // A letter jumps to the NEXT option starting with it (cycling, so a repeated
      // letter walks through same-initial options).
      const c = ch.toLowerCase();
      if (c >= 'a' && c <= 'z') {
        for (let d = 1; d <= options.length; d++) {
          const i = (sel + d) % options.length;
          if (options[i].toLowerCase().startsWith(c)) { sel = i; return; }
        }
      }
    }

    const onData = (chunk: string): void => {
      pend += chunk;
      while (pend && !done) {
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
      if (!done) render();
    };

    process.once('exit', restore);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    w(`${ESC}[?25l`); // hide the real cursor; the highlight IS the cursor
    render();
  });
}
