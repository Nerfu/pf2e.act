import { ID } from "./config.mjs";
import { t, userFor } from "./state.mjs";

/** Read evaluated PF2e rolls, including native modifier and kept-die information. */
export function describeRoll(roll, outcome = null, message = null) {
  const dice = Array.isArray(roll?.dice) ? roll.dice.map(term => ({
    faces: Number(term.faces) || 0,
    results: (term.results ?? []).filter(r => Number.isFinite(r.result)).map(r => ({
      value: r.result, kept: r.active !== false && r.discarded !== true,
    })),
  })).filter(term => term.faces && term.results.length) : [];
  // Match PF2e chat highlighting: only an active d20 showing a natural 1 or 20.
  // Damage/healing dice and discarded fortune/misfortune dice never trigger it.
  const firstDie = dice[0];
  const kept = firstDie?.faces === 20 ? firstDie.results.filter(d => d.kept) : [];
  const natural = kept.length && kept.every(d => d.value === 20) ? 20
    : kept.length && kept.every(d => d.value === 1) ? 1 : null;
  const modifiers = (message?.flags?.pf2e?.modifiers ?? [])
    .filter(m => m.enabled !== false && !m.ignored && Number.isFinite(m.modifier) && m.modifier !== 0)
    .map(m => ({ label: String(m.label ?? m.slug ?? ""), value: m.modifier }));
  return {
    total: Number.isFinite(roll?.total) ? roll.total : null,
    outcome,
    formula: String(roll?.formula ?? ""),
    dice,
    natural,
    modifiers,
  };
}

/** DSN applies the selected character's owner's appearance, or falls back to the GM. */
export async function animateRoll(roll, { actor = null, secret = false } = {}) {
  if (!roll || !game.modules.get("dice-so-nice")?.active || typeof game.dice3d?.showForRoll !== "function") return;
  const roller = (actor && userFor(actor)) || game.user;
  const recipients = secret ? [...new Set([game.user.id,
    ...ChatMessage.getWhisperRecipients("GM").map(u => u.id)])] : null;
  const speaker = actor && typeof ChatMessage.getSpeaker === "function"
    ? ChatMessage.getSpeaker({ actor }) : undefined;
  try {
    // The client running the checks is the GM; the visual dice belong to the
    // assigned player. GM-only whispers never include the character's player.
    await game.dice3d.showForRoll(roll, roller, true, recipients, false, null, speaker,
      { ghost: false, secret });
  } catch (error) {
    // An animation error must not change or re-roll an evaluated PF2e result.
    console.warn(`${ID} | Dice So Nice could not animate a roll`, error);
  }
}

/** Launch every recorded roll in a single wave and await all animations together. */
export async function playRollWave(queue) {
  if (!queue?.length) return;
  // map starts all showForRoll calls without awaiting the previous one. Dice So
  // Nice may visually merge them according to its own simultaneous-roll setting.
  await Promise.all(queue.map(({ roll, actor, secret }) => animateRoll(roll, { actor, secret })));
}

/** Native PF2e check; no modifier dialog or chat roll card is ever created. */
export async function rollCheck(actor, slug, {
  secret = false, action = "", options = [], traits = [], dc = null, queue = null,
} = {}) {
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
  if (queue) queue.push({ roll, actor, secret });
  else await animateRoll(roll, { actor, secret });
  return describeRoll(roll, outcome, message);
}
