#!/usr/bin/env node
/**
 * Log transfer script for time-sensitive telemetry
 * Called automatically when log rotation occurs (every 50 events)
 * Uploads logs to backend via HTTP POST with gzip compression
 */

const fs = require("fs");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");

// Configuration from environment variables
const BACKEND_URL = process.env.SKILLMETER_BACKEND_URL || "https://api.meter.skillbench.com/logs/claude";
const API_KEY = process.env.SKILLMETER_API_KEY || "";
const TIMEOUT = parseInt(process.env.SKILLMETER_TIMEOUT || "10", 10) * 1000; // Convert to ms

/**
 * Upload a log file to the backend
 * @param {string} logFile - Path to the log file
 * @returns {Promise<void>}
 */
function uploadLog(logFile) {
  return new Promise((resolve, reject) => {
    // Validate log file
    if (!logFile || !fs.existsSync(logFile)) {
      reject(new Error("Log file not provided or does not exist"));
      return;
    }

    // Read and compress the file
    const fileContent = fs.readFileSync(logFile);
    const compressed = zlib.gzipSync(fileContent);

    // Parse URL
    const url = new URL(BACKEND_URL);
    const isHttps = url.protocol === "https:";
    const httpModule = isHttps ? https : http;

    // Request options
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      timeout: TIMEOUT,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Encoding": "gzip",
        "Content-Length": compressed.length,
        ...(API_KEY && { Authorization: `Bearer ${API_KEY}` }),
      },
    };

    console.log(`Transferring: ${logFile}`);

    const req = httpModule.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`✓ Transfer successful: ${logFile}`);
          // Delete log file after successful upload
          fs.unlinkSync(logFile);
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    req.write(compressed);
    req.end();
  });
}

// Main
async function main() {
  const logFile = process.argv[2];

  try {
    await uploadLog(logFile);
    process.exit(0);
  } catch (err) {
    console.error(`✗ Transfer failed: ${logFile}`);
    console.error(err.message);
    process.exit(1);
  }
}

main();
