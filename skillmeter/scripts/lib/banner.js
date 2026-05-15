/**
 * ASCII welcome banner shown on /skillmeter:signin success. Kept in one
 * place so the in-Claude expansion hook and the direct shell flow render
 * the exact same art.
 *
 * Inner box width (between the two │ chars) is 42 columns. Box-drawing
 * glyphs and ✓ all render single-column in modern terminals.
 */

function welcomeBanner(orgs) {
  const identity = Array.isArray(orgs) && orgs.length
    ? `@${orgs.join(", @")}`
    : "(no GitHub identities cached)";

  return [
    "",
    "   ╭──────────────────────────────────────────╮",
    "   │                                          │",
    "   │           ✓   SkillMeter                 │",
    "   │               signed in                  │",
    "   │                                          │",
    "   ╰──────────────────────────────────────────╯",
    `      Welcome, ${identity}`,
    "",
  ].join("\n");
}

module.exports = { welcomeBanner };
