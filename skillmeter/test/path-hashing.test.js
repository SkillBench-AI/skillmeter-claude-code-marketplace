"use strict";

// Segment-wise path hashing (policy 3.1.0, ADR 002 amendment decision 6):
// structure, extension and shared vocabulary survive; every other segment is
// its own HMAC; cwd-type and generic `path` keys stay whole-value hashes;
// counts.path tallies every path HMAC.
// Run: node --test skillmeter/test/path-hashing.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const s = require("../scripts/lib/sanitize");
const rules = require("../scripts/lib/rules");
const VOCAB = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "scripts", "lib", "path-vocabulary.json"), "utf8")
);

const SALT = "deadbeefcafe";
const HOME = os.homedir();
const HEX = "[0-9a-f]{12}";
const homeHash = s.hashHmac(HOME, SALT);

// --- hashPathSegments -------------------------------------------------------

test("home-prefixed file path: home is one unit, names are hashed, structure and extension survive", () => {
  const out = s.hashPathSegments(`${HOME}/work/acme-portal/src/billing/invoice-acme.ts`, SALT);
  // `work`, `src`, `billing` are vocabulary; `acme-portal` and `invoice-acme` are not.
  assert.match(out, new RegExp(`^${homeHash}/work/${HEX}/src/billing/${HEX}\\.ts$`));
  assert.equal(out.includes("acme"), false);
  assert.equal(out.includes(HOME), false);
});

test("vocabulary, version-like and structural segments stay in clear", () => {
  assert.equal(s.hashPathSegments("src/index.ts", SALT), "src/index.ts");
  assert.equal(s.hashPathSegments("api/v2/1.2.0/README.md", SALT), "api/v2/1.2.0/README.md");
  assert.match(s.hashPathSegments("../src/thing.ts", SALT), new RegExp(`^\\.\\./src/${HEX}\\.ts$`));
  assert.match(s.hashPathSegments("./thing", SALT), new RegExp(`^\\./${HEX}$`));
  assert.equal(s.hashPathSegments("packages/api/package.json", SALT), "packages/api/package.json");
});

test("compound extensions and dotfiles", () => {
  assert.match(s.hashPathSegments("src/App.test.tsx", SALT), new RegExp(`^src/${HEX}\\.test\\.tsx$`));
  assert.match(s.hashPathSegments("types/foo.d.ts", SALT), new RegExp(`^types/${HEX}\\.d\\.ts$`));
  assert.equal(s.hashPathSegments("proj/.env", SALT).endsWith("/.env"), true, "well-known dotfile kept");
  assert.match(s.hashPathSegments("proj/.secretrc", SALT), new RegExp(`^${HEX}/${HEX}$`), "unknown dotfile hashed whole, no extension split");
  assert.match(s.hashPathSegments("proj/Makefile.local", SALT), new RegExp(`^${HEX}/${HEX}\\.local$`));
});

test("absolute paths outside home and another user's home", () => {
  assert.match(s.hashPathSegments("/opt/acme/app.py", SALT), new RegExp(`^/opt/${HEX}/app\\.py$`));
  // `journal.md` is not a well-known file name (`todo.md` would be kept as vocabulary).
  const other = s.hashPathSegments("/Users/otheruser/notes/journal.md", SALT);
  assert.match(other, new RegExp(`^/Users/${HEX}/${HEX}/${HEX}\\.md$`));
  assert.equal(other.includes("otheruser"), false);
});

test("Windows paths: drive letter kept, separators normalised, names hashed", () => {
  const out = s.hashPathSegments("C:\\Users\\jane\\code\\Acme\\report.xlsx", SALT);
  assert.match(out, new RegExp(`^C:/Users/${HEX}/code/${HEX}/${HEX}\\.xlsx$`));
  assert.equal(out.includes("jane"), false);
});

test("the same segment hashes to the same value wherever it appears (directory identity)", () => {
  const a = s.hashPathSegments("/opt/acme/src/a.ts", SALT).split("/")[2];
  const b = s.hashPathSegments("/var/acme/lib/b.ts", SALT).split("/")[2];
  assert.equal(a, b);
  assert.notEqual(a, s.hashPathSegments("/opt/other/src/a.ts", SALT).split("/")[2]);
});

test("no salt: fail closed to an empty value, as before", () => {
  assert.equal(s.hashPathSegments("/Users/me/a.js", ""), "");
});

test("looksSegmentHashed recognises its own output and rejects raw paths", () => {
  const out = s.hashPathSegments(`${HOME}/work/acme/src/x.ts`, SALT);
  assert.equal(s.looksSegmentHashed(out), true);
  assert.equal(s.looksSegmentHashed(`${HOME}/work/acme/src/x.ts`), false);
  assert.equal(s.looksSegmentHashed("/Users/otheruser/x.ts"), false);
  assert.equal(s.looksSegmentHashed("src/index.ts"), true, "all-clear paths are already in final form");
});

// --- through sanitizeEventData -----------------------------------------------

test("segment keys are segment-hashed; cwd and generic path stay whole-value hashes", () => {
  const { value } = s.sanitizeEventData(
    {
      cwd: `${HOME}/work/acme`,
      tool_input: {
        file_path: `${HOME}/work/acme/src/billing/invoice.ts`,
        notebook_path: `${HOME}/work/acme/nb/analysis.ipynb`,
        path: `${HOME}/work/acme/src`,
        command: `cat ${HOME}/work/acme/src/billing/invoice.ts`,
      },
    },
    SALT
  );
  const ti = value.tool_input;
  assert.match(ti.file_path, new RegExp(`^${homeHash}/work/${HEX}/src/billing/${HEX}\\.ts$`));
  assert.match(ti.notebook_path, new RegExp(`^${homeHash}/work/${HEX}/${HEX}/${HEX}\\.ipynb$`));
  assert.match(ti.path, new RegExp(`^${HEX}$`), "generic path key is a whole-value hash");
  assert.match(value.cwd, new RegExp(`^${HEX}$`), "cwd is a whole-value hash");
  assert.equal(ti.command, `cat ${homeHash}/work/acme/src/billing/invoice.ts`, "free text: home prefix only, unchanged behaviour");
  // The file name is gone from every path key; it survives only inside the
  // command string, which is the accepted free-text asymmetry.
  const withoutCommand = { ...ti, command: undefined };
  assert.equal(JSON.stringify(withoutCommand).includes("invoice"), false);
});

test("counts.path tallies segment hashes, whole-value hashes and home-prefix replacements", () => {
  const { meta, value } = s.sanitizeEventData(
    {
      cwd: `${HOME}/work/acme`, // 1 whole
      tool_input: {
        file_path: `${HOME}/work/acme/src/invoice.ts`, // home(1) + work? work is vocabulary → 0; acme(1); src → 0; invoice(1) = 3
        command: `cd ${HOME}/work && cat ${HOME}/notes.txt`, // 2 home-prefix replacements
      },
    },
    SALT
  );
  assert.equal(meta.counts.path, 6, JSON.stringify({ counts: meta.counts, value }));
  assert.equal(meta.secrets, 0);
  assert.equal(meta.pii, 0);
  assert.deepEqual(meta.ids, [], "path hashing is not a detector id");
  assert.equal(meta.policyVersion, "3.1.0");
});

test("second pass over a stamped record is a no-op for segment-hashed paths", () => {
  const first = s.sanitizeEventData(
    { tool_input: { file_path: `${HOME}/work/acme/src/x.ts`, edits: [{ file_path: "/opt/acme/y.py" }] }, cwd: `${HOME}/w` },
    SALT
  );
  const second = s.sanitizeEventData(first.value, SALT);
  assert.deepEqual(second.value, first.value);
  assert.equal(second.meta.counts.path, 0);
});

test("a raw file path added to a stamped record is segment-hashed and leaks nothing", () => {
  const first = s.sanitizeEventData({ file_path: `${HOME}/work/a.ts` }, SALT);
  const tampered = { ...first.value, file_path: `${HOME}/work/new-secret-project/b.ts` };
  const { value, meta } = s.sanitizeEventData(tampered, SALT);
  assert.match(value.file_path, new RegExp(`^${homeHash}/work/${HEX}/${HEX}\\.ts$`));
  assert.equal(JSON.stringify(value).includes("new-secret-project"), false);
  assert.equal(meta.counts.path, 3);
});

test("KINDS includes path and counts always carries it", () => {
  assert.ok(rules.KINDS.includes("path"));
  const { meta } = s.sanitizeEventData({ plain: "nothing" }, SALT);
  assert.equal(meta.counts.path, 0);
});

// --- vocabulary file sanity ---------------------------------------------------

test("vocabulary: lowercase, unique, no whitespace; patterns behave", () => {
  for (const list of [VOCAB.directories, VOCAB.files, VOCAB.compound_extensions]) {
    for (const t of list) {
      assert.equal(t, t.toLowerCase(), `${t} must be lowercase`);
      assert.equal(/\s/.test(t), false, `${t} must not contain whitespace`);
    }
  }
  assert.equal(new Set(VOCAB.directories).size, VOCAB.directories.length, "directories unique");
  assert.equal(new Set(VOCAB.files).size, VOCAB.files.length, "files unique");
  for (const ce of VOCAB.compound_extensions) assert.ok(ce.startsWith("."), ce);
  const version = new RegExp(VOCAB.version_pattern);
  for (const ok of ["v1", "v12", "2", "1.2.0", "1.2.3.4"]) assert.ok(version.test(ok), ok);
  for (const no of ["2026-09-11", "v1beta", "1_2", "acme2"]) assert.equal(version.test(no), false, no);
  const structural = new RegExp(VOCAB.structural_pattern);
  for (const ok of [".", "..", "~", "C:", "d:"]) assert.ok(structural.test(ok), ok);
  assert.equal(structural.test("..."), false);
});

test("vocabulary never contains a person-like or customer-like token", () => {
  // Guard against accidental additions: tokens must be short technical words.
  for (const t of [...VOCAB.directories, ...VOCAB.files]) {
    assert.ok(t.length <= 32, `${t} is suspiciously long`);
    assert.equal(/@/.test(t), false, t);
  }
});
