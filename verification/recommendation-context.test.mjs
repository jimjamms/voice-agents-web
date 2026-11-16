import test from 'node:test';
import assert from 'node:assert/strict';
import {responseContract,renderResponse,whyRequired} from '../worker/src/response-policy.mjs';
import {acceptedRecommendation} from '../worker/src/conversation-flow.mjs';
const a=content=>({role:'assistant',content}),u=content=>({role:'user',content});
const opening='Hi, I’m Sage! What do you most enjoy doing in your free time?';
const recommendation='Japan could be a fun fit for your interest in games—Tokyo’s Akihabara neighborhood has arcades and gaming shops. If you prefer tabletop games, Germany’s Berlin has board-game cafés worth exploring. Which destination catches your interest?';
const history=[a(opening),u('i like to play games'),a('We can make room for some gaming fun on your trip! What country do you have in mind for this trip?'),u('do you have any suggestions'),a(recommendation)];
const c=args=>responseContract({agent:'Sage',mode:'shared',transcript:'japan',history,...args});
const raw=(question,ask_why=true,statements='Japan it is! Let’s find an experience there you’ll really enjoy.')=>JSON.stringify({statements,question,ask_why,memory_use:null});
test('The reported Japan choice retains its game-based recommendation context in both modes',()=>{
 for(const mode of ['shared','isolated']) {
  const contract=c({mode});assert.ok(contract.accepted);assert.equal(contract.required,false);assert.ok(contract.clarification);
  const reply=renderResponse(raw('What appeals to you most about visiting Japan?'),contract);
  assert.equal(reply,'Japan it is! Let’s find an experience there you’ll really enjoy. What kinds of games do you enjoy?');
  assert.equal((reply.match(/\?/g)||[]).length,1);assert.doesNotMatch(reply,/appeals.*Japan/);
 }
});
test('To-play and playing express the same broad hobby and each receives a useful clarification',()=>{
 for(const transcript of ['i like to play games','I like playing games','I enjoy games']) {
  const contract=responseContract({agent:'Sage',mode:'shared',transcript,history:[a(opening)]});
  assert.ok(contract.clarification,transcript);assert.match(renderResponse(raw(null,false,'Games could work.'),contract),/What kinds of games do you enjoy\?$/);
 }
});
test('The generic reason-known check is grounded in actual user preferences, not just agent claims',()=>{
 assert.equal(whyRequired('Sage','Japan',history),false);
 const unrelated=[u('I like games'),a('Japan could fit your love of anime. Which destination would you choose?')];
 assert.equal(acceptedRecommendation('Japan',unrelated),null);
 assert.equal(whyRequired('Sage','Japan',unrelated),true);
 assert.equal(acceptedRecommendation('Japan',[a(recommendation)]),null);
 assert.equal(acceptedRecommendation('Japan',[u('Do I like games?'),a(recommendation)]),null);
 assert.equal(acceptedRecommendation('Japan',[u("I'm not sure I like games"),a(recommendation)]),null);
});
test('A later correction prevents an older preference from falsely grounding a recommendation',()=>{
 const revised=[u('I like games'),u("I don't play games anymore"),a(recommendation)];
 assert.equal(acceptedRecommendation('Japan',revised),null);
});
test('Acceptance does not infer a genre or turn a competing-option yes into a specific choice',()=>{
 assert.equal(acceptedRecommendation('yes',history),null);
 assert.equal(acceptedRecommendation('maybe Japan',history),null);
 const accepted=acceptedRecommendation('Japan',history);
 assert.equal(accepted.preference,'i like to play games');assert.doesNotMatch(accepted.preference,/tabletop|video|arcade/);
});
test('The same fix applies beyond Japan and games when another preference grounds the recommendation',()=>{
 const h=[u('I prefer hiking'),a('Innsbruck could suit your interest in hiking. Which city would you like?')];
 assert.ok(acceptedRecommendation('Innsbruck',h));assert.equal(whyRequired('Sage','Innsbruck',h),false);
 const contract=responseContract({agent:'Sage',mode:'shared',transcript:'Innsbruck',history:h});
 const reply=renderResponse(raw('What appeals about Innsbruck?',true,'Innsbruck it is!'),contract);
 assert.doesNotMatch(reply,/What appeals/);assert.match(reply,/Which part of the trip would you like to plan next/);
});
test('An unanswered games question is not repeated after accepting the destination',()=>{
 const h=[a(opening),u('I like to play games'),a('What kinds of games do you enjoy?'),u('Strategy and puzzles'),a(recommendation)];
 const contract=c({history:h});assert.ok(contract.accepted);assert.equal(contract.clarification,null);
 assert.doesNotMatch(renderResponse(raw('Why Japan?'),contract),/Why Japan|What kinds of games/);
});
test('Fresh contextual questions survive and unrelated private memories remain unavailable',()=>{
 const contract=c({});const question='What games do you find yourself coming back to?';
 assert.ok(renderResponse(raw(question,false),contract).endsWith(question));
 const isolated=responseContract({agent:'Sage',mode:'isolated',transcript:'Japan',history:[a(recommendation)],memories:[{fact:'Likes games',type:'preference',learned_by:'Astra'}]});
 assert.equal(isolated.accepted,null);
});
