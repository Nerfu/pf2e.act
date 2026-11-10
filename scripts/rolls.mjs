import { ID } from "./config.mjs";
import { t } from "./state.mjs";

/** Read the evaluated PF2e roll and its native, already-calculated modifiers. */
export function describeRoll(roll, outcome = null, message = null) {
  const dice = Array.isArray(roll?.dice) ? roll.dice.map(term => ({
    faces: Number(term.faces) || 0,
    results: (term.results ?? []).filter(r => Number.isFinite(r.result)).map(r => ({
      value: r.result, kept: r.active !== false && r.discarded !== true,
    })),
  })).filter(term => term.faces && term.results.length) : [];
  const modifiers = (message?.flags?.pf2e?.modifiers ?? [])
    .filter(m => m.enabled !== false && !m.ignored && Number.isFinite(m.modifier) && m.modifier !== 0)
    .map(m => ({ label: String(m.label ?? m.slug ?? ""), value: m.modifier }));
  return {
    total: Number.isFinite(roll?.total) ? roll.total : null,
    outcome,
    formula: String(roll?.formula ?? ""),
    dice,
    modifiers,
  };
}

/** DSN is optional; show directly instead of creating roll messages. */
export async function animateRoll(roll, { secret = false } = {}) {
  if (!roll || !game.modules.get("dice-so-nice")?.active || typeof game.dice3d?.showForRoll !== "function") return;
  const recipients = secret ? [...new Set([game.user.id,
    ...ChatMessage.getWhisperRecipients("GM").map(u => u.id)])] : null;
  try {
    // Whispers are restricted to GMs even on synchronized clients. Never broadcast hidden dice.
    await game.dice3d.showForRoll(roll, game.user, true, recipients, false);
  } catch (error) {
    // Animation errors cannot change or re-roll an already evaluated PF2e result.
    console.warn(`${ID} | Dice So Nice could not animate a roll`, error);
  }
}

/** One native PF2e check, without a modifier dialog or a standalone chat card. */
export async function rollCheck(actor, slug, { secret = false, action = "", options = [], traits = [], dc = null } = {}) {
  const statistic = actor.getStatistic?.(slug) ?? actor.skills?.[slug] ?? (slug === "perception" ? actor.perception : null);
  if (!statistic?.check?.roll) throw new Error(`${actor.name}: ${t("MissingStatistic")} (${slug})`);
  let outcome = null;
  let message = null;
  const roll = await statistic.check.roll({
    action: action || undefined,
    extraRollOptions: options,
    traits,
    dc,
    skipDialog: true,
    messageMode: secret ? "blind" : "public",
    createMessage: false,
    callback: (_roll, degree, source) => { outcome = degree ?? null; message = source ?? null; },
  });
  if (!roll) throw new Error(`${actor.name}: ${t("MissingRoll")}`);
  await animateRoll(roll, { secret });
  return describeRoll(roll, outcome, message);
}
