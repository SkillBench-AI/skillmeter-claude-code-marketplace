/**
 * Scan historical sessions and check repository ownership using lib/repo-scope.
 * Read cwd from transcript records: encoded directory names lose literal dashes.
 * Directory-name decoding is only a fallback when no record supplies cwd.
 * Repositories must still exist locally to verify their remotes; otherwise skip.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { getRepoScopeDecision } = require("./repo-scope");

const CLAUDE_PROJECTS_DIR = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  "projects"
);

// How many bytes to read from a transcript while hunting for the first cwd
// field. Claude Code writes cwd on user/assistant message records, which
// usually appear within the first few KB. 64 KB is generous without forcing
// us to slurp multi-MB transcripts during the scan.
const CWD_PROBE_BYTES = 64 * 1024;

// Sessions are stored as `<uuid>.jsonl`. Anything else in the project dir
// (sub-folders, lock files, etc.) is ignored.
const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

function readHeadBytes(filePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.slice(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Pull the canonical cwd out of a transcript by scanning the first
 * CWD_PROBE_BYTES for a JSON `"cwd":"..."` field. Returns "" when none found.
 */
function readCwdFromTranscript(transcriptPath) {
  const head = readHeadBytes(transcriptPath, CWD_PROBE_BYTES);
  if (!head) return "";
  const match = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return "";
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return "";
  }
}

/**
 * Best-effort reverse of Claude Code's dir encoding (`/` → `-`). Lossy when
 * the original path contained dashes — used only as a fallback when no
 * transcript in the directory yields a cwd.
 */
function decodeDirNameToCwd(dirName) {
  if (!dirName) return "";
  // Encoded names start with a leading `-` representing the root slash.
  if (!dirName.startsWith("-")) return "";
  return "/" + dirName.slice(1).replace(/-/g, "/");
}

function listProjectDirs(projectsDir) {
  try {
    return fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listSessionFiles(projectDir) {
  try {
    return fs.readdirSync(projectDir)
      .filter((name) => SESSION_FILE_RE.test(name))
      .map((name) => path.join(projectDir, name));
  } catch {
    return [];
  }
}

/**
 * Resolve a project directory's canonical cwd by probing its session
 * transcripts. Returns "" when no transcript yields one and the dir-name
 * fallback can't be verified against the filesystem.
 */
function resolveCwdForProject(projectDir, dirName) {
  const sessions = listSessionFiles(projectDir);
  for (const file of sessions) {
    const cwd = readCwdFromTranscript(file);
    if (cwd) return cwd;
  }
  const decoded = decodeDirNameToCwd(dirName);
  if (decoded && fs.existsSync(decoded)) return decoded;
  return "";
}

/**
 * Scan `~/.claude/projects/` and partition every session JSONL into
 * `included` (org-allowed) or `skipped` (out-of-scope, no repo, etc.).
 *
 * Returns:
 *   {
 *     included: Array<{ sessionFile, sessionId, cwd, repoRoot, remoteOrg, repoKey }>,
 *     skipped:  Array<{ sessionFile, cwd, reason }>,
 *     summary:  {
 *       projectsScanned, sessionsIncluded, sessionsSkipped,
 *       skippedByReason: { [classification]: count }
 *     }
 *   }
 */
function scanHistoricalSessions({
  projectsDir = CLAUDE_PROJECTS_DIR,
  getScopeDecision = getRepoScopeDecision,
  allowedRepoKeys = null,
  cutoffAt = Infinity,
  excludeSessionId = "",
} = {}) {
  const included = [];
  const skipped = [];
  const skippedByReason = {};

  const projectDirNames = listProjectDirs(projectsDir);

  for (const dirName of projectDirNames) {
    const projectDir = path.join(projectsDir, dirName);
    const sessions = listSessionFiles(projectDir);
    if (sessions.length === 0) continue;

    const cwd = resolveCwdForProject(projectDir, dirName);

    // One scope decision per project — every session in this directory shares
    // the same cwd, so we don't re-walk `.git/config` per session.
    const decision = cwd
      ? getScopeDecision(cwd)
      : { allowed: false, classification: "no_cwd" };

    if (decision.allowed) {
      for (const sessionFile of sessions) {
        const sessionId = path.basename(sessionFile, ".jsonl");
        let reason = "";
        if (
          allowedRepoKeys instanceof Set &&
          !allowedRepoKeys.has(decision.repoKey)
        ) {
          reason = "repository_not_selected";
        } else if (excludeSessionId && sessionId === excludeSessionId) {
          reason = "active_session";
        } else {
          try {
            if (fs.statSync(sessionFile).mtimeMs > cutoffAt) {
              reason = "modified_after_cutoff";
            }
          } catch {
            reason = "unreadable";
          }
        }
        if (reason) {
          skipped.push({ sessionFile, cwd, reason });
          skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
          continue;
        }
        included.push({
          sessionFile,
          sessionId,
          cwd,
          repoRoot: decision.repoRoot,
          remoteOrg: decision.remoteOrg,
          repoKey: decision.repoKey,
        });
      }
    } else {
      const reason = decision.classification || "unknown";
      skippedByReason[reason] = (skippedByReason[reason] || 0) + sessions.length;
      for (const sessionFile of sessions) {
        skipped.push({ sessionFile, cwd, reason });
      }
    }
  }

  return {
    included,
    skipped,
    summary: {
      projectsScanned: projectDirNames.length,
      sessionsIncluded: included.length,
      sessionsSkipped: skipped.length,
      skippedByReason,
    },
  };
}

module.exports = {
  scanHistoricalSessions,
};
