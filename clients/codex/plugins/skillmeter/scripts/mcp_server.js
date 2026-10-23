#!/usr/bin/env node
/**
 * SkillMeter's MCP server for Codex. It asks consent questions through MCP
 * elicitation, which Codex renders as a form with a picker, the counterpart
 * of AskUserQuestion in the Claude Code plugin. Nothing changes unless the
 * user accepts the form; a declined, cancelled or unsupported form returns an
 * outcome the skills answer with a text question instead.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio, no dependencies.
 * Only responses go to stdout; diagnostics go to stderr.
 */

const path = require("path");

const SCOPE_STATEMENT = "This choice applies to SkillMeter for Codex on this machine and to every clone or worktree of these repositories. It does not change SkillMeter for Claude Code.";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-11-25", "2026-07-28"];

let version = "";
try { version = require(path.join(__dirname, "..", ".codex-plugin", "plugin.json")).version || ""; }
catch { /* The version is informational. */ }

const cwdProperty = {
  type: "string",
  description: "Absolute path of the working directory the user is in; used to find the current repository.",
};

const TOOLS = [
  {
    name: "onboard_organization",
    title: "Choose SkillMeter telemetry for an organization",
    description: "Shows the user a form to choose Codex telemetry for one licensed GitHub organization and its local repositories, then saves the answer. Use after sign-in or when the user wants to change an organization's choice.",
    inputSchema: {
      type: "object",
      properties: { organization: { type: "string", description: "Organization exactly as in the sign-in state." }, cwd: cwdProperty },
      required: ["organization"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "review_repositories",
    title: "Review SkillMeter telemetry for local repositories",
    description: "Shows the user a form with every local repository of the licensed organizations as ON or OFF, then saves the changes. Use for the telemetry list.",
    inputSchema: { type: "object", properties: { cwd: cwdProperty } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

// --- JSON-RPC over stdio ---------------------------------------------------

let clientCapabilities = {};
let nextId = 1;
const pending = new Map();

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function request(method, params) {
  const id = `skillmeter-${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

// Absent capability, an error response or a closed connection all mean the
// form could not be shown.
async function elicit(message, requestedSchema) {
  if (!clientCapabilities.elicitation) return { action: "unavailable" };
  try {
    const result = await request("elicitation/create", { message, requestedSchema });
    return result && typeof result.action === "string" ? result : { action: "unavailable" };
  } catch {
    return { action: "unavailable" };
  }
}

// --- Tools -------------------------------------------------------------------

function inventoryFor(cwd) {
  const { loadInventory } = require("./lib/repository-inventory");
  return loadInventory({ cwd }).inventory;
}

const revisionOf = inventory => inventory.revision === "absent" ? null : inventory.revision;
const lines = repositories => repositories.map(repo => repo.displayName).join("\n");

function outcomeFor(answer) {
  if (answer.action === "unavailable") return { outcome: "unavailable" };
  return { outcome: answer.action === "accept" ? "no_choice" : answer.action === "decline" ? "declined" : "cancelled" };
}

async function onboardOrganization({ organization, cwd }) {
  const org = String(organization || "").trim().toLowerCase();
  const inventory = inventoryFor(cwd);
  const entry = inventory.orgs.find(item => item.org === org);
  if (!entry) throw Object.assign(new Error("This organization is not covered by the current license and scope settings."), { code: "ORGANIZATION_UNAVAILABLE" });
  const repositories = inventory.repositories.filter(repo => repo.org === org);
  const listed = repositories.filter(repo => !repo.localRestriction);
  const restricted = repositories.filter(repo => repo.localRestriction);
  const fresh = listed.filter(repo => repo.consent === null);

  // Each option: title shown in the picker, and the write it stands for.
  let question, options;
  if (entry.consent === null) {
    question = [`Choose telemetry for @${org}.`, listed.length ? `Repositories found:\n${lines(listed)}` : `No local @${org} repositories found.`];
    options = [
      ...(listed.length ? [{ const: "enable_listed", title: "Enable listed repositories", write: { action: "onboard", enabled: true, keys: listed.map(repo => repo.key) } }] : []),
      { const: "organization_only", title: "Organization only (keep repositories off)", write: { action: "onboard", enabled: false, keys: listed.map(repo => repo.key) } },
      { const: "keep_off", title: "Keep telemetry off", write: { action: "org", enabled: false } },
    ];
  } else if (entry.consent === true) {
    question = [`Keep SkillMeter telemetry authorized for @${org}?`, ...(fresh.length ? [`New repositories:\n${lines(fresh)}`] : [])];
    options = [
      ...(fresh.length ? [{ const: "enable_new", title: "Enable new repositories", write: { action: "onboard", enabled: true, keys: fresh.map(repo => repo.key) } }] : []),
      { const: "keep_authorized", title: "Keep authorized", write: null },
      { const: "turn_off", title: "Turn telemetry off", write: { action: "org", enabled: false } },
    ];
  } else {
    question = [`Authorize SkillMeter telemetry for @${org}?`];
    options = [
      { const: "authorize", title: `Authorize @${org}`, write: { action: "org", enabled: true } },
      { const: "keep_off", title: "Keep off for now", write: { action: "org", enabled: false } },
    ];
  }
  if (restricted.length) question.push(`Turned off in this checkout's local settings (not changed here):\n${lines(restricted)}`);
  if (inventory.globalPaused) question.push("Codex telemetry is paused on this machine; nothing is sent until it is resumed.");
  question.push(SCOPE_STATEMENT, "Turning an organization off removes the queued, unsent data of its repositories.");

  const answer = await elicit(question.join("\n\n"), {
    type: "object",
    properties: { choice: { type: "string", title: `Telemetry for @${org}`, oneOf: options.map(({ const: value, title }) => ({ const: value, title })) } },
    required: ["choice"],
  });
  const option = answer.action === "accept" && options.find(item => item.const === answer.content?.choice);
  if (!option) return outcomeFor(answer);
  if (!option.write) return { outcome: "unchanged", choice: option.const };

  const { runConsentAction } = require("./lib/consent-actions");
  const result = runConsentAction({
    ...option.write, organization: org, cwd, expectedRevision: revisionOf(inventory),
    // The option was chosen in a form that showed the scope statement.
    acknowledged: true,
  });
  return { outcome: result.stale ? "stale" : "applied", choice: option.const, result };
}

async function reviewRepositories({ cwd }) {
  const inventory = inventoryFor(cwd);
  const actionable = inventory.repositories.filter(repo => repo.action);
  const blocked = inventory.repositories.filter(repo => !repo.action)
    .map(({ key, displayName, effective, blockedBy }) => ({ key, displayName, effective, blockedBy }));
  if (!actionable.length) return { outcome: "nothing_to_review", blocked };

  // A titled single-select per repository: Codex renders it as an ON/OFF
  // picker, where a boolean would read True/False.
  const properties = Object.fromEntries(actionable.map((repo, index) => [`r${index}`, {
    type: "string",
    title: repo.displayName,
    oneOf: [{ const: "on", title: "ON" }, { const: "off", title: "OFF" }],
    default: repo.effective,
  }]));
  const message = [
    "Choose ON or OFF for each repository.",
    ...(blocked.length ? [`Not shown (blocked by the pause or the organization's choice):\n${lines(blocked)}`] : []),
    SCOPE_STATEMENT,
    "Turning a repository off removes its queued, unsent data.",
  ].join("\n\n");
  const answer = await elicit(message, { type: "object", properties });
  if (answer.action !== "accept") return { ...outcomeFor(answer), blocked };

  const keys = actionable.filter((repo, index) => ["on", "off"].includes(answer.content?.[`r${index}`]) &&
    answer.content[`r${index}`] !== repo.effective).map(repo => repo.key);
  if (!keys.length) return { outcome: "unchanged", blocked };
  const { runConsentAction } = require("./lib/consent-actions");
  const result = runConsentAction({ action: "toggle", keys, cwd, expectedRevision: revisionOf(inventory), acknowledged: true });
  return { outcome: result.stale ? "stale" : "applied", result, blocked };
}

const HANDLERS = { onboard_organization: onboardOrganization, review_repositories: reviewRepositories };

async function callTool({ name, arguments: args = {} }) {
  const handler = HANDLERS[name];
  if (!handler) throw Object.assign(new Error(`Unknown tool ${name}.`), { rpc: -32602 });
  const cwd = typeof args.cwd === "string" && path.isAbsolute(args.cwd) ? args.cwd : process.cwd();
  try {
    const result = await handler({ ...args, cwd });
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  } catch (err) {
    const result = { outcome: "error", code: err.code || "CONSENT_UPDATE_FAILED", message: err.message };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
  }
}

async function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "error"));
    else waiter.resolve(message.result);
    return;
  }
  const { id, method, params = {} } = message;
  try {
    let result;
    if (method === "initialize") {
      clientCapabilities = params.capabilities || {};
      result = {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "skillmeter", version },
        instructions: "SkillMeter consent questions for Codex. Call these tools only when a SkillMeter skill says so.",
      };
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      result = await callTool(params);
    } else if (method === "ping") {
      result = {};
    } else if (id === undefined) {
      return; // Notifications such as notifications/initialized need no reply.
    } else {
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    if (id !== undefined) send({ id, result });
  } catch (err) {
    if (id !== undefined) send({ id, error: { code: err.rpc || -32603, message: err.message } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    handle(message).catch(err => process.stderr.write(`[skillmeter] MCP request failed: ${err.message}\n`));
  }
});
process.stdin.on("end", () => {
  for (const waiter of pending.values()) waiter.reject(new Error("connection closed"));
  process.exit(0);
});
