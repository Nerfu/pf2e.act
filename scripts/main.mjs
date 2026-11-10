import { ID } from "./config.mjs";
import { session, fail, t } from "./state.mjs";
import { launch, finish, chatLauncher } from "./controller.mjs";
import { renderAppliedTreatment } from "./healing.mjs";
import { LauncherWindow, ActivityWindow, updateWindows } from "./ui.mjs";

Hooks.once("init", () => {
  game.settings.register(ID,"session",{
    name:`${ID}.Title`,scope:"world",config:false,type:Object,
    default:{id:null,phase:"closed",partyId:null,actorIds:[]},
    onChange:()=>updateWindows(),
  });
  game.settings.registerMenu(ID,"launcher",{
    name:`${ID}.SettingsTitle`,label:`${ID}.Launch`,hint:`${ID}.SettingsHint`,
    icon:"fas fa-compass",type:LauncherWindow,restricted:true,
  });
  game.modules.get(ID).api={launch,finish,open:()=>ActivityWindow.open(),getSession:()=>session()};
});
Hooks.on("renderChatMessageHTML",chatLauncher);
Hooks.on("renderChatMessageHTML",renderAppliedTreatment);
Hooks.on("updateActor",actor=>{if(session().actorIds?.includes(actor.id))updateWindows();});
Hooks.on("deleteActor",()=>updateWindows());
Hooks.on("updateUser",()=>updateWindows());
Hooks.on("chatMessage",(log,text) => {
  if(text.trim().toLowerCase()!=="/activities")return;
  if(game.user.isGM)launch().catch(fail);
  else ui.notifications.warn(t("GMOnly"));
  return false;
});
Hooks.once("ready",()=>{
  if(game.system.id!=="pf2e")ui.notifications.warn(`${ID}: PF2e required`);
});
