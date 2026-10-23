"use strict";
// Path policy: segment hashing with the shared vocabulary, whole-value hashing
// for cwd-like keys, the home prefix in free text, and counts.path.
const { isolateHome } = require("../../test-support/plugin.cjs");
isolateHome({ device_id: "TEST-DEVICE", hash_salt: "deadbeefsalt" });

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SALT, HEX, HOME_DEPENDENT, SAMPLES, POLICY_VERSION } = require("../../test-support/sanitizer.cjs");
const s = require("../../scripts/lib/sanitize");
const rules = require("../../scripts/lib/rules");
const logger = require("../../scripts/logger");
const VOCAB = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "lib", "path-vocabulary.json"), "utf8"));

const HOME = require("node:os").homedir();
const homeHash = s.hashHmac(HOME, SALT);
const re = source => new RegExp(`^${source}$`);

test("home-prefixed file path: home is one unit, names are hashed, structure and extension survive", HOME_DEPENDENT, () => {
  const out = s.hashPathSegments(`${HOME}/work/acme-portal/src/billing/invoice-acme.ts`, SALT);
  assert.match(out, re(`${homeHash}/work/${HEX}/src/billing/${HEX}\\.ts`));
  assert.equal(out.includes("acme"), false);
  assert.equal(out.includes(HOME), false);
});

test("vocabulary, version-like and structural segments stay in clear", () => {
  assert.equal(s.hashPathSegments("src/index.ts", SALT), "src/index.ts");
  assert.equal(s.hashPathSegments("api/v2/1.2.0/README.md", SALT), "api/v2/1.2.0/README.md");
  assert.match(s.hashPathSegments("../src/thing.ts", SALT), re(`\\.\\./src/${HEX}\\.ts`));
  assert.match(s.hashPathSegments("./thing", SALT), re(`\\./${HEX}`));
  assert.equal(s.hashPathSegments("packages/api/package.json", SALT), "packages/api/package.json");
});

test("compound extensions and dotfiles", () => {
  assert.match(s.hashPathSegments("src/App.test.tsx", SALT), re(`src/${HEX}\\.test\\.tsx`));
  assert.match(s.hashPathSegments("types/foo.d.ts", SALT), re(`types/${HEX}\\.d\\.ts`));
  assert.equal(s.hashPathSegments("proj/.env", SALT).endsWith("/.env"), true, "well-known dotfile kept");
  assert.match(s.hashPathSegments("proj/.secretrc", SALT), re(`${HEX}/${HEX}`), "unknown dotfile hashed whole");
  assert.match(s.hashPathSegments("proj/Makefile.local", SALT), re(`${HEX}/${HEX}\\.local`));
});

test("absolute paths outside home and another user's home", () => {
  assert.match(s.hashPathSegments("/opt/acme/app.py", SALT), re(`/opt/${HEX}/app\\.py`));
  const other = s.hashPathSegments("/Users/otheruser/notes/journal.md", SALT);
  assert.match(other, re(`/Users/${HEX}/${HEX}/${HEX}\\.md`));
  assert.equal(other.includes("otheruser"), false);
});

test("Windows and UNC paths: drive letter and prefix kept, separators normalised, names hashed", () => {
  const out = s.hashPathSegments("C:\\Users\\jane\\code\\Acme\\report.xlsx", SALT);
  assert.match(out, re(`C:/Users/${HEX}/code/${HEX}/${HEX}\\.xlsx`));
  assert.equal(out.includes("jane"), false);
  const unc = s.hashPathSegments("\\\\fileserver\\share\\report.xlsx", SALT);
  assert.match(unc, re(`//${HEX}/${HEX}/${HEX}\\.xlsx`));
  assert.equal(unc.includes("fileserver"), false);
});

test("trailing separators are preserved and inner repeats collapse", HOME_DEPENDENT, () => {
  assert.match(s.hashPathSegments("/opt/acme/src/", SALT), re(`/opt/${HEX}/src/`));
  assert.match(s.hashPathSegments("/opt//acme///x.py", SALT), re(`/opt/${HEX}/${HEX}\\.py`));
  assert.equal(s.hashPathSegments("/", SALT), "/");
  assert.equal(s.hashPathSegments(HOME, SALT), homeHash);
  assert.equal(s.hashPathSegments(`${HOME}/`, SALT), `${homeHash}/`);
  assert.match(s.hashPathSegments(`${HOME}/work/`, SALT), re(`${homeHash}/work/`));
});

test("the same segment hashes to the same value wherever it appears", () => {
  const a = s.hashPathSegments("/opt/acme/src/a.ts", SALT).split("/")[2];
  const b = s.hashPathSegments("/var/acme/lib/b.ts", SALT).split("/")[2];
  assert.equal(a, b);
  assert.notEqual(a, s.hashPathSegments("/opt/other/src/a.ts", SALT).split("/")[2]);
});

test("bare numeric identifiers are hashed; dotted or v-prefixed versions are kept", () => {
  const card = s.hashPathSegments("/accounts/4111111111111111/file.txt", SALT);
  assert.match(card, re(`/accounts/${HEX}/${HEX}\\.txt`));
  assert.equal(card.includes("4111"), false);
  assert.match(s.hashPathSegments("/users/123456789/data/file.json", SALT), re(`/users/${HEX}/data/${HEX}\\.json`));
  assert.equal(s.hashPathSegments("api/v2/1.2.0/x", SALT).startsWith("api/v2/1.2.0/"), true);
  assert.match(s.hashPathSegments("releases/2026/notes.txt", SALT), re(`releases/${HEX}/${HEX}\\.txt`));
});

test("without a salt path hashing fails closed to an empty value and no count", () => {
  assert.equal(s.hashPathSegments("/Users/me/a.js", ""), "");
  const { value, meta } = s.sanitizeEventData({ cwd: "/Users/me/x", path: "" }, "");
  assert.equal(value.cwd, "");
  assert.equal(meta.counts.path, 0);
  assert.ok(s.scrubString(`key ${SAMPLES.jwt}`, "").includes("[REDACTED_SECRET]"), "secrets are still redacted");
});

test("scrubString hashes the home prefix in free text and keeps the tail", HOME_DEPENDENT, () => {
  const input = `${HOME}/vscode/proj/file.js`;
  const out = s.scrubString(input, SALT);
  assert.equal(out.includes(HOME), false);
  assert.ok(out.endsWith("/vscode/proj/file.js"));
  assert.equal(out, s.scrubString(input, SALT), "deterministic under one salt");
});

test("segment keys are segment-hashed; cwd-like and generic path keys are whole-value hashes", HOME_DEPENDENT, () => {
  const { value } = s.sanitizeEventData({
    cwd: `${HOME}/work/acme`, old_cwd: "/Users/example/project", new_cwd: "/Users/example/project/src",
    tool_input: {
      file_path: `${HOME}/work/acme/src/billing/invoice.ts`,
      notebook_path: `${HOME}/work/acme/nb/analysis.ipynb`,
      edits: [{ file_path: `${HOME}/work/acme/src/b.js` }],
      path: `${HOME}/work/acme/src`,
      command: `cat ${HOME}/work/acme/src/billing/invoice.ts`,
    },
  }, SALT);
  const ti = value.tool_input;
  assert.match(ti.file_path, re(`${homeHash}/work/${HEX}/src/billing/${HEX}\\.ts`));
  assert.match(ti.notebook_path, re(`${homeHash}/work/${HEX}/${HEX}/${HEX}\\.ipynb`));
  assert.match(ti.edits[0].file_path, re(`${homeHash}/work/${HEX}/src/${HEX}\\.js`));
  assert.match(ti.path, re(HEX), "generic path key is a whole-value hash");
  for (const key of ["cwd", "old_cwd", "new_cwd"]) assert.match(value[key], re(HEX), key);
  assert.notEqual(value.old_cwd, value.new_cwd);
  assert.equal(ti.command, `cat ${homeHash}/work/acme/src/billing/invoice.ts`, "free text: home prefix only");
  assert.equal(JSON.stringify({ ...ti, command: undefined }).includes("invoice"), false);
  assert.match(s.sanitizeLine({ type: "user", cwd: `${HOME}/vscode/proj` }, SALT).cwd, re(HEX), "same rule at the transcript boundary");
});

test("commands are scrubbed for content, not hashed whole", () => {
  const { value } = s.sanitizeEventData({ tool_input: { command: `curl -H "Authorization: Bearer ${SAMPLES.jwt}" https://api.x` } }, SALT);
  assert.ok(value.tool_input.command.startsWith("curl -H"));
  assert.ok(value.tool_input.command.includes("[REDACTED_SECRET]"));
  assert.equal(value.tool_input.command.includes(SAMPLES.jwt), false);
});

test("counts.path tallies segment hashes, whole-value hashes and home-prefix replacements", HOME_DEPENDENT, () => {
  const { meta } = s.sanitizeEventData({
    cwd: `${HOME}/work/acme`,
    tool_input: { file_path: `${HOME}/work/acme/src/invoice.ts`, command: `cd ${HOME}/work && cat ${HOME}/notes.txt` },
  }, SALT);
  assert.equal(meta.counts.path, 6, "cwd (1) + home, acme, invoice (3) + two home prefixes in the command");
  assert.equal(meta.secrets, 0);
  assert.equal(meta.pii, 0);
  assert.deepEqual(meta.ids, [], "path hashing is not a detector id");
  assert.equal(meta.policyVersion, POLICY_VERSION);
  assert.ok(rules.KINDS.includes("path"));
  assert.equal(s.sanitizeEventData({ plain: "nothing" }, SALT).meta.counts.path, 0);
  const keyed = s.sanitizeEventData({ toolUseResult: { [`${HOME}/work/acme/README.md`]: { size: 1 } } }, SALT);
  assert.ok(Object.keys(keyed.value.toolUseResult)[0].startsWith(homeHash + "/"), "object keys are hashed too");
  assert.equal(keyed.meta.counts.path, 1);
});

test("a second pass hashes stamped path values again and never restores them", HOME_DEPENDENT, () => {
  const first = s.sanitizeEventData({ tool_input: { file_path: `${HOME}/work/acme/src/x.ts`, edits: [{ file_path: "/opt/acme/y.py" }] }, cwd: `${HOME}/w` }, SALT);
  const second = s.sanitizeEventData(first.value, SALT);
  assert.notEqual(second.value.tool_input.file_path, first.value.tool_input.file_path);
  assert.notEqual(second.value.cwd, first.value.cwd);
  assert.deepEqual(second.value._sanitization, first.value._sanitization, "first-pass stamp kept");
  assert.equal(JSON.stringify(second.value).includes("acme"), false);
  const stamped = s.sanitizeEventData({ file_path: `${HOME}/work/a.ts` }, SALT).value;
  const { value, meta } = s.sanitizeEventData({ ...stamped, file_path: `${HOME}/work/new-secret-project/b.ts` }, SALT);
  assert.match(value.file_path, re(`${homeHash}/work/${HEX}/${HEX}\\.ts`));
  assert.equal(JSON.stringify(value).includes("new-secret-project"), false);
  assert.equal(meta.counts.path, 3);
});

test("the vocabulary file is lowercase, unique, short, and its patterns behave", () => {
  for (const list of [VOCAB.directories, VOCAB.files, VOCAB.compound_extensions]) {
    for (const t of list) {
      assert.equal(t, t.toLowerCase(), `${t} must be lowercase`);
      assert.equal(/\s/.test(t), false, `${t} must not contain whitespace`);
      assert.ok(t.length <= 32 && !t.includes("@"), `${t} is not a short technical word`);
    }
  }
  assert.equal(new Set(VOCAB.directories).size, VOCAB.directories.length);
  assert.equal(new Set(VOCAB.files).size, VOCAB.files.length);
  for (const ce of VOCAB.compound_extensions) assert.ok(ce.startsWith("."), ce);
  const version = new RegExp(VOCAB.version_pattern);
  for (const ok of ["v1", "v12", "1.2.0", "1.2.3.4", "v2.1"]) assert.ok(version.test(ok), ok);
  for (const no of ["2", "2026", "123456789", "4111111111111111", "2026-09-11", "v1beta", "1_2", "acme2"]) {
    assert.equal(version.test(no), false, `${no} must be hashed`);
  }
  const structural = new RegExp(VOCAB.structural_pattern);
  for (const ok of [".", "..", "~", "C:", "d:"]) assert.ok(structural.test(ok), ok);
  assert.equal(structural.test("..."), false);
});

test("sanitizeToolData hashes every path-like key by the shared policy and leaves the rest alone", () => {
  const input = {
    file_path: "/Users/dev/secret/app.ts", filePath: "/Users/dev/secret/other.ts", path: "/etc/passwd",
    command: "cat ~/.aws/credentials", cwd: "/Users/dev/secret-project", patch: "*** Update File: /Users/dev/secret/app.ts",
    tool_name: "Bash", description: "run the deploy script", count: 3, enabled: true, nothing: null,
    nested: { command: "ls /secret", args: [{ path: "/a/b" }, { path: "/c/d" }] }, numeric: { command: 42, path: { nested: "/a" } },
  };
  const out = logger.sanitizeToolData(input, SALT);
  for (const key of ["file_path", "filePath", "path", "command", "cwd", "patch"]) {
    const expected = ["file_path", "filePath"].includes(key) ? s.hashPathSegments(input[key], SALT) : logger.hashHmac(input[key], SALT);
    assert.equal(out[key], expected, `${key} follows the shared path policy`);
  }
  for (const key of ["tool_name", "description", "count", "enabled", "nothing"]) assert.deepEqual(out[key], input[key]);
  assert.match(out.nested.command, re(HEX));
  assert.match(out.nested.args[1].path, re(HEX));
  assert.equal(out.numeric.command, 42, "non-string values are not hashed");
  assert.equal(out.numeric.path.nested, "/a", "objects under a path key recurse");
  for (const scalar of [null, undefined, "a string", 7]) assert.equal(logger.sanitizeToolData(scalar, SALT), scalar);
  assert.notEqual(logger.sanitizeToolData({ command: "rm -rf /" }, "salt-a").command,
    logger.sanitizeToolData({ command: "rm -rf /" }, "salt-b").command, "hashes depend on the salt");
});
