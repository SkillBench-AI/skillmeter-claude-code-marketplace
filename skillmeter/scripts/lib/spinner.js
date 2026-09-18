/**
 * Show a TTY spinner and return stop(), which clears the line.
 * Do nothing when stdout is not a TTY.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
const ESC_HIDE_CURSOR = "\x1b[?25l";
const ESC_SHOW_CURSOR = "\x1b[?25h";
const ESC_CLEAR_LINE = "\r\x1b[2K";

function startSpinner(message) {
  const out = process.stdout;
  if (!out.isTTY) {
    // No-op: a single static line so the user knows something is happening
    // even in a buffered runner. Animation frames would be useless.
    out.write(`${message}...\n`);
    return () => {};
  }

  const started = Date.now();
  let frame = 0;
  out.write(ESC_HIDE_CURSOR);

  const render = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    out.write(`${ESC_CLEAR_LINE}${FRAMES[frame % FRAMES.length]}  ${message} [${seconds}s]`);
    frame += 1;
  };
  render();
  const handle = setInterval(render, FRAME_MS);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
    out.write(ESC_CLEAR_LINE);
    out.write(ESC_SHOW_CURSOR);
  };

  // Belt-and-suspenders: if the process dies mid-spin, restore the cursor.
  process.once("exit", stop);
  process.once("SIGINT", () => { stop(); process.exit(130); });

  return stop;
}

module.exports = { startSpinner };
