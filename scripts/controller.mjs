import { ID, ACTIVITY_BY_ID, HEAL_RANKS, esc, validateChoice } from "./config.mjs";
import { t, session, party, members, choiceFor, remember, userFor, actorColor, choiceText, fail, itemsFor } from "./state.mjs";

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
      const hasFeat = slug => actor.items.some(item => item.type === "feat" && item.slug === slug);
      const feats = {
        "risky-surgery":hasFeat("risky-surgery") && actor.getRollOptions(["medicine"]).includes("risky-surgery"),
        "mortal-healing":hasFeat("mortal-healing"),
      };
      const target = game.actors.get(choice.targetId);
      if (!target) throw new Error(t("MissingTarget"));
      // Use PF2e's own action: it creates both the check and a native healing/damage card.
      // The card's standard application button targets tokens selected at application time.
      return actionRoll(await action.use({actors:[actor],target,selection:{skill:"medicine",rank:choice.rank,modifier:0,feats}}));
    }
    case "repair": {
      const item = await fromUuid(choice.itemUuid);
      if (!item?.isOfType?.("physical")) throw new Error(t("MissingItem"));
      // The PF2e legacy action intentionally renders a native Repair result card.
      if (typeof game.pf2e?.actions?.repair !== "function") throw new Error(t("MissingAction")+" (Repair)");
      // Repair's legacy macro returns before its asynchronous native chat card is posted.
      // Never invent a result: link the user to that native PF2e card instead.
      await game.pf2e.actions.repair({actors:[actor],item});
      return { external: true };
    }
    default: return;
  }
}

function tokenPortrait(actor) {
  // Prototype token artwork, not the portrait on the actor sheet.
  return actor.prototypeToken?.texture?.src || actor.img || "icons/svg/mystery-man.svg";
}

function resultHTML(choice, result, gm) {
  if (ACTIVITY_BY_ID.get(choice.activityId)?.secret && !gm) return esc(t("SecretResult"));
  if (result?.error) return esc(t("FailedCheck"));
  if (result?.external) return esc(t("SeeChat"));
  if (Number.isFinite(result?.total)) {
    const outcome = ["criticalSuccess", "success", "failure", "criticalFailure"].includes(result?.outcome)
      ? game.i18n.localize(`PF2E.Check.Result.Degree.Check.${result.outcome}`) : "";
    const localized = outcome?.startsWith("PF2E.") ? "" : outcome;
    return `<strong>${esc(result.total)}</strong>${localized ? ` <small>(${esc(localized)})</small>` : ""}`;
  }
  return result?.noRoll ? esc(t("NoRoll")) : esc(t("SeeChat"));
}

function resultsSummary(snapshots, outcomes, { gm = false } = {}) {
  const rows = snapshots.map(({ actor, choice }) => {
    const character = `<span class="pf2e-ea-report-actor"><img src="${esc(tokenPortrait(actor))}" alt="" />`+
      `<strong style="color:${esc(actorColor(actor))}">${esc(actor.name)}</strong></span>`;
    const activity = esc(choiceText(choice, actor));
    return `<tr><td>${character}</td><td>${activity}</td>`+
      `<td class="pf2e-ea-result">${resultHTML(choice, outcomes.get(actor.id), gm)}</td></tr>`;
  }).join("");
  const title = gm ? t("GMResults") : t("ChatResults");
  return `<div class="pf2e-ea-chat-summary"><h3>${esc(title)}</h3>`+
    `<table><thead><tr><th>${esc(t("Character"))}</th><th>${esc(t("ActivityHeader"))}</th><th>${esc(t("Result"))}</th></tr></thead>`+
    `<tbody>${rows || `<tr><td colspan="3">${esc(t("NoChoice"))}</td></tr>`}</tbody></table></div>`;
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
  const snapshots = members(s).map(actor=>({actor,choice:choiceFor(actor,s)})).filter(x=>!!x.choice);
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
