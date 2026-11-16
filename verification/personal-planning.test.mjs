import test from 'node:test';
import assert from 'node:assert/strict';
import {knownPersonalFacts,astraDiscovery,openDiscoveryQuestion,isPersonalDiscoveryQuestion} from '../worker/src/personal-planning.mjs';
import {responseContract,renderResponse} from '../worker/src/response-policy.mjs';
const own=(fact,reason=null,source='Astra')=>({fact,reason,type:'preference',learned_by:source});
const base={agent:'Astra',mode:'shared',tripChoices:{cities:['Kyoto']}};
const c=options=>responseContract({...base,...options});
const out=(question,statements='We can build the day around your garden visit.')=>JSON.stringify({statements,question,ask_why:false,memory_use:null});
const u=content=>({role:'user',content});const a=content=>({role:'assistant',content});

test('Both agents receive their own personal facts as well as genuinely shared facts',()=>{
 for(const agent of ['Sage','Astra']) {
  const other=agent==='Sage'?'Astra':'Sage';
  const facts=knownPersonalFacts({agent,mode:'shared',memories:[own('Prefers quiet cafes','Crowds feel tiring',agent),own('Prefers short walks',null,other)]});
  assert.equal(facts.length,2);assert.ok(facts.some(f=>f.source===agent && f.reason==='Crowds feel tiring'));assert.ok(facts.some(f=>f.source===other));
 }
});
test('Personal fact context respects Separate mode and excludes itinerary records',()=>{
 const facts=knownPersonalFacts({agent:'Astra',mode:'isolated',memories:[own('Prefers quiet cafes',null,'Sage'),own('Likes riverside walks'),{fact:'Kyoto on day 2',type:'trip_detail',learned_by:'Astra'}],sharedTurns:[{agent:'sage',transcript:'I dislike museums'}],history:[u('I enjoy food markets')]});
 assert.deepEqual(facts.map(f=>f.fact),['I enjoy food markets','Likes riverside walks']);
});
test('Recent user disclosures count before extraction, while assistant suggestions and questions do not',()=>{
 const facts=knownPersonalFacts({agent:'Astra',mode:'shared',history:[u('I like relaxed mornings'),a('You prefer expensive hotels')],sharedTurns:[{agent:'sage',transcript:'I hate crowds. What can we visit?',reply:'You need short walks.'},{agent:'sage',transcript:'Do I enjoy museums?',reply:'Yes'}],transcript:'I prefer short walks'});
 assert.equal(facts[0].fact,'I prefer short walks');
 assert.ok(facts.some(f=>f.fact==='I hate crowds.'));
 assert.ok(!facts.some(f=>/expensive hotels|need short walks|Do I enjoy/.test(f.fact)));
});
test('Astra proactively asks about comfortable pace when an actual trip is known',()=>{
 const contract=c({greeting:true});
 assert.equal(contract.discovery.topic,'pace');
 const reply=renderResponse(out('What is your budget?'),contract);
 assert.equal(reply,'We can build the day around your garden visit. What does a comfortable day of sightseeing look like for you?');
 assert.equal((reply.match(/\?/g)||[]).length,1);
 assert.equal(responseContract({agent:'Sage',mode:'shared',greeting:true,tripChoices:base.tripChoices}).discovery,null);
});
test('Astra can ask about lodging, transport and spending during ordinary planning without rejection',()=>{
 for(const [transcript,topic] of [['I am thinking about hotels','lodging'],['A train between the cities sounds good','transport'],['My budget is 1000 dollars','spending']]) {
  const contract=c({transcript});assert.equal(contract.required,false);assert.equal(contract.discovery.topic,topic);
  const reply=renderResponse(out('Does that work for you?'),contract);
  assert.match(reply,topic==='lodging'?/What helps you feel comfortable/:topic==='transport'?/What tends to make travel/:/What would you most want/);
 }
});
test('An exact budget is not treated as an already-known spending priority',()=>{
 const contract=c({transcript:'1000 dollars',history:[a('What is your budget?')],memories:[{fact:'Budget is 1000 dollars',type:'constraint',learned_by:'Astra'}]});
 assert.equal(contract.discovery.topic,'spending');
 const known=c({transcript:'Okay',history:[a('Your budget covers the planned costs.')],memories:[own('Prefers to spend more on food')]});
 assert.equal(known.discovery,null);
});
test('Answered personal topics are applied rather than asked again',()=>{
 for(const [fact,transcript] of [['Prefers a relaxed pace with breaks','Okay'],['Needs a quiet hotel room','Hotels sound good'],['Prefers trains to avoid airport transfers','A train sounds good']]) {
  const contract=c({transcript,memories:[own(fact)]});assert.equal(contract.discovery,null,fact);
  assert.ok(contract.prompt.includes(fact));
 }
});
test('After an open-ended practical question, give useful planning replies before another personal question',()=>{
 const history=[a('What does a comfortable day of sightseeing look like for you?'),u('A relaxed morning and one main activity')];
 const contract=c({transcript:'I am thinking about hotels',history});
 assert.equal(contract.pauseWhy,true);assert.equal(contract.discovery,null);
 assert.equal(renderResponse(out("What helps you feel comfortable in a place you're staying?",'We can keep the morning free and visit the garden after lunch.'),contract),'We can keep the morning free and visit the garden after lunch.');
});
test('An unanswered discovery question is not revisited after the cooldown expires',()=>{
 const history=[a('What does a comfortable day of sightseeing look like for you?'),u('Not sure'),a('We can start with one garden visit.'),u('Okay'),a('The riverside walk is nearby.')];
 assert.equal(c({transcript:'Okay',history}).discovery,null);
});
test('Natural open-ended alternatives are preserved but binary and stacked questions are replaced',()=>{
 const contract=c({greeting:true});
 const question='How do you like to pace a day of sightseeing?';
 assert.equal(openDiscoveryQuestion(question,'pace'),true);
 assert.equal(renderResponse(out(question),contract),'We can build the day around your garden visit. '+question);
 for(const question of ['Do you like relaxed days?','What is your budget?','How do you like to pace sightseeing and what is your budget?']) {
  const reply=renderResponse(out(question),contract);assert.match(reply,/What does a comfortable day/);assert.equal((reply.match(/\?/g)||[]).length,1);
 }
});
test('Direct requests, declines, approvals and sensitive causes do not trigger personal discovery',()=>{
 for(const transcript of ['What time does the museum open?','Please suggest a hotel','I would rather not answer','Just proceed','No more questions','Looks good','I approve the plan','I have a medical diagnosis']) assert.equal(c({transcript}).discovery,null,transcript);
 assert.equal(c({tripChoices:{cities:['Kyoto'],finalized:true},transcript:'Okay'}).discovery,null);
 assert.equal(responseContract({agent:'Astra',mode:'isolated',transcript:'Hi'}).discovery,null);
});
test('A changed suggestion gets one why, not a separate discovery question too',()=>{
 const contract=c({transcript:'No museums on day 2'});assert.equal(contract.required,true);assert.equal(contract.discovery,null);
 const reply=renderResponse(out('What is your budget?'),contract);assert.match(reply,/What puts you off museums/);assert.equal((reply.match(/\?/g)||[]).length,1);
});
test('Only known and allowed facts are supplied to the final application rules',()=>{
 const contract=c({mode:'isolated',memories:[own('Dislikes crowds',null,'Sage'),own('Prefers short walks')]});
 assert.match(contract.prompt,/Use personal facts to change decisions/);
 assert.match(contract.prompt,/shorter walk/);assert.match(contract.prompt,/Prefers short walks/);
 assert.doesNotMatch(contract.prompt,/Dislikes crowds/);
 assert.match(contract.prompt,/Quiet settings do not automatically imply slow pacing/);
});
test('Numeric and destination questions do not masquerade as personal discovery',()=>{
 for(const question of ['What is your budget?','How many days would you like?','What activity would you enjoy?','Which city would you prefer?']) assert.equal(isPersonalDiscoveryQuestion(question),false,question);
 for(const question of ['What matters most to you in a hotel?','What would you most want to make room for in the trip budget?']) assert.equal(isPersonalDiscoveryQuestion(question),true,question);
});
