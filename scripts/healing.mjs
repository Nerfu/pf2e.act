import { t } from "./state.mjs";
import { rollCheck, animateRoll, describeRoll } from "./rolls.mjs";

/**
 * Quiet Treat Wounds for the module's preselected Medicine rank and patient.
 * Preserve the PF2e check engine, risky surgery / mortal healing adjustments,
 * native PF2e DamageRoll formulas, and Actor.applyDamage. No chat roll is posted.
 * The GM remains responsible for time, cooldowns, tools, and eligibility.
 */
const HEALING_BONUS = { trained: 0, expert: 10, master: 30, legendary: 50 };
const RANKS = ["untrained", "trained", "expert", "master", "legendary"];
const DCS = { trained: 15, expert: 20, master: 30, legendary: 40 };
const OUTCOMES_WITH_HEAL_ROLL = new Set(["success", "criticalSuccess", "criticalFailure"]);

function hasFeat(actor, slug) {
  return actor.items?.some(item => item.type === "feat" && item.slug === slug) ?? false;
}

/** Mirrors PF2e's temporary Risky Surgery toggle without persisting actor data. */
function riskySurgeryRule(actor) {
  return actor.rules?.find(rule => rule.key === "RollOption" && rule.option === "risky-surgery") ?? null;
}

function damageRollClass() {
  // PF2e registers its DamageRoll class among Foundry's roll types during setup.
  const cls = CONFIG.Dice.rolls.find(type => type.name === "DamageRoll");
  if (!cls) throw new Error(t("MissingHealingRoll"));
  return cls;
}

async function rollTreatmentDice(formula) {
  const DamageRoll = damageRollClass();
  const roll = await new DamageRoll(formula).roll();
  await animateRoll(roll);
  return roll;
}

async function applyTreatmentRoll(target, token, roll, { damaging, outcome }) {
  const amount = roll?.total;
  if (!Number.isFinite(amount) || amount < 0) throw new Error(t("MissingHealingRoll"));
  await target.applyDamage({
    damage: damaging ? roll : -amount,
    token,
    skipIWR: !damaging,
    rollOptions: new Set(["action:treat-wounds"]),
    outcome,
  });
  return { ...describeRoll(roll), amount, damaging };
}

export async function performTreatment(actor, target, choice) {
  const skill = actor.getStatistic?.("medicine") ?? actor.skills?.medicine;
  if (!skill?.check?.roll || Number(actor.skills?.medicine?.rank ?? 0) < 1) {
    throw new Error(`${actor.name}: ${t("MedicineTrainingRequired")}`);
  }
  const selectedRank = RANKS.indexOf(choice.rank);
  const currentRank = Math.min(selectedRank, Number(actor.skills.medicine.rank));
  const usedRank = RANKS[currentRank];
  const dc = DCS[usedRank];
  if (!Number.isFinite(dc)) throw new Error(t("InvalidChoice"));

  const risky = hasFeat(actor, "risky-surgery") &&
    actor.getRollOptions(["medicine"]).includes("risky-surgery");
  const mortal = hasFeat(actor, "mortal-healing") && !risky;
  const rule = riskySurgeryRule(actor);
  const oldValue = rule?.value;
  const adjustments = actor.synthetics?.degreeOfSuccessAdjustments?.medicine ?? [];
  const adjustment = mortal ? {
    adjustments: { success: { label: "PF2E.Actions.TreatWounds.Feats.MortalHealing", amount: 1 } },
  } : null;
  // Use the native PF2e degree adjustment mechanism, not a post-hoc total alteration.
  if (adjustment) {
    actor.synthetics.degreeOfSuccessAdjustments.medicine ??= adjustments;
    adjustments.push(adjustment);
  }
  if (rule) rule.value = risky;

  let check;
  try {
    const options = ["action:treat-wounds", ...actor.getRollOptions(["all", "skill-check", "medicine"])];
    if (risky && !options.includes("risky-surgery")) options.push("risky-surgery");
    check = await rollCheck(actor, "medicine", {
      action: "treat-wounds", options,
      traits: ["exploration", "healing", "manipulate"],
      dc: { value: dc, visible: true },
    });
  } finally {
    if (rule) rule.value = oldValue;
    if (adjustment) {
      const i = adjustments.indexOf(adjustment);
      if (i >= 0) adjustments.splice(i, 1);
    }
  }

  const result = check;
  if (!OUTCOMES_WITH_HEAL_ROLL.has(result.outcome) && !risky) return result;

  // The same PF2e formulas as Treat Wounds' native callback, but without messages.
  const bonus = HEALING_BONUS[usedRank] +
    (hasFeat(actor, "medic-dedication") ? (currentRank - 1) * 5 : 0) +
    (hasFeat(actor, "magic-hands") ? Number(actor.system?.details?.level?.value ?? 0) : 0);
  const healDice = hasFeat(actor, "magic-hands") ? "d10" : "d8";
  const healFormula = result.outcome === "criticalFailure" ? "{1d8}" :
    OUTCOMES_WITH_HEAL_ROLL.has(result.outcome)
      ? `{(${result.outcome === "criticalSuccess" ? 4 : 2}${healDice}${bonus > 0 ? ` + ${bonus}` : ""})[healing]}`
      : null;

  // Evaluate all required dice first. Once application begins, never re-roll them.
  const riskyRoll = risky ? await rollTreatmentDice("{1d8[slashing]}") : null;
  const healingRoll = healFormula ? await rollTreatmentDice(healFormula) : null;
  const token = await target.getTokenDocument({ actorLink: true });
  if (!token) throw new Error(t("MissingHealingToken"));
  if (riskyRoll) result.risky = await applyTreatmentRoll(target, token, riskyRoll, {
    damaging: true, outcome: result.outcome,
  });
  if (healingRoll) {
    const damaging = result.outcome === "criticalFailure";
    result.applied = await applyTreatmentRoll(target, token, healingRoll, { damaging, outcome: result.outcome });
    if (!damaging && target.hasCondition?.("wounded")) {
      await target.toggleCondition("wounded", { active: false });
    }
  }
  return result;
}
