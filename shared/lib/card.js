"use strict";

/**
 * The status card both SkillMeter clients print: a content-sized box in plain
 * Unicode, titled with the plugin version and any non-stable channel. Plain
 * Unicode because Claude Code's systemMessage displays ANSI escape codes
 * literally. Each client decides the card's lines; a caller that writes the
 * card straight to a terminal adds the final newline.
 */

function cardTitle({ version, channel, env } = {}) {
  const name = version ? `SkillMeter v${version}` : "SkillMeter";
  return channel && channel !== "stable" ? `${name} · ${channel} (${env})` : name;
}

// Content-sized card (2-space body padding). All glyphs used here are
// single-column, so [...value].length measures the visible width correctly.
//
// Every card starts with a newline: the renderers that show these prefix the
// first line ("SessionStart:startup says: ", "FileChanged says: "), which would
// otherwise indent the top border past the rest of the box.
function renderCard(lines, header) {
  const title = cardTitle(header);
  const bodyWidth = Math.max([...title].length, ...lines.map((line) => [...line].length));
  const innerWidth = bodyWidth + 4;
  const titleRule = `─ ${title} `;
  const top = `╭${titleRule}${"─".repeat(innerWidth - [...titleRule].length)}╮`;
  const body = lines.map((line) => `│  ${line}${" ".repeat(bodyWidth - [...line].length)}  │`);
  return ["", top, ...body, `╰${"─".repeat(innerWidth)}╯`].join("\n");
}

// A label padded to the value column the cards share.
const cardRow = (label, value) => `${label.padEnd(14)}${value}`;

module.exports = { renderCard, cardRow };
