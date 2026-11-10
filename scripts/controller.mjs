import { ID, ACTIVITY_BY_ID, esc, validateChoice } from "./config.mjs";
import { performTreatment } from "./healing.mjs";
import { t, session, party, members, choiceFor, orderedSelections, remember, userFor, actorColor, choiceText, fail } from "./state.mjs";

let resolving = false;
const apiAction = slug => game.pf2e?.actions?.get?.(slug);
const actorStat = (actor, slug) => actor.getStatistic?.(slug) ?? actor.skills?.[slug] ?? (slug === "perception" ? actor.perception : null);

async function check(actor, statSlug, { secret = false, action = "", options = [], traits = [] } = {}) {
  const statistic = actorStat(actor, statSlug);
  if (!statistic?.check?.roll) throw new Error(`${actor.name}: ${t("MissingStatistic")} (${statSlug})`);
  let outcome = null;
  const roll = await statistic.check.roll({
    action: action || undefined,
    extraRollOptions: options,
    traits,
    skipDialog: true,
    messageMode: secret ? "blind" : "public",
    createMessage: true,
    callback: (_roll, degree) => { outcome = degree ?? null; },
  });
  return { total: Number.isFinite(roll?.total) ? roll.total : null, outcome };
}

function actionRoll(results) {
  const entry = Array.isArray(results) ? results[0] : null;
  return { total: Number.isFinite(entry?.roll?.total) ? entry.roll.total : null, outcome: entry?.outcome ?? null };
}

async function execute(actor, choice) {
  switch (choice.activityId) {
    case "search":
      return check(actor,"perception",{secret:true,action:"seek",options:["action:seek"],traits:["concentrate","secret"]});
    case "avoid":
      return check(actor,"stealth",{secret:true,action:"avoid-notice",options:["action:avoid-notice"],traits:["exploration","secret"]});
    case "investigate":
      return check(actor,choice.skill,{secret:true,action:"recall-knowledge",options:["action:recall-knowledge",`action:recall-knowledge:${choice.skill}`],traits:["concentrate","secret"]});
    case "skill":
      return check(actor,choice.skill,{secret:false});
    case "track": {
      const track = apiAction("track");
      if (!track?.use) throw new Error(t("MissingAction")+" (Track)");
      return actionRoll(await track.use({actors:[actor]}));
    }
    case "heal": {
      const action = apiAction("treat-wounds");
      if (!action?.use) throw new Error(t("MissingAction")+" (Treat Wounds)");
      const target = game.actors.get(choice.targetId);
      if (!target) throw new Error(t("MissingTarget"));
      return performTreatment(actor, target, choice, action);
    }
    default: return;
  }
}

function tokenPortrait(actor) {
  // Use the prototype-token image, not the actor-sheet portrait.
  return actor.prototypeToken?.texture?.src || actor.img || "icons/svg/mystery-man.svg";
}

/** Return only result markup. For public secret checks: no result data whatsoever. */
function resultHTML(choice, result, gm) {
  if (ACTIVITY_BY_ID.get(choice.activityId)?.secret && !gm) return "";
  if (result?.error) return `<span class="pf2e-ea-report-error">${esc(t("FailedCheck"))}</span>`;
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
    return `<span class="pf2e-ea-report-total">${esc(result.total)}</span>`+
      (degree ? `<span class="pf2e-ea-report-degree">${esc(degree)}</span>` : "")+ summary;
  }
  // No-roll activities need no separate 'without a roll' label: the activity is shown.
  if (result?.noRoll) return "";
  return `<span class="pf2e-ea-report-muted">${esc(t("SeeChat"))}</span>`;
}

/** Content-first Foundry chat cards: no tables, so long names remain readable. */
export function resultsSummary(snapshots, outcomes, { gm = false } = {}) {
  const rows = snapshots.map(({ actor, choice }) => {
    const result = resultHTML(choice, outcomes.get(actor.id), gm);
    const activity = esc(t(`Activity.${choice.activityId}`));
    const details = choiceText(choice, actor);
    const prefix = t(`Activity.${choice.activityId}`);
    const detail = details.startsWith(`${prefix} — `) ? details.slice(prefix.length + 3) : "";
    return `<li class="pf2e-ea-report-row">`+
      `<img class="pf2e-ea-report-avatar" src="${esc(tokenPortrait(actor))}" alt="" />`+
      `<div class="pf2e-ea-report-info">`+
      `<span class="pf2e-ea-report-name" style="color:${esc(actorColor(actor))}">${esc(actor.name)}</span>`+
      `<span class="pf2e-ea-report-activity">${activity}${detail ? ` <span class="pf2e-ea-report-detail">— ${esc(detail)}</span>` : ""}</span>`+
      `</div>`+
      (result ? `<div class="pf2e-ea-report-result">${result}</div>` : "")+
      `</li>`;
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
    for (const {actor,choice} of snapshots) {
      try {
        const result = await execute(actor,choice);
        outcomes.set(actor.id, result ?? { noRoll: true });
      } catch(error) {
        console.error(ID,"Action failed",actor.name,choice.activityId,error);
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
      await ChatMessage.create({
        whisper:gmRecipients,
        content:`<p><strong>${esc(t("RollErrors"))}</strong></p><ul>${failures.map(f=>`<li>${esc(f)}</li>`).join("")}</ul>`,
      });
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
