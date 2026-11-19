import test from 'node:test';
import assert from 'node:assert/strict';
import {responseContract,renderResponse} from '../worker/src/response-policy.mjs';
const a=content=>({role:'assistant',content});
const fact='Dislikes excessive heat and crowds';
const setup=(agent='Sage',options={})=>responseContract({agent,mode:'shared',transcript:'Can you suggest a stop?',memories:[{fact,type:'avoidance',learned_by:agent==='Sage'?'Astra':'Sage'}],...options});
const raw=(c,application,statements)=>JSON.stringify({statements,question:null,memory_use:{id:c.evidence[0].id,application}});
test('The reported standalone source sentence and Absolutely become one smooth verified connection',()=>{
 const c=setup();const application="I'd aim for a cooler, quieter time for your food stop.";
 const statements='Astra mentioned that you dislike excessive heat and crowds. Absolutely! '+application;
 assert.equal(renderResponse(raw(c,application,statements),c),"Astra mentioned you'd rather avoid very hot weather and crowds, so I'd aim for a cooler, quieter time for your food stop.");
});
test('Filler included in the application metadata is also removed before linking',()=>{
 const c=setup();const application="Absolutely! I'd aim for a cooler, quieter time for your food stop.";
 const reply=renderResponse(raw(c,application,application),c);
 assert.equal(reply,"Astra mentioned you'd rather avoid very hot weather and crowds, so I'd aim for a cooler, quieter time for your food stop.");
});
test('The same phrasing fix works for Astra using a Sage fact',()=>{
 const c=setup('Astra');const application='We could choose a cooler, quieter time.';
 assert.equal(renderResponse(raw(c,application,'Certainly! '+application),c),"Sage mentioned you'd rather avoid very hot weather and crowds, so we could choose a cooler, quieter time.");
});
test('A recent natural source mention stays suppressed and filler does not return on the next use',()=>{
 const first=setup();const application="I'd aim for a cooler, quieter time.";
 const reply=renderResponse(raw(first,application,application),first);
 const next=setup('Sage',{history:[a(reply)]});const suggestion='We could choose a quiet indoor stop.';
 assert.equal(renderResponse(raw(next,suggestion,'Absolutely! '+suggestion),next),suggestion);
});
test('Real negative qualifications and unrelated replies are preserved',()=>{
 const c=setup();const application='We could choose an indoor stop.';
 const reply=renderResponse(raw(c,application,'Absolutely not! '+application),c);
 assert.ok(reply.startsWith('Absolutely not! '));
 const normal=responseContract({agent:'Sage',mode:'isolated',transcript:'Can you explain that?'});
 assert.equal(renderResponse(JSON.stringify({statements:'Absolutely! Here is the explanation.',question:null,memory_use:null}),normal),'Absolutely! Here is the explanation.');
});
test('Direct user disclosure is given the same conversational wording without changing the source fact',()=>{
 const c=responseContract({agent:'Sage',mode:'shared',transcript:'Can you suggest a stop?',sharedTurns:[{agent:'astra',transcript:'I dislike excessive heat and crowds',reply:'Okay.'}]});
 const application='We could choose a cooler, quieter time.';
 assert.equal(renderResponse(raw(c,application,application),c),"Astra mentioned you'd rather avoid very hot weather and crowds, so we could choose a cooler, quieter time.");
 assert.equal(c.evidence[0].fact,'I dislike excessive heat and crowds');
});
