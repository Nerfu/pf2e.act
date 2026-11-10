import { ID, ACTIVITY_BY_ID, HEAL_RANKS, esc, validateChoice } from "./config.mjs";
import { t, session, party, members, choiceFor, remember, userFor, choiceText, fail, itemsFor } from "./state.mjs";

let resolving = false;
const apiAction = slug => game.pf2e?.actions?.get?.(slug);
const actorStat = (actor, slug) => actor.getStatistic?.(slug) ?? actor.skills?.[slug] ?? (slug === "perception" ? actor.perception : null);

async function check(actor, statSlug, { secret = false, action = "", options = [], traits = [] } = {}) {
  const statistic = actorStat(actor, statSlug);
  if (!statistic?.check?.roll) throw new Error(`${actor.name}: ${t("MissingStatistic")} (${statSlug})`);
  await statistic.check.roll({
    action: action || undefined,
    extraRollOptions: options,
    traits,
    skipDialog: true,
    messageMode: secret ? "blind" : "public",
    createMessage: true,
  });
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
      return track.use({actors:[actor]});
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
      return action.use({actors:[actor],target,selection:{skill:"medicine",rank:choice.rank,modifier:0,feats}});
    }
    case "repair": {
      const item = await fromUuid(choice.itemUuid);
      if (!item?.isOfType?.("physical")) throw new Error(t("MissingItem"));
      // The PF2e legacy action intentionally renders a native Repair result card.
      if (typeof game.pf2e?.actions?.repair !== "function") throw new Error(t("MissingAction")+" (Repair)");
      return game.pf2e.actions.repair({actors:[actor],item});
    }
    default: return;
  }
}

function resultsSummary(s, snapshots) {
  const rows = snapshots.map(({actor,choice}) => `
    <tr><td>${esc(actor.name)}</td><td>${esc(choiceText(choice,actor))}</td></tr>`).join("");
  return `<div class="pf2e-ea-chat-summary"><h3>${esc(t("ChatResults"))}</h3>
    <table><thead><tr><th>${esc(t("Character"))}</th><th>${esc(t("ActivityHeader"))}</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

export async function launch() {
  if (!game.user.isGM) return ui.notifications.warn(t("GMOnly"));
  const p = party();
  if (!p) return ui.notifications.warn(t("NoParty"));
  const participants = p.members.filter(a => !!a?.id);
  if (!participants.length) return ui.notifications.warn(t("EmptyParty"));
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
  const snapshots = members(s).map(actor=>({actor,choice:choiceFor(actor,s)}));
  const absent = snapshots.filter(x=>!x.choice);
  if (absent.length) return ui.notifications.warn(`${t("MissingSelections")}: ${absent.map(x=>x.actor.name).join(", ")}`);
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
    await ChatMessage.create({speaker:{alias:t("Title")},content:resultsSummary(s,snapshots)});
    const failures=[];
    for (const {actor,choice} of snapshots) {
      try { await execute(actor,choice); }
      catch(error) {
        console.error(ID,"Action failed",actor.name,choice.activityId,error);
        failures.push(`${actor.name}: ${error?.message ?? String(error)}`);
      }
    }
    if(failures.length) {
      await ChatMessage.create({
        whisper:ChatMessage.getWhisperRecipients("GM").map(u=>u.id),
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
