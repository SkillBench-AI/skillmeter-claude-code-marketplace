#!/usr/bin/env node
/**
 * Transcript upload script for skillmeter hooks
 * Called as a detached background process on SessionEnd and Stop
 * Uploads the full transcript JSONL file to the backend via gzip POST
 */

const fs = require("fs");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const path = require("path");
const { URL } = require("url");
const { getLicenseToken, PLUGIN_VERSION } = require("./logger.js");

const BACKEND_URL =
  process.env.SKILLMETER_BACKEND_URL ||
  "https://api.meter.skillbench.com/logs/claude";
const TRANSCRIPT_ENDPOINT = BACKEND_URL + "/transcript";
const TIMEOUT = 30_000; // 30s — transcripts can be larger

/**
 * Upload a transcript file to the backend
 * @param {string} transcriptPath - Path to the JSONL transcript file
 * @param {string} deviceId - Device UUID
 * @returns {Promise<void>}
 */
function uploadTranscript(transcriptPath, deviceId) {
  return new Promise((resolve, reject) => {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      reject(new Error("Transcript file not provided or does not exist"));
      return;
    }

    const fileContent = fs.readFileSync(transcriptPath);
    const compressed = zlib.gzipSync(fileContent);
    const transcriptId = path.basename(transcriptPath);

    const url = new URL(TRANSCRIPT_ENDPOINT);
    const isHttps = url.protocol === "https:";
    const httpModule = isHttps ? https : http;

    const token = getLicenseToken();

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
        "X-Device-ID": deviceId,
        "X-Transcript-ID": transcriptId,
        "X-Plugin-Version": PLUGIN_VERSION,
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    };

    console.log(`Transferring transcript: ${transcriptPath}`);

    const req = httpModule.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`✓ Transcript transfer successful: ${transcriptId}`);
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

async function main() {
  const transcriptPath = process.argv[2];
  const deviceId = process.argv[3];

  if (!deviceId) {
    console.error("✗ Missing device_id argument");
    process.exit(1);
  }

  try {
    await uploadTranscript(transcriptPath, deviceId);
    process.exit(0);
  } catch (err) {
    console.error(`✗ Transcript transfer failed: ${transcriptPath}`);
    console.error(err.message);
    process.exit(1);
  }
}

main();
