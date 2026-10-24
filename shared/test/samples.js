"use strict";
// Synthetic credentials for the sanitizer tests; no complete token literal
// appears in source.

// High-entropy filler so no complete token literal appears in source.
const HI = "aB3dEf6hIj9kLm2nOp5qRs8tUvWxYz0AbC4dEfGhIjKlMnOp";
const hi = n => HI.slice(0, n);

const SAMPLES = {
  "github-token": "ghp_" + hi(36),
  "gitlab-pat": "glpat-" + hi(20),
  "aws-access-token": "AKIAIOSFODNN7EXAMPLE",
  "google-api-key": "AIza" + hi(35),
  "slack-token": "xoxb-" + hi(30),
  "openai-api-key": "sk-proj-" + hi(43),
  "anthropic-api-key": "sk-ant-" + hi(36),
  "stripe-access-token": "sk_live_" + hi(24),
  "npm-access-token": "npm_" + hi(36),
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
  "database-url": "postgres://admin:s3cr3tP4ss@db.internal:5432/prod",
};

module.exports = { hi, SAMPLES };
