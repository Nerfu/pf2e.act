import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const base = fileURLToPath(new URL('../../scripts/', import.meta.url));
const chats = [];
const animations = [];
const setup = {
  phase:'open', id:'sess1', actorIds:['track1','skill1','heal1'], partyId:'party1'
};
const title = 'pf2e-exploration-activities';
const t = x => x.replace(`${title}.`, '');
const gm = { id:'gm', isGM:true };
const player = { id:'player', isGM:false, character: {id:'track1'}, color:'#ff0000' };
const actors = new Map();
globalThis.game = {
  user:gm,
  users:[gm,player],
  actors:{get:id=>actors.get(id),party:{members:[]}},
  modules:{get:id=>id==='dice-so-nice'?{active:true}:null},
  dice3d:{showForRoll:async (...args)=>{animations.push(args);return true}},
  settings:{get:(_id,key)=>key==='session'?setup:null, async set(_id,key,v){assert.equal(key,'session');Object.assign(setup,v)}},
  i18n:{localize:t,lang:'ru'},
};
globalThis.ChatMessage = {
  async create(data){chats.push(data);return data},
  getWhisperRecipients:()=>[gm],
};
globalThis.ui = {notifications:{warn:()=>{},info:()=>{},error:()=>{}}};
globalThis.foundry = {utils:{randomID:()=> 'random1'}};
class DamageRoll {
  constructor(formula){this.formula=formula;this.dice=[{faces:8,results:[{result:5,active:true}]}];this.total=5}
  async roll(){return this}
}
globalThis.CONFIG = {Dice:{rolls:[DamageRoll]}};

const {rollCheck,describeRoll} = await import(new URL('../../scripts/rolls.mjs',import.meta.url));
const {performTreatment} = await import(new URL('../../scripts/healing.mjs',import.meta.url));
const {resultsSummary,finish} = await import(new URL('../../scripts/controller.mjs',import.meta.url));

function makeActor(id,rollResult,choice){
  const flags = {current:{sessionId:'sess1',chosenAt:id==='track1'?1:id==='skill1'?2:3,choice},remember:false};
  let checkOpt;
  const actor = {
    id,name:id,prototypeToken:{texture:{src:'img.png'}}, img:'img.png',
    skills: {survival:{rank:2},medicine:{rank:3},athletics:{rank:2}},
    items:[],rules:[],synthetics:{degreeOfSuccessAdjustments:{}},system:{details:{level:{value:6}}},
    getRollOptions:()=>[],
    getFlag:(_id,key)=>flags[key],
    async setFlag(_id,key,v){flags[key]=v},
    getStatistic:slug=>({check:{async roll(options){checkOpt=options;const roll={total:rollResult.total,formula:rollResult.formula??'1d20+7',dice:[{faces:20,results:[{result:rollResult.total-7,active:true}]}]}; options.callback(roll,rollResult.outcome??null,{flags:{pf2e:{modifiers:[{label:'Mod',modifier:7,enabled:true}]}}}); return roll}}}),
    inspect:()=>checkOpt,
    getTokenDocument:async()=>({id:'token1'}),
    applied:[],async applyDamage(x){this.applied.push(x)},
    hasCondition:()=>false,
  };
  return actor;
}

test('private track has no result details in public HTML and can expand only for GM',()=>{
  const actor={id:'abc',name:'Test<script>',prototypeToken:{texture:{src:'x.png'}}};
  const data=[{actor,choice:{activityId:'track'}}];
  const result=new Map([['abc',{total:25,formula:'1d20 + 7',dice:[{faces:20,results:[{value:18,kept:true}]}],modifiers:[{label:'Survival',value:7}]}]]);
  const publicCard=resultsSummary(data,result);
  assert.ok(publicCard.includes('Test&lt;script&gt;'));
  assert.ok(!publicCard.includes('25'));
  assert.ok(!publicCard.includes('1d20'));
  assert.ok(!publicCard.includes('<details'));
  const secretCard=resultsSummary(data,result,{gm:true});
  assert.ok(secretCard.includes('25'));
  assert.ok(secretCard.includes('1d20 + 7'));
  assert.ok(secretCard.includes('d20: 18'));
  assert.ok(secretCard.includes('<details'));
});

test('check runs silently, without dialogs, with GM-only DSN animation',async()=>{
  const actor=makeActor('track1',{total:25},{activityId:'track'});
  actors.set('track1',actor);
  let r=await rollCheck(actor,'survival',{secret:true,options:['action:track'],traits:['secret']});
  assert.equal(r.total,25);
  assert.equal(actor.inspect().createMessage,false);
  assert.equal(actor.inspect().skipDialog,true);
  assert.equal(actor.inspect().messageMode,'blind');
  assert.deepEqual(animations.at(-1)[3],['gm']);
  assert.equal(chats.length,0);
});

test('quiet native healing applies PF2e rolls, with no chat messages',async()=>{
  const actor=makeActor('heal1',{total:22,outcome:'success'},{activityId:'heal',rank:'trained',targetId:'track1'});
  const target=makeActor('track1',{total:1},{activityId:'track'});
  actors.set('heal1',actor);actors.set('track1',target);
  let result=await performTreatment(actor,target,{rank:'trained'});
  assert.equal(actor.inspect().createMessage,false);
  assert.equal(actor.inspect().skipDialog,true);
  assert.equal(result.outcome,'success');
  assert.equal(result.applied.amount,5);
  assert.equal(target.applied.length,1);
  assert.equal(target.applied[0].damage,-5);
  assert.equal(chats.length,0);
});

test('risky surgery and a critical failure apply native damage twice and no messages',async()=>{
  const actor=makeActor('heal1',{total:1,outcome:'criticalFailure'},{activityId:'heal',rank:'trained',targetId:'track1'});
  actor.items=[{type:'feat',slug:'risky-surgery'}];
  actor.rules=[{key:'RollOption',option:'risky-surgery',value:false}];
  actor.getRollOptions=()=>['risky-surgery'];
  const target=makeActor('track1',{total:1},{activityId:'track'});
  actors.set('heal1',actor);actors.set('track1',target);
  const result=await performTreatment(actor,target,{rank:'trained'});
  assert.equal(result.risky.amount,5);
  assert.equal(result.applied.amount,5);
  assert.equal(target.applied.length,2);
  assert.equal(target.applied[0].damage.constructor.name,'DamageRoll');
  assert.equal(target.applied[1].damage.constructor.name,'DamageRoll');
  assert.equal(actor.rules[0].value,false);
  assert.equal(chats.length,0);
});

test('finish posts only public+GM summaries; hidden checks never reach players',async()=>{
  chats.length=0;
  setup.id='sess1';setup.phase='open';
  const track=makeActor('track1',{total:25},{activityId:'track'});
  const skill=makeActor('skill1',{total:19},{activityId:'skill',skill:'athletics'});
  const patient=makeActor('heal1',{total:22,outcome:'success'},{activityId:'heal',rank:'trained',targetId:'track1'});
  for(const a of [track,skill,patient])actors.set(a.id,a);
  game.actors.party.members=[track,skill,patient];
  await finish();
  assert.equal(chats.length,2);
  assert.ok(!chats[0].content.includes('25'));
  assert.ok(chats[0].content.includes('19'));
  assert.ok(!chats[0].whisper);
  assert.deepEqual(chats[1].whisper,['gm']);
  assert.ok(chats[1].content.includes('25'));
  assert.equal(setup.phase,'closed');
});
