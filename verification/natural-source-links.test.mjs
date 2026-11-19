import test from 'node:test';
import assert from 'node:assert/strict';
import {responseContract,renderResponse} from '../worker/src/response-policy.mjs';
const a=content=>({role:'assistant',content});
function setup(agent,fact,options={}) {
 const source=agent==='Sage'?'Astra':'Sage';
 return responseContract({agent,mode:'shared',transcript:'Can you suggest a stop?',memories:[{fact,type:'preference',learned_by:source}],...options});
}
function output(c,application,statements=application) {
 return JSON.stringify({statements,question:null,memory_use:{id:c.evidence[0].id,application}});
}
test('Astra clearly links Sage preference to a concrete timing suggestion in one sentence',()=>{
 const c=setup('Astra','Prefers quieter places');
 const application="I'd schedule that visit early.";
 assert.equal(renderResponse(output(c,application),c),"Sage mentioned you prefer quieter places, so I'd schedule that visit early.");
});
test('Sage clearly links Astra priority to a concrete suggestion without a quoted profile note',()=>{
 const c=setup('Sage','Prioritizes spending the trip budget on food and gifts');
 const application='A market stop could fit well.';
 assert.equal(renderResponse(output(c,application),c),'Astra mentioned you prioritize spending the trip budget on food and gifts, so a market stop could fit well.');
});
test('The source link is inserted at the specific application, preserving other relevant sentences',()=>{
 const c=setup('Astra','Prefers quieter places');const application='We could visit the garden early.';
 assert.equal(renderResponse(output(c,application,'The garden is one option. '+application),c),'The garden is one option. Sage mentioned you prefer quieter places, so we could visit the garden early.');
});
test('A recent linked attribution suppresses the next source announcement but retains the next actual suggestion',()=>{
 const first=setup('Astra','Prefers quieter places');const application="I'd schedule that visit early.";
 const reply=renderResponse(output(first,application),first);
 const next=setup('Astra','Prefers quieter places',{history:[a(reply)]});
 assert.equal(renderResponse(output(next,'We could choose a cafe on a side street.'),next),'We could choose a cafe on a side street.');
});
test('Direct first-person shared statements can be expressed naturally without quoted transcript text',()=>{
 const c=responseContract({agent:'Astra',mode:'shared',transcript:'Can you suggest a cafe?',sharedTurns:[{agent:'sage',transcript:'I prefer quiet cafes',reply:'Okay.'}]});
 const application='We could choose a side-street cafe.';
 assert.equal(renderResponse(output(c,application),c),'Sage mentioned you prefer quiet cafes, so we could choose a side-street cafe.');
});
test('Complex records use a brief source link rather than inventing a paraphrase or reading a profile note aloud',()=>{
 const c=setup('Astra','Crowds tire the traveler. Their sister also prefers short walks.');
 const application='We could keep the walk short.';
 assert.equal(renderResponse(output(c,application),c),'Based on what Sage shared, we could keep the walk short.');
});
test('Unprovided facts and public arrangements cannot gain an apparent personal source',()=>{
 for(const options of [{mode:'isolated'},{memories:[{fact:'Visit the garden on day 2',type:'trip_detail',learned_by:'Sage'}]}]) {
  const c=setup('Astra','Prefers quieter places',options);
  const reply=renderResponse(JSON.stringify({statements:'We could visit the garden early.',question:null,memory_use:{id:'memory-1',application:'We could visit the garden early.'}}),c);
  assert.equal(reply,'We could visit the garden early.');
 }
});
test('A shortened source clause still suppresses the next attribution when the full record contains a reason',()=>{
 const sharedTurns=[{agent:'sage',transcript:'I prefer quiet cafes because crowds tire me out.',reply:'Okay.'}];
 const first=responseContract({agent:'Astra',mode:'shared',transcript:'Can you suggest a cafe?',sharedTurns});
 const application='We could choose a side-street cafe.';
 const reply=renderResponse(output(first,application),first);
 assert.match(reply,/Sage mentioned you prefer quiet cafes, so/);
 const next=responseContract({agent:'Astra',mode:'shared',transcript:'Can you suggest another stop?',sharedTurns,history:[a(reply)]});
 assert.equal(renderResponse(output(next,'We could visit a garden early.'),next),'We could visit a garden early.');
});
test('A compact source link for a complex record also suppresses a repeated related attribution',()=>{
 const fact='Crowds tire the traveler. Their sister also prefers short walks.';
 const first=setup('Astra',fact);
 const reply=renderResponse(output(first,'We could keep the walk short.'),first);
 const next=setup('Astra',fact,{history:[a(reply)]});
 assert.equal(renderResponse(output(next,'We could choose another short walk.'),next),'We could choose another short walk.');
});
