/**
 * Shared low-level I/O helpers. This is a LEAF module — it imports only Node
 * built-ins (fs/path/process) and nothing from the plugin, so any module
 * (credstore, paths, harness, settings, repo-scope, …) can require it without
 * risking an import cycle.
 */

const fs = require("fs");
const path = require("path");

/**
 * Read and JSON-parse a file, returning `fallback` on any error (missing file,
 * malformed JSON, permission denied). Consolidates the many
 * `try { JSON.parse(readFileSync(p)) } catch { return null/{} }` copies.
 * @param {string} file
 * @param {*} [fallback=null] value returned on any read/parse failure
 */
function safeReadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Atomic JSON write: write to a sibling tempfile, fsync, then rename into place.
 * POSIX rename within the same filesystem is atomic — readers see either the old
 * file or the new file, never a partial write. Concurrent writers can still lose
 * updates; eliminating that requires a file lock (separate follow-up). The
 * directory is created 0o700 and the file written 0o600.
 */
function atomicWriteJson(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tempPath = `${file}.tmp.${process.pid}.${Date.now()}`;
  let fd;
  try {
    fd = fs.openSync(tempPath, "w", 0o600);
    fs.writeSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, file);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

/**
 * Read all of stdin and JSON-parse it. Rejects on malformed JSON (matching the
 * hooks' prior behavior). Options tune the two edge cases the callers differ on:
 * @param {object}  [opts]
 * @param {*} [opts.tty=null]   value resolved when stdin is a TTY (no piped input)
 * @param {*} [opts.empty=null] value resolved when stdin is empty
 */
function readStdinJson({ tty = null, empty = null } = {}) {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve(tty);
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : empty);
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on("error", reject);
  });
}

/**
 * Walk up from `startPath` until a directory containing a `.git` marker is
 * found. Returns "" when not inside a repo. If `startPath` is a file (or can't
 * be stat'd), the walk begins from its parent directory.
 */
function findGitRoot(startPath) {
  if (!startPath || typeof startPath !== "string") return "";

  let current = path.resolve(startPath);
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

module.exports = {
  safeReadJson,
  atomicWriteJson,
  readStdinJson,
  findGitRoot,
};
