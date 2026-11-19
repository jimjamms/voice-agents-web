import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {responseContract,renderResponse} from '../worker/src/response-policy.mjs';
const a=content=>({role:'assistant',content});
const memory=source=>({fact:'Prefers quiet cafes',type:'preference',reason:'Crowds feel tiring',learned_by:source});
const c=(agent='Astra',options={})=>responseContract({agent,mode:'shared',transcript:agent==='Astra'?'How did you know what I told Sage?':'How did you know what I told Astra?',history:[],memories:[memory(agent==='Astra'?'Sage':'Astra')],...options});
test('Both agents answer conversational source questions with supported team framing',()=>{
 for(const agent of ['Sage','Astra']) {
  const contract=c(agent);const other=agent==='Sage'?'Astra':'Sage';
  assert.equal(renderResponse(JSON.stringify({statements:'You are in the shared memory condition. A database transfers your saved facts.',question:'Why do you ask?'}),contract),`${other} and I are working together to help plan your trip.`);
 }
});
test('Common source-question wording and a follow-up without the name get the brief reply',()=>{
 for(const transcript of ['How did u know what I told Sage','Where did you hear what I said to Sage?','Did Sage tell you that?','How do you know that?']) {
  const contract=c('Astra',{transcript,history:[a('Sage mentioned that you prefer quiet cafes.')]});
  assert.equal(renderResponse('backend mechanics',contract),'Sage and I are working together to help plan your trip.');
 }
});
test('Separate mode does not turn team language into a claim of private chat access',()=>{
 const contract=c('Astra',{mode:'isolated',history:[a('Sage mentioned that you prefer quiet cafes.')]});
 assert.match(contract.sourceReply,/shouldn't have implied/);assert.doesNotMatch(contract.sourceReply,/condition|database|experiment|working together/);
 const unknown=c('Astra',{mode:'isolated'});assert.match(unknown.sourceReply,/trip notes/);assert.doesNotMatch(unknown.sourceReply,/Sage told me|Sage mentioned/);
});
test('Source handling does not intercept normal planning, recall, or privacy actions',()=>{
 for(const transcript of ['How do I get to the museum?','What did I tell Sage?','Delete what I told Sage','What is your privacy policy?','Export what I told Sage']) assert.equal(c('Astra',{transcript}).sourceReply,null,transcript);
});
test('Sage still names Astra when a relevant supplied fact informs an actual suggestion',()=>{
 const contract=c('Sage',{transcript:'Can you suggest a cafe?'});
 const application="I'd choose a cafe on a quieter side street.";
 const reply=renderResponse(JSON.stringify({statements:application,question:null,memory_use:{id:contract.evidence[0].id,application}}),contract);
 assert.match(reply,/Astra mentioned that you prefer quiet cafes/);assert.match(reply,/quieter side street/);
});
function formatter() {
 class Node {
  constructor(doc,tag='',text=''){this.ownerDocument=doc;this.tagName=tag;this.children=[];this.data=text;}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=[...items];this.data='';}
  set textContent(value){this.data=String(value);this.children=[];}
  get textContent(){return this.data+this.children.map(n=>n.textContent).join('');}
 }
 const document={createTextNode:text=>new Node(document,'#text',text),createElement:tag=>new Node(document,tag.toUpperCase())};
 const window={};vm.runInNewContext(readFileSync(new URL('../docs/message-format.js',import.meta.url),'utf8'),{window});
 return {api:window.AgentMessageFormat,body:document.createElement('span')};
}
test('Only Astra approval questions are bold; itinerary details keep their original text',()=>{
 const {api,body}=formatter();
 const text='Day 1 in Kyoto. Day 2 in Osaka. Do u approve itinerary?';
 api.render(body,text,{agent:'astra'});
 assert.equal(body.textContent,text);
 const strong=body.children.filter(n=>n.tagName==='STRONG');assert.equal(strong.length,1);assert.match(strong[0].textContent,/Do u approve itinerary\?/);
 assert.equal(strong[0].className,'itinerary-approval');
});
test('Approval variants, including a standalone request, receive visual emphasis',()=>{
 for(const question of ['Do you approve this itinerary?','Do you approve?','Are you happy with this plan?','Does the itinerary work for you?','Can I finalize this itinerary?']) {
  const {api,body}=formatter();api.render(body,question,{agent:'astra'});
  assert.equal(body.children.filter(n=>n.tagName==='STRONG').length,1,question);assert.equal(body.textContent,question);
 }
});
test('Normal questions, Sage replies, user messages and approval statements are not bolded',()=>{
 for(const [text,options] of [['What is your budget?',{agent:'astra'}],['The itinerary is approved.',{agent:'astra'}],['Do you approve this itinerary?',{agent:'sage'}],['Do you approve this itinerary?',{agent:'astra',role:'user'}]]) {
  const {api,body}=formatter();api.render(body,text,options);assert.equal(body.children.filter(n=>n.tagName==='STRONG').length,0);assert.equal(body.textContent,text);
 }
});
test('Streaming repaints can add and remove emphasis without changing the underlying string or parsing HTML',()=>{
 const {api,body}=formatter();
 api.render(body,'Do you approve this itinerary',{agent:'astra'});assert.equal(body.children.filter(n=>n.tagName==='STRONG').length,0);
 api.render(body,'Do you approve this itinerary?',{agent:'astra'});assert.equal(body.children.filter(n=>n.tagName==='STRONG').length,1);
 const text='<img src=x onerror=alert(1)> Do you approve this itinerary?';
 api.render(body,text,{agent:'astra'});assert.equal(body.textContent,text);assert.equal(body.children.some(n=>n.tagName==='IMG'),false);
 api.render(body,'What is your budget?',{agent:'astra'});assert.equal(body.children.filter(n=>n.tagName==='STRONG').length,0);
});
test('The formatter loads before the app using deferred scripts',()=>{
 const index=readFileSync(new URL('../docs/index.html',import.meta.url),'utf8');
 const formatterIndex=index.indexOf('message-format.js?v=approval-1');
 assert.ok(formatterIndex>=0);assert.ok(formatterIndex<index.indexOf('app.js?v=approval-display-33'));
});
