import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {planningContinuity,redundantTimingQuestion} from '../worker/src/planning-continuity.mjs';
import {responseContract,renderResponse,eligibleEvidence} from '../worker/src/response-policy.mjs';
import {memoryContext} from '../worker/src/memory.mjs';
import {memoryAttributionContext,normalizeMemory} from '../worker/src/personal-memory.mjs';
import {knownPersonalFacts} from '../worker/src/personal-planning.mjs';
import {cleanProfile} from '../worker/src/profiles.mjs';
const a=content=>({role:'assistant',content}),u=content=>({role:'user',content});
const record=i=>({fact:`Preference record ${String(i).padStart(3,'0')}`,type:'preference',reason:null,learned_by:'Sage'});
const records=Array.from({length:50},(_,i)=>record(i));
const blank=()=>({notes:'',choices:{countries:[],cities:[],activities:[]},memories:{shared:[],sage:[],astra:[],recentShared:[]}});
const history=[a('I suggest mid-to-late October for cooler weather. What year would you be traveling?'),u('2027'),a('For 2027, mid-to-late October remains my suggestion; exact dates can stay flexible for now. How many people will your budget cover?'),u('Just me'),a('What expenses does your budget need to cover?'),u('Everything'),a('Which city will you be flying from?'),u('Austin Texas'),a('How many days can you allow in total, including flights?'),u('a week total'),a('I would keep Seoul as your base and visit Suwon.'),u('Sure')];
const state=args=>planningContinuity({agent:'Astra',mode:'shared',history,transcript:'sure',...args});
const c=args=>responseContract({agent:'Astra',mode:'shared',history,transcript:'sure',...args});
function browserMemory(){const values=new Map(),window={};const localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};vm.runInNewContext(readFileSync(new URL('../docs/memory.js',import.meta.url),'utf8'),{window,localStorage});return window.AgentMemory;}
test('Browser retains the latest 50 in each independent compartment and restores them',()=>{
 const m=browserMemory();
 for(const [mode,agent] of [['shared','sage'],['isolated','sage'],['isolated','astra']]) {
  for(let i=0;i<55;i++)m.remember('p1',mode,agent,record(i));
  const saved=m.entries('p1',mode,agent);assert.equal(saved.length,50);assert.equal(saved[0].fact,record(5).fact);assert.equal(saved.at(-1).fact,record(54).fact);
 }
 const snapshot=JSON.parse(JSON.stringify(m.snapshot('p1')));m.restore('p2',snapshot);
 assert.equal(m.entries('p2','shared','astra').length,50);assert.equal(m.entries('p2','isolated','astra').length,50);
});
test('Cloud validation accepts 50 per bucket, reads older 20-record profiles, and rejects 51',()=>{
 const profile=blank();for(const key of ['shared','sage','astra'])profile.memories[key]=records;
 const saved=cleanProfile(profile);for(const key of ['shared','sage','astra'])assert.equal(saved.memories[key].length,50);
 profile.memories.shared=records.slice(0,20);assert.equal(cleanProfile(profile).memories.shared.length,20);
 profile.memories.shared=[...records,record(50)];assert.throws(()=>cleanProfile(profile),/Invalid memories/);
});
test('All 50 saved facts reach regular, personal and source context including the oldest eligible record',()=>{
 const context=memoryContext('p1',records,'Astra','shared');assert.match(context,/record 000/);assert.match(context,/record 049/);
 const attribution=memoryAttributionContext(records,'Astra','shared');assert.match(attribution,/record 000/);assert.match(attribution,/record 049/);
 assert.equal(eligibleEvidence('Astra','shared',records).length,50);
 const facts=knownPersonalFacts({agent:'Astra',mode:'shared',memories:records,history:[u('I enjoy cafes')]});
 assert.ok(facts.some(f=>f.fact===record(0).fact));assert.ok(facts.some(f=>f.fact===record(49).fact));assert.equal(facts.length,51);
 assert.equal(eligibleEvidence('Astra','isolated',records).length,0);
});
test('The reported flexible October window, year and whole-trip duration are carried forward',()=>{
 const s=state();assert.match(s.window,/October/);assert.equal(s.year,'2027');assert.equal(s.flexible,true);assert.match(s.duration,/week/);assert.equal(s.durationIncludesTravel,true);
 for(const q of ['What dates in 2027 would work for your week away?','What year would you be traveling?','When would you like to go?','How many days can you allow in total, including flights?'])assert.equal(redundantTimingQuestion(q,s),true,q);
 const reply=renderResponse(JSON.stringify({statements:'The hotel allowance remains an estimate.',question:'What dates in 2027 would work for your week away?',memory_use:null}),c({}));
 assert.doesNotMatch(reply,/What dates/);assert.match(reply,/hotel allowance/);assert.equal((reply.match(/\?/g)||[]).length,1);
});
test('Genuine precision needs, unknown years, city allocation and time-of-day questions remain available',()=>{
 assert.equal(redundantTimingQuestion('What year would you be traveling?',state({history:[a('October could work.')],transcript:'okay'})),false);
 assert.equal(redundantTimingQuestion('What exact dates do you want to book?',state({transcript:'I want to book the actual flights now'})),false);
 const s=state({tripChoices:{cities:['Seoul','Suwon']}});
 assert.equal(redundantTimingQuestion('How many days would you like to spend in Seoul?',s),false);
 assert.equal(redundantTimingQuestion('What time would you like to leave for the market?',s),false);
 assert.equal(redundantTimingQuestion('Would mid-to-late October work for you?',s),false);
});
test('A rejection removes the previous timing proposal instead of keeping it as a confirmed decision',()=>{
 const s=state({transcript:'Not October, that does not work'});assert.equal(s.window,'');assert.equal(redundantTimingQuestion('What dates would work instead?',s),false);
});
test('Saved proposals preserve continuity beyond chat truncation without becoming user preferences or approval',()=>{
 const proposal={fact:'Proposed: mid-to-late October 2027, exact dates flexible.',type:'planning_proposal',learned_by:'Astra'};
 const contract=c({history:[],memories:[proposal],tripChoices:{finalized:false}});
 assert.ok(contract.continuity.proposals.length);assert.match(contract.continuity.proposals[0].status,/not user-confirmed/);
 assert.equal(redundantTimingQuestion('What dates work?',contract.continuity),true);
 assert.equal(contract.evidence.length,0);assert.equal(contract.knownFacts.length,0);
 assert.match(contract.prompt,/Silence and lack of rejection never count as consent/);
});
test('Separate mode excludes the other agent proposal, and public timing cannot carry private reasons',()=>{
 const proposal={fact:'Proposed: October 2027, flexible.',type:'planning_proposal',learned_by:'Sage'};
 assert.equal(state({mode:'isolated',history:[],memories:[proposal]}).window,'');
 const s=state({mode:'isolated',history:[],tripChoices:{itinerary:{timing:'October 2027 because crowds tire me out'}},tripNotes:'Dates: October 2027 because crowds tire me out'});
 assert.match(s.window,/October 2027/);assert.doesNotMatch(JSON.stringify(s),/crowds tire/);
});
test('Proposal type persists through normalization, browser storage and cloud profile without a fabricated reason',()=>{
 const proposal=normalizeMemory({fact:'Proposed: small hotel in Yeonnam; property can be chosen later.',type:'planning_proposal',reason:'made up'},'Astra');
 assert.equal(proposal.type,'planning_proposal');assert.equal(proposal.reason,null);
 const m=browserMemory();m.remember('p1','shared','astra',proposal);
 const profile=blank();profile.memories=m.snapshot('p1');const saved=cleanProfile(profile);
 assert.equal(saved.memories.shared[0].type,'planning_proposal');assert.equal(saved.choices.finalized,false);
 assert.equal(memoryAttributionContext(saved.memories.shared,'Sage','shared').includes('Personal facts actually learned'),false);
});
test('A saved date rejection supersedes an older proposal after the raw conversation is truncated',()=>{
 const memories=[{fact:'Proposed: October 2027, dates flexible.',type:'planning_proposal',learned_by:'Astra'},{fact:'Cannot travel in October',type:'constraint',learned_by:'Astra'}];
 const s=state({history:[],memories});assert.equal(s.window,'');assert.equal(redundantTimingQuestion('What dates would work?',s),false);
});
test('A comfort constraint mentioning October is not mistaken for rejecting October itself',()=>{
 const memories=[{fact:'Proposed: October 2027, dates flexible.',type:'planning_proposal',learned_by:'Astra'},{fact:'Avoid crowds in October',type:'avoidance',learned_by:'Astra'}];
 const s=state({history:[],memories});assert.match(s.window,/October/);
});
test('Public calendar-only notes preserve flexible timing in either mode without sharing a private reason',()=>{
 for(const mode of ['shared','isolated']) {
  const s=state({mode,history:[],tripNotes:'Dates: mid-to-late October 2027, exact dates flexible'});
  assert.match(s.window,/October 2027/);assert.equal(s.flexible,true);assert.equal(redundantTimingQuestion('What dates work?',s),true);
 }
});
