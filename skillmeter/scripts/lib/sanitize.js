/**
 * Sanitisation primitives for logs and transcripts. Consolidates the
 * previously-separate sanitizer.js module plus the tool-data path hashing
 * that used to live inline in logger.js.
 */

const crypto = require("crypto");
const fs = require("fs");

/**
 * Hash a string using HMAC-SHA256 with salt (first 12 chars).
 * Matches the VS Code extension's HashingService.hash() so the same input
 * salt + string produces the same token across client surfaces.
 */
function hashHmac(str, salt) {
  if (!str || !salt) return "";
  return crypto.createHmac("sha256", salt).update(str).digest("hex").slice(0, 12);
}

// Keys in tool_input / tool_response whose values contain sensitive paths
// and should be HMAC-hashed before the event ships off the machine.
const PATH_KEYS = new Set(["file_path", "filePath", "path", "command"]);

/**
 * Sanitize a tool object by hashing path values.
 * Leaves non-path keys and non-string values untouched.
 */
function sanitizeToolData(obj, hashSalt) {
  if (!obj || typeof obj !== "object") return obj;

  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (PATH_KEYS.has(key) && typeof val === "string") {
      result[key] = hashHmac(val, hashSalt);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Sanitize a single parsed transcript line by hashing the cwd field.
 */
function sanitizeLine(obj, hashSalt) {
  if (obj.cwd && typeof obj.cwd === "string") {
    obj.cwd = hashHmac(obj.cwd, hashSalt);
  }
  return obj;
}

/**
 * Sanitize a JSONL transcript file, returning the sanitized content as a
 * Buffer. Malformed lines are skipped individually so a single corrupt
 * entry (e.g. trailing partial line from a crashed writer) doesn't abort
 * the whole upload.
 */
function sanitizeTranscript(transcriptPath, hashSalt) {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n");
  const output = [];
  let malformed = 0;

  for (const line of lines) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      output.push(JSON.stringify(sanitizeLine(obj, hashSalt)));
    } catch {
      malformed++;
    }
  }

  if (malformed > 0) {
    process.stderr.write(
      `[skillmeter] transcript: dropped ${malformed} malformed line(s) during sanitize\n`
    );
  }

  return Buffer.from(output.join("\n") + "\n", "utf8");
}

module.exports = {
  PATH_KEYS,
  hashHmac,
  sanitizeToolData,
  sanitizeLine,
  sanitizeTranscript,
};
