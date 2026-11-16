import test from 'node:test';
import assert from 'node:assert/strict';
import {responseContract,renderResponse} from '../worker/src/response-policy.mjs';
import {SHARING_VALUE_RULES,invitationBenefit} from '../worker/src/personal-planning.mjs';
const contract=options=>responseContract({agent:'Sage',mode:'shared',greeting:true,...options});
const model=(statements='',question=null)=>JSON.stringify({statements,question,ask_why:false,memory_use:null});
test('Sage offers a useful early interests invitation with a concrete benefit',()=>{
 const c=contract({});const reply=renderResponse(model('Hi, I’m Sage.'),c);
 assert.equal(c.discovery.topic,'interests');assert.match(reply,/use your interests to suggest experiences that fit you/);
 assert.match(reply,/What do you enjoy doing when you have a free afternoon\?/);
 assert.equal((reply.match(/\?/g)||[]).length,1);
});
test('Astra connects each selected practical question to a concrete trip benefit',()=>{
 for(const [transcript,topic] of [['I am thinking about hotels','lodging'],['A train sounds good','transport'],['My budget is 1000 dollars','spending'],['Hello','pace']]) {
  const c=contract({agent:'Astra',greeting:false,transcript,tripChoices:{cities:['Kyoto']}});
  assert.equal(c.discovery.topic,topic);assert.ok(c.benefit);
  const reply=renderResponse(model('We can work on that.','Is that okay?'),c);
  assert.ok(reply.includes(c.benefit));assert.ok(reply.includes(c.discovery.question));assert.equal((reply.match(/\?/g)||[]).length,1);
 }
});
test('The invitation and benefit are identical across modes when available knowledge is identical',()=>{
 for(const agent of ['Sage','Astra']) {
  const options={agent,greeting:true,tripChoices:{cities:['Kyoto']}};
  const shared=contract({...options,mode:'shared'}),isolated=contract({...options,mode:'isolated'});
  assert.deepEqual(shared.discovery,isolated.discovery);assert.equal(shared.benefit,isolated.benefit);
  assert.equal(renderResponse(model(),shared),renderResponse(model(),isolated));
 }
});
test('Recently explained benefits are not repeated, and a model explanation is not duplicated',()=>{
 const history=[{role:'assistant',content:'I can use your interests to suggest experiences that fit you.'}];
 assert.equal(invitationBenefit('pace',history),'');
 const c=contract({agent:'Astra',tripChoices:{cities:['Kyoto']},history});assert.equal(c.benefit,'');
 const fresh=contract({});const reply=renderResponse(model('Knowing your interests helps me choose experiences for you.',fresh.discovery.question),fresh);
 assert.equal((reply.match(/experiences/g)||[]).length,1);assert.doesNotMatch(reply,/I can use/);
});
test('Known interests, explicit skips and completed plans do not create another Sage interview',()=>{
 for(const options of [
  {transcript:'Rather not'}, {transcript:'Just proceed'}, {transcript:'No more questions'}, {transcript:"I don't want to answer"}, {transcript:'I have a food allergy'},
  {tripChoices:{finalized:true}}, {memories:[{fact:'Enjoys gardening',type:'preference',learned_by:'Sage'}]},
  {history:[{role:'assistant',content:'What do you enjoy doing in your free time?'}]},
 ]) assert.equal(contract(options).discovery,null);
});
test('An answer does not start another personal question or benefit pitch',()=>{
 const history=[{role:'assistant',content:'I can use your interests to suggest experiences that fit you. What do you enjoy doing when you have a free afternoon?'}];
 const c=contract({greeting:false,transcript:'I enjoy wandering without a schedule',history});
 assert.equal(c.discovery,null);assert.equal(c.benefit,'');
 const reply=renderResponse(model('We could leave the afternoon free for an unhurried neighborhood walk.','What else do you enjoy?'),c);
 assert.equal(reply,'We could leave the afternoon free for an unhurried neighborhood walk.');
});
test('The policy requests useful voluntary context without rewarding disclosure or coaching study outcomes',()=>{
 assert.match(SHARING_VALUE_RULES,/same invitation rules/);assert.match(SHARING_VALUE_RULES,/continue helping fully/);
 assert.match(SHARING_VALUE_RULES,/minimum number of facts/);assert.match(SHARING_VALUE_RULES,/compensation/);
 assert.match(SHARING_VALUE_RULES,/Do not create facts, reasons or memories/);
 assert.match(SHARING_VALUE_RULES,/next relevant suggestion/);
});
