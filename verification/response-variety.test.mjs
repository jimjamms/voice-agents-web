import test from 'node:test';
import assert from 'node:assert/strict';
import {varyFallback,varietyContext,hasBenefitExplanation} from '../worker/src/response-variety.mjs';
import {responseContract,renderResponse} from '../worker/src/response-policy.mjs';
import {invitationBenefit} from '../worker/src/personal-planning.mjs';
const a=content=>({role:'assistant',content}),u=content=>({role:'user',content});
const raw=(statements='',question=null)=>JSON.stringify({statements,question,ask_why:false,memory_use:null});
const c=args=>responseContract({agent:'Sage',mode:'shared',...args});
test('Opening questions and benefit lines have multiple variants, with no fixed participant identity',()=>{
 const replies=new Set();const prompts=new Set();
 for(let i=0;i<32;i++) {
  const contract=c({greeting:true,variationKey:'request-'+i});
  replies.add(renderResponse(raw(),contract));prompts.add(varietyContext('request-'+i));
 }
 assert.ok(replies.size>=4);assert.ok(prompts.size>=3);
});
test('Variation is independent of memory condition and preserves personalities and question purpose',()=>{
 for(let i=0;i<8;i++) {
  const args={greeting:true,variationKey:'request-'+i};
  assert.equal(renderResponse(raw(),c({...args,mode:'shared'})),renderResponse(raw(),c({...args,mode:'isolated'})));
 }
 assert.match(varietyContext('request-1'),/not a change in your persona/);
 assert.match(varietyContext('request-1'),/Do not invent different preferences/);
});
test('Fallback selection avoids a recent verbatim question when alternatives remain',()=>{
 const first=varyFallback('What kinds of games do you enjoy?','request-1');
 const second=varyFallback('What kinds of games do you enjoy?','request-1',[a(first)]);
 assert.notEqual(first,second);
});
test('Different game-question wording does not break clarification or resume repetitive why questions',()=>{
 for(let i=0;i<24;i++) {
  const key='request-'+i;
  const intro=c({greeting:true,variationKey:key});
  const opening=renderResponse(raw(),intro);
  const first=c({transcript:'I like playing games',history:[a(opening)],variationKey:key});
  assert.ok(first.clarification,opening);
  const reply=renderResponse(raw('Games give us a starting point.'),first);
  assert.match(reply,/games?/i);assert.equal((reply.match(/\?/g)||[]).length,1);
  const next=c({transcript:'I like strategy and puzzle games',history:[a(opening),u('I like playing games'),a(reply)],variationKey:key});
  assert.equal(next.clarification,null);assert.equal(next.pauseWhy,true,reply);
  const continued=renderResponse(raw('That gives us a starting point.','What makes strategy games appealing?',true),next);
  assert.match(continued,/\?$/);assert.doesNotMatch(continued,/What makes strategy/);
 }
});
test('New benefit variants are recognized instead of being added repeatedly',()=>{
 for(let i=0;i<20;i++) {
  const phrase=varyFallback('I can use your interests to suggest experiences that fit you.','request-'+i);
  assert.equal(hasBenefitExplanation(phrase),true);
  assert.equal(invitationBenefit('pace',[a(phrase)]),'');
 }
});
test('A suitable original model question is kept, not forced into a question bank',()=>{
 const contract=c({greeting:true,variationKey:'request-1'});
 const question='What interests do you enjoy making time for on a free day?';
 const reply=renderResponse(raw('Let’s find a trip that suits you.',question),contract);
 assert.ok(reply.endsWith(question));assert.equal((reply.match(/\?/g)||[]).length,1);
});
test('Only fallback wording varies; actual user facts are not rewritten or shared across users',()=>{
 const contract=c({transcript:'Can you suggest a cafe?',variationKey:'request-1',memories:[{fact:'Prefers quiet cafes',reason:'Crowds feel tiring',type:'preference',learned_by:'Sage'}]});
 assert.match(contract.prompt,/Prefers quiet cafes/);assert.match(contract.prompt,/Crowds feel tiring/);
 const statement='A cafe on a quiet side street would give you a calmer stop.';
 assert.equal(renderResponse(raw(statement),contract),statement);
 const unrelated=c({variationKey:'request-1'});assert.doesNotMatch(unrelated.prompt,/Crowds feel tiring/);
});
test('Varied Astra rejection questions still activate the pause before another personal probe',()=>{
 for(let i=0;i<12;i++) {
  const first=c({agent:'Astra',transcript:'Skip museums',variationKey:'request-'+i});
  const reply=renderResponse(raw('We can leave them out.'),first);
  const next=c({agent:'Astra',transcript:'Skip galleries instead',history:[a(reply)],variationKey:'request-'+i});
  assert.equal(next.pauseWhy,true,reply);assert.equal(next.required,false);
 }
});
