"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture } = require("../../../test-support/consent-record.cjs");
const shared = `
  policy.organizations.acme.consent_version=2;
  policy.repositories['github.com/acme/widgets'].consent_version=2;
  writePolicy(policy);
  fs.unlinkSync(path.join(repo,'.codex/settings.local.json'));
`;

for (const kind of ['original','clone','worktree']) {
  test(`acknowledged shared consent captures in an unselected ${kind}`, t => fixture(t).run(shared + `
    let cwd=repo;
    if ('${kind}'!=='original') {
      cwd=path.join(path.dirname(repo),'${kind}');fs.mkdirSync(cwd);
      if ('${kind}'==='clone') {fs.mkdirSync(path.join(cwd,'.git'));fs.copyFileSync(path.join(repo,'.git/config'),path.join(cwd,'.git/config'));}
      else {const dir=path.join(repo,'.git/worktrees/second');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'commondir'),'../..');fs.writeFileSync(path.join(cwd,'.git'),'gitdir: '+dir+'\\n');}
    }
    assert.equal(logger.getTelemetryOptIn(cwd),true);
    fs.writeFileSync(source,line('existing excluded'));logger.observeTranscriptConsent(source,cwd);
    fs.appendFileSync(source,line('new allowed'));const chunk=logger.stageTranscriptForUpload(source,{cwd});assert.ok(chunk);
    assert.deepEqual(records([chunk]).map(r=>r.payload.content),['new allowed']);
    assert.equal(fs.existsSync(path.join(cwd,'.codex/settings.local.json')),false);
  `));
}

for (const record of ['organizations.acme', "repositories['github.com/acme/widgets']"]) {
  test(`unacknowledged ${record} grants nothing, even with local ON`, t => fixture(t).run(shared + `
    delete policy.${record}.consent_version;writePolicy(policy);
    assert.equal(logger.getTelemetryOptIn(repo),null);
    logger.saveTelemetryOptIn(repo,true);assert.equal(logger.getTelemetryOptIn(repo),null);
  `));
}

test("no consent record grants nothing, even with local ON", t => fixture(t).run(`
  assert.equal(fs.existsSync(policyFile),false);
  assert.equal(logger.getTelemetryOptIn(repo),null);
  fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,repo);
  fs.appendFileSync(source,line('no record'));assert.equal(stage(),null);
`));

test("a record at the former shared path neither grants nor pauses", t => fixture(t).run(`
  writePolicy(policy);fs.renameSync(policyFile,legacyPolicyFile);
  assert.equal(logger.getTelemetryOptIn(repo),null);
  policy.global={enabled:false,decided_at:2};fs.writeFileSync(legacyPolicyFile,JSON.stringify(policy));
  assert.equal(logger.getTelemetryGloballyDisabled(),false);
  assert.equal(fs.existsSync(policyFile),false);
`));

for (const raw of ['{"skillmeter":{"telemetry":false}}','{','{"skillmeter":{"telemetry":"true"}}','[]']) {
  for (const location of ['root','child']) {
    test(`shared grant preserves ${location} restriction ${raw}`, t => fixture(t).run(shared + `
      const cwd='${location}'==='root'?repo:path.join(repo,'src');fs.mkdirSync(path.join(cwd,'.codex'),{recursive:true});
      fs.writeFileSync(path.join(cwd,'.codex/settings.local.json'),${JSON.stringify(raw)});
      assert.notEqual(logger.getTelemetryOptIn(cwd),true);
      fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,cwd);
      fs.appendFileSync(source,line('blocked'));assert.equal(logger.stageTranscriptForUpload(source,{cwd}),null);
    `));
  }
}

test("acknowledgement transition excludes the uncertain interval and allows subsequent text", t => fixture(t).run(`
  delete policy.organizations.acme.consent_version;delete policy.repositories['github.com/acme/widgets'].consent_version;
  writePolicy(policy);fs.unlinkSync(path.join(repo,'.codex/settings.local.json'));
  fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,repo);
  fs.appendFileSync(source,line('before acknowledgement'));
  policy.organizations.acme.consent_version=2;policy.repositories['github.com/acme/widgets'].consent_version=2;policy.revision++;
  writePolicy(policy);logger.observeTranscriptConsent(source,repo);
  fs.appendFileSync(source,line('after acknowledgement'));const chunk=stage();assert.ok(chunk);
  assert.deepEqual(records([chunk]).map(r=>r.payload.content),['after acknowledgement']);
`));

test("a queued payload cannot cross a re-recorded grant unnoticed", t => fixture(t).run(shared + `
  fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,repo);
  fs.appendFileSync(source,line('queued under the first grant'));const chunk=stage();assert.ok(chunk);const before=fs.readFileSync(chunk);
  policy.repositories['github.com/acme/widgets'].decided_at=5;policy.revision++;
  writePolicy(policy);
  let sent=0;global.fetch=async()=>{sent++;return {ok:true};};
  await logger.processPendingTranscript(chunk,'SYNTHETIC','https://collector.invalid',1000);
  assert.equal(sent,0);assert.deepEqual(fs.readFileSync(chunk),before);
`));

test("runtime observation persists across processes and protects an unselected clone after deletion", t => {
  const f=fixture(t);fs.writeFileSync(f.policyFile,JSON.stringify(f.policy()));
  f.run('logger.getTelemetryGloballyDisabled();');fs.unlinkSync(f.policyFile);
  f.run(`assert.equal(logger.getTelemetryGloballyDisabled(),true);assert.notEqual(logger.getTelemetryOptIn(repo),true);`);
  assert.match(f.cli(['status']).stderr,/previously observed consent record is missing/);
});

test("marker I/O failure cannot authorize acknowledged capture", t => fixture(t).run(shared + `
  fs.mkdirSync(logger.LOG_DIR,{recursive:true});fs.mkdirSync(logger.CONSENT_OBSERVED_FILE);
  assert.equal(logger.getTelemetryGloballyDisabled(),true);
  assert.notEqual(logger.getTelemetryOptIn(repo),true);
`));

for (const patch of ["policy.future_restriction=true", "policy.repositories['github.com/acme/widgets'].consent_version=3", "policy.revision=-1"]) {
  test(`unsupported shared state holds both queues: ${patch}`, t => fixture(t).run(`
    writePolicy(policy);fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('valid queue'));const chunk=stage();assert.ok(chunk);
    const event=path.join(logger.LOG_DIR,'events.jsonl.'+Date.now());fs.writeFileSync(event,'{}\\n');
    const before=[chunk,event].map(f=>fs.readFileSync(f));
    ${patch};writePolicy(policy);const raw=fs.readFileSync(policyFile);
    assert.equal(logger.getTelemetryGloballyDisabled(),true);
    await logger.processPendingTranscript(chunk,'SYNTHETIC','https://collector.invalid',1000);
    await logger.processSealedBatch(event,'https://collector.invalid',1000);
    assert.deepEqual([chunk,event].map(f=>fs.readFileSync(f)),before);assert.deepEqual(fs.readFileSync(policyFile),raw);
  `));
}

test("acknowledged hook events are delivered and a retry rechecks revocation", t => fixture(t).run(shared + `
  await logger.runHook('PreToolUse',()=>({synthetic:true}));const event=logger.sealEventLog();assert.ok(event);
  let calls=0;global.fetch=async()=>{calls++;return {ok:false,status:503};};
  await logger.processSealedBatch(event,'https://collector.invalid',1000);assert.equal(calls,1);
  policy.repositories['github.com/acme/widgets']={enabled:false,decided_at:2};policy.revision++;writePolicy(policy);
  global.fetch=async()=>{calls++;return {ok:true};};
  await logger.processSealedBatch(event,'https://collector.invalid',1000);assert.equal(calls,1);
  assert.equal(fs.existsSync(event),false);
`));

test("status distinguishes acknowledged consent from a missing acknowledgement", t => {
  const f=fixture(t);f.run(shared);
  assert.match(f.cli(['status']).stderr,/\[ TELEMETRY ON \]/);
  f.run("delete policy.repositories['github.com/acme/widgets'].consent_version;writePolicy(policy);");
  assert.match(f.cli(['status']).stderr,/scope acknowledgement/);
});

test("shared permission preserves organization narrowing and the Work transcript boundary", t => fixture(t).run(shared + `
  process.env.SKILLMETER_REPO_SCOPE_ORGS='other';
  assert.equal(logger.getRepoScopeDecision(repo).allowed,false);
  assert.notEqual(logger.getTelemetryOptIn(repo),true);
  process.env.SKILLMETER_REPO_SCOPE_ORGS='';
  fs.writeFileSync(source,JSON.stringify({type:'session_meta',payload:{id:'synthetic',cwd:repo,originator:'codex_work_desktop'}})+'\\n');
  logger.observeTranscriptConsent(source,repo);fs.appendFileSync(source,line('Work remains unsupported'));
  assert.equal(stage(),null);assert.equal(logger.listPendingTranscripts().length,0);
`));

test("downgraded acknowledgement stops new capture in an unselected checkout", t => fixture(t).run(shared + `
  fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,repo);
  fs.appendFileSync(source,line('queued before downgrade'));const chunk=stage();assert.ok(chunk);
  delete policy.repositories['github.com/acme/widgets'].consent_version;policy.revision++;writePolicy(policy);
  fs.appendFileSync(source,line('after downgrade'));assert.equal(stage(),null);
  let sent=0;global.fetch=async()=>{sent++;return {ok:true};};
  await logger.processPendingTranscript(chunk,'SYNTHETIC','https://collector.invalid',1000);
  assert.equal(sent,0);assert.equal(fs.existsSync(chunk),true);
`));

test("global pause holds acknowledged backlog and excludes paused growth", t => fixture(t).run(shared + `
  fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,repo);
  fs.appendFileSync(source,line('before pause'));const queued=stage();assert.ok(queued);
  policy.global={enabled:false,decided_at:2};policy.revision++;writePolicy(policy);
  fs.appendFileSync(source,line('paused text'));assert.equal(stage(),null);
  await logger.drainQueuesOnce('https://collector.invalid',1000);assert.equal(fs.existsSync(queued),true);
  policy.global={enabled:true,decided_at:3};policy.revision++;writePolicy(policy);logger.observeTranscriptConsent(source,repo);
  fs.appendFileSync(source,line('after pause'));assert.ok(stage());
  const received=[];global.fetch=async(_,opts)=>{received.push(...require('node:zlib').gunzipSync(opts.body).toString().trim().split('\\n').map(JSON.parse));return {ok:true};};
  await logger.drainPendingTranscripts('https://collector.invalid',1000);
  assert.deepEqual(received.map(r=>r.payload.content),['before pause','after pause']);
`));

test("an unrelated repository edit does not close an acknowledged interval", t => fixture(t).run(shared + `
  fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,repo);
  fs.appendFileSync(source,line('preserved'));policy.repositories['github.com/acme/other']={enabled:false};policy.revision++;writePolicy(policy);
  const chunk=stage();assert.ok(chunk);assert.deepEqual(records([chunk]).map(r=>r.payload.content),['preserved']);
`));

test("restoring a disappeared policy excludes observed missing-policy growth", t => {
  const f=fixture(t);
  f.run(shared + `fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,repo);fs.unlinkSync(policyFile);`);
  f.run(`fs.appendFileSync(source,line('policy missing'));assert.equal(stage(),null);`);
  f.run(`
    policy.organizations.acme.consent_version=2;policy.repositories['github.com/acme/widgets'].consent_version=2;writePolicy(policy);
    logger.observeTranscriptConsent(source,repo);fs.appendFileSync(source,line('restored'));const chunk=stage();assert.ok(chunk);
    assert.deepEqual(records([chunk]).map(r=>r.payload.content),['restored']);
  `);
});

for (const target of ['missing.json','settings-dir']) {
  test(`invalid local settings path cannot be bypassed by shared ON: ${target}`, t => fixture(t).run(shared + `
    const settings=path.join(repo,'.codex/settings.local.json');
    if ('${target}'==='settings-dir') fs.mkdirSync(settings);else fs.symlinkSync('${target}',settings);
    assert.notEqual(logger.getTelemetryOptIn(repo),true);
  `));
}

test("an unchanged acknowledged record retains its serialized queue boundary", t => fixture(t).run(shared + `
  fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,repo);
  fs.appendFileSync(source,line('backlog'));const chunk=stage();assert.ok(chunk);
  const boundary=JSON.stringify(['github.com/acme/widgets',[true,1,2],[true,1,2]]);
  const index=path.join(logger.LOG_DIR,'repository-routing');
  const state=fs.readdirSync(index).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(index,n)))).find(x=>x.repoRoot===repo);
  assert.equal(state.sharedStamp,boundary);
  let sent=0;global.fetch=async()=>{sent++;return {ok:true};};
  await logger.processPendingTranscript(chunk,'SYNTHETIC','https://collector.invalid',1000);assert.equal(sent,1);
`));

test("an acknowledged parent repository cannot authorize a different nested repository", t => fixture(t).run(shared + `
  const nested=path.join(repo,'nested');fs.mkdirSync(path.join(nested,'.git'),{recursive:true});
  fs.writeFileSync(path.join(nested,'.git/config'),'[remote "origin"]\\nurl = https://github.com/acme/other.git\\n');
  assert.equal(logger.getRepoScopeDecision(nested).repoKey,'github.com/acme/other');
  assert.notEqual(logger.getTelemetryOptIn(nested),true);
  fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,nested);
  fs.appendFileSync(source,line('nested unselected'));assert.equal(logger.stageTranscriptForUpload(source,{cwd:nested}),null);
`));
