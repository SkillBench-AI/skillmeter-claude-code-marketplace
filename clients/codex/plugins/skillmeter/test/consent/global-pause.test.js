"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { fixture } = require("../../../../test-support/consent-record.cjs");

test("shared global OFF blocks capture and both queues without consuming queued bytes", t => {
  fixture(t).run(`
    writePolicy(policy);
    fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('authorized')); const chunk=stage(); assert.ok(chunk);
    fs.mkdirSync(logger.LOG_DIR,{recursive:true});
    const event=path.join(logger.LOG_DIR,'events.jsonl.'+Date.now()); fs.writeFileSync(event,'{"event":"synthetic"}\\n');
    const before=[chunk,event].map(f=>fs.readFileSync(f));
    writePolicy({...policy,revision:2,global:{enabled:false,decided_at:2,source:'user'}});
    assert.equal(logger.getTelemetryGloballyDisabled(),true);
    assert.equal(stage(),null);
    assert.equal(await logger.processPendingTranscript(chunk,'SYNTHETIC','https://collector.invalid',1000),'skip');
    assert.equal(await logger.processSealedBatch(event,'https://collector.invalid',1000),'skip');
    assert.deepEqual([chunk,event].map(f=>fs.readFileSync(f)),before);
    writePolicy({...policy,revision:3,global:{enabled:true,decided_at:3,source:'user'}});
    let sent=0; global.fetch=async()=>{sent++;return {ok:true};};
    assert.equal(await logger.processPendingTranscript(chunk,'SYNTHETIC','https://collector.invalid',1000),'sent');
    assert.equal(await logger.processSealedBatch(event,'https://collector.invalid',1000),'sent');
    assert.equal(sent,2);
  `);
});

for (const raw of ['{', 'null', '[]', '{"schema_version":2,"global":{"enabled":true}}', '{"schema_version":1,"global":{"enabled":"false"}}', '{"schema_version":1}']) {
  test(`invalid shared policy blocks capture without repairing the file: ${raw}`, t => {
    const f = fixture(t); fs.writeFileSync(f.policyFile, raw);
    f.run(`assert.equal(logger.getTelemetryGloballyDisabled(),true);`);
    assert.equal(fs.readFileSync(f.policyFile,"utf8"),raw);
  });
}

test("the gate honors a local OFF and the pause is written to the consent record", t => {
  fixture(t).run(`
    assert.equal(logger.resolveTelemetryGate(true,true).capture,true);
    assert.equal(fs.existsSync(policyFile),false);
    writePolicy(policy);
    assert.equal(logger.resolveTelemetryGate(false,true).capture,false);
    logger.setTelemetryGloballyDisabled(true);
    assert.equal(logger.getTelemetryGloballyDisabled(),true);
  `);
});

test("shared off/on between observations excludes uncertain transcript growth", t => {
  fixture(t).run(`
    writePolicy(policy); fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('authorized before')); assert.ok(stage());
    writePolicy({...policy,revision:2,global:{enabled:false,decided_at:2,source:'user'}});
    fs.appendFileSync(source,line('disabled secret'));
    writePolicy({...policy,revision:3,global:{enabled:true,decided_at:3,source:'user'}});
    logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('authorized after')); assert.ok(stage());
    assert.deepEqual(records(logger.listPendingTranscripts()).map(r=>r.payload.content),['authorized before','authorized after']);
  `);
});

test("an unrelated policy revision does not exclude an authorized interval", t => {
  fixture(t).run(`
    writePolicy(policy); fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('authorized'));
    writePolicy({...policy,revision:2,repositories:{...policy.repositories,'github.com/acme/other':{enabled:false}}});
    assert.ok(stage()); assert.deepEqual(records(logger.listPendingTranscripts()).map(r=>r.payload.content),['authorized']);
  `);
});

// The global pause is Codex's own: it lives in Codex's consent record.
test("CLI reports the pause and enable --global resumes it for Codex", t => {
  const f=fixture(t); fs.writeFileSync(f.policyFile,JSON.stringify(f.policy(false)));
  assert.match(f.cli(['status']).stderr,/globally paused for Codex on this machine/i);
  assert.match(f.cli(['enable','--global']).stderr,/resumed for Codex on this machine/);
  const policy=JSON.parse(fs.readFileSync(f.policyFile,'utf8'));
  assert.equal(policy.global.enabled,true);
  assert.equal(policy.revision,2);
  assert.deepEqual([policy.organizations,policy.repositories],[f.policy().organizations,f.policy().repositories]);
});

test("CLI identifies an unreadable or invalid consent record", t => {
  const f=fixture(t); fs.writeFileSync(f.policyFile,'{');
  assert.match(f.cli(['status']).stderr,/consent record invalid/i);
});

test("a pause at the former shared path does not pause Codex", t => {
  const f=fixture(t); fs.writeFileSync(f.legacyPolicyFile,JSON.stringify(f.policy(false)));
  f.run("assert.equal(logger.getTelemetryGloballyDisabled(),false);");
  assert.doesNotMatch(f.cli(['status']).stderr,/globally paused/);
});

for (const policyKind of ["paused", "malformed"]) {
  test(`hook does not append events under ${policyKind} shared policy`, t => {
    const f=fixture(t);
    fs.writeFileSync(f.policyFile,policyKind === "paused" ? JSON.stringify(f.policy(false)) : "{");
    f.run("await logger.runHook('PreToolUse',()=>({synthetic:true}));");
    assert.equal(fs.existsSync(require("node:path").join(f.root,"data/logs/events.jsonl")),false);
  });
}

test("malformed policy after staging retains queue bytes and blocks both send paths", t => {
  fixture(t).run(`
    writePolicy(policy); fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('authorized')); const chunk=stage(); assert.ok(chunk);
    const event=path.join(logger.LOG_DIR,'events.jsonl.'+Date.now()); fs.writeFileSync(event,'{}\\n');
    const before=[chunk,event].map(f=>fs.readFileSync(f));
    fs.writeFileSync(policyFile,'{');
    assert.equal(await logger.processPendingTranscript(chunk,'SYNTHETIC','https://collector.invalid',1000),'skip');
    assert.equal(await logger.processSealedBatch(event,'https://collector.invalid',1000),'skip');
    assert.deepEqual([chunk,event].map(f=>fs.readFileSync(f)),before);
  `);
});

test("policy changes are rechecked between successive queued chunks", t => {
  fixture(t).run(`
    writePolicy(policy); fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('first')); const first=stage();
    fs.appendFileSync(source,line('second')); assert.ok(stage());
    let requests=0;
    global.fetch=async()=>{ requests++; writePolicy({...policy,global:{enabled:false,decided_at:2}}); return {ok:true}; };
    await logger.processPendingTranscript(first,'SYNTHETIC','https://collector.invalid',1000);
    assert.equal(requests,1); assert.equal(logger.listPendingTranscripts().length,1);
  `);
});

test("consent record location follows the default and explicit state directories", t => {
  fixture(t).run(`
    const record=dir=>{const file=path.join(dir,'clients/codex/telemetry-policy.json');fs.mkdirSync(path.dirname(file),{recursive:true});return file;};
    writePolicy({...policy,global:{enabled:false}});
    delete process.env.SKILLMETER_STATE_DIR;
    assert.equal(logger.getTelemetryGloballyDisabled(),true);
    const explicit=path.join(process.env.HOME,'explicit');
    process.env.SKILLMETER_STATE_DIR=explicit;
    // Reusing client data after observing a record cannot restore first-use
    // permission just by selecting an empty state directory.
    assert.equal(logger.getTelemetryGloballyDisabled(),true);
    fs.writeFileSync(record(explicit),JSON.stringify(policy));
    assert.equal(logger.getTelemetryGloballyDisabled(),false);
    fs.writeFileSync(path.join(explicit,'telemetry-policy.json'),JSON.stringify({...policy,global:{enabled:false}}));
    assert.equal(logger.getTelemetryGloballyDisabled(),false);
  `);
});

test("a policy path that cannot be read as a file is not treated as absent", t => {
  const f=fixture(t); fs.mkdirSync(f.policyFile);
  f.run("assert.equal(logger.getTelemetryGloballyDisabled(),true);");
  assert.match(f.cli(['status']).stderr,/consent record invalid/i);
});

test("enabled shared policy allows an explicitly enabled native hook path", t => {
  const f=fixture(t); fs.writeFileSync(f.policyFile,JSON.stringify(f.policy()));
  f.run("await logger.runHook('PreToolUse',()=>({synthetic:true}));");
  const events=fs.readFileSync(require("node:path").join(f.root,'data/logs/events.jsonl'),'utf8').trim().split('\n');
  assert.equal(events.length,1);
});

test("a dangling shared policy symlink fails closed without replacing the link", t => {
  const f=fixture(t);
  fs.symlinkSync('missing-policy.json',f.policyFile);
  f.run("assert.equal(logger.getTelemetryGloballyDisabled(),true);");
  assert.match(f.cli(['status']).stderr,/consent record invalid/i);
  assert.equal(fs.lstatSync(f.policyFile).isSymbolicLink(),true);
});

for (const suffix of ['', '/nested/state']) {
  test(`dangling shared state parent blocks capture: ${suffix || 'direct'}`, t => {
    fixture(t).run(`
      const link=path.join(process.env.HOME,'broken-state'); fs.symlinkSync('missing-directory',link);
      process.env.SKILLMETER_STATE_DIR=link+${JSON.stringify(suffix)};
      assert.equal(logger.getTelemetryGloballyDisabled(),true);
    `);
  });
}

test("a valid directory symlink with no policy is treated as no record", t => {
  fixture(t).run(`
    const dir=path.join(process.env.HOME,'empty-state'); fs.mkdirSync(dir);
    const link=path.join(process.env.HOME,'linked-state'); fs.symlinkSync(dir,link);
    process.env.SKILLMETER_STATE_DIR=link;
    assert.equal(logger.getTelemetryGloballyDisabled(),false);
  `);
});
