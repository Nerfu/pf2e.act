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
/**
 * One ordering key per character's current activity. Changing only an activity's
 * detail must not change its place in the queue. A new activity enters last.
 * Remembered choices without an explicit selection are placed first, in Party
 * order, so a returning group gets a predictable starting order.
 */
export function selectionFor(actor, s = session()) {
  if (!actor || !s.id || !s.actorIds?.includes(actor.id)) return null;
  const latest = actor.getFlag(ID, "current");
  const fromCurrent = latest?.sessionId === s.id;
  const choice = fromCurrent
    ? latest.choice
    : (remember(actor) ? actor.getFlag(ID, "last") : null);
  if (!ACTIVITY_BY_ID.has(choice?.activityId)) return null;
  const chosenAt = fromCurrent && Number.isFinite(latest.chosenAt) ? latest.chosenAt : 0;
  return { choice, chosenAt };
}
export function choiceFor(actor, s = session()) {
  return selectionFor(actor, s)?.choice ?? null;
}
/** Shared ordering for the on-screen names, chat reports and execution. */
export function orderedSelections(s = session()) {
  return members(s).map((actor, partyIndex) => {
    const selection = selectionFor(actor, s);
    return selection ? { actor, choice: selection.choice, chosenAt: selection.chosenAt, partyIndex } : null;
  }).filter(Boolean).sort((a, b) =>
    a.chosenAt - b.chosenAt || a.partyIndex - b.partyIndex
  );
}
let lastSelectionTime = 0;
function nextSelectionTime() {
  // Foundry's server-synchronized clock keeps connected clients in approximately
  // the same time frame; local monotonicity resolves rapid repeated GM choices.
  const serverTime = Number(game.time?.serverTime);
  const now = Number.isFinite(serverTime) && serverTime > 1e12 ? serverTime : Date.now();
  lastSelectionTime = Math.max(Math.trunc(now), lastSelectionTime + 1);
  return lastSelectionTime;
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
  }
  return `${t(`Activity.${choice.activityId}`)}${extra ? ` — ${extra}` : ""}`;
}
export function detailText(choice, actor) {
  const whole = choiceText(choice, actor);
  const name = t(`Activity.${choice?.activityId}`);
  return whole.startsWith(`${name} — `) ? whole.slice(name.length + 3) : "";
}
export async function setChoice(actor, choice) {
  const s = session();
  if (s.phase !== "open" || !s.actorIds?.includes(actor.id)) throw new Error(t("Unavailable"));
  if (!game.user.isGM && (!ownedActor() || ownedActor().id !== actor.id)) throw new Error(t("NoRights"));
  if (!validateChoice(choice, actor, s.actorIds)) throw new Error(t("InvalidChoice"));
  const previous = selectionFor(actor, s);
  // Reconfirming the same activity (or editing its skill/target) keeps its place.
  // Switching activities always puts the character at the end of the new list.
  const chosenAt = previous?.choice.activityId === choice.activityId
    ? previous.chosenAt : nextSelectionTime();
  await actor.setFlag(ID, "current", {sessionId:s.id,choice,chosenAt});
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
