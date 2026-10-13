import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { saveLogs, exportLogs, cleanTurn } from '../worker/src/logs.mjs';
import worker from '../worker/src/index.mjs';
const turn = { turn_id:'turn-1',participant_id:'participant-1',session_id:'session-1',timestamp:'2026-10-13T05:00:00Z',agent:'sage',engine:'pipeline',memory_sharing_mode:'shared',speaker:'Jenny',user_text:'I chose Kyoto.',agent_reply:'We can plan your trip.',interrupted:false };
function database() {
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../worker/migrations/0003_deleted_name_ids.sql', import.meta.url), 'utf8'));db.exec(readFileSync(new URL('../worker/migrations/0001_chat_logs.sql',import.meta.url),'utf8'));
  const prepare=sql=>({bind(...params){return {run(){return db.prepare(sql).run(...params)},async all(){return {results:db.prepare(sql).all(...params)}}}}});
  return {db,prepare,async batch(statements){return statements.map(statement=>statement.run())}};
}
const post=turns=>new Request('https://worker.test/logs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({turns})});
const admin=(key='host-only',filter='')=>new Request('https://worker.test/logs/export'+filter,{headers:{authorization:`Bearer ${key}`}});
test('database saves a transcript, prevents duplicates and updates interruption status',async()=>{
  const db=database(),env={LOG_DB:db,LOG_ADMIN_KEY:'host-only'};
  assert.equal((await saveLogs(post([turn]),env,{})).status,200);
  await saveLogs(post([turn]),env,{});await saveLogs(post([{...turn,interrupted:true}]),env,{});await saveLogs(post([turn]),env,{});
  const result=await (await exportLogs(admin(),env,{})).json();
  assert.equal(result.turns.length,1);assert.equal(result.turns[0].interrupted,true);
  assert.equal(result.turns[0].speaker,'Jenny');assert.equal(result.turns[0].agent_traits.extraversion,5);
  db.db.close();
});
test('the demo code cannot read logs and invalid payloads are rejected',async()=>{
  const db=database();const env={LOG_DB:db,LOG_ADMIN_KEY:'host-only',PUBLIC_ORIGIN:'https://example.github.io',DEMO_ACCESS_CODE:'demo-code',OPENAI_API_KEY:'fake-key',DEMO_RATE_LIMITER:{async limit(){return {success:true}}}};
  assert.equal((await worker.fetch(admin('demo-code'),env)).status,401);
  assert.equal((await saveLogs(post([{...turn,agent:'unknown'}]),env,{})).status,400);
  assert.throws(()=>cleanTurn({...turn,user_text:'x'.repeat(3501)}));
  assert.equal((await exportLogs(admin(),env,{})).status,200);db.db.close();
});
test('host export filters names case-insensitively and paginates without skipping rows',async()=>{
  const db=database(),env={LOG_DB:db,LOG_ADMIN_KEY:'host-only'};
  const insert=db.db.prepare('INSERT INTO chat_turns(turn_id,participant_id,session_id,speaker_lower,timestamp,payload,interrupted) VALUES(?,?,?,?,?,?,?)');
  for(let i=1;i<=501;i++){const item={...turn,turn_id:`t-${i}`};insert.run(item.turn_id,item.participant_id,item.session_id,'jenny',item.timestamp,JSON.stringify(item),0)}
  let data=await (await exportLogs(admin('host-only','?speaker=JENNY'),env,{})).json();assert.equal(data.turns.length,500);assert.equal(data.nextCursor,500);
  data=await (await exportLogs(admin('host-only','?speaker=jenny&cursor=500'),env,{})).json();assert.equal(data.turns.length,1);assert.equal(data.nextCursor,null);
  data=await (await exportLogs(admin('host-only','?speaker=Other'),env,{})).json();assert.equal(data.turns.length,0);db.db.close();
});
function logger(storage=new Map(),fetcher=async(_url,init)=>Response.json({saved:JSON.parse(init.body).turns.map(t=>t.turn_id)})){
  let code='';let uuid=0;const status={};
  const context={window:{addEventListener(){}},crypto:{randomUUID:()=>`uuid-${++uuid}`},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},TextEncoder,AbortController,fetch:fetcher,setTimeout:()=>1,clearTimeout(){}};
  vm.runInNewContext(readFileSync(new URL('../docs/remote-logs.js',import.meta.url),'utf8'),context);
  return {value:context.window.createRemoteLogger({base:()=> 'https://worker.test',code:()=>code,status}),status,setCode(value){code=value}};
}
test('failed uploads remain in the outbox and upload after a reload',async()=>{
  const storage=new Map(),first=logger(storage,async()=>{throw new Error('Offline')});first.value.record({...turn});first.setCode('demo');await first.value.flush();assert.equal(first.value.queue.length,1);
  const second=logger(storage);second.setCode('demo');await second.value.flush();assert.equal(second.value.queue.length,0);assert.match(second.status.textContent,/saved for the host/);
});
test('an interruption update made during upload is kept for the next upload',async()=>{
  let release;const app=logger(new Map(),()=>new Promise(resolve=>{release=resolve}));const current={...turn};app.value.record(current);app.setCode('demo');const pending=app.value.flush();
  current.interrupted=true;app.value.record(current);release(Response.json({saved:[turn.turn_id]}));await pending;
  assert.equal(app.value.queue.length,1);assert.equal(app.value.queue[0].interrupted,true);
});
