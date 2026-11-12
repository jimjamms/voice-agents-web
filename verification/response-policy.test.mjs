import test from 'node:test';
import assert from 'node:assert/strict';
import {whyRequired,eligibleEvidence,responseContract,renderResponse} from '../worker/src/response-policy.mjs';
const h = content => [{role:'assistant',content}];
const m = (source='Sage') => ({fact:'Prefers quiet cafes',type:'preference',reason:'Crowds feel tiring',learned_by:source});
const contract = args => responseContract({agent:'Sage',mode:'shared',...args});
const out = data => JSON.stringify({statements:'That works.',question:null,ask_why:false,memory_use:null,...data});
test('Sage follows both explicit preferences and short country, city and activity choices',()=>{
 for(const text of ['I prefer quiet places','I love outdoor activities',"Let's do the garden","I'd like Kyoto"]) assert.equal(whyRequired('Sage',text),true,text);
 for(const [q,a] of [['Which country would you like to visit?','Japan'],['Which city appeals to you?','Kyoto'],['What activity would you enjoy?','Walking in a garden']]) assert.equal(whyRequired('Sage',a,h(q)),true,a);
});
test('Astra asks why after a rejection or change, not every accepted detail',()=>{
 for(const text of ['No museums on day 2','Skip the museum',"I'd rather take the train",'Replace the tour with a park']) assert.equal(whyRequired('Astra',text),true,text);
 for(const text of ['Yes','Kyoto','I prefer quiet cafes']) assert.equal(whyRequired('Astra',text),false,text);
});
test('Already explained choices, declined questions, sensitive needs, logistics and approval do not force probing',()=>{
 for(const text of ['I prefer parks because I enjoy fresh air','I prefer parks since crowds tire me out','I would rather not explain','Just proceed','Looks good, I approve','I need wheelchair access','I want a budget of 500 dollars','I want five days']) assert.equal(whyRequired('Sage',text),false,text);
 assert.equal(whyRequired('Sage','Quiet cafes',[],[m()]),false);
 assert.equal(whyRequired('Sage','I prefer quiet cafes',h('What drew you to that choice?')),false);
 assert.equal(whyRequired('Sage','I like gardens',[{role:'user',content:'Gardens appeal because I enjoy plants'}]),false);
});
test('A missing why replaces logistics and a stacked why falls back to one question',()=>{
 const c=contract({transcript:'I prefer quiet places'});
 for(const data of [out({question:'How many days do you have?'}),out({question:'Why do you prefer quiet places and what is your budget?',ask_why:true}),'Sounds good. What is your budget?']) {
  const reply=renderResponse(data,c);assert.match(reply,/What do you enjoy about a quieter setting\?/);assert.equal((reply.match(/\?/g)||[]).length,1);assert.doesNotMatch(reply,/budget|days/);
 }
});
test('A contextual single why is retained and question-like sentences are removed from statements',()=>{
 const result=renderResponse(out({statements:'That sounds lovely. How long is the trip?',question:'What is it about quiet places that appeals to you?',ask_why:true}),contract({transcript:'I prefer quiet places'}));
 assert.equal(result,'That sounds lovely. What is it about quiet places that appeals to you?');
});
test('Shared evidence and visible use work in both directions',()=>{
 for(const agent of ['Sage','Astra']) {
  const other=agent==='Sage'?'Astra':'Sage';const c=contract({agent,memories:[m(other)]});
  const application="I'd choose a cafe on a quieter side street.";
  const reply=renderResponse(out({statements:application,memory_use:{id:c.evidence[0].id,application}}),c);
  assert.match(reply,new RegExp(other+' mentioned'));assert.match(reply,/you prefer quiet cafes/);assert.match(reply,/quieter side street/);
 }
});
test('Ineligible or irrelevant facts do not gain a source mention',()=>{
 for(const mode of ['shared','isolated']) {
  const c=contract({mode,memories:[m('Astra')]});
  assert.doesNotMatch(renderResponse(out({statements:'The journey takes about two hours.'}),c),/mentioned/);
  assert.doesNotMatch(renderResponse(out({memory_use:{id:'invented',application:'That works.'}}),c),/mentioned/);
 }
 assert.equal(eligibleEvidence('Astra','shared',[{fact:'Kyoto on day 2',type:'trip_detail',learned_by:'Sage'}]).length,0);
 assert.equal(eligibleEvidence('Astra','shared',[m('Astra')]).length,0);
 assert.equal(eligibleEvidence('Astra','shared',[m(),m('Astra')]).length,0);
});
test('Cross-agent user statements are immediately eligible before deferred extraction finishes',()=>{
 const turns=[{agent:'sage',transcript:'I prefer quiet cafes because crowds tire me out.',reply:'Try this museum.'}];
 const c=contract({agent:'Astra',sharedTurns:turns});
 assert.equal(c.evidence.length,1);assert.match(c.evidence[0].fact,/crowds tire/);
 const application="I'd schedule your cafe stop away from the main square.";
 const reply=renderResponse(out({statements:application,memory_use:{id:c.evidence[0].id,application}}),c);
 assert.match(reply,/Sage mentioned/);assert.match(reply,/crowds tire/);
 assert.equal(contract({agent:'Astra',mode:'isolated',sharedTurns:turns}).evidence.length,0);
 assert.equal(contract({agent:'Astra',sharedTurns:[{agent:'sage',transcript:'Okay',reply:'You prefer quiet cafes.'}]}).evidence.length,0);
});
test('A directly repeated statement is not advertised as exclusive knowledge from the other agent',()=>{
 const turns=[{agent:'sage',transcript:'I prefer quiet cafes'}];
 assert.equal(contract({agent:'Astra',sharedTurns:turns,transcript:'I prefer quiet cafes'}).evidence.length,0);
 assert.equal(contract({agent:'Astra',sharedTurns:turns,history:[{role:'user',content:'I prefer quiet cafes'}]}).evidence.length,0);
});
test('A forged source or a nonexistent application cannot produce a verified attribution',()=>{
 const c=contract({agent:'Astra',mode:'isolated'});
 assert.doesNotMatch(renderResponse(out({statements:'Sage mentioned you like crowds. The park opens early.'}),c),/Sage/);
 const shared=contract({agent:'Astra',memories:[m()]});
 assert.doesNotMatch(renderResponse(out({memory_use:{id:'memory-1',application:'Invented decision not in reply.'}}),shared),/mentioned/);
});
test('Malformed JSON never leaks internal fields into speech',()=>{
 assert.equal(renderResponse('{"statements":',contract({transcript:'I prefer parks'})),'What appeals to you about parks?');
 assert.doesNotMatch(renderResponse('[{"statements":"hello"}]',contract({})),/statements/);
});
test('Isolated policy does not suppress questions using the other agent private reasons',()=>{
 assert.equal(contract({agent:'Sage',mode:'isolated',transcript:'I prefer quiet cafes',memories:[m('Astra')]}).required,true);
});

test('Companion disclosures and already-explained dislikes do not force a why question',()=>{
 assert.equal(whyRequired('Sage',"I'm traveling with my sister"),false);
 assert.equal(whyRequired('Astra','Skip museums, I find them boring'),false);
});

test('Conversational why questions keep their wording instead of becoming the generic fallback',()=>{
 const c=contract({transcript:'I prefer quiet cafes'});
 for(const question of ["How come quieter cafes appeal to you?", "What's the appeal of a quieter cafe for you?", 'What are you looking for in a cafe?', 'Does a quiet cafe connect to a trip you enjoyed?']) {
  assert.equal(renderResponse(out({statements:'A tucked-away cafe could work well.',question,ask_why:true}),c),'A tucked-away cafe could work well. '+question);
 }
 // Plain legacy model output can also use ordinary conversational motivation phrasing.
 assert.equal(renderResponse('A tucked-away cafe could work well. How come you prefer quieter spots?',c),'A tucked-away cafe could work well. How come you prefer quieter spots?');
});
test('After a why, allow useful planning replies before another motivation question',()=>{
 const history=[{role:'user',content:'I like gardens'},{role:'assistant',content:'What do you enjoy about gardens?'},{role:'user',content:'The greenery'},{role:'assistant',content:'The botanical garden has shaded paths.'}];
 const c=contract({transcript:'I like food markets too',history});
 assert.equal(c.required,false);assert.equal(c.pauseWhy,true);
 assert.equal(renderResponse(out({statements:'We could visit the market after the garden.',question:'What do you like about food markets?',ask_why:true}),c),'We could visit the market after the garden.');
 assert.equal(renderResponse(out({statements:'We could visit the market after the garden.',question:'Which day will you be in Kyoto?'}),c),'We could visit the market after the garden. Which day will you be in Kyoto?');
 history.push({role:'user',content:'Sounds good'},{role:'assistant',content:'The market and garden fit into one afternoon.'});
 assert.equal(contract({transcript:'I like boat rides',history}).required,true);
});
test('An earlier unexplained preference is not probed again after the pacing pause',()=>{
 const history=[{role:'user',content:'I prefer quiet cafes'},{role:'assistant',content:'What do you enjoy about a quieter setting?'},{role:'user',content:'Just a preference'},{role:'assistant',content:'There is a cafe near your hotel.'},{role:'user',content:'Okay'},{role:'assistant',content:'It fits before your afternoon walk.'}];
 const c=contract({transcript:'I like quiet cafes',history});
 assert.equal(c.required,false);assert.equal(c.pauseWhy,true);
 assert.equal(renderResponse(out({question:'How come you prefer quiet cafes?',ask_why:true}),c),'That works.');
});
test('Repeated questions are suppressed and fallback wording refers to the choice',()=>{
 const c=contract({transcript:'Kyoto',history:h('Which city appeals to you?')});
 assert.equal(renderResponse(out({question:'What is your budget?'}),c),'That works. What appeals to you about Kyoto?');
 const repeated=contract({history:h('Which day will you arrive?')});
 assert.equal(renderResponse(out({question:'Which day will you arrive?'}),repeated),'That works.');
});
test('Shared follow-up pacing crosses switches; isolated pacing uses only own history',()=>{
 const sharedTurns=[{agent:'sage',transcript:'I prefer gardens',reply:'What do you enjoy about gardens?'}];
 assert.equal(contract({agent:'Astra',transcript:'Skip museums',sharedTurns}).required,false);
 assert.equal(contract({agent:'Astra',transcript:'Skip museums',mode:'isolated',sharedTurns}).required,true);
});
test('Direct user questions do not force a why back at the user',()=>{
 for(const transcript of ['Why would you suggest Kyoto?','What is the best city for gardens','Can you suggest a cafe?']) assert.equal(contract({transcript,history:h('Which city would you prefer?')}).required,false);
});
test('A null question stays null even if statements accidentally contain a question',()=>{
 const c=contract({});
 assert.equal(renderResponse(out({statements:'A garden could work. Which city do you want?',question:null}),c),'A garden could work.');
});
test('The final contract explicitly tells the model to apply an answer rather than keep probing',()=>{
 const c=contract({history:h('What do you enjoy about a quieter setting?'),transcript:'I find crowds tiring'});
 assert.match(c.prompt,/PACING:/);assert.match(c.prompt,/Do NOT ask another motivation question/);
 assert.match(c.prompt,/A useful suggestion or short observation can be the entire reply/);
});

test('A statement explaining why does not turn a logistical question into a motivation question',()=>{
 const c=contract({transcript:'I like gardens',history:h("That is why I suggest staying near the station. Which day will you arrive?")});
 assert.equal(c.pauseWhy,false);
});
