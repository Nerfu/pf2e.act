import { ID, ACTIVITIES, ACTIVITY_BY_ID, HEAL_RANKS, esc, skillOptions } from "./config.mjs";
import { t, session, members, ownedActor, choiceFor, remember, actorColor, choiceText, detailText, itemsFor, setChoice, setRemember, chosenCount, fail } from "./state.mjs";
import { launch, finish } from "./controller.mjs";

const ApplicationV2 = foundry.applications.api.ApplicationV2;
function option(value, text, selected = false) {
  return `<option value="${esc(value)}" ${selected ? "selected" : ""}>${esc(text)}</option>`;
}
function icon(name) { return `<i class="fa-solid fa-${esc(name)}" aria-hidden="true"></i>`; }
function box(html, cls = "") { return `<div class="pf2e-ea-${cls}">${html}</div>`; }
function inputFields(actor, activityId, old = {}) {
  const detail = ACTIVITY_BY_ID.get(activityId)?.detail;
  if (detail === "knowledge" || detail === "skill") {
    const skills = skillOptions(actor, detail === "knowledge");
    if (!skills.length) return `<p class="pf2e-ea-warning">${esc(t("NoSkills"))}</p>`;
    return `<label>${esc(detail === "knowledge" ? t("KnowledgeSkill") : t("Skill"))}
        <select name="skill" required>${skills.map(s=>option(s.value,s.label,s.value===old.skill)).join("")}</select></label>`;
  }
  if (detail === "follow") {
    const candidates = members().filter(a=>a.id !== actor.id);
    if (!candidates.length) return `<p class="pf2e-ea-warning">${esc(t("NoOtherMembers"))}</p>`;
    return `<label>${esc(t("Expert"))}<select name="targetId" required>
      ${candidates.map(a=>option(a.id,a.name,a.id===old.targetId)).join("")}</select></label>`;
  }
  if (detail === "text") {
    return `<label>${esc(t("Detail"))}<input name="detail" maxlength="300" required value="${esc(old.detail ?? "")}" /></label>`;
  }
  if (detail === "heal") {
    const targets = members();
    const rank = Number(actor.skills?.medicine?.rank ?? 0);
    const options = HEAL_RANKS.filter(x => x.rank <= rank);
    return `${options.length ? "" : `<p class="pf2e-ea-warning">${esc(t("MedicineTrainingRequired"))}</p>`}
      <label>${esc(t("Patient"))}<select name="targetId" required>
        ${targets.map(a=>option(a.id,a.name,a.id===old.targetId)).join("")}</select></label>
      <label>${esc(t("TreatmentDC"))}<select name="rank" required>
        ${options.map(x=>option(x.key,`${t("DC")} ${x.dc} — ${t(`Rank.${x.key}`)}`,x.key===old.rank)).join("")}</select></label>
      <p class="pf2e-ea-hint">${esc(t("HealingHint"))}</p>`;
  }
  if (detail === "repair") {
    const items = itemsFor(actor);
    if (!items.length) return `<p class="pf2e-ea-warning">${esc(t("NoRepairableItems"))}</p>`;
    return `<label>${esc(t("RepairItem"))}<select name="itemUuid" required>
      ${items.map(i=>option(i.value,i.label,i.value===old.itemUuid)).join("")}</select></label>`;
  }
  return "";
}
function parseForm(actor, activityId, form) {
  const choice = {activityId};
  const detail = ACTIVITY_BY_ID.get(activityId)?.detail;
  const read = key => String(new FormData(form).get(key) ?? "");
  switch (detail) {
    case "knowledge": case "skill": choice.skill = read("skill"); break;
    case "follow": choice.targetId = read("targetId"); break;
    case "text": choice.detail = read("detail").trim().slice(0,300); break;
    case "heal": choice.targetId = read("targetId");choice.rank = read("rank");break;
    case "repair": {
      choice.itemUuid = read("itemUuid");
      choice.itemName = itemsFor(actor).find(i=>i.value===choice.itemUuid)?.label ?? "";
      break;
    }
  }
  return choice;
}

class BaseWindow extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["pf2e-ea-window"],
    position: { width: 570, height: "auto" },
    window: { resizable: true },
  };
  async _renderHTML() {
    const root = document.createElement("div");
    root.className = "pf2e-ea-root";
    root.innerHTML = this.contentHTML();
    root.addEventListener("click",event=>this.onClick(event));
    root.addEventListener("change",event=>this.onChange(event));
    root.addEventListener("input",event=>this.onInput(event));
    root.addEventListener("submit",event=>this.onSubmit(event));
    return root;
  }
  _replaceHTML(html, content) {
    const scroll = content.querySelector(".pf2e-ea-activities, .pf2e-ea-master-list")?.scrollTop ?? 0;
    content.replaceChildren(html);
    const next = content.querySelector(".pf2e-ea-activities, .pf2e-ea-master-list");
    if (next) next.scrollTop = scroll;
  }
  onClick() {}
  onChange() {}
  onInput() {}
  onSubmit() {}
  refresh() { if(this.rendered) this.render().catch(fail); }
}

export class ActivityWindow extends BaseWindow {
  static current = null;
  editing = null;
  get title() { return t("Title"); }
  static open() {
    if(session().phase !== "open") return ui.notifications.info(t("Unavailable"));
    if(this.current?.rendered) { this.current.render().catch(fail);this.current.bringToFront();return this.current; }
    this.current = new this();
    this.current.render({force:true}).catch(fail);
    return this.current;
  }
  contentHTML() {
    if(session().phase !== "open") return `<p>${esc(t("Unavailable"))}</p>`;
    const own = ownedActor();
    const rows = ACTIVITIES.map(activity => {
      const chosen = members().filter(a=>choiceFor(a)?.activityId === activity.id);
      const selected = own && choiceFor(own)?.activityId === activity.id;
      const names = chosen.map(actor=> {
        const ch = choiceFor(actor);
        const detail = detailText(ch,actor);
        return `<div class="pf2e-ea-choice">
          <img src="${esc(actor.img || "icons/svg/mystery-man.svg")}" alt="" />
          <span class="pf2e-ea-character" style="color:${esc(actorColor(actor))}">${esc(actor.name)}</span>
          ${detail?`<span class="pf2e-ea-detail"> — ${esc(detail)}</span>`:""}
        </div>`;
      }).join("");
      return `<section class="pf2e-ea-activity ${selected?"pf2e-ea-selected":""}">
        <button type="button" class="pf2e-ea-activity-button" data-pick="${esc(activity.id)}" ${own?"":"disabled"}>
          ${icon(activity.icon)}<span>${esc(t(`Activity.${activity.id}`))}</span>
          ${selected?icon("circle-check"):icon("plus")}
        </button>
        ${names?`<div class="pf2e-ea-players">${names}</div>`:""}
        ${this.editing?.activityId===activity.id && own ? this.editorHTML(own,activity.id,choiceFor(own)) : ""}
      </section>`;
    }).join("");
    const footer = `<footer class="pf2e-ea-footer">
      <div class="pf2e-ea-footer-left">${own?`<label class="pf2e-ea-remember"><input type="checkbox" data-remember="${esc(own.id)}" ${remember(own)?"checked":""} />${esc(t("Remember"))}</label>`:""}</div>
      <div class="pf2e-ea-footer-center">${game.user.isGM?`<button type="button" data-master="1">${esc(t("ChooseForPlayers"))}</button>`:""}</div>
      <div class="pf2e-ea-footer-right">${game.user.isGM?`<button type="button" class="pf2e-ea-primary" data-finish="1">${esc(t("Finish"))}</button>`:""}</div>
    </footer>`;
    return `<header class="pf2e-ea-heading">
      <strong>${icon("compass")} ${esc(t("Title"))}</strong>
      <span>${esc(t("Chosen"))}: ${chosenCount()} / ${members().length}</span>
      </header><div class="pf2e-ea-activities">${rows}</div>${footer}`;
  }
  editorHTML(actor, activityId, prior) {
    const prev = this.editing?.draft ?? (prior?.activityId===activityId ? prior : {});
    return `<form class="pf2e-ea-editor" data-editor="${esc(activityId)}">
      ${inputFields(actor,activityId,prev)}
      <div class="pf2e-ea-editor-actions">
        <button type="button" data-cancel="1">${esc(t("Cancel"))}</button>
        <button type="submit" class="pf2e-ea-primary">${esc(t("Save"))}</button>
      </div></form>`;
  }
  async onClick(event) {
    const b = event.target.closest("button");if(!b)return;
    if(b.dataset.cancel){this.editing=null;this.refresh();return;}
    if(b.dataset.master){MasterWindow.open();return;}
    if(b.dataset.finish){b.disabled=true;try{await finish();}finally{if(b.isConnected)b.disabled=false;}return;}
    if(b.dataset.pick){
      const actor = ownedActor();if(!actor)return;
      const activityId=b.dataset.pick;
      const activity=ACTIVITY_BY_ID.get(activityId);if(!activity)return;
      if(activity.detail){this.editing={activityId};this.refresh();}
      else {try{await setChoice(actor,{activityId});this.editing=null;this.refresh();}catch(error){fail(error);}}
    }
  }
  async onChange(event) {
    const checkbox=event.target.closest("input[data-remember]");
    if(!checkbox){this.onInput(event);return;}
    const actor=ownedActor();if(!actor)return;
    try{await setRemember(actor,checkbox.checked);}catch(error){fail(error);this.refresh();}
  }
  onInput(event) {
    const form=event.target.closest("form[data-editor]");
    if (form && this.editing) this.editing.draft = Object.fromEntries(new FormData(form));
  }
  async onSubmit(event) {
    const form=event.target.closest("form[data-editor]");if(!form)return;
    event.preventDefault();
    const actor=ownedActor();if(!actor)return;
    const b=form.querySelector('[type="submit"]');if(b)b.disabled=true;
    try{await setChoice(actor,parseForm(actor,form.dataset.editor,form));this.editing=null;this.refresh();}
    catch(error){fail(error);if(b?.isConnected)b.disabled=false;}
  }
}

export class MasterWindow extends BaseWindow {
  static current=null;
  actorId=null;
  activityId="search";
  draft=null;
  get title(){return t("ChooseForPlayers");}
  static open(){
    if(!game.user.isGM||session().phase!=="open")return;
    if(this.current?.rendered){this.current.render().catch(fail);this.current.bringToFront();return this.current;}
    this.current=new this();this.current.render({force:true}).catch(fail);return this.current;
  }
  contentHTML(){
    if(!game.user.isGM||session().phase!=="open")return `<p>${esc(t("Unavailable"))}</p>`;
    const actors=members();
    const person=actors.find(a=>a.id===this.actorId);
    if(!person){
      return `<header class="pf2e-ea-heading"><strong>${esc(t("ChooseForPlayers"))}</strong></header>
        <p class="pf2e-ea-hint">${esc(t("SelectCharacter"))}</p>
        <div class="pf2e-ea-master-list">${actors.map(actor=>`
          <button type="button" data-person="${esc(actor.id)}">
            <img src="${esc(actor.img||"icons/svg/mystery-man.svg")}" alt="" />
            <span><strong style="color:${esc(actorColor(actor))}">${esc(actor.name)}</strong>
            <small>${esc(choiceText(choiceFor(actor),actor))}</small></span>${icon("chevron-right")}
          </button>`).join("")}</div>`;
    }
    const old=choiceFor(person);
    return `<header class="pf2e-ea-heading">
        <button type="button" data-back="1">${icon("arrow-left")}</button>
        <strong style="color:${esc(actorColor(person))}">${esc(person.name)}</strong>
      </header>
      <form class="pf2e-ea-master-editor" data-master-editor="1">
        <label>${esc(t("ActivityHeader"))}<select name="activityId" data-activity-select="1">
          ${ACTIVITIES.map(a=>option(a.id,t(`Activity.${a.id}`),a.id===this.activityId)).join("")}
        </select></label>
        ${inputFields(person,this.activityId,this.draft ?? (old?.activityId===this.activityId?old:{}))}
        <label class="pf2e-ea-remember"><input type="checkbox" name="remember" ${remember(person)?"checked":""}/>${esc(t("Remember"))}</label>
        <div class="pf2e-ea-editor-actions"><button type="submit" class="pf2e-ea-primary">${esc(t("Save"))}</button></div>
      </form>`;
  }
  onClick(event){
    const person=event.target.closest("[data-person]");
    if(person){this.actorId=person.dataset.person;this.activityId=choiceFor(game.actors.get(this.actorId))?.activityId??"search";this.draft=null;this.refresh();return;}
    if(event.target.closest("[data-back]")){this.actorId=null;this.draft=null;this.refresh();}
  }
  onChange(event){
    if(event.target.matches("[data-activity-select]")){this.activityId=event.target.value;this.draft=null;this.refresh();}
    else this.onInput(event);
  }
  onInput(event) {
    const form=event.target.closest("form[data-master-editor]");
    if (form) this.draft = Object.fromEntries(new FormData(form));
  }
  async onSubmit(event){
    const form=event.target.closest("form[data-master-editor]");if(!form)return;
    event.preventDefault();
    const actor=game.actors.get(this.actorId);if(!actor)return;
    const submit=form.querySelector('[type="submit"]');if(submit)submit.disabled=true;
    try{
      const activityId=String(new FormData(form).get("activityId"));
      await setChoice(actor,parseForm(actor,activityId,form));
      await setRemember(actor,!!form.querySelector('[name="remember"]:checked'));
      this.actorId=null;this.draft=null;this.refresh();
    }catch(error){fail(error);if(submit?.isConnected)submit.disabled=false;}
  }
}

export class LauncherWindow extends BaseWindow {
  get title(){return t("SettingsTitle");}
  contentHTML(){return `<div class="pf2e-ea-launch-panel"><p>${esc(t("SettingsHint"))}</p>
    <button type="button" class="pf2e-ea-primary" data-launch="1">${icon("compass")} ${esc(t("Launch"))}</button>
    <p class="pf2e-ea-hint">${esc(t("MacroHint"))}</p></div>`;}
  async onClick(event){if(!event.target.closest('[data-launch]'))return;
    const button=event.target.closest('[data-launch]');button.disabled=true;
    try{if(await launch())await this.close();}catch(error){fail(error);}finally{if(button.isConnected)button.disabled=false;}
  }
}

export function updateWindows(){
  if(session().phase!=="open"){
    for(const window of [ActivityWindow.current,MasterWindow.current])if(window?.rendered)window.close();
  }else{
    ActivityWindow.current?.refresh();MasterWindow.current?.refresh();
  }
}
