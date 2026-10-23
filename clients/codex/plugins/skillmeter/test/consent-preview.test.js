"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture } = require("../../../test-support/consent-record.cjs");
const { sessionFileIn } = require("../test-support/plugin.cjs");
const repoKey = "github.com/acme/widgets";
const preview = f => JSON.parse(f.cli(["consent-preview", "--json"]).stdout);
const codes = result => result.notices.map(notice => notice.code);

test("preview does not treat local ON as consent or create the record", t => {
  const f = fixture(t);
  const result = preview(f);
  assert.equal(result.repository, repoKey);
  assert.equal(result.localChoices[0].choice, "on");
  assert.equal(result.sharedRevision, null);
  assert.equal(result.changesApplied, false);
  assert.ok(codes(result).includes("organization_choice_required"));
  assert.ok(codes(result).includes("repository_choice_required"));
  assert.equal(fs.existsSync(f.policyFile), false);
});

test("a record written by the former shared store is ignored", t => {
  const f = fixture(t); fs.writeFileSync(f.legacyPolicyFile, JSON.stringify(f.policy()));
  const result = preview(f);
  assert.equal(result.sharedRevision, null);
  assert.ok(codes(result).includes("organization_choice_required"));
  assert.ok(codes(result).includes("repository_choice_required"));
});

test("unacknowledged choices require acknowledgement and preview preserves bytes", t => {
  const f = fixture(t);
  const raw = JSON.stringify(f.policy(true, {
    organizations: { acme: { enabled: true, consent_version: 1 } },
    repositories: { [repoKey]: { enabled: true } },
  }));
  fs.writeFileSync(f.policyFile, raw);
  const files = [f.policyFile, path.join(f.repo, ".codex/settings.local.json"), path.join(f.state, "credentials.json")];
  const before = files.map(file => fs.readFileSync(file));
  const result = preview(f);
  assert.equal(result.sharedRevision, 1);
  assert.ok(codes(result).includes("organization_acknowledgement_required"));
  assert.ok(codes(result).includes("repository_acknowledgement_required"));
  assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
});

test("acknowledged shared ON does not clear a local OFF", t => {
  const f = fixture(t);
  fs.writeFileSync(f.policyFile, JSON.stringify(f.policy(true, {
    organizations: { acme: { enabled: true, consent_version: 2 } },
    repositories: { [repoKey]: { enabled: true, consent_version: 2 } },
  })));
  const settings = path.join(f.repo, ".codex/settings.local.json");
  fs.writeFileSync(settings, '{"skillmeter":{"telemetry":false}}');
  const result = preview(f);
  assert.ok(codes(result).includes("local_opt_out"));
  assert.equal(result.localChoices[0].choice, "off");
  assert.equal(JSON.parse(fs.readFileSync(settings)).skillmeter.telemetry, false);
});

test("a descendant OFF is shown separately from the root ON", t => {
  fixture(t).run(`
    const child = path.join(repo,'src'); fs.mkdirSync(path.join(child,'.codex'),{recursive:true});
    fs.writeFileSync(path.join(child,'.codex/settings.local.json'),'{"skillmeter":{"telemetry":false}}');
    const { buildConsentPreview } = require(${JSON.stringify(path.resolve(__dirname, "../scripts/lib/consent-preview.js"))});
    const result = buildConsentPreview({cwd:child,scope:logger.getRepoScopeDecision(child),policy:null});
    assert.deepEqual(result.localChoices.map(x=>x.choice),['on','off']);
    assert.equal(result.localChoices[1].path,'src/.codex/settings.local.json');
    assert.ok(result.notices.some(x=>x.code==='local_opt_out'));
  `);
});

for (const raw of ["{", '{"skillmeter":{"telemetry":"true"}}']) {
  test(`invalid local choices are surfaced, not inferred as opt-in: ${raw}`, t => {
    const f = fixture(t); const settings = path.join(f.repo, ".codex/settings.local.json");
    fs.writeFileSync(settings, raw);
    const result = preview(f);
    assert.ok(codes(result).includes("invalid_local_choice"));
    assert.equal(fs.readFileSync(settings, "utf8"), raw);
  });
}

test("malformed shared policy is reported without repair", t => {
  const f = fixture(t); fs.writeFileSync(f.policyFile, "{");
  const result = preview(f);
  assert.ok(codes(result).includes("INVALID_POLICY"));
  assert.equal(fs.readFileSync(f.policyFile, "utf8"), "{");
  assert.equal(Object.hasOwn(result, "sharedRevision"), false);
});

test("shared OFF remains visible while globally paused", t => {
  const f = fixture(t); fs.writeFileSync(f.policyFile, JSON.stringify(f.policy(false, { repositories: { [repoKey]: { enabled: false } } })));
  const result = preview(f);
  assert.ok(codes(result).includes("global_pause"));
  assert.ok(codes(result).includes("repository_opt_out"));
});

test("removed observed policy is not described as first-use consent", t => {
  const f = fixture(t); fs.writeFileSync(f.policyFile, JSON.stringify(f.policy()));
  preview(f); fs.unlinkSync(f.policyFile);
  const result = preview(f);
  assert.ok(codes(result).includes("POLICY_MISSING"));
  assert.equal(Object.hasOwn(result, "sharedRevision"), false);
  assert.equal(fs.existsSync(f.policyFile), false);
});

test("missing repository identity cannot produce a consent target", t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.repo, ".git/config"), "");
  const result = preview(f);
  assert.equal(result.repository, null);
  assert.ok(codes(result).includes("repository_unavailable"));
});

test("human output distinguishes the preview from a saved choice", t => {
  const f = fixture(t); const result = f.cli(["consent-preview"]);
  assert.match(result.stdout, /No consent settings changed/);
  assert.match(result.stdout, /Local OFF settings remain in effect/);
  assert.match(result.stdout, /Revision: absent/);
  assert.match(result.stdout, /does not change SkillMeter for Claude Code/);
  assert.doesNotMatch(result.stdout, /capture enabled|uploads enabled|migration complete/i);
});

test("the documented CLI wrapper forwards the preview and JSON option", t => {
  const f = fixture(t);
  const result = f.run(`
    process.argv=['node','sk-telemetry','consent-preview','--json'];
    require(${JSON.stringify(path.resolve(__dirname, "../bin/sk-telemetry"))});
  `);
  assert.equal(JSON.parse(result.stdout).changesApplied, false);
  assert.equal(fs.existsSync(f.policyFile), false);
});

test("a nested repository does not inherit its parent's local opt-out", t => {
  fixture(t).run(`
    fs.writeFileSync(path.join(repo,'.codex/settings.local.json'),'{"skillmeter":{"telemetry":false}}');
    const nested=path.join(repo,'nested'); fs.mkdirSync(path.join(nested,'.git'),{recursive:true});
    fs.writeFileSync(path.join(nested,'.git/config'),'[remote "origin"]\\nurl = https://github.com/acme/other.git\\n');
    const { buildConsentPreview } = require(${JSON.stringify(path.resolve(__dirname, "../scripts/lib/consent-preview.js"))});
    const result=buildConsentPreview({cwd:nested,scope:logger.getRepoScopeDecision(nested),policy:null});
    assert.equal(result.repository,'github.com/acme/other');
    assert.deepEqual(result.localChoices.map(x=>x.choice),['unset']);
    assert.equal(result.notices.some(x=>x.code==='local_opt_out'),false);
  `);
});

for (const kind of ["clone", "worktree"]) {
  test(`a ${kind} resolves to the same recorded choice without creating local consent`, t => {
    fixture(t).run(`
      const second=path.join(path.dirname(repo),'${kind}'); fs.mkdirSync(second);
      if ('${kind}' === 'clone') {
        fs.mkdirSync(path.join(second,'.git')); fs.copyFileSync(path.join(repo,'.git/config'),path.join(second,'.git/config'));
      } else {
        const gitdir=path.join(repo,'.git/worktrees/second'); fs.mkdirSync(gitdir,{recursive:true});
        fs.writeFileSync(path.join(gitdir,'commondir'),'../..');
        fs.writeFileSync(path.join(second,'.git'),'gitdir: '+gitdir+'\\n');
      }
      const { buildConsentPreview } = require(${JSON.stringify(path.resolve(__dirname, "../scripts/lib/consent-preview.js"))});
      const result=buildConsentPreview({cwd:second,scope:logger.getRepoScopeDecision(second),policy});
      assert.equal(result.repository,'github.com/acme/widgets');
      assert.equal(result.localChoices[0].choice,'unset');
      assert.deepEqual(result.notices.map(x=>x.code),[]);
      assert.equal(fs.existsSync(path.join(second,'.codex/settings.local.json')),false);
    `);
  });
}

test("preview leaves queued data intact and records only the client observation", t => {
  const f = fixture(t); fs.writeFileSync(f.policyFile, JSON.stringify(f.policy()));
  const logs = path.join(f.root, "data/logs"); fs.mkdirSync(logs, { recursive: true });
  const queue = path.join(logs, "events.jsonl.123"); fs.writeFileSync(queue, "synthetic queue\n");
  preview(f);
  assert.equal(fs.readFileSync(queue, "utf8"), "synthetic queue\n");
  assert.deepEqual(fs.readdirSync(logs).sort(), ["consent-policy-observed", "events.jsonl.123"]);
});


for (const raw of ['{"skillmeter":{"telemetry":false}}', '{']) {
  test(`signed-out preview still shows local restrictions: ${raw}`, t => {
    const f = fixture(t);
    fs.writeFileSync(sessionFileIn(f.state), '{"signed_out":true}');
    fs.writeFileSync(path.join(f.repo, ".codex/settings.local.json"), raw);
    const result = preview(f);
    assert.equal(result.repository, null);
    assert.equal(result.localChoices[0]?.choice, raw === "{" ? "invalid" : "off");
    assert.ok(codes(result).includes(raw === "{" ? "invalid_local_choice" : "local_opt_out"));
  });
}
