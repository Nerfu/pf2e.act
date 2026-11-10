import { ID, ACTIVITY_BY_ID, esc, validateChoice } from "./config.mjs";
import { prepareTreatment } from "./healing.mjs";
import { rollCheck, playRollWave } from "./rolls.mjs";
import { t, session, party, members, choiceFor, orderedSelections, remember, userFor, actorColor, choiceText, fail } from "./state.mjs";

let resolving = false;
async function execute(actor, choice, queue) {
  switch (choice.activityId) {
    case "search":
      return rollCheck(actor,"perception",{secret:true,action:"seek",options:["action:seek"],traits:["concentrate","secret"],queue});
    case "avoid":
      return rollCheck(actor,"stealth",{secret:true,action:"avoid-notice",options:["action:avoid-notice"],traits:["exploration","secret"],queue});
    case "investigate":
      return rollCheck(actor,choice.skill,{secret:true,action:"recall-knowledge",options:["action:recall-knowledge",`action:recall-knowledge:${choice.skill}`],traits:["concentrate","secret"],queue});
    case "skill":
      return rollCheck(actor,choice.skill,{secret:false,queue});
    case "track": {
      return rollCheck(actor,"survival",{secret:false,action:"track",options:["action:track"],traits:["concentrate","exploration","move"],queue});
    }
    case "heal": {
      const target = game.actors.get(choice.targetId);
      if (!target) throw new Error(t("MissingTarget"));
      return prepareTreatment(actor, target, choice, { queue });
    }
    default: return;
  }
}

function tokenPortrait(actor) {
  // Use the prototype-token image, not the actor-sheet portrait.
  return actor.prototypeToken?.texture?.src || actor.img || "icons/svg/mystery-man.svg";
}

/** Display a formula only to viewers allowed to see the check. */
function breakdownHTML(result) {
  const dice = (result.dice ?? []).flatMap((term, index) => term.results.map(die => {
    const natural = index === 0 && term.faces === 20 && die.kept && die.value === result.natural
      ? `pf2e-ea-natural-${result.natural}` : "";
    return `<span class="pf2e-ea-die ${die.kept ? "" : "pf2e-ea-die-dropped"} ${natural}">`+
      `d${esc(term.faces)}: ${esc(die.value)}</span>`;
  })).join("");
  const modifiers = (result.modifiers ?? []).map(mod =>
    `<span class="pf2e-ea-modifier">${esc(mod.label)} ${mod.value >= 0 ? "+" : ""}${esc(mod.value)}</span>`
  ).join("");
  return `<div class="pf2e-ea-roll-breakdown">`+
    `<div class="pf2e-ea-roll-formula"><strong>${esc(t("Formula"))}:</strong> ${esc(result.formula ?? "")}</div>`+
    (dice ? `<div class="pf2e-ea-roll-dice">${dice}</div>` : "")+
    (modifiers ? `<div class="pf2e-ea-roll-modifiers">${modifiers}</div>` : "")+
    `</div>`;
}

function resultHTML(choice, result, gm) {
  if (ACTIVITY_BY_ID.get(choice.activityId)?.secret && !gm) return { value: "", details: "" };
  if (result?.error) return { value: `<span class="pf2e-ea-report-error">${esc(t("FailedCheck"))}</span>`, details: "" };
  if (Number.isFinite(result?.total)) {
    const key = `PF2E.Check.Result.Degree.Check.${result.outcome}`;
    const localized = ["criticalSuccess", "success", "failure", "criticalFailure"].includes(result?.outcome)
      ? game.i18n.localize(key) : "";
    const degree = localized && localized !== key ? localized : "";
    const applications = [result?.risky, result?.applied].filter(Boolean);
    const summary = applications.map(applied =>
      `<span class="pf2e-ea-report-applied ${applied.damaging ? "pf2e-ea-report-applied-damage" : ""}">`+
      `${esc(applied.damaging ? "−" : "+")}${esc(applied.amount)} ${esc(t("HPUnit"))}</span>`
    ).join("");
    const details = breakdownHTML(result) + applications.map(applied =>
      `<div class="pf2e-ea-applied-breakdown"><strong>${esc(t(applied.damaging ? "Damage" : "Healing"))}</strong>`+
      breakdownHTML(applied) + `</div>`
    ).join("");
    const natural = [1, 20].includes(result.natural) ? ` pf2e-ea-natural-${result.natural}` : "";
    return { value: `<span class="pf2e-ea-report-total${natural}">${esc(result.total)}</span>`+
      (degree ? `<span class="pf2e-ea-report-degree">${esc(degree)}</span>` : "") + summary,
      details };
  }
  if (result?.noRoll) return { value: "", details: "" };
  return { value: `<span class="pf2e-ea-report-muted">${esc(t("FailedCheck"))}</span>`, details: "" };
}

/** One accessible, collapsible result per character, no independently posted roll cards. */
export function resultsSummary(snapshots, outcomes, { gm = false } = {}) {
  const rows = snapshots.map(({ actor, choice }) => {
    const { value, details } = resultHTML(choice, outcomes.get(actor.id), gm);
    const activity = esc(t(`Activity.${choice.activityId}`));
    const desc = choiceText(choice, actor);
    const prefix = t(`Activity.${choice.activityId}`);
    const detail = desc.startsWith(`${prefix} — `) ? desc.slice(prefix.length + 3) : "";
    const inner = `<img class="pf2e-ea-report-avatar" src="${esc(tokenPortrait(actor))}" alt="" />`+
      `<div class="pf2e-ea-report-info">`+
      `<span class="pf2e-ea-report-name" style="color:${esc(actorColor(actor))}">${esc(actor.name)}</span>`+
      `<span class="pf2e-ea-report-activity">${activity}${detail ? ` <span class="pf2e-ea-report-detail">— ${esc(detail)}</span>` : ""}</span>`+
      `</div>`+
      (value ? `<div class="pf2e-ea-report-result">${value}</div>` : "");
    if (!details) return `<li class="pf2e-ea-report-row"><div class="pf2e-ea-report-line">${inner}</div></li>`;
    return `<li class="pf2e-ea-report-row"><details class="pf2e-ea-report-expand">`+
      `<summary class="pf2e-ea-report-line" title="${esc(t("ExpandResult"))}">${inner}</summary>`+
      `${details}</details></li>`;
  }).join("");
  return `<div class="pf2e-ea-chat-summary">`+
    `<h3 class="pf2e-ea-report-title">${esc(t(gm ? "GMResults" : "ChatResults"))}</h3>`+
    (rows ? `<ul class="pf2e-ea-report-list">${rows}</ul>` : `<p class="pf2e-ea-report-empty">${esc(t("NoChoice"))}</p>`)+
    `</div>`;
}

export async function launch() {
  if (!game.user.isGM) return ui.notifications.warn(t("GMOnly"));
  const p = party();
  if (!p) return ui.notifications.warn(t("NoParty"));
  const participants = p.members.filter(a => !!a?.id);
  const s = session();
  if (s.phase === "resolving") return ui.notifications.warn(t("Resolving"));
  if (s.phase !== "open") {
    // Duplicate assignment produces ambiguous control and player color.
    const duplicate = participants.find(a => game.users.filter(u => u.character?.id === a.id).length > 1);
    if (duplicate) return ui.notifications.warn(`${t("DuplicateAssignment")}: ${duplicate.name}`);
    await game.settings.set(ID,"session",{
      id:foundry.utils.randomID(),partyId:p.id,actorIds:participants.map(a=>a.id),phase:"open",
    });
  }
  // Intentionally always create a NEW message, even when an open session already exists.
  await ChatMessage.create({
    speaker:{alias:t("Title")},
    content:`<p><strong>${esc(t("ChatInvitation"))}</strong></p>`,
    flags:{[ID]:{launcher:true}},
  });
  return true;
}

export async function finish() {
  if (!game.user.isGM || resolving) return;
  const s = session();
  if (s.phase !== "open") return ui.notifications.warn(t("Unavailable"));
  // Characters without an activity are allowed: only chosen activities roll.
  // The GM may finish even when nobody has selected anything.
  // Use exactly the same chronological ordering as the names under each button.
  const snapshots = orderedSelections(s);
  const invalid = snapshots.filter(({actor,choice})=>!validateChoice(choice,actor,s.actorIds));
  if (invalid.length) return ui.notifications.warn(`${t("InvalidSelections")}: ${invalid.map(x=>x.actor.name).join(", ")}`);
  resolving = true;
  try {
    // This is the locking point; clients close their windows via setting onChange.
    await game.settings.set(ID,"session",{...s,phase:"resolving"});
    for (const {actor,choice} of snapshots) {
      if (remember(actor)) {
        try { await actor.setFlag(ID,"last",choice); }
        catch(e) { console.warn(ID,"Could not save remembered choice",actor.name,e); }
      }
    }
    const failures=[];
    const outcomes = new Map();
    const animations = [];
    const treatments = [];
    // Preserve selection order for all PF2e checks. Do not change any HP yet.
    for (const {actor,choice} of snapshots) {
      try {
        const result = await execute(actor,choice,animations);
        if (choice.activityId === "heal") {
          treatments.push({ actor, choice, prepared: result });
          outcomes.set(actor.id, result.result);
        } else {
          outcomes.set(actor.id, result ?? { noRoll: true });
        }
      } catch(error) {
        console.error(ID,"Action failed",actor.name,choice.activityId,error);
        outcomes.set(actor.id, { error: true });
        failures.push(`${actor.name}: ${error?.message ?? String(error)}`);
      }
    }
    // Start all actors' Dice So Nice rolls together, retaining each player's
    // appearance and per-roll visibility. Wait for every animation to finish.
    await playRollWave(animations);
    // Now apply the already-evaluated treatment dice in original selection
    // order. Within each treatment, Risky Surgery damage precedes healing.
    for (const {actor,choice,prepared} of treatments) {
      try {
        outcomes.set(actor.id, await prepared.apply());
      } catch(error) {
        console.error(ID,"Treatment application failed",actor.name,choice.activityId,error);
        outcomes.set(actor.id, { error: true });
        failures.push(`${actor.name}: ${error?.message ?? String(error)}`);
      }
    }
    // Public report contains activity names and public outcomes only. Blind roll
    // totals are never included, even in hidden attributes or data-* fields.
    await ChatMessage.create({speaker:{alias:t("Title")},content:resultsSummary(snapshots,outcomes)});
    const gmRecipients = [...new Set([
      game.user.id,
      ...ChatMessage.getWhisperRecipients("GM").map(u => u.id),
    ])];
    if (snapshots.some(({choice}) => ACTIVITY_BY_ID.get(choice.activityId)?.secret)) {
      await ChatMessage.create({
        speaker:{alias:t("Title")},
        whisper:gmRecipients,
        content:resultsSummary(snapshots,outcomes,{gm:true}),
      });
    }
    if(failures.length) {
      console.warn(`${ID} | ${t("RollErrors")}`, failures);
      ui.notifications.warn(t("SomeRollsFailed"));
    }
  } catch(error) { fail(error); }
  finally {
    try { await game.settings.set(ID,"session",{...s,phase:"closed"}); }
    catch(error) { fail(error); }
    resolving = false;
  }
}

export function chatLauncher(message, html) {
  if (!message.getFlag(ID,"launcher")) return;
  const content = html.querySelector(".message-content");
  if (!content || content.querySelector(".pf2e-ea-chat-open")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pf2e-ea-chat-open";
  button.innerHTML = `<i class="fa-solid fa-compass" aria-hidden="true"></i> ${esc(t("ChatButton"))}`;
  button.addEventListener("click",event => {
    event.preventDefault();event.stopPropagation();
    if(session().phase !== "open") return ui.notifications.info(t("Unavailable"));
    game.modules.get(ID)?.api?.open();
  });
  content.append(button);
}
