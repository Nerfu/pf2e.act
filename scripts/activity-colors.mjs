/** Read a Foundry user color without modifying it. The background is only for activity-choice pills. */
const BACKGROUNDS = [
  "#b8bdc5", // subdued neutral light: black/dark blue text
  "#242a32", // subdued neutral dark: pale or vivid text
  "#d4d8de", // stronger contrast for dark midtones
  "#0e1217", // stronger contrast for bright midtones
];

function luminance(hex) {
  const value = hex.slice(1);
  const short = value.length === 3 || value.length === 4;
  const rgb = short
    ? [...value.slice(0, 3)].map(v => parseInt(v + v, 16))
    : [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16));
  const linear = rgb.map(channel => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Returns a muted, contrasting background while leaving the player's exact text/border color intact.
 * The candidate order prefers quieter tones and escalates only if readability requires it.
 */
export function activityChoicePalette(color) {
  if (typeof color !== "string" || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) {
    return { background: "rgba(95,130,165,0.15)", detailColor: "var(--color-text-primary, inherit)", border: "transparent" };
  }
  const foreground = luminance(color);
  const candidates = BACKGROUNDS.map(background => ({
    background,
    score: contrast(foreground, luminance(background)),
    detailColor: luminance(background) > 0.18 ? "#2b3038" : "#d9dce2",
  }));
  const chosen = candidates.find(candidate => candidate.score >= 4.5)
    ?? candidates.reduce((best, candidate) => candidate.score > best.score ? candidate : best);
  return { background: chosen.background, detailColor: chosen.detailColor, border: color };
}
