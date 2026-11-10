import { ID } from "./config.mjs";
import { t } from "./state.mjs";

/**
 * Apply native PF2e Treat Wounds rolls to the explicitly chosen Party member.
 * We do not prevent repeated treatment or manage time, immunity, or toolkit use.
 * Game rules and decisions about eligibility remain with the GM.
 */

const TREAT_OUTCOMES = new Set(["success", "criticalSuccess", "criticalFailure"]);

function originId(message) {
  return message?.getFlag?.("pf2e", "origin")?.messageId ?? message?.flags?.pf2e?.origin?.messageId ?? null;
}

function isRiskySurgeryRoll(message) {
  const roll = message.rolls?.[0];
  const localized = game.i18n.localize("PF2E.Actions.TreatWounds.Rolls.RiskySurgery");
  return (localized !== "PF2E.Actions.TreatWounds.Rolls.RiskySurgery" &&
      String(message.flavor ?? "").includes(localized)) ||
      /\[slashing\]/i.test(String(roll?.formula ?? ""));
}

/** Observe before executing the native action so fast chat messages cannot be lost. */
function collectTreatmentMessages() {
  const observed = new Map();
  const watchers = new Set();
  function onCreate(message) {
    if (originId(message) && message.id) observed.set(message.id, message);
    for (const watcher of watchers) watcher();
  }
  const hookId = Hooks.on("createChatMessage", onCreate);
  const find = (checkId, kind) => {
    const all = new Map(game.messages.contents.map(m => [m.id, m]));
    for (const [id, message] of observed) all.set(id, message);
    return [...all.values()].find(message =>
      originId(message) === checkId &&
      Number.isFinite(message.rolls?.[0]?.total) &&
      (kind === "risky" ? isRiskySurgeryRoll(message) : !isRiskySurgeryRoll(message))
    );
  };
  return {
    async waitFor(checkId, kind) {
      const existing = find(checkId, kind);
      if (existing) return existing;
      return new Promise((resolve, reject) => {
        let timer;
        const done = () => {
          const message = find(checkId, kind);
          if (!message) return;
          clearTimeout(timer);
          watchers.delete(done);
          resolve(message);
        };
        watchers.add(done);
        timer = setTimeout(() => {
          watchers.delete(done);
          reject(new Error(t("MissingHealingRoll")));
        }, 12000);
        done(); // Close the gap between the initial search and subscription.
      });
    },
    stop() {
      Hooks.off("createChatMessage", hookId);
      watchers.clear();
    },
  };
}

async function patientToken(target) {
  // This is an Actor-based action; never depend on scene token selection.
  // A temporary linked prototype token provides the context PF2e applyDamage needs.
  const token = await target.getTokenDocument({ actorLink: true });
  if (!token) throw new Error(t("MissingHealingToken"));
  return token;
}

async function recordAutomaticApplication(message, target, amount, damaging) {
  try {
    await message.setFlag(ID, "autoApplied", {
      targetId: target.id, targetName: target.name, amount, damaging,
    });
  } catch (error) {
    console.warn(`${ID} | Unable to annotate an automatically applied treatment card`, error);
    // Not an HP error: the application itself succeeded. Don't apply again.
  }
}

async function applyNativeRoll(target, token, message, { type, outcome }) {
  const roll = message.rolls?.[0];
  const amount = roll?.total;
  if (!Number.isFinite(amount) || amount < 0) throw new Error(t("MissingHealingRoll"));
  if (message.getFlag?.(ID, "autoApplied")) throw new Error(t("AlreadyApplied"));

  const damaging = type !== "healing";
  // Risky Surgery uses a native slashing DamageRoll, respecting the PF2e damage
  // system. Critical failure uses its own native DamageRoll. Healing is negative
  // damage and passes through PF2e's healing-received adjustments and max HP cap.
  await target.applyDamage({
    damage: damaging ? roll : -amount,
    token,
    skipIWR: !damaging,
    rollOptions: new Set(["action:treat-wounds"]),
    outcome,
  });
  await recordAutomaticApplication(message, target, amount, damaging);
  return { amount, damaging, targetName: target.name };
}

export async function performTreatment(actor, target, choice, action) {
  const feats = {
    "risky-surgery": actor.items.some(item => item.type === "feat" && item.slug === "risky-surgery") &&
      actor.getRollOptions(["medicine"]).includes("risky-surgery"),
    "mortal-healing": actor.items.some(item => item.type === "feat" && item.slug === "mortal-healing"),
  };
  const collector = collectTreatmentMessages();
  try {
    const results = await action.use({
      actors: [actor], target,
      selection: { skill: "medicine", rank: choice.rank, modifier: 0, feats },
    });
    const entry = Array.isArray(results) ? results[0] : null;
    if (!entry?.roll) throw new Error(t("MissingHealingRoll"));
    const result = {
      total: Number.isFinite(entry?.roll?.total) ? entry.roll.total : null,
      outcome: entry?.outcome ?? null,
    };
    const hasTreatmentRoll = TREAT_OUTCOMES.has(result.outcome);
    // Risky Surgery deals its native 1d8 slashing damage even when the Medicine
    // check merely fails, in which case there is no treatment/healing roll.
    if (!hasTreatmentRoll && !feats["risky-surgery"]) return result;
    const checkId = entry?.message?.id;
    if (!checkId) throw new Error(t("MissingHealingRoll"));

    // Wait for all required dice before mutating any health. PF2e creates the
    // roll messages asynchronously after its check, sometimes in either order.
    const [riskyRoll, treatmentRoll] = await Promise.all([
      feats["risky-surgery"] ? collector.waitFor(checkId, "risky") : null,
      hasTreatmentRoll ? collector.waitFor(checkId, "treatment") : null,
    ]);
    const token = await patientToken(target);
    if (riskyRoll) result.risky = await applyNativeRoll(target, token, riskyRoll, { type: "risky", outcome: result.outcome });
    if (treatmentRoll) {
      const type = result.outcome === "criticalFailure" ? "damage" : "healing";
      result.applied = await applyNativeRoll(target, token, treatmentRoll, { type, outcome: result.outcome });

      // PF2e Treat Wounds success (including critical success) also removes Wounded.
      // No immunity, timers, or attempt tracking is added by this module.
      if (type === "healing" && target.hasCondition?.("wounded")) {
        await target.toggleCondition("wounded", { active: false });
      }
    }
    return result;
  } finally {
    collector.stop();
  }
}

/** Native PF2e roll cards stay visible; disable manual reapplication after success. */
export function renderAppliedTreatment(message, html) {
  const applied = message.getFlag?.(ID, "autoApplied");
  if (!applied) return;
  const content = html.querySelector?.(".message-content");
  if (!content) return;
  for (const button of content.querySelectorAll?.('[data-action="applyDamage"]') ?? []) {
    button.disabled = true;
    button.title = t("AlreadyApplied");
  }
  if (!content.querySelector?.(".pf2e-ea-auto-heal-note")) {
    const note = document.createElement("p");
    note.className = "pf2e-ea-auto-heal-note";
    note.textContent = `${t("AutomaticallyApplied")}: ${applied.targetName} (${applied.damaging ? "−" : "+"}${applied.amount})`;
    content.append(note);
  }
}
