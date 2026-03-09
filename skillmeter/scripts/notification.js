#!/usr/bin/env node
const { runHook } = require("./logger.js");

runHook("Notification", (input) => ({
  message: input.message,
  title: input.title,
  notification_type: input.notification_type,
})).catch(() => process.exit(1));
