"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture } = require("../../../test-support/consent-record.cjs");
const modulePath = path.resolve(__dirname, "../scripts/lib/consent-apply.js");
const setup = `
  const {applyRepositoryConsent} = require(${JSON.stringify(modulePath)});
  const store = require(${JSON.stringify(path.resolve(__dirname, "../scripts/lib/consent-store.js"))}).createConsentStore({file:policyFile,observedFile:logger.CONSENT_OBSERVED_FILE});
  const key='github.com/acme/widgets';
  policy.organizations.acme.consent_version=2;
  writePolicy(policy);
  const apply=opts=>applyRepositoryConsent({cwd:repo,scope:logger.getRepoScopeDecision(repo),store,
    repository:key,expectedRevision:1,enabled:true,acknowledged:true,...opts});
`;

for (const [name, change, code] of [
  ["missing scope acknowledgement", "{acknowledged:false}", "ACKNOWLEDGEMENT_REQUIRED"],
  ["missing revision", "{expectedRevision:undefined}", "EXPECTED_REVISION_REQUIRED"],
  ["stale revision", "{expectedRevision:0}", "STALE_POLICY"],
  ["different repository", "{repository:'github.com/acme/other'}", "REPOSITORY_CHANGED"],
  ["unresolved identity", "{scope:{allowed:false}}", "REPOSITORY_UNAVAILABLE"],
  ["implicit choice", "{enabled:undefined}", "CHOICE_REQUIRED"],
]) {
  test(`${name} cannot apply consent`, t => fixture(t).run(setup + `
    const before=fs.readFileSync(policyFile);
    assert.throws(()=>apply(${change}),{code:'${code}'});
    assert.deepEqual(fs.readFileSync(policyFile),before);
  `));
}

for (const organization of [null, {enabled:false}, {enabled:true}, {enabled:true,consent_version:1}]) {
  test(`ON requires acknowledged organization authorization: ${JSON.stringify(organization)}`, t => fixture(t).run(setup + `
    policy.organizations=${organization === null ? '{}' : JSON.stringify({acme:organization})};writePolicy(policy);
    const before=fs.readFileSync(policyFile);
    assert.throws(()=>apply(),{code:'ORGANIZATION_CONSENT_REQUIRED'});
    assert.deepEqual(fs.readFileSync(policyFile),before);
  `));
}

for (const raw of ['{"skillmeter":{"telemetry":false}}', '{']) {
  test(`ON preserves and reports local restriction: ${raw}`, t => fixture(t).run(setup + `
    const settings=path.join(repo,'.codex/settings.local.json');fs.writeFileSync(settings,${JSON.stringify(raw)});
    assert.throws(()=>apply(),{code:'LOCAL_CONSENT_CONFLICT'});
    assert.equal(fs.readFileSync(settings,'utf8'),${JSON.stringify(raw)});
    assert.equal(store.readPolicy().revision,1);
  `));
}

test("descendant OFF prevents repository ON from that directory", t => fixture(t).run(setup + `
  const child=path.join(repo,'src');fs.mkdirSync(path.join(child,'.codex'),{recursive:true});
  fs.writeFileSync(path.join(child,'.codex/settings.local.json'),'{"skillmeter":{"telemetry":false}}');
  assert.throws(()=>apply({cwd:child,scope:logger.getRepoScopeDecision(child)}),{code:'LOCAL_CONSENT_CONFLICT'});
`));

test("explicit acknowledgement records repository scope without editing other choices or local settings", t => fixture(t).run(setup + `
  policy.global.enabled=false;writePolicy(policy);
  const settings=path.join(repo,'.codex/settings.local.json'),before=fs.readFileSync(settings);
  const updated=apply();
  assert.equal(updated.revision,2);assert.equal(updated.repositories[key].consent_version,2);
  assert.deepEqual(updated.organizations,policy.organizations);
  assert.equal(updated.global.enabled,false);assert.deepEqual(fs.readFileSync(settings),before);
`));

test("OFF needs neither organization authorization nor acknowledgement and preserves local settings", t => fixture(t).run(setup + `
  policy.organizations={};writePolicy(policy);
  const settings=path.join(repo,'.codex/settings.local.json');fs.writeFileSync(settings,'{');
  const updated=apply({enabled:false,acknowledged:false});
  assert.equal(updated.repositories[key].enabled,false);assert.equal(updated.repositories[key].consent_version,undefined);
  assert.deepEqual(updated.organizations,{});assert.equal(fs.readFileSync(settings,'utf8'),'{');
`));

test("a concurrent OFF between validation and commit survives", t => fixture(t).run(setup + `
  const read=store.readPolicy;
  store.readPolicy=()=>{const p=read();writePolicy({...policy,revision:2,repositories:{[key]:{enabled:false}}});return p;};
  assert.throws(()=>apply(),{code:'STALE_POLICY'});
  assert.equal(JSON.parse(fs.readFileSync(policyFile)).repositories[key].enabled,false);
`));

test("CLI shared OFF revokes known payloads while paused without changing credentials", t => {
  const f=fixture(t);
  const result=f.run(setup + `
    fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('authorized'));const chunk=stage();assert.ok(chunk);
    logger.setTelemetryGloballyDisabled(true);
    // The pause is a shared policy write, so the choice names the revision after it.
    const revision=String(JSON.parse(fs.readFileSync(policyFile,'utf8')).revision);
    const credentials=path.join(${JSON.stringify(f.state)},'credentials.json'),before=fs.readFileSync(credentials);
    process.argv=['node','telemetry.js','consent-set','off','--repository',key,'--revision',revision];
    require(${JSON.stringify(path.resolve(__dirname, "../scripts/telemetry.js"))});
    assert.equal(fs.existsSync(chunk),false);
    assert.deepEqual(fs.readFileSync(credentials),before);
    assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(chunk)),'consent.json')),true);
  `);
  assert.match(result.stdout,/\[ REPOSITORY OFF \]/);
  assert.doesNotMatch(result.stdout,/delivered|report generated/i);
});

test("CLI consent-set --help prints the choice arguments and exits successfully", t => {
  const f=fixture(t);
  const result=f.run(`
    process.argv=['node','telemetry.js','consent-set','--help'];
    require(${JSON.stringify(path.resolve(__dirname, "../scripts/telemetry.js"))});
    assert.equal(process.exitCode,undefined);
    assert.equal(fs.existsSync(policyFile),false);
  `);
  assert.match(result.stdout,/^Usage: consent-set <on\|off> \(--organization org \| --repository/m);
});

for (const args of [[], ['on'], ['on','--repository','github.com/acme/widgets','--revision','1'], ['off','--repository','github.com/acme/widgets','--revision','1','--typo'],
  ['off','--organization','acme','--repository','github.com/acme/widgets','--revision','absent'], ['off','--organization','acme']]) {
  test(`CLI rejects incomplete or unknown choice arguments: ${args.join(' ')}`, t => {
    const f=fixture(t);
    f.run(`
      process.argv=['node','telemetry.js','consent-set',...${JSON.stringify(args)}];
      require(${JSON.stringify(path.resolve(__dirname, "../scripts/telemetry.js"))});
      assert.equal(process.exitCode,1);process.exitCode=0;
      assert.equal(fs.existsSync(policyFile),false);
    `);
  });
}


test("revocation observer runs under the shared writer lock", t => fixture(t).run(setup + `
  let observed=false;
  const updated=apply({enabled:false,onCommitted:committed=>{
    observed=true;
    assert.equal(committed.repositories[key].enabled,false);
    assert.equal(JSON.parse(fs.readFileSync(policyFile)).repositories[key].enabled,false);
    assert.throws(()=>store.setRepositoryOverride(key,true,{expectedRevision:2,acknowledged:true}),{code:'POLICY_BUSY'});
  }});
  assert.equal(observed,true);assert.equal(updated.revision,2);
  assert.equal(fs.existsSync(policyFile+'.lock'),false);
`));

test("absent policy can record OFF without inventing an organization grant", t => fixture(t).run(setup + `
  fs.unlinkSync(policyFile);
  const updated=apply({enabled:false,acknowledged:false,expectedRevision:null});
  assert.equal(updated.repositories[key].enabled,false);
  assert.deepEqual(updated.organizations,{});
`));

test("new clone records shared consent without creating local settings", t => fixture(t).run(setup + `
  fs.unlinkSync(path.join(repo,'.codex/settings.local.json'));
  const updated=apply();
  assert.equal(updated.repositories[key].consent_version,2);
  assert.equal(fs.existsSync(path.join(repo,'.codex/settings.local.json')),false);
  assert.equal(logger.getTelemetryOptIn(repo),true);
`));

test("CLI OFF/ON excludes disabled text and preserves another repository's queued data", t => fixture(t).run(setup + `
  const other=path.join(path.dirname(repo),'other');fs.mkdirSync(path.join(other,'.git'),{recursive:true});
  fs.writeFileSync(path.join(other,'.git/config'),'[remote "origin"]\\nurl = https://github.com/acme/other.git\\n');
  policy.repositories['github.com/acme/other']={enabled:true,consent_version:2};writePolicy(policy);
  logger.saveTelemetryOptIn(other,true);
  const bSource=source+'.b';fs.writeFileSync(bSource,'');logger.observeTranscriptConsent(bSource,other);
  fs.appendFileSync(bSource,line('B backlog'));const bChunk=logger.stageTranscriptForUpload(bSource,{cwd:other});
  const bBytes=fs.readFileSync(bChunk);
  fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,repo);
  fs.appendFileSync(source,line('A backlog'));const aChunk=stage();assert.ok(aChunk);
  const cursor=path.join(path.dirname(path.dirname(aChunk)),'cursor.json'),cursorBytes=fs.readFileSync(cursor);
  const cli=${JSON.stringify(path.resolve(__dirname, "../scripts/telemetry.js"))};
  const command=args=>{process.argv=['node','telemetry.js',...args];delete require.cache[cli];require(cli);assert.notEqual(process.exitCode,1);};
  command(['consent-set','off','--repository',key,'--revision','1']);
  assert.equal(fs.existsSync(aChunk),false);assert.deepEqual(fs.readFileSync(cursor),cursorBytes);
  assert.deepEqual(fs.readFileSync(bChunk),bBytes);
  fs.appendFileSync(source,line('disabled text'));
  command(['consent-set','on','--repository',key,'--revision','2','--acknowledge-machine-scope']);
  fs.appendFileSync(source,line('new allowed text'));const next=stage();assert.ok(next);
  assert.deepEqual(records([next]).map(r=>r.payload.content),['new allowed text']);
  assert.deepEqual(fs.readFileSync(bChunk),bBytes);
`));

test("malformed shared policy blocks apply without changing the file", t => fixture(t).run(setup + `
  fs.writeFileSync(policyFile,'{');
  assert.throws(()=>apply({enabled:false}),{code:'INVALID_POLICY'});
  assert.equal(fs.readFileSync(policyFile,'utf8'),'{');
`));

test("a concurrent local OFF remains restrictive even after an acknowledged shared write", t => fixture(t).run(setup + `
  const set=store.setRepositoryOverride;
  store.setRepositoryOverride=(...args)=>{
    fs.writeFileSync(path.join(repo,'.codex/settings.local.json'),'{"skillmeter":{"telemetry":false}}');
    return set(...args);
  };
  apply();assert.equal(logger.getTelemetryOptIn(repo),false);
`));

test("busy payload cleanup is reported as deferred after the choice is saved", t => {
  const f=fixture(t);
  const result=f.run(setup + `
    fs.writeFileSync(source,'');logger.observeTranscriptConsent(source,repo);
    fs.appendFileSync(source,line('backlog'));const chunk=stage();
    const lock=path.join(path.dirname(path.dirname(chunk)),'lock');fs.writeFileSync(lock,'busy');
    process.argv=['node','telemetry.js','consent-set','off','--repository',key,'--revision','1'];
    require(${JSON.stringify(path.resolve(__dirname, "../scripts/telemetry.js"))});
    assert.equal(JSON.parse(fs.readFileSync(policyFile)).repositories[key].enabled,false);
    assert.equal(fs.existsSync(chunk),true);
    fs.unlinkSync(lock);logger.reconcileConsentRevocations();assert.equal(fs.existsSync(chunk),false);
  `);
  assert.match(result.stdout,/\[ REPOSITORY OFF \]/);
  assert.match(result.stdout,/cleanup deferred/);
});

test("post-commit observer failure reports that consent was saved and does not roll it back", t => fixture(t).run(setup + `
  assert.throws(()=>apply({enabled:false,onCommitted:()=>{throw Error('synthetic');}}),{code:'POLICY_COMMITTED_OBSERVER_FAILED'});
  assert.equal(store.readPolicy().repositories[key].enabled,false);
  assert.equal(store.readPolicy().revision,2);
  assert.equal(fs.existsSync(policyFile+'.lock'),false);
`));

const orgSetup = `
  const {applyOrganizationConsent} = require(${JSON.stringify(modulePath)});
  const store = require(${JSON.stringify(path.resolve(__dirname, "../scripts/lib/consent-store.js"))}).createConsentStore({file:policyFile,observedFile:logger.CONSENT_OBSERVED_FILE});
  const applyOrg=opts=>applyOrganizationConsent({store,organization:'acme',allowedOrgs:['acme'],expectedRevision:null,enabled:true,acknowledged:true,...opts});
`;

for (const [name, change, code] of [
  ["missing scope acknowledgement", "{acknowledged:false}", "ACKNOWLEDGEMENT_REQUIRED"],
  ["organization outside the license", "{organization:'other'}", "ORGANIZATION_UNAVAILABLE"],
  ["organization removed by narrowing", "{allowedOrgs:[]}", "ORGANIZATION_UNAVAILABLE"],
  ["stale revision", "{expectedRevision:0}", "STALE_POLICY"],
  ["implicit choice", "{enabled:undefined}", "CHOICE_REQUIRED"],
]) {
  test(`${name} cannot apply organization consent`, t => fixture(t).run(orgSetup + `
    assert.throws(()=>applyOrg(${change}),{code:'${code}'});
    assert.equal(fs.existsSync(policyFile),false);
  `));
}

test("organization ON records the acknowledgement and OFF drops it", t => fixture(t).run(orgSetup + `
  const on=applyOrg();
  assert.deepEqual({...on.organizations.acme,decided_at:0},{enabled:true,decided_at:0,source:'user',consent_version:2});
  assert.deepEqual(on.repositories,{});
  const off=applyOrg({enabled:false,acknowledged:false,expectedRevision:on.revision});
  assert.equal(off.organizations.acme.enabled,false);assert.equal(off.organizations.acme.consent_version,undefined);
`));

test("CLI records organization then repository consent from no record and enables capture", t => {
  const f=fixture(t);
  const result=f.run(`
    const cli=${JSON.stringify(path.resolve(__dirname, "../scripts/telemetry.js"))};
    const command=args=>{process.argv=['node','telemetry.js',...args];delete require.cache[cli];require(cli);assert.notEqual(process.exitCode,1);};
    assert.equal(logger.getTelemetryOptIn(repo),null);
    command(['consent-set','on','--organization','ACME','--revision','absent','--acknowledge-machine-scope']);
    assert.equal(logger.getTelemetryOptIn(repo),null);
    command(['consent-set','on','--repository','github.com/acme/widgets','--revision','1','--acknowledge-machine-scope']);
    assert.equal(logger.getTelemetryOptIn(repo),true);
    command(['consent-set','off','--organization','acme','--revision','2']);
    assert.equal(logger.getTelemetryOptIn(repo),false);
    assert.equal(fs.existsSync(legacyPolicyFile),false);
  `);
  assert.match(result.stdout,/\[ ORGANIZATION ON \][\s\S]*Revision +1/);
  assert.match(result.stdout,/\[ TELEMETRY ON \][\s\S]*Revision +2/);
  assert.match(result.stdout,/\[ ORGANIZATION OFF \][\s\S]*Revision +3/);
});

test("CLI rejects an organization the license does not cover", t => {
  const f=fixture(t);
  const result=f.run(`
    process.argv=['node','telemetry.js','consent-set','on','--organization','other','--revision','absent','--acknowledge-machine-scope'];
    require(${JSON.stringify(path.resolve(__dirname, "../scripts/telemetry.js"))});
    assert.equal(process.exitCode,1);process.exitCode=0;
    assert.equal(fs.existsSync(policyFile),false);
  `);
  assert.match(result.stderr,/ORGANIZATION_UNAVAILABLE/);
});
