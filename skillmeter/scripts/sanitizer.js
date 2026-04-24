const crypto = require("crypto");

/**
 * Hash a string using HMAC-SHA256 with salt (first 12 chars)
 * @param {string} str - String to hash
 * @param {string} salt - HMAC salt
 * @returns {string} First 12 characters of HMAC-SHA256 hash
 */
function hashHmac(str, salt) {
  if (!str || !salt) return "";
  return crypto.createHmac("sha256", salt).update(str).digest("hex").slice(0, 12);
}

/**
 * Sanitize a single parsed transcript line by hashing the cwd field.
 * @param {object} obj - Parsed JSON line from transcript
 * @param {string} hashSalt - HMAC salt
 * @returns {object} Sanitized object
 */
function sanitizeLine(obj, hashSalt) {
  if (obj.cwd && typeof obj.cwd === "string") {
    obj.cwd = hashHmac(obj.cwd, hashSalt);
  }
  return obj;
}

/**
 * Sanitize a JSONL transcript file, returning the sanitized content as a Buffer.
 * @param {string} transcriptPath - Path to the JSONL transcript file
 * @param {string} hashSalt - HMAC salt
 * @returns {Buffer} Sanitized JSONL content
 */
function sanitizeTranscript(transcriptPath, hashSalt) {
  const fs = require("fs");
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n");
  const output = [];
  let malformed = 0;

  for (const line of lines) {
    if (!line) continue;
    // JSONL written by a crashing or concurrent writer can include a
    // trailing partial line or embedded bad bytes. Drop only the offending
    // line so one corrupt entry doesn't lose the whole transcript.
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

module.exports = { sanitizeTranscript, sanitizeLine };
