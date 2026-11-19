import test from 'node:test';
import assert from 'node:assert/strict';
import {responseContract,renderResponse,alreadyAttributed} from '../worker/src/response-policy.mjs';
const fact='Prioritizes spending the trip budget on food and gifts';
const first='Astra shared this detail about you, "'+fact+'". Suwon would make a lovely nearby second city without eating up your short trip in transit, with markets for food and gifts to match your spending priorities. How does Suwon sound for your second city?';
const a=content=>({role:'assistant',content}),u=content=>({role:'user',content});
const c=(agent='Sage',history=[])=>responseContract({agent,mode:'shared',transcript:'yes',history,memories:[{fact,type:'preference',learned_by:agent==='Sage'?'Astra':'Sage'}]});
const output=(contract,statements='Suwon joins the trip! A snack stop at Jidong Market could fit well.')=>JSON.stringify({statements,question:'How does a Jidong Market food stop sound for your Suwon activity?',ask_why:false,memory_use:{id:contract.evidence[0].id,application:'A snack stop at Jidong Market could fit well.'}});
test('The reported repeated source is omitted while the actual next suggestion is preserved',()=>{
 const contract=c('Sage',[a(first),u('yes')]);
 const reply=renderResponse(output(contract),contract);
 assert.equal(reply,'Suwon joins the trip! A snack stop at Jidong Market could fit well. How does a Jidong Market food stop sound for your Suwon activity?');
 assert.doesNotMatch(reply,/Astra|Prioritizes|spending priorities/);
 assert.match(contract.prompt,/A new decision does not require a new source announcement/);
});
test('A first useful attribution stays visible and uses natural second-person phrasing',()=>{
 const contract=c();const reply=renderResponse(output(contract),contract);
 assert.match(reply,/Astra mentioned you prioritize spending the trip budget on food and gifts, so/);
 assert.doesNotMatch(reply,/shared this detail|"Prioritizes/);
});
test('Natural attribution is also recognized on the next turn, in either source direction',()=>{
 for(const agent of ['Sage','Astra']) {
  const firstContract=c(agent);const reply=renderResponse(output(firstContract),firstContract);
  const next=c(agent,[a(reply),u('yes')]);const result=renderResponse(output(next),next);
  assert.doesNotMatch(result,/mentioned|shared this detail/);assert.match(result,/Jidong Market/);
 }
});
test('A recent equivalent paraphrase of the same source fact is not recited again',()=>{
 const contract=c('Sage',[a('Astra mentioned you wanted to spend on food and gifts. Suwon has markets for both.')]);
 assert.equal(alreadyAttributed(contract.evidence[0],contract.history),true);
 assert.doesNotMatch(renderResponse(output(contract),contract),/Astra/);
});
test('A distinct relevant fact can still receive its own attribution on a consecutive reply',()=>{
 const contract=c('Sage',[a('Astra mentioned you prefer short walks. Suwon is nearby.')]);
 assert.equal(alreadyAttributed(contract.evidence[0],contract.history),false);
 assert.match(renderResponse(output(contract),contract),/Astra mentioned you prioritize/);
});
test('Application without a source announcement and user messages do not falsely count as an attribution',()=>{
 for(const history of [[a('Food and gifts can fit the budget.')],[u(first)]]) {
  const evidence=c().evidence[0];assert.equal(alreadyAttributed(evidence,history),false);
 }
});
test('The six-reply window limits unnecessary reminders without blocking future relevant source mentions forever',()=>{
 const history=[a(first),...Array.from({length:6},()=>a('We can continue planning the route.'))];
 const evidence=c().evidence[0];assert.equal(alreadyAttributed(evidence,history),false);
});
test('A model-provided duplicate source sentence is stripped even when the renderer omits its own prefix',()=>{
 const contract=c('Sage',[a(first)]);
 const text='Astra shared this detail about you, "'+fact+'". A snack stop at Jidong Market could fit well.';
 const reply=renderResponse(output(contract,text),contract);
 assert.doesNotMatch(reply,/Astra|Prioritizes|shared this detail/);assert.match(reply,/A snack stop at Jidong Market/);
});
test('Both agents are told to review the supplied facts and make a concrete adaptation without repetitive recaps',()=>{
 for(const agent of ['Sage','Astra']) {
  const contract=c(agent,[a((agent==='Sage'?'Astra':'Sage')+' mentioned that you prioritize spending the trip budget on food and gifts.')]);
  assert.match(contract.prompt,/SHARED-FACT REVIEW BEFORE WRITING/);
  assert.match(contract.prompt,/Astra should translate Sage/);assert.match(contract.prompt,/Sage should translate Astra/);
  assert.match(contract.prompt,/not_relevant/);assert.match(contract.prompt,/Do not invent a reason or insert irrelevant facts/);
  const text=renderResponse(output(contract),contract);assert.match(text,/Jidong Market/);assert.doesNotMatch(text,/mentioned that you prioritize/);
 }
});
