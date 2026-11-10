export const ID = "pf2e-exploration-activities";
export const ACTIVITIES = Object.freeze([
  { id: "search", icon: "magnifying-glass", secret: true, stat: "perception" },
  { id: "avoid", icon: "eye-slash", secret: true, stat: "stealth" },
  { id: "investigate", icon: "book-open", secret: true, detail: "knowledge" },
  { id: "scout", icon: "binoculars" },
  { id: "defend", icon: "shield" },
  { id: "detect", icon: "wand-magic-sparkles" },
  { id: "repeat", icon: "rotate" },
  { id: "follow", icon: "users", detail: "follow" },
  { id: "other", icon: "ellipsis", detail: "text" },
  { id: "skill", icon: "dice-d20", detail: "skill" },
  { id: "track", icon: "shoe-prints", stat: "survival" },
  { id: "heal", icon: "heart-pulse", detail: "heal" },
  { id: "repair", icon: "screwdriver-wrench", detail: "repair" },
]);
export const ACTIVITY_BY_ID = new Map(ACTIVITIES.map(a => [a.id, a]));
export const KNOWLEDGE_SKILLS = new Set(["arcana", "nature", "occultism", "religion", "society"]);
export const HEAL_RANKS = Object.freeze([
  { key: "trained", rank: 1, dc: 15 },
  { key: "expert", rank: 2, dc: 20 },
  { key: "master", rank: 3, dc: 30 },
  { key: "legendary", rank: 4, dc: 40 },
]);
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
}
export function skillOptions(actor, knowledgeOnly = false) {
  const skills = actor?.skills ?? {};
  return Object.entries(skills)
    .filter(([slug, stat]) => !!stat && (!knowledgeOnly || KNOWLEDGE_SKILLS.has(slug) || stat.lore === true))
    .map(([slug, stat]) => ({ value: slug, label: stat.label || slug }))
    .sort((a, b) => a.label.localeCompare(b.label, game?.i18n?.lang ?? "ru"));
}
export function validateChoice(choice, actor, partyIds, availableItemUuids = null) {
  if (!choice || typeof choice !== "object" || !ACTIVITY_BY_ID.has(choice.activityId)) return false;
  const type = ACTIVITY_BY_ID.get(choice.activityId);
  if (!type.detail) return true;
  if (type.detail === "knowledge" || type.detail === "skill") {
    return skillOptions(actor, type.detail === "knowledge").some(x => x.value === choice.skill);
  }
  if (type.detail === "follow") return choice.targetId !== actor.id && partyIds.includes(choice.targetId);
  if (type.detail === "text") return typeof choice.detail === "string" && choice.detail.trim().length > 0 && choice.detail.length <= 300;
  if (type.detail === "heal") {
    const skill = actor?.skills?.medicine;
    const rank = HEAL_RANKS.find(x => x.key === choice.rank);
    return partyIds.includes(choice.targetId) && !!rank && Number(skill?.rank ?? 0) >= rank.rank;
  }
  if (type.detail === "repair") {
    return typeof choice.itemUuid === "string" && !!choice.itemUuid &&
      (availableItemUuids === null || availableItemUuids.has(choice.itemUuid));
  }
  return false;
}
