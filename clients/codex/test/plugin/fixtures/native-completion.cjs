"use strict";
// Authored synthetic data. The token is a non-functional detector fixture.
const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const email = "native-fixture@example.com";
function records(home) {
  const root = `${home}/synthetic-native-work`;
  const source = { id: "synthetic-native-session", cwd: root, source: "cli" };
  const complete = (item) => ({type: "event_msg", payload: {
    type: "item_completed", thread_id: source.id, turn_id: "synthetic-turn", item,
    started_at_ms: 1789776000000, completed_at_ms: 1789776001000,
  }});
  const command = (id, status, exit_code) => complete({
    type: "CommandExecution", id, status, exit_code, cwd: root,
    command: ["node", "test.js", `--token=${token}`, `--contact=${email}`],
    parsed_cmd: [], source: "unified_exec_startup",
    stdout: `contact ${email}`, stderr: `fixture token ${token}`,
  });
  return [
    {type: "session_meta", payload: source},
    {type: "response_item", payload: {type: "message", role: "user", content: "Synthetic native test"}},
    {type: "response_item", payload: {type: "custom_tool_call", call_id: "wrapper", name: "exec",
      input: `text(await tools.apply_patch("synthetic ${token}"));`}},
    complete({type: "FileChange", id: "native-patch", status: "completed", changes: {
      [`${root}/src/cart.cjs`]: {type: "update", unified_diff: `@@ -1 +1 @@\n-return price;\n+return units * price; // ${email} ${token}`, move_path: null},
      [`${root}/src/new.cjs`]: {type: "add", content: `module.exports = 1; // ${email} ${token}\n`},
      [`${root}/src/old.cjs`]: {type: "delete", content: `old value // ${email} ${token}`},
      [`${root}/src/move.cjs`]: {type: "update", unified_diff: "-old\n+new", move_path: `${root}/src/moved.cjs`},
    }, stdout: `updated ${root}/src/cart.cjs`, stderr: ""}),
    complete({type: "FileChange", id: "native-failed-patch", status: "failed", changes: {
      [`${root}/src/rejected.cjs`]: {type: "update", unified_diff: "-old\n+new", move_path: null},
    }, stdout: "", stderr: `no match ${email} ${token}`}),
    command("command-success", "completed", 0),
    command("command-failure", "failed", 1),
    command("command-declined", "declined", null),
    {type: "response_item", payload: {type: "custom_tool_call_output", call_id: "wrapper", output: "Synthetic operations complete"}},
  ];
}
module.exports = {records, token, email};
