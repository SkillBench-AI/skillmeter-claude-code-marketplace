"use strict";
// Synthetic fixtures for the repository choice in the Codex consent record.
const { test } = require("node:test");
const { fixture } = require("../../../../test-support/consent-record.cjs");

for (const scope of ["organizations", "repositories"]) {
  const key = scope === "organizations" ? "acme" : "github.com/acme/widgets";
  test(`shared ${scope} OFF prevents capture in a locally enabled checkout`, t => {
    fixture(t).run(`
      writePolicy({...policy,${scope}:{'${key}':{enabled:false}}});
      fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
      fs.appendFileSync(source,line('must not capture'));
      assert.equal(stage(),null);
    `);
  });
}

for (const kind of ["clone", "worktree"]) {
  test(`shared repository opt-out applies to a second ${kind}`, t => {
    fixture(t).run(`
      const second=path.join(path.dirname(repo),'${kind}'); fs.mkdirSync(second);
      if ('${kind}' === 'clone') {
        fs.mkdirSync(path.join(second,'.git')); fs.copyFileSync(path.join(repo,'.git/config'),path.join(second,'.git/config'));
      } else {
        const gitdir=path.join(repo,'.git/worktrees/second'); fs.mkdirSync(gitdir,{recursive:true});
        fs.writeFileSync(path.join(gitdir,'commondir'),'../..');
        fs.writeFileSync(path.join(second,'.git'),'gitdir: '+gitdir+'\\n');
      }
      assert.equal(logger.getRepoScopeDecision(second).repoKey,logger.getRepoScopeDecision(repo).repoKey);
      logger.saveTelemetryOptIn(second,true);
      writePolicy({...policy,repositories:{'github.com/acme/widgets':{enabled:false}}});
      fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,second);
      fs.appendFileSync(source,line('revoked in all checkouts'));
      assert.equal(logger.stageTranscriptForUpload(source,{cwd:second}),null);
    `);
  });
}

test("shared repository OFF purges already queued repository payloads", t => {
  fixture(t).run(`
    writePolicy(policy); fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('formerly authorized')); const chunk=stage(); assert.ok(chunk);
    writePolicy({...policy,revision:2,repositories:{'github.com/acme/widgets':{enabled:false}}});
    // A blocked request alone is insufficient: the canonical contract deletes
    // queued payloads after revocation. Never acknowledge a fake upload here.
    global.fetch=async()=>({ok:false,status:503});
    await logger.processPendingTranscript(chunk,'SYNTHETIC','https://collector.invalid',1000);
    assert.equal(fs.existsSync(chunk),false);
  `);
});

test("an unobserved shared OFF/ON cycle holds old payloads without restoring delivery", t => {
  fixture(t).run(`
    writePolicy(policy); fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('old authorization')); const old=stage(); assert.ok(old);
    writePolicy({...policy,revision:2,repositories:{'github.com/acme/widgets':{enabled:false,decided_at:2}}});
    fs.appendFileSync(source,line('disabled content'));
    writePolicy({...policy,revision:3,repositories:{'github.com/acme/widgets':{enabled:true,decided_at:3,consent_version:2}}});
    const received=[]; global.fetch=async(_,opts)=>{received.push(...require('node:zlib').gunzipSync(opts.body).toString().trim().split('\\n').map(JSON.parse));return {ok:true};};
    await logger.processPendingTranscript(old,'SYNTHETIC','https://collector.invalid',1000);
    assert.equal(fs.existsSync(old),true); assert.equal(received.length,0);
    logger.observeTranscriptConsent(source,repo); fs.appendFileSync(source,line('new authorization')); assert.ok(stage());
    assert.deepEqual(records(logger.listPendingTranscripts()).filter(r=>r.type==='response_item').map(r=>r.payload.content),['new authorization']);
    await logger.drainPendingTranscripts('https://collector.invalid',1000);
    assert.deepEqual(received.filter(r=>r.type==='response_item').map(r=>r.payload.content),['new authorization']);
  `);
});

test("a changed positive organization decision holds earlier queued data", t => {
  fixture(t).run(`
    writePolicy(policy); fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('old')); const old=stage(); assert.ok(old);
    writePolicy({...policy,organizations:{acme:{enabled:true,decided_at:3,consent_version:2}}});
    await logger.processPendingTranscript(old,'SYNTHETIC','https://collector.invalid',1000);
    assert.equal(fs.existsSync(old),true);
  `);
});

test("a local opt-out restricts an acknowledged grant until it is removed", t => {
  fixture(t).run(`
    writePolicy(policy); logger.saveTelemetryOptIn(repo,false);
    assert.equal(logger.getTelemetryOptIn(repo),false);
    fs.unlinkSync(path.join(repo,'.codex/settings.local.json'));
    assert.equal(logger.getTelemetryOptIn(repo),true);
  `);
});

for (const patch of ["organizations:{}", "repositories:{}", "organizations:[]", "repositories:{'github.com/acme/widgets':{enabled:'true'}}"]) {
  test(`unknown shared choices hold queued payloads: ${patch}`, t => {
    fixture(t).run(`
      writePolicy(policy); fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
      fs.appendFileSync(source,line('authorized')); const chunk=stage(); assert.ok(chunk);
      const before=fs.readFileSync(chunk);
      writePolicy({...policy,${patch}});
      assert.equal(logger.getTelemetryOptIn(repo),null);
      await logger.processPendingTranscript(chunk,'SYNTHETIC','https://collector.invalid',1000);
      assert.deepEqual(fs.readFileSync(chunk),before);
    `);
  });
}

test("canonical origin wins; ambiguous matching remotes do not authorize capture", t => {
  fixture(t).run(`
    writePolicy(policy);
    fs.appendFileSync(path.join(repo,'.git/config'),'[remote "upstream"]\\nurl = https://github.com/acme/other.git\\n');
    assert.equal(logger.getRepoScopeDecision(repo).repoKey,'github.com/acme/widgets');
    fs.writeFileSync(path.join(repo,'.git/config'),'[remote "a"]\\nurl = https://github.com/acme/widgets.git\\n[remote "b"]\\nurl = https://github.com/acme/other.git\\n');
    assert.equal(logger.getRepoScopeDecision(repo).classification,'ambiguous_github_repository');
    assert.equal(logger.getRepoScopeDecision(repo).allowed,false);
  `);
});

test("SSH aliases and Git rewrites resolve the same shared opt-out", t => {
  fixture(t).run(`
    writePolicy({...policy,repositories:{'github.com/acme/widgets':{enabled:false}}});
    fs.mkdirSync(path.join(process.env.HOME,'.ssh'));
    fs.writeFileSync(path.join(process.env.HOME,'.ssh/config'),'Host company\\n HostName github.com\\n');
    fs.writeFileSync(path.join(repo,'.git/config'),'[remote "origin"]\\nurl = git@company:Acme/Widgets.git\\n');
    assert.equal(logger.getRepoScopeDecision(repo).repoKey,'github.com/acme/widgets');
    assert.equal(logger.getTelemetryOptIn(repo),false);
    fs.writeFileSync(path.join(process.env.HOME,'.gitconfig'),'[url "git@github.com:"]\\n insteadOf = company:\\n');
    fs.writeFileSync(path.join(repo,'.git/config'),'[remote "origin"]\\nurl = company:Acme/Widgets.git\\n');
    assert.equal(logger.getRepoScopeDecision(repo).repoKey,'github.com/acme/widgets');
    assert.equal(logger.getTelemetryOptIn(repo),false);
  `);
});

test("mixed event delivery drops shared-disabled A and preserves B, including after a retry", t => {
  fixture(t).run(`
    const b=path.join(path.dirname(repo),'b'); fs.mkdirSync(path.join(b,'.git'),{recursive:true});
    fs.writeFileSync(path.join(b,'.git/config'),'[remote "origin"]\\nurl = https://github.com/acme/other.git\\n');
    policy.repositories['github.com/acme/other']={enabled:true,consent_version:2}; writePolicy(policy);
    logger.saveTelemetryOptIn(repo,true); logger.saveTelemetryOptIn(b,true);
    const event=(cwd,name)=>logger.logInfo('Stop',name,{cwd:logger.hashHmac(cwd,'fixture-salt'),repo_root:logger.hashHmac(cwd,'fixture-salt')},'SYNTHETIC');
    event(repo,'a');event(b,'b'); const file=logger.sealEventLog();
    let calls=0; const received=[];
    global.fetch=async(_,options)=>{
      calls++; received.push(require('node:zlib').gunzipSync(options.body).toString());
      if(calls===1){writePolicy({...policy,revision:2,repositories:{...policy.repositories,'github.com/acme/widgets':{enabled:false,decided_at:2}}});return {ok:false,status:503};}
      return {ok:true};
    };
    await logger.processSealedBatch(file,'https://collector.invalid',1000);
    assert.equal(calls,1);
    await logger.processSealedBatch(file,'https://collector.invalid',1000);
    assert.equal(calls,2);
    assert.equal(received[1].includes('"session_id":"a"'),false);
    assert.equal(received[1].includes('"session_id":"b"'),true);
  `);
});

test("removing an observed record holds queued data instead of granting capture", t => {
  fixture(t).run(`
    writePolicy(policy); fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('authorized')); const chunk=stage(); const before=fs.readFileSync(chunk);
    fs.unlinkSync(policyFile);
    assert.equal(logger.getTelemetryOptIn(repo),null);
    await logger.processPendingTranscript(chunk,'SYNTHETIC','https://collector.invalid',1000);
    assert.deepEqual(fs.readFileSync(chunk),before);
    fs.appendFileSync(source,line('unknown policy interval')); logger.observeTranscriptConsent(source,repo);
    writePolicy(policy); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('restored')); assert.ok(stage());
    assert.deepEqual(records(logger.listPendingTranscripts()).map(r=>r.payload.content),['authorized','restored']);
  `);
});

test("repository OFF purges active, quarantined and transcript payloads even under global pause", t => {
  fixture(t).run(`
    writePolicy(policy); logger.saveTelemetryOptIn(repo,true);
    fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('authorized')); const chunk=stage(); assert.ok(chunk);
    const cursor=path.join(path.dirname(path.dirname(chunk)),'cursor.json'); const before=fs.readFileSync(cursor);
    const event=()=>logger.logInfo('Stop','a',{cwd:logger.hashHmac(repo,'fixture-salt'),repo_root:logger.hashHmac(repo,'fixture-salt')},'SYNTHETIC');
    event(); const batch=logger.sealEventLog(); fs.mkdirSync(logger.POISON_DIR,{recursive:true});
    const poison=path.join(logger.POISON_DIR,path.basename(batch)); fs.renameSync(batch,poison); event();
    writePolicy({...policy,global:{enabled:false,decided_at:2},repositories:{'github.com/acme/widgets':{enabled:false,decided_at:2}}});
    await logger.drainQueuesOnce('https://collector.invalid',1000);
    assert.equal(fs.existsSync(chunk),false); assert.equal(fs.existsSync(poison),false);
    assert.equal(fs.existsSync(logger.LOG_FILE),false);
    assert.deepEqual(fs.readFileSync(cursor),before);
  `);
});


test("native hook routing records a shared decision locally and removes it from wire data", t => {
  const f=fixture(t);
  require("node:fs").writeFileSync(f.policyFile,JSON.stringify(f.policy()));
  f.run("await logger.runHook('PreToolUse',()=>({synthetic:true}));");
  f.run(`
    const pending=logger.sealEventLog(); const local=JSON.parse(fs.readFileSync(pending,'utf8').trim());
    assert.equal(typeof local._queue.sharedStamp,'string');
    let calls=0; global.fetch=async(_,options)=>{
      calls++; const wire=JSON.parse(require('node:zlib').gunzipSync(options.body).toString().trim());
      assert.equal(wire._queue,undefined); return {ok:true};
    };
    assert.equal(await logger.processSealedBatch(pending,'https://collector.invalid',1000),'sent');
    assert.equal(calls,1);
  `);
});

test("a changed positive decision holds old events without blocking a different repository", t => {
  fixture(t).run(`
    const b=path.join(path.dirname(repo),'b'); fs.mkdirSync(path.join(b,'.git'),{recursive:true});
    fs.writeFileSync(path.join(b,'.git/config'),'[remote "origin"]\\nurl = https://github.com/acme/other.git\\n');
    policy.repositories['github.com/acme/other']={enabled:true,consent_version:2}; writePolicy(policy);
    logger.saveTelemetryOptIn(repo,true); logger.saveTelemetryOptIn(b,true);
    for(const [cwd,name] of [[repo,'a'],[b,'b']]) logger.logInfo('Stop',name,{cwd:logger.hashHmac(cwd,'fixture-salt'),repo_root:logger.hashHmac(cwd,'fixture-salt')},'SYNTHETIC');
    const file=logger.sealEventLog();
    writePolicy({...policy,repositories:{...policy.repositories,'github.com/acme/widgets':{enabled:true,decided_at:3,consent_version:2}}});
    const received=[]; global.fetch=async(_,o)=>{received.push(require('node:zlib').gunzipSync(o.body).toString());return {ok:true};};
    await logger.processSealedBatch(file,'https://collector.invalid',1000);
    assert.equal(received.length,1); assert.equal(received[0].includes('"session_id":"a"'),false);
    assert.equal(received[0].includes('"session_id":"b"'),true);
    const held=fs.readFileSync(file,'utf8'); assert.equal(held.includes('"session_id":"a"'),true);
    assert.equal(held.includes('"session_id":"b"'),false);
  `);
});

test("CLI identifies shared blockers and local enable leaves shared OFF untouched", t => {
  const f=fixture(t), fs=require('node:fs'), assert=require('node:assert/strict');
  const raw=JSON.stringify(f.policy(true,{repositories:{'github.com/acme/widgets':{enabled:false}}}));
  fs.writeFileSync(f.policyFile,raw);
  assert.match(f.cli(['status']).stderr,/disabled by the organization or repository choice/);
  assert.match(f.cli(['unrestrict']).stderr,/Capture remains blocked: disabled by the organization or repository choice/);
  assert.equal(fs.readFileSync(f.policyFile,'utf8'),raw);
});

test("CLI reports an observed record disappearing", t => {
  const f=fixture(t), fs=require('node:fs'), assert=require('node:assert/strict');
  fs.writeFileSync(f.policyFile,JSON.stringify(f.policy()));
  f.run("await logger.runHook('PreToolUse',()=>({synthetic:true}));"); fs.unlinkSync(f.policyFile);
  assert.match(f.cli(['status']).stderr,/previously observed consent record is missing/);
});

test("shared OFF purges indexed transcript payloads after the checkout was removed", t => {
  fixture(t).run(`
    writePolicy(policy); fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('authorized')); const chunk=stage(); assert.ok(chunk);
    process.chdir(path.dirname(repo)); fs.rmSync(repo,{recursive:true});
    writePolicy({...policy,repositories:{'github.com/acme/widgets':{enabled:false,decided_at:2}}});
    await logger.drainQueuesOnce('https://collector.invalid',1000);
    assert.equal(fs.existsSync(chunk),false);
  `);
});

test("restoring an older shared policy cannot release held events from its old authorization", t => {
  fixture(t).run(`
    writePolicy(policy); logger.saveTelemetryOptIn(repo,true);
    logger.logInfo('Stop','old',{cwd:logger.hashHmac(repo,'fixture-salt'),repo_root:logger.hashHmac(repo,'fixture-salt')},'SYNTHETIC');
    const file=logger.sealEventLog(), before=fs.readFileSync(file);
    writePolicy({...policy,repositories:{'github.com/acme/widgets':{enabled:true,decided_at:2,consent_version:2}}});
    assert.equal(await logger.processSealedBatch(file,'https://collector.invalid',1000),'held');
    writePolicy(policy);
    assert.equal(await logger.processSealedBatch(file,'https://collector.invalid',1000),'held');
    assert.deepEqual(fs.readFileSync(file),before);
  `);
});


test("revocation uses the queued repository identity after its remote changes", t => {
  fixture(t).run(`
    policy.repositories['github.com/acme/other']={enabled:true,consent_version:2}; writePolicy(policy);
    fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('old repository')); const chunk=stage(); assert.ok(chunk);
    const cursor=path.join(path.dirname(path.dirname(chunk)),'cursor.json'); const before=fs.readFileSync(cursor);
    fs.writeFileSync(path.join(repo,'.git/config'),'[remote "origin"]\\nurl = https://github.com/acme/other.git\\n');
    writePolicy({...policy,repositories:{...policy.repositories,'github.com/acme/widgets':{enabled:false}}});
    await logger.drainQueuesOnce('https://collector.invalid',1000);
    assert.equal(fs.existsSync(chunk),false);
    assert.deepEqual(fs.readFileSync(cursor),before);
  `);
});


test("a later opt-out purges the prior remote's events without purging new repository events", t => {
  fixture(t).run(`
    policy.repositories['github.com/acme/other']={enabled:true,consent_version:2}; writePolicy(policy);
    logger.saveTelemetryOptIn(repo,true);
    const event=name=>logger.logInfo('Stop',name,{cwd:logger.hashHmac(repo,'fixture-salt'),repo_root:logger.hashHmac(repo,'fixture-salt')},'SYNTHETIC');
    event('old'); const old=logger.sealEventLog();
    fs.writeFileSync(path.join(repo,'.git/config'),'[remote "origin"]\\nurl = https://github.com/acme/other.git\\n');
    // Observe the new identity while both repositories are still allowed.
    logger.saveTelemetryOptIn(repo,true); event('new'); const next=logger.sealEventLog();
    writePolicy({...policy,repositories:{...policy.repositories,'github.com/acme/widgets':{enabled:false}}});
    const received=[]; global.fetch=async(_,o)=>{received.push(require('node:zlib').gunzipSync(o.body).toString()); return {ok:true};};
    await logger.drainQueuesOnce('https://collector.invalid',1000);
    assert.equal(received.some(body=>body.includes('"session_id":"old"')),false);
    assert.equal(received.some(body=>body.includes('"session_id":"new"')),true);
    assert.equal(fs.existsSync(old),false);
  `);
});

test("revoking the new remote keeps prior-repository payloads held", t => {
  fixture(t).run(`
    policy.repositories['github.com/acme/other']={enabled:true,consent_version:2}; writePolicy(policy);
    logger.saveTelemetryOptIn(repo,true);
    logger.logInfo('Stop','prior',{cwd:logger.hashHmac(repo,'fixture-salt'),repo_root:logger.hashHmac(repo,'fixture-salt')},'SYNTHETIC');
    const old=logger.sealEventLog(), before=fs.readFileSync(old);
    fs.writeFileSync(path.join(repo,'.git/config'),'[remote "origin"]\\nurl = https://github.com/acme/other.git\\n');
    logger.saveTelemetryOptIn(repo,true);
    writePolicy({...policy,repositories:{...policy.repositories,'github.com/acme/other':{enabled:false}}});
    await logger.drainQueuesOnce('https://collector.invalid',1000);
    assert.deepEqual(fs.readFileSync(old),before);
  `);
});


test("a remote change to another enabled repository delivers new text and holds the prior payload", t => {
  fixture(t).run(`
    policy.repositories['github.com/acme/other']={enabled:true,consent_version:2}; writePolicy(policy);
    fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('old repository')); const old=stage(); assert.ok(old);
    const oldBytes=fs.readFileSync(old);
    fs.writeFileSync(path.join(repo,'.git/config'),'[remote "origin"]\\nurl = https://github.com/acme/other.git\\n');
    logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('new repository')); const next=stage(); assert.ok(next);
    const received=[];
    global.fetch=async(_,options)=>{received.push(...require('node:zlib').gunzipSync(options.body).toString().trim().split('\\n').map(JSON.parse));return {ok:true};};
    await logger.drainPendingTranscripts('https://collector.invalid',1000);
    assert.deepEqual(received.filter(r=>r.type==='response_item').map(r=>r.payload.content),['new repository']);
    assert.deepEqual(fs.readFileSync(old),oldBytes,'prior repository payload remains held');
  `);
});

test("no consent record captures nothing in a locally enabled checkout", t => {
  fixture(t).run(`
    assert.equal(fs.existsSync(policyFile),false);
    fs.writeFileSync(source,''); logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('no record')); assert.equal(stage(),null);
    assert.equal(fs.existsSync(policyFile),false,'no record is invented');
  `);
});
