import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename } from 'node:path';
import { webcrypto } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const text = p => readFileSync(resolve(root, p), 'utf8');
const plain = v => JSON.parse(JSON.stringify(v));
async function worker(file, fetch = async () => { throw new Error('No live network in tests'); }) {
  const context = vm.createContext({ Response, Request, FormData, Blob, AbortSignal, crypto: webcrypto, console, fetch });
  const cache = new Map();
  function get(path) {
    path = resolve(path);
    if (cache.has(path)) return cache.get(path);
    let mod;
    if (!existsSync(path) && basename(path) === 'chat-options.mjs') {
      // Older patch archives omit this unchanged installed dependency.
      mod = new vm.SyntheticModule(['chatOptions'], function() { this.setExport('chatOptions', model => ({ model })); }, { context, identifier: path });
    } else if (path.endsWith('.json')) {
      const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
      mod = new vm.SyntheticModule(['default'], function() { this.setExport('default', data); }, { context, identifier: path });
    } else mod = new vm.SourceTextModule(readFileSync(path, 'utf8'), { context, identifier: path });
    cache.set(path, mod); return mod;
  }
  const mod = get(resolve(root, 'worker/src', file));
  await mod.link((spec, parent) => get(resolve(dirname(parent.identifier), spec)));
  await mod.evaluate(); return mod.namespace;
}
function browser(files, extra = {}) {
  const stored = new Map();
  const window = { addEventListener() {}, ...extra.window };
  const localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  const context = vm.createContext({ window, localStorage, crypto: webcrypto, console, AbortController, setTimeout, clearTimeout, fetch: extra.fetch });
  for (const file of files) vm.runInContext(text(file), context);
  return { window, stored, context };
}
const record = { fact: 'Prefers quiet cafes', type: 'preference', reason: 'Crowds feel tiring' };

test('Sage and Astra extraction returns typed facts, stated reasons, and server-owned source', async () => {
  for (const agent of ['Sage', 'Astra']) {
    let request;
    const m = await worker('memory.mjs', async (_url, init) => {
      request = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ memories: [{ ...record, learned_by: 'someone else' }] }) } }] });
    });
    const result = await m.extractMemories({}, agent, 'p1', 'Quiet cafes, because crowds tire me out.', 'Understood.');
    assert.equal(result.memories[0].type, 'preference');
    assert.equal(result.memories[0].reason, record.reason);
    assert.equal(result.memories[0].learned_by, agent);
    assert.match(request.messages[0].content, /Both agents learn personal facts/);
    assert.match(request.messages[0].content, /reason when given; use null/);
    assert.match(request.messages[0].content, /not contact details/);
  }
});
test('Unknown reasons stay null; NONE, empty extraction and legacy summaries are supported', async () => {
  for (const [content, expected] of [
    [JSON.stringify({memories:[{fact:'Travels with a sister',type:'travel_companion',reason:null}]}),1],
    ['NONE',0],[JSON.stringify({memories:[]}),0],['Enjoys parks',1],
  ]) {
    const m = await worker('memory.mjs', async () => Response.json({choices:[{message:{content}}]}));
    const result = await m.extractMemories({}, 'Astra', 'p1', 'I travel with my sister.', 'Okay.');
    assert.equal(result.memories.length, expected);
    for (const entry of result.memories) assert.equal(entry.reason, null);
  }
});
test('Malformed memory JSON stays retryable; unknown speakers cause no model request', async () => {
  let calls=0;
  const m=await worker('memory.mjs', async()=>{calls++;return Response.json({choices:[{message:{content:'{"memories":'}}]});});
  await assert.rejects(m.extractMemories({},'Sage','p1','hi','hi',[],true));
  const result=await m.memoryTurn(new Request('https://example.test/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent:'sage',speaker:'p1',userText:'hi',reply:'hi'})}),{},{});
  assert.equal(result.status,503);
  await m.extractMemories({},'Sage',' Unknown ','hi','hi');assert.equal(calls,2);
});
test('Profile save preserves type/reason in all buckets and reads legacy strings', async () => {
  const p=await worker('profiles.mjs');
  const profile=p.cleanProfile({notes:'',memories:{shared:[{...record,learned_by:'Astra'}],sage:[record,'Likes parks'],astra:[{...record,learned_by:'Sage'}]}});
  assert.equal(profile.memories.shared[0].learned_by,'Astra');
  assert.equal(profile.memories.sage[0].reason,record.reason);
  assert.equal(profile.memories.sage[1],'Likes parks');
  assert.equal(profile.memories.astra[0].learned_by,'Astra');
});
test('Shared memory flows in both directions, while separate buckets stay isolated', () => {
  const {window}=browser(['docs/memory.js']);const m=window.AgentMemory;
  m.remember('p1','shared','sage',record);
  m.remember('p1','shared','astra',{fact:'Avoids long drives',type:'constraint',reason:'Wants more time outdoors'});
  assert.match(m.context('p1','shared','astra'),/learned by Sage/);
  assert.match(m.context('p1','shared','sage'),/learned by Astra/);
  m.remember('p2','isolated','astra',record);
  assert.equal(m.entries('p2','isolated','sage').length,0);
  assert.doesNotMatch(m.context('p2','isolated','sage'),/Prefers quiet cafes/);
  const snapshot=plain(m.snapshot('p1'));
  m.restore('p1',snapshot);
  assert.equal(m.entries('p1','shared','sage')[0].reason,record.reason);
});
test('Source mentions require a real personal memory and the other agent as source', async () => {
  const p=await worker('personal-memory.mjs');
  const incoming=[{...record,learned_by:'Sage'}];
  assert.match(p.memoryAttributionContext(incoming,'Astra','shared'),/Sage mentioned/);
  assert.match(p.memoryAttributionContext([{...record,learned_by:'Astra'}],'Sage','shared'),/Astra mentioned/);
  for(const [entries,mode] of [[incoming,'isolated'],[[{...record,type:'trip_detail',learned_by:'Sage'}],'shared'],[[...incoming,{...record,learned_by:'Astra'}],'shared']])
    assert.match(p.memoryAttributionContext(entries,'Astra',mode),/Do not say the other agent told you/);
});
test('Isolated worker context filters cross-agent records; public notes do not expose reasons', async () => {
  const m=await worker('memory.mjs');
  assert.doesNotMatch(m.memoryContext('p1',[{...record,learned_by:'Sage'}],'Astra','isolated'),/Crowds feel tiring/);
  const note=m.checklistContext({countries:['Japan'],cities:['Kyoto'],cityActivities:{Kyoto:'Visit a garden because crowds feel tiring'},budget:null,itinerary:null});
  assert.match(note,/Visit a garden/);assert.doesNotMatch(note,/crowds feel tiring/);
});
test('Durable background queue retains structured fields, source, and legacy fallback', async () => {
  for(const structured of [true,false]) {
    const seen=[];
    const {window}=browser(['docs/memory-work.js'],{fetch:async()=>Response.json({fact:'Prefers quiet cafes',...(structured?{memories:[record]}:{})})});
    const q=window.createMemoryWorkQueue({base:()=> 'https://worker.test',code:()=> 'test',remember:(...args)=>{seen.push(args);return true;}});
    q.activate('p1',0);
    await q.enqueue({agent:'astra',speaker:'p1',mode:'shared',transcript:'Quiet cafes',reply:'Okay'},[],0);
    await q.flush();assert.equal(q.pendingCount(),0);
    assert.equal(seen[0][2],'astra');
    if(structured)assert.equal(seen[0][3][0].reason,record.reason);else assert.equal(typeof seen[0][3],'string');
  }
});
test('Deleting a trip discards pending personal memories rather than restoring them', async () => {
  const seen=[];let release;
  const response=new Promise(resolve=>{release=resolve;});
  const {window}=browser(['docs/memory-work.js'],{fetch:()=>response});
  const q=window.createMemoryWorkQueue({base:()=> 'https://worker.test',code:()=> 'test',remember:(...args)=>{seen.push(args);return true;}});
  q.activate('p1',0);
  const task=q.enqueue({agent:'sage',speaker:'p1',mode:'shared',transcript:'Quiet cafes',reply:'Okay'},[],0);
  await new Promise(resolve=>setImmediate(resolve));q.invalidate('p1');
  release(Response.json({fact:record.fact,memories:[record]}));await task;
  assert.equal(seen.length,0);assert.equal(q.pendingCount(),0);
});
test('Pipeline receives current follow-up rules and returns typed memories for either agent', async () => {
  for(const agent of ['sage','astra']) {
    const requests=[];
    const p=await worker('pipeline.mjs',async (_url,init)=>{
      const body=JSON.parse(init.body);requests.push(body);
      return Response.json({choices:[{message:{content:body.messages[0].content.includes('You extract memories')?JSON.stringify({memories:[record]}):'Got it. What makes that appealing to you?'}}]});
    });
    const form=new FormData();form.set('agent',agent);form.set('speaker','p1');form.set('text','I prefer quiet cafes');form.set('reply_audio','false');form.set('memory_mode','shared');
    form.set('memories',JSON.stringify([{...record,learned_by:agent==='sage'?'Astra':'Sage'}]));
    const response=await p.pipelineTurn(new Request('https://worker.test/turn',{method:'POST',body:form}),{OPENAI_API_KEY:'test'},{});
    assert.equal(response.status,200);const result=await response.json();
    assert.equal(result.memories[0].type,'preference');assert.equal(result.memories[0].learned_by,agent==='sage'?'Sage':'Astra');
    const prompt=requests[0].messages[0].content;
    assert.match(prompt,/at most ONE question/);assert.match(prompt,/Never stack questions/);
    assert.match(prompt,agent==='sage'?/What is it about quiet places/:/What made you want to skip/);
    assert.match(requests[0].messages.map(m=>m.content).join('\n'),/Source|Personal facts actually learned/);
  }
});
test('Pipeline still checks the saved memory assignment', async () => {
  const p=await worker('pipeline.mjs');const form=new FormData();
  for(const [key,value] of Object.entries({agent:'astra',speaker:'p1',text:'hello',memory_mode:'shared'}))form.set(key,value);
  const env={LOG_DB:{prepare:()=>({bind:()=>({first:async()=>({mode:'isolated'})})})}};
  assert.equal((await p.pipelineTurn(new Request('https://worker.test/turn',{method:'POST',body:form}),env,{})).status,409);
});
function formFixture() {
  let next=1;const items=[],props=new Map();
  const form={getItems:type=>type?items.filter(i=>i.type===type):[...items],getItemById:id=>items.find(i=>i.id===id),
    addMultipleChoiceItem:()=>add('MULTIPLE_CHOICE'),addParagraphTextItem:()=>add('PARAGRAPH_TEXT'),
    moveItem:(from,to)=>{const [item]=items.splice(from,1);items.splice(to,0,item);},setShuffleQuestions:value=>{form.shuffle=value;}};
  function add(type,title='') {
    const item={type,id:next++,title,getType(){return this.type;},getTitle(){return this.title;},getId(){return this.id;},getIndex(){return items.indexOf(this);},asMultipleChoiceItem(){return this;},asParagraphTextItem(){return this;},
      setTitle(v){this.title=v;return this;},setChoiceValues(v){this.choices=v;return this;},setHelpText(v){this.help=v;return this;},setRequired(v){this.required=v;return this;}};
    items.push(item);return item;
  }
  add('TEXT','Survey code');add('MULTIPLE_CHOICE','Existing engagement item');
  const context=vm.createContext({FormApp:{getActiveForm:()=>form,ItemType:{MULTIPLE_CHOICE:'MULTIPLE_CHOICE',PARAGRAPH_TEXT:'PARAGRAPH_TEXT'}},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k),setProperty:(k,v)=>props.set(k,v)})},console});
  vm.runInContext(text('google-form/Code.gs'),context);return {context,items,props,form};
}
test('Awareness installer adds identical neutral questions to both forms and is idempotent',()=>{
  const a=formFixture(),b=formFixture();
  for(const x of [a,b]) {x.context.installSharingAwarenessQuestions();x.context.installSharingAwarenessQuestions();assert.equal(x.items.length,6);assert.equal(x.items[0].title,'Survey code');assert.equal(x.items[1].title,'Existing engagement item');assert.equal(x.form.shuffle,false);}
  assert.deepEqual(plain(a.items.map(({title,choices,help,required})=>({title,choices,help,required}))),plain(b.items.map(({title,choices,help,required})=>({title,choices,help,required}))));
  assert.deepEqual(plain(a.items[2].choices),['Yes','No','Not sure']);
  assert.match(a.items[3].title,/What, if anything/);assert.match(a.items[4].choices.join('|'),/Both directions/);
  assert.match(a.items[5].title,/say it learned/);
  assert.doesNotMatch(a.items.slice(2).map(i=>i.title).join(' '),/assigned|shared condition|separate condition/);
});
test('Pipeline and realtime personas both include the same one-question and privacy rules',()=>{
  for(const [name,key] of [['pipeline_agents.json','prompt'],['agents.json','instructions']]) {
    const agents=JSON.parse(text('worker/src/'+name));
    for(const agent of ['sage','astra']) {
      assert.match(agents[agent][key],/at most ONE question/);assert.match(agents[agent][key],/Different relevant facts may be acknowledged on consecutive replies/i);
      assert.match(agents[agent][key],/Never ask for medical diagnoses/);
      assert.match(agents[agent][key],/Reasons are unknown unless the user supplied them/);
    }
  }
});

test('Cloud recovery saves metadata-only changes instead of dropping reasons', async () => {
  const remote={notes:'',choices:{countries:[],cities:[],activities:[]},memories:{shared:[{...record,learned_by:'Astra',reason:null}],sage:[],astra:[],recentShared:[]}};
  const pending=plain(remote);pending.memories.shared[0].reason=record.reason;
  const saved=[];let applied;
  const {window,stored}=browser(['docs/cloud.js'],{fetch:async(_url,init)=>{
    const body=JSON.parse(init.body);
    if(body.action==='load')return Response.json({profile:remote,version:1,generation:0,memoryMode:'shared',chatTurns:[]});
    assert.equal(body.action,'save');saved.push(body.profile);return Response.json({version:2});
  }});
  stored.set('sage-astra-cloud-work-v1',JSON.stringify({[JSON.stringify(['https://worker.test','p1'])]:{version:1,generation:0,profile:pending}}));
  const cloud=window.createTripCloud({base:()=> 'https://worker.test',code:()=> 'test',status:{textContent:''},snapshot:()=>pending,apply:(_name,profile)=>{applied=profile;}});
  await cloud.load('p1');
  assert.equal(saved.length,1);assert.equal(saved[0].memories.shared[0].reason,record.reason);assert.equal(applied.memories.shared[0].reason,record.reason);
});

test('Pipeline enforces why instead of the mocked model logistics question for both agents', async()=>{
  for(const [agent,input] of [['sage','I prefer quiet gardens'],['astra','No museums on day 2']]) {
    let request;
    const p=await worker('pipeline.mjs',async(_url,init)=>{
      request=JSON.parse(init.body);
      return Response.json({choices:[{message:{content:JSON.stringify({statements:'Got it.',question:'What is your budget?',ask_why:false,memory_use:null})}}]});
    });
    const form=new FormData();
    for(const [key,value] of Object.entries({agent,speaker:'p1',text:input,memory_mode:'shared',defer_memory:'true',reply_audio:'false'})) form.set(key,value);
    const response=await p.pipelineTurn(new Request('https://worker.test/turn',{method:'POST',body:form}),{OPENAI_API_KEY:'test'},{});
    assert.equal(response.status,200);const result=await response.json();
    assert.match(result.reply,agent==='sage'?/(?:What do you enjoy|What makes a quiet spot|What appeals to you about spending time somewhere quiet)/:/(?:What puts you off|What isn't working for you about including museums|What would you prefer to avoid about a museum visit)/);assert.doesNotMatch(result.reply,/budget/);
    assert.equal(result.agent_version,'travel-personal-memory-v16');
    assert.equal(request.response_format.type,'json_object');assert.match(request.messages.at(-1).content,/THIS TURN REQUIRES/);
  }
});
test('Pipeline attributes relevant unextracted user disclosures in both directions, including switch openings, only in Shared mode', async()=>{
  for(const agent of ['sage','astra']) for(const mode of ['shared','isolated']) for(const greeting of [false,true]) {
    const other=agent==='sage'?'astra':'sage';
    const application='I would choose a quieter cafe on a side street.';
    let modelRequest;
    const p=await worker('pipeline.mjs',async(_url,init)=>{
      modelRequest=JSON.parse(init.body);
      return Response.json({choices:[{message:{content:JSON.stringify({statements:application,question:null,memory_use:{id:'memory-1',application}})}}]});
    });
    const form=new FormData();
    for(const [key,value] of Object.entries({agent,speaker:'p1',memory_mode:mode,reply_audio:'false',defer_memory:'true',shared_turns:JSON.stringify([{agent:other,transcript:'I prefer quiet cafes because crowds tire me out.',reply:'Understood.'}])})) form.set(key,value);
    if(greeting) form.set('greeting','true');else form.set('text','Can you suggest a cafe?');
    const response=await p.pipelineTurn(new Request('https://worker.test/turn',{method:'POST',body:form}),{OPENAI_API_KEY:'test'},{});
    assert.equal(response.status,200);const result=await response.json();
    if(mode==='shared') {assert.match(result.reply,new RegExp(other==='sage'?'Sage mentioned':'Astra mentioned'));assert.match(result.reply,/side street/);}
    else {assert.doesNotMatch(result.reply,/mentioned/);assert.doesNotMatch(modelRequest.messages.map(m=>m.content).join('\n'),/crowds tire me out/);}
    assert.doesNotMatch(result.reply,/memory_use|memory-1|statements/);
  }
});
test('Voices, personality values, and completion requirements remain intact',()=>{
 const pipeline=JSON.parse(text('worker/src/pipeline_agents.json'));
 const realtime=JSON.parse(text('worker/src/agents.json'));
 for(const [name,voice,traits] of [['sage','marin',{openness:4,conscientiousness:3,extraversion:5,agreeableness:5,neuroticism:2}],['astra','cedar',{openness:3,conscientiousness:4,extraversion:2,agreeableness:3,neuroticism:1}]]) {
  for(const agents of [pipeline,realtime]) {assert.equal(agents[name].voice,voice);assert.deepEqual(agents[name].traits,traits);}
  assert.match(pipeline[name].prompt,/at least one country, two cities/);
  assert.match(pipeline[name].prompt,/explicitly approve the complete itinerary/);
  assert.doesNotMatch(pipeline[name].prompt,/Limit preference exploration to the initial question|never in consecutive replies/);
 }
});

test('Astra pipeline openings ask an open-ended practical preference when a real trip is supplied',async()=>{
 for(const memory_mode of ['shared','isolated']) {
  let prompt;
  const p=await worker('pipeline.mjs',async(_url,init)=>{
   prompt=JSON.parse(init.body).messages.at(-1).content;
   return Response.json({choices:[{message:{content:JSON.stringify({statements:'We can arrange your Kyoto visit.',question:'What is your budget?',ask_why:false,memory_use:null})}}]});
  });
  const form=new FormData();
  for(const [key,value] of Object.entries({agent:'astra',speaker:'p1',greeting:'true',memory_mode,reply_audio:'false',trip_choices:JSON.stringify({countries:['Japan'],cities:['Kyoto'],cityActivities:{Kyoto:'Visit a garden'}})}))form.set(key,value);
  const response=await p.pipelineTurn(new Request('https://worker.test/turn',{method:'POST',body:form}),{OPENAI_API_KEY:'test'},{});
  assert.equal(response.status,200);const result=await response.json();
  assert.match(prompt,/ASTRA OPEN-ENDED PLANNING OPPORTUNITY/);assert.match(result.reply,/(?:What does a comfortable day of sightseeing look like for you|How do you like to pace a day of sightseeing|What would make a day of sightseeing feel comfortable for you)\?/);assert.doesNotMatch(result.reply,/budget/);
 }
});
test('Own-source facts and reasons reach both agents final personalization instructions',async()=>{
 for(const agent of ['sage','astra']) {
  let prompt;
  const p=await worker('pipeline.mjs',async(_url,init)=>{
   prompt=JSON.parse(init.body).messages.at(-1).content;
   return Response.json({choices:[{message:{content:JSON.stringify({statements:"I'd put the cafe on a quiet side street to avoid crowds.",question:null,ask_why:false,memory_use:null})}}]});
  });
  const form=new FormData();
  for(const [key,value] of Object.entries({agent,speaker:'p1',text:'Can you suggest a cafe?',memory_mode:'isolated',reply_audio:'false',defer_memory:'true',memories:JSON.stringify([{...record,learned_by:agent==='sage'?'Sage':'Astra'}])}))form.set(key,value);
  const response=await p.pipelineTurn(new Request('https://worker.test/turn',{method:'POST',body:form}),{OPENAI_API_KEY:'test'},{});
  assert.equal(response.status,200);const result=await response.json();
  assert.match(prompt,/Prefers quiet cafes/);assert.match(prompt,/Crowds feel tiring/);assert.match(prompt,/Use personal facts to change decisions/);
  assert.match(result.reply,/quiet side street/);assert.doesNotMatch(result.reply,/Sage mentioned|Astra mentioned/);
 }
});

test('The reported games reply does not stall through the actual pipeline handler',async()=>{
 for(const memory_mode of ['shared','isolated']) {
  const p=await worker('pipeline.mjs',async()=>Response.json({choices:[{message:{content:JSON.stringify({statements:'Games could be a fun starting point for your trip!',question:null,ask_why:false,memory_use:null})}}]}));
  const form=new FormData();
  const history=[{role:'assistant',content:'Hi, I’m Sage! Let’s find a trip you’re excited about. I can use your interests to suggest experiences that fit you. What do you enjoy doing when you have a free afternoon?'}];
  for(const [key,value] of Object.entries({agent:'sage',speaker:'testing 2',text:'i like playing games',memory_mode,reply_audio:'false',defer_memory:'true',history:JSON.stringify(history)}))form.set(key,value);
  const response=await p.pipelineTurn(new Request('https://worker.test/turn',{method:'POST',body:form}),{OPENAI_API_KEY:'test'},{});
  assert.equal(response.status,200);const result=await response.json();
  assert.match(result.reply,/^Games could be a fun starting point for your trip!/);assert.match(result.reply,/(?:What kinds of games do you enjoy|What games do you find yourself coming back to|Which games do you most enjoy playing|What's a game you really enjoy playing)\?$/);assert.equal((result.reply.match(/\?/g)||[]).length,1);
 }
});

test('The real pipeline replaces redundant Japan motivation with missing hobby detail',async()=>{
 const history=[{role:'assistant',content:'What do you most enjoy doing in your free time?'},{role:'user',content:'i like to play games'},{role:'assistant',content:'What country do you have in mind for this trip?'},{role:'user',content:'do you have any suggestions'},{role:'assistant',content:'Japan could be a fun fit for your interest in games—Tokyo’s Akihabara neighborhood has arcades and gaming shops. If you prefer tabletop games, Germany’s Berlin has board-game cafés worth exploring. Which destination catches your interest?'}];
 for(const memory_mode of ['shared','isolated']) {
  const p=await worker('pipeline.mjs',async()=>Response.json({choices:[{message:{content:JSON.stringify({statements:'Japan it is!',question:'What appeals to you most about visiting Japan?',ask_why:true,memory_use:null})}}]}));
  const form=new FormData();
  for(const [key,value] of Object.entries({agent:'sage',speaker:'testing 2',text:'japan',memory_mode,reply_audio:'false',defer_memory:'true',history:JSON.stringify(history)}))form.set(key,value);
  const response=await p.pipelineTurn(new Request('https://worker.test/turn',{method:'POST',body:form}),{OPENAI_API_KEY:'test'},{});
  assert.equal(response.status,200);const result=await response.json();
  assert.doesNotMatch(result.reply,/appeals|Why Japan/);assert.match(result.reply,/games?|playing/i);assert.equal((result.reply.match(/\?/g)||[]).length,1);
 }
});

test('Pipeline source questions cannot render condition details or stack a follow-up',async()=>{
 const p=await worker('pipeline.mjs',async()=>Response.json({choices:[{message:{content:JSON.stringify({statements:'You are in the shared memory condition. The database stores extracted facts.',question:'Why do you ask?',ask_why:true})}}]}));
 const form=new FormData();
 for(const [key,value] of Object.entries({agent:'astra',speaker:'testing 2',text:'how did u know what i told sage',memory_mode:'shared',reply_audio:'false',defer_memory:'true',memories:JSON.stringify([{fact:'Prefers quiet cafes',type:'preference',learned_by:'Sage'}])}))form.set(key,value);
 const response=await p.pipelineTurn(new Request('https://worker.test/turn',{method:'POST',body:form}),{OPENAI_API_KEY:'test'},{});
 assert.equal(response.status,200);assert.equal((await response.json()).reply,'Sage and I are working together to help plan your trip.');
});

test('Pipeline applies the same Sage/Astra fact twice without re-announcing its source',async()=>{
 const fact='Prioritizes spending the trip budget on food and gifts';
 const application='A snack stop at Jidong Market could fit well.';
 const p=await worker('pipeline.mjs',async()=>Response.json({choices:[{message:{content:JSON.stringify({statements:application,question:'How does that sound?',memory_use:{id:'memory-1',application}})}}]}));
 const form=new FormData();
 const history=[{role:'assistant',content:'Astra shared this detail about you, "'+fact+'". Suwon could fit your priorities. How does Suwon sound?'},{role:'user',content:'yes'}];
 for(const [key,value] of Object.entries({agent:'sage',speaker:'testing 2',text:'yes',memory_mode:'shared',reply_audio:'false',defer_memory:'true',memories:JSON.stringify([{fact,type:'preference',learned_by:'Astra'}]),history:JSON.stringify(history)}))form.set(key,value);
 const response=await p.pipelineTurn(new Request('https://worker.test/turn',{method:'POST',body:form}),{OPENAI_API_KEY:'test'},{});
 assert.equal(response.status,200);const reply=(await response.json()).reply;
 assert.match(reply,/Jidong Market/);assert.doesNotMatch(reply,/Astra|Prioritizes|mentioned|shared/);
});

test('Both pipeline agents receive cross-agent facts for concrete adaptation while recent source wording is suppressed',async()=>{
 for(const agent of ['sage','astra']) {
  const other=agent==='sage'?'Astra':'Sage';
  const fact=agent==='sage'?'Prioritizes spending the trip budget on food and gifts':'Enjoys playing games';
  const application=agent==='sage'?'A snack stop at Jidong Market could fit well.':'I would leave a flexible arcade stop in the afternoon.';
  let prompt;
  const p=await worker('pipeline.mjs',async(_url,init)=>{prompt=JSON.parse(init.body).messages.at(-1).content;return Response.json({choices:[{message:{content:JSON.stringify({statements:application,question:null,shared_fact_check:'use_relevant_fact',memory_use:{id:'memory-1',application}})}}]});});
  const form=new FormData();
  const history=[{role:'assistant',content:other+' shared this detail about you, "'+fact+'". We can use it in the plan.'},{role:'user',content:'yes'}];
  for(const [key,value] of Object.entries({agent,speaker:'testing 2',text:'Can you suggest the next activity?',memory_mode:'shared',reply_audio:'false',defer_memory:'true',memories:JSON.stringify([{fact,type:'preference',learned_by:other}]),history:JSON.stringify(history)}))form.set(key,value);
  const response=await p.pipelineTurn(new Request('https://worker.test/turn',{method:'POST',body:form}),{OPENAI_API_KEY:'test'},{});
  assert.equal(response.status,200);const reply=(await response.json()).reply;
  assert.match(prompt,/SHARED-FACT REVIEW BEFORE WRITING/);assert.ok(prompt.includes(fact));
  assert.equal(reply,application);assert.doesNotMatch(reply,/shared this detail|mentioned|shared_fact_check/);
 }
});
