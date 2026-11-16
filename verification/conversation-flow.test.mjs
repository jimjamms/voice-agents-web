import test from 'node:test';
import assert from 'node:assert/strict';
import {responseContract,renderResponse} from '../worker/src/response-policy.mjs';
const opening='Hi, I’m Sage! Let’s find a trip you’re excited about. I can use your interests to suggest experiences that fit you. What do you enjoy doing when you have a free afternoon?';
const a=content=>({role:'assistant',content}),u=content=>({role:'user',content});
const contract=args=>responseContract({agent:'Sage',mode:'shared',transcript:'i like playing games',history:[a(opening)],...args});
const raw=(statements,question=null,ask_why=false)=>JSON.stringify({statements,question,ask_why,memory_use:null});
test('The reported acknowledgement-only response gets exactly one games clarification in both modes',()=>{
 for(const mode of ['shared','isolated']) for(const content of [raw('Games could be a fun starting point for your trip!'),'Games could be a fun starting point for your trip!']) {
  const c=contract({mode});assert.ok(c.clarification);assert.equal(c.pauseWhy,true);
  assert.equal(renderResponse(content,c),'Games could be a fun starting point for your trip! What kinds of games do you enjoy?');
 }
});
test('A generated useful clarification survives the existing personal-question pause',()=>{
 const reply=renderResponse(raw('Games give us something to build on.','What games are you into?',true),contract({}));
 assert.equal(reply,'Games give us something to build on. What games are you into?');
});
test('Unrelated and stacked questions are replaced without stacking another question',()=>{
 for(const q of ['What is your budget?','What games do you enjoy and what country do you want to visit?']) {
  const reply=renderResponse(raw('Games could work.',q),contract({}));
  assert.match(reply,/What kinds of games do you enjoy\?$/);assert.equal((reply.match(/\?/g)||[]).length,1);
 }
});
test('The exception is bounded: answer the games clarification, then advance planning',()=>{
 const history=[a(opening),u('I like playing games'),a('What kinds of games do you enjoy?')];
 const c=contract({transcript:'Strategy and puzzle games',history});
 assert.equal(c.clarification,null);assert.equal(c.pauseWhy,true);
 const reply=renderResponse(raw('That gives us a starting point.','What do you enjoy about puzzle games?',true),c);
 assert.equal(reply,'That gives us a starting point. Which country would you like to visit?');
 assert.equal((reply.match(/\?/g)||[]).length,1);
});
test('Detailed or explained interests are used rather than forced into a second clarification',()=>{
 for(const transcript of ['I like strategy games because I enjoy solving puzzles','I enjoy wandering without a schedule']) {
  const c=contract({transcript});assert.equal(c.clarification,null);
  const reply=renderResponse(raw('We could try an escape room as a puzzle-focused activity.'),c);
  assert.equal(reply,'We could try an escape room as a puzzle-focused activity.');
 }
});
test('Skips, direct questions and completion do not receive a forced clarification or next question',()=>{
 for(const args of [{transcript:'Rather not'},{transcript:'No more questions'},{transcript:'Just proceed'},{transcript:'What about Japan?'},{tripChoices:{finalized:true}}]) {
  const c=contract(args);assert.equal(c.clarification,null);assert.equal(c.progress,'');
 }
});
test('Fallback follows saved progress and does not repeat existing place questions',()=>{
 const history=[a(opening),u('Games'),a('What kinds of games do you enjoy?')];
 assert.match(renderResponse(raw('That sounds fun.'),contract({transcript:'Strategy',history,tripChoices:{countries:['Japan']}})),/Which city would you like to explore first\?$/);
 const c=contract({transcript:'Strategy',history:[a('Which country would you like to visit?'),u('Japan'),...history]});
 assert.equal(c.progress,'');
 const saved=contract({transcript:'Strategy',history,memories:[{fact:'Trip to Japan',type:'trip_detail',learned_by:'Sage'}]});
 assert.equal(saved.progress,'');
});
test('Other broad categories get one relevant question without repeating the benefit pitch',()=>{
 for(const [transcript,word] of [['I like music','music'],['I like food','foods'],['I like nature','outdoors'],['I like reading','reading'],['I like board games','board games']]) {
  const c=contract({transcript});assert.ok(c.clarification,transcript);
  const reply=renderResponse(raw('That can guide the trip.'),c);assert.ok(reply.includes(word));assert.equal((reply.match(/\?/g)||[]).length,1);assert.doesNotMatch(reply,/I can use/);
 }
});
