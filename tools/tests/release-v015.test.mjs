import test from 'node:test';
import assert from 'node:assert/strict';

const ID = 'pf2e-exploration-activities';
const animationCalls = [];
const messages = [];
const changes = [];
const actors = new Map();
const gm = { id: 'gm', isGM: true };
const userA = { id: 'user-a', isGM: false, character: { id: 'track' } };
const userB = { id: 'user-b', isGM: false, character: { id: 'healer1' } };
const userC = { id: 'user-c', isGM: false, character: { id: 'healer2' } };
const session = { phase: 'open', id: 's-v015', actorIds: [], partyId: 'p1' };
let diceOn = true;
let deferredAnimations = false;
let pending = [];
const fakeRoller = {
  async showForRoll(...args) {
    animationCalls.push(args);
    if (deferredAnimations) return new Promise(resolve => { pending.push(resolve); });
    return true;
  },
};
globalThis.game = {
  user: gm, users: [gm,userA,userB,userC],
  actors: { get: id => actors.get(id), party: { members: [] } },
  modules: { get: name => name === 'dice-so-nice' ? { active: diceOn } : null },
  dice3d: fakeRoller,
  settings: { get: () => session, async set(_id, key, next) {
    assert.equal(key, 'session'); Object.assign(session, next);
  }},
  i18n: {localize: key => key.replace(`${ID}.`, ''), lang: 'ru'},
};
globalThis.ChatMessage = {
  async create(data) { messages.push(data); return data; },
  getWhisperRecipients: () => [gm],
  getSpeaker: ({ actor }) => ({ alias: actor.name, actor: actor.id }),
};
globalThis.foundry = { utils: { randomID: () => 's-new' } };
globalThis.ui = { notifications: { warn(){}, info(){}, error(){} } };
class DamageRoll {
  constructor(formula) { this.formula = formula; this.total = 5; this.dice = [
    {faces:8, results:[{result:5,active:true}]},
  ]; }
  async roll() { return this; }
}
globalThis.CONFIG = { Dice: {rolls:[DamageRoll]} };

const { describeRoll, rollCheck, playRollWave } = await import('../../scripts/rolls.mjs');
const { resultsSummary, finish } = await import('../../scripts/controller.mjs');

function character(id, chosenAt, choice, { total = 19, natural = 12, outcome = null, risky = false } = {}) {
  const flags = {current: {sessionId:'s-v015',chosenAt,choice}, remember: false};
  const actor = {
    id, name:id, prototypeToken:{ texture:{ src: 'portrait.png' } },
    img:'portrait.png', rules:risky?[{key:'RollOption',option:'risky-surgery',value:false}]:[],
    items:risky?[{slug:'risky-surgery',type:'feat'}]:[],
    synthetics:{degreeOfSuccessAdjustments:{}}, system:{details:{level:{value:5}}},
    skills:{ medicine:{rank:2,check:{}}, survival:{rank:2,check:{}}, athletics:{rank:2,check:{}}, perception:{rank:2,check:{}} },
    getFlag:(_,key)=>flags[key], async setFlag(_,key,value){ flags[key]=value; },
    getRollOptions:()=>risky?['risky-surgery']:[],
    getStatistic:slug => ({ check:{async roll(options) {
      assert.equal(options.createMessage,false);
      assert.equal(options.skipDialog,true);
      assert.equal(changes.length,0,'no HP changes before any group checks finish');
      const roll={ total, formula:`1d20 + ${total-natural}`,
        dice:[{ faces:20, results:[{result:natural,active:true}] }] };
      options.callback(roll,outcome,{ flags:{pf2e:{modifiers:[{label:'bonus',modifier:total-natural,enabled:true}]}} });
      return roll;
    }} }),
    getTokenDocument: async()=>({id:`${id}-token`}),
    async applyDamage(data){ changes.push({ target:id, damage:typeof data.damage==='number'?data.damage:data.damage.total,
      type:typeof data.damage==='number'?'healing':'damage', outcome:data.outcome }); },
    hasCondition:()=>false,
  };
  return actor;
}

function reset(characters) {
  animationCalls.length=0; messages.length=0; changes.length=0; pending=[];
  session.phase='open'; session.id='s-v015';session.actorIds=characters.map(a=>a.id);
  actors.clear(); for (const actor of characters) actors.set(actor.id,actor);
  game.actors.party.members=characters;
}

async function until(check, message) {
  for (let i=0; i<120; i++) {
    if (check()) return;
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  assert.fail(message);
}

test('PF2e-style natural 1/20 are highlighted in the REPORT, not DSN rolls',()=>{
  const r20 = describeRoll({total:25,formula:'1d20+5',dice:[{faces:20,results:[{result:20,active:true}]}]});
  const r1 = describeRoll({total:8,formula:'1d20+7',dice:[{faces:20,results:[{result:1,active:true}]}]});
  const drop20 = describeRoll({total:13,formula:'2d20kl+5',dice:[{faces:20,results:[{result:20,active:false},{result:8,active:true}]}]});
  const d8 = describeRoll({total:8,formula:'1d8',dice:[{faces:8,results:[{result:8,active:true}]}]});
  const keep20 = describeRoll({total:28,formula:'2d20kh+8',dice:[{faces:20,results:[{result:1,active:false},{result:20,active:true}]}]});
  assert.equal(r20.natural,20);assert.equal(r1.natural,1);
  assert.equal(drop20.natural,null);assert.equal(d8.natural,null);
  assert.equal(keep20.natural,20);
  const data=[{actor:{id:'a',name:'A',prototypeToken:{texture:{src:'x'}}},choice:{activityId:'track'}}];
  const html20=resultsSummary(data,new Map([['a',r20]]));
  const html1=resultsSummary(data,new Map([['a',r1]]));
  assert.match(html20,/pf2e-ea-report-total pf2e-ea-natural-20/);
  assert.match(html20,/pf2e-ea-die[^"']*pf2e-ea-natural-20/);
  assert.match(html1,/pf2e-ea-report-total pf2e-ea-natural-1/);
  const secret=resultsSummary([{actor:data[0].actor,choice:{activityId:'search'}}],new Map([['a',r20]]));
  assert.doesNotMatch(secret,/pf2e-ea-natural-20|1d20|25/);
});

test('all dice launch in ONE concurrent wave, using assigned player styles, and no HP changes before the last animation',async()=>{
  const party=[
    character('track',1,{activityId:'track'},{total:8,natural:1}),
    character('healer1',2,{activityId:'heal',rank:'trained',targetId:'track'},{total:4,natural:1,outcome:'criticalFailure',risky:true}),
    character('search',3,{activityId:'search'},{total:29,natural:20}),
    character('healer2',4,{activityId:'heal',rank:'trained',targetId:'track'},{total:24,natural:17,outcome:'success'}),
  ];
  reset(party);
  deferredAnimations=true;
  let done = false;
  const action = finish().finally(()=>{done=true;});
  await until(()=>animationCalls.length === 7, 'All 7 PF2e rolls must start before any animation ends');
  assert.equal(pending.length,7);
  assert.equal(changes.length,0);
  assert.equal(messages.length,0);
  assert.equal(done,false);
  assert.deepEqual(animationCalls.map(args=>args[1].id),[
    'user-a','user-b','user-b','user-b','gm','user-c','user-c',
  ]);
  assert.deepEqual(animationCalls[4][3],['gm'],'hidden search animation is GM-only');
  assert.equal(animationCalls[4][7].secret,true);
  for(const args of animationCalls){
    assert.equal(args[2],true,'3D dice synchronize');
    assert.equal(args[4],false,'GM can see hidden animations');
    assert.equal(args[7].ghost,false,'never leak hidden rolls through ghost dice');
  }
  pending.slice(0,-1).forEach(resolve=>resolve(true));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(changes.length,0);
  assert.equal(messages.length,0);
  assert.equal(done,false);
  pending.at(-1)(true);
  await action;
  assert.equal(session.phase,'closed');
  assert.deepEqual(changes.map(c=>[c.target,c.damage,c.type]),[
    ['track',5,'damage'],['track',5,'damage'],['track',-5,'healing'],
  ],'Treatments apply in Party selection order; risky damage before medicine damage');
  assert.equal(messages.length,2,'one public card and one GM report, no intermediate rolls');
  assert.match(messages[0].content,/pf2e-ea-natural-1/);
  assert.doesNotMatch(messages[0].content,/29/);
  assert.doesNotMatch(messages[0].content,/pf2e-ea-natural-20/);
  assert.match(messages[1].content,/pf2e-ea-natural-20/);
  assert.deepEqual(messages[1].whisper,['gm']);
  deferredAnimations=false;
});

test('without Dice So Nice all changes apply promptly; no forced animation delay',async()=>{
  reset([
    character('healer1',1,{activityId:'heal',rank:'trained',targetId:'track'},{total:19,natural:12,outcome:'success'}),
    character('track',2,{activityId:'track'},{total:8,natural:1}),
  ]);
  diceOn=false;
  await finish();
  assert.equal(animationCalls.length,0);
  assert.equal(changes.length,1);
  assert.equal(changes[0].damage,-5);
  assert.equal(messages.length,1);
  diceOn=true;
});
