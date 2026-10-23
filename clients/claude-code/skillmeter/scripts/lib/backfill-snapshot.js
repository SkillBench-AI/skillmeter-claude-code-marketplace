/**
 * Privacy boundary used only for historical snapshots. Live transcript
 * sanitization still owns secret/PII/path scrubbing; this pass removes payload
 * classes that should never be copied from history in the first place.
 */

const DROP = Symbol("drop");
const OMITTED_TYPES = new Set(["image", "tool_result"]);
const OMITTED_KEYS = new Set(["toolUseResult"]);

function stripHistoricalPayload(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => stripHistoricalPayload(item))
      .filter((item) => item !== DROP);
  }
  if (!value || typeof value !== "object") return value;
  if (OMITTED_TYPES.has(value.type)) return DROP;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (OMITTED_KEYS.has(key)) continue;
    const sanitized = stripHistoricalPayload(child);
    if (sanitized !== DROP) out[key] = sanitized;
  }
  return out;
}

function prepareHistoricalRecords(records) {
  return records.map((record) => {
    const prepared = stripHistoricalPayload(record);
    return prepared === DROP ? {} : prepared;
  });
}

module.exports = {
  prepareHistoricalRecords,
};
