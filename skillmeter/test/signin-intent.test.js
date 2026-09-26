"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { makeTempDir, writeJson } = require("../testing/helpers");

for (const mode of ["background", "background-cycle", "background-missing", "background-cycle-failure", "foreground", "foreground-cycle", "spawn"]) {
  test(`sign-in CLI binds the original intent: ${mode}`, () => {
    const root = makeTempDir("signin-intent-");
    const state = path.join(root, ".skillbench");
    const file = path.join(state, "credentials.json");
    writeJson(file, { device_id: "fixture-device", hash_salt: "fixture-salt", auth_generation: "fixture-generation" });
    const preload = path.join(root, "preload.cjs");
    fs.writeFileSync(preload, `
      const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)};
      const fs = require("fs"), path = require("path");
      require("os").homedir = () => root;
      const bootstrap = require(${JSON.stringify(path.resolve(__dirname, "../testing/bootstrap.js"))});
      process.on("exit", () => fs.rmSync(bootstrap.TEST_PLUGIN_DATA_ROOT, {recursive:true,force:true}));
      process.env.SKILLMETER_STATE_DIR = path.join(root, ".skillbench");
      Object.defineProperty(process.stdout, "isTTY", { value: mode.startsWith("foreground") });
      const cp = require("child_process");
      for (const key of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]) cp[key] = () => { throw Error("unexpected-subprocess"); };
      cp.spawnSync = () => ({ status: 1 });
      cp.spawn = (_cmd, args) => {
        const current = JSON.parse(fs.readFileSync(path.join(root,".skillbench/credentials.json")));
        require("assert/strict").equal(args[5], current.auth_generation);
        fs.writeFileSync(path.join(root,"spawn-checked"), "yes");
        return { unref() {} };
      };
      for (const name of ["http", "https", "net", "tls"]) {
        const module = require(name);
        for (const key of ["get", "request", "connect", "createConnection"]) if (module[key]) module[key] = () => { throw Error("network-forbidden"); };
      }
      const store = require(${JSON.stringify(path.resolve(__dirname, "../scripts/credstore.js"))});
      global.fetch = async (url) => {
        const target = String(url);
        let payload;
        if (target.endsWith("/activate")) payload = {token:"fixture-issued"};
        else if (target.includes("device")) payload = {device_code:"fixture-code",user_code:"fixture",verification_uri:"https://fixture.invalid",expires_in:60,interval:0.001};
        else {
          if (mode.includes("cycle")) {
            store.signOut(); store.markEngaged(); store.commitSignin({jwt:"fixture-newer"});
            store.writeSigninResult({status:"success", marker:"newer-intent"});
          }
          if (mode.endsWith("failure")) throw Error("synthetic-old-poll-error");
          payload = {id_token:"fixture-id-token"};
        }
        return {ok:true,status:200,json:async()=>payload,text:async()=>JSON.stringify(payload)};
      };
    `);
    const args = ["-r", preload, path.resolve(__dirname, "../scripts/signin.js")];
    if (mode.startsWith("background")) {
      args.push("--background-poll", "fixture-device", "fixture-code", "0.001");
      if (mode !== "background-missing") args.push("fixture-generation");
    }
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 5000,
      cwd: root, env: { PATH: process.env.PATH, TMPDIR: os.tmpdir() } });
    assert.equal(result.status, (mode === "background-missing" || mode.endsWith("failure")) ? 1 : 0, result.stderr);
    const current = JSON.parse(fs.readFileSync(file));
    if (mode.includes("cycle")) {
      const sentinel = JSON.parse(fs.readFileSync(path.join(state, "signin-result.json")));
      assert.equal(sentinel.status, "success");
      assert.equal(sentinel.marker, "newer-intent");
    }
    if (mode === "spawn") assert.equal(fs.readFileSync(path.join(root, "spawn-checked"), "utf8"), "yes");
    else assert.equal(current.license_jwt, mode.includes("cycle") ? "fixture-newer" :
      mode === "background-missing" ? undefined : "fixture-issued");
  });
}
