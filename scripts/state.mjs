import { ID, esc, ACTIVITY_BY_ID, skillOptions, validateChoice } from "./config.mjs";

export function t(key) { return game.i18n.localize(`${ID}.${key}`); }
export function session() { return game.settings.get(ID, "session") ?? {}; }
export function isOpen() { return session().phase === "open"; }
export function party() { return game.actors?.party ?? null; }
export function members(s = session()) {
  return (s.actorIds ?? []).map(id => game.actors.get(id)).filter(Boolean);
}
export function ownedActor() {
  const actor = game.user?.character;
  return actor && members().some(a => a.id === actor.id) && actor.isOwner ? actor : null;
}
export function remember(actor) { return actor?.getFlag(ID, "remember") === true; }
export function choiceFor(actor, s = session()) {
  if (!actor || !s.id || !s.actorIds?.includes(actor.id)) return null;
  const latest = actor.getFlag(ID, "current");
  if (latest?.sessionId === s.id) return latest.choice ?? null;
  return remember(actor) ? actor.getFlag(ID, "last") ?? null : null;
}
export function userFor(actor) {
  return game.users.find(u => u.character?.id === actor.id) ?? null;
}
export function actorColor(actor) {
  const raw = userFor(actor)?.color;
  const color = typeof raw === "string" ? raw : raw?.css ?? String(raw ?? "");
  return /^#[\da-f]{3,8}$/i.test(color) ? color : "var(--color-text-primary, currentColor)";
}
export function choiceText(choice, actor) {
  if (!choice) return t("NoChoice");
  const activity = ACTIVITY_BY_ID.get(choice.activityId);
  if (!activity) return t("NoChoice");
  let extra = "";
  switch (activity.detail) {
    case "knowledge":
    case "skill": extra = skillOptions(actor).find(x => x.value === choice.skill)?.label ?? choice.skill; break;
    case "follow": extra = `${t("Following")} ${game.actors.get(choice.targetId)?.name ?? "?"}`; break;
    case "text": extra = choice.detail; break;
    case "heal": extra = `${game.actors.get(choice.targetId)?.name ?? "?"}, ${t("DC")} ${({trained:15,expert:20,master:30,legendary:40})[choice.rank] ?? "?"}`; break;
    case "repair": extra = choice.itemName || t("Item"); break;
  }
  return `${t(`Activity.${choice.activityId}`)}${extra ? ` — ${extra}` : ""}`;
}
export function detailText(choice, actor) {
  const whole = choiceText(choice, actor);
  const name = t(`Activity.${choice?.activityId}`);
  return whole.startsWith(`${name} — `) ? whole.slice(name.length + 3) : "";
}
export function itemsFor(actor) {
  // Real PF2e physical item documents, visible to the player (not scene tokens).
  const sources = [actor, ...members().filter(a => a.id !== actor.id), party()].filter(Boolean);
  const seen = new Set();
  const items = [];
  for (const holder of sources) {
    if (!holder.visible) continue;
    for (const item of holder.items ?? []) {
      if (!item.isOfType?.("physical") || !item.uuid || seen.has(item.uuid) || !item.visible) continue;
      seen.add(item.uuid);
      items.push({value:item.uuid, label:`${item.name} (${holder.name})`});
    }
  }
  return items.sort((a,b) => a.label.localeCompare(b.label,game.i18n.lang));
}
export async function setChoice(actor, choice) {
  const s = session();
  if (s.phase !== "open" || !s.actorIds?.includes(actor.id)) throw new Error(t("Unavailable"));
  if (!game.user.isGM && (!ownedActor() || ownedActor().id !== actor.id)) throw new Error(t("NoRights"));
  const items = choice?.activityId === "repair" ? new Set(itemsFor(actor).map(i=>i.value)) : null;
  if (!validateChoice(choice, actor, s.actorIds, items)) throw new Error(t("InvalidChoice"));
  await actor.setFlag(ID, "current", {sessionId:s.id,choice});
}
export async function setRemember(actor, checked) {
  if (!isOpen()) throw new Error(t("Unavailable"));
  if (!game.user.isGM && ownedActor()?.id !== actor.id) throw new Error(t("NoRights"));
  await actor.setFlag(ID, "remember", !!checked);
}
export function chosenCount() { return members().filter(a=>choiceFor(a)).length; }
export function allChosen() { return members().every(a=>choiceFor(a)); }
export function fail(error) {
  console.error(`${ID} |`,error);
  ui.notifications.error(error?.message || t("UnexpectedError"));
}
export { esc };
