import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { surveyAccess } from '../worker/src/survey.mjs';

test('survey endpoint releases debrief only after a receipt, in both conditions', async () => {
  globalThis.crypto ??= webcrypto;
  for (const mode of ['shared','isolated']) {
    for (const submitted of [false,true]) {
      const env={SURVEY_SIGNING_KEY:'test',SURVEY_SHARED_ENTRY_ID:'entry.1',SURVEY_SEPARATE_ENTRY_ID:'entry.2',STUDY_DEBRIEF_TEXT:'Approved debrief',LOG_DB:{
        prepare(sql) { return {bind(){return this;},async run(){},async first(){
          if(sql.includes('memory_assignments'))return {mode};
          return {response_id:submitted?'receipt':null,form_url:mode==='shared'?'https://docs.google.com/forms/d/e/1FAIpQLSfE3zVMUF7Vhy-ZqAA47HYjv3880pw99WswhVsZphc5hhV3Kw/viewform':'https://docs.google.com/forms/d/e/1FAIpQLSeyNKhB_Dvb-udkmOxTuuhoBLXynMQgF6pqFry6x6__RzHebg/viewform'};
        }};}
      }};
      const result=await surveyAccess(new Request('https://test/survey/access',{method:'POST',body:JSON.stringify({name:'participant'})}),env,{});
      assert.equal(result.status,200);
      const body=await result.json();
      assert.equal(body.submitted,submitted);
      assert.equal(result.headers.get('cache-control'),'no-store');
      if(submitted){assert.equal(body.debrief.text,'Approved debrief');assert.match(body.debrief.url,/^https:\/\/app.notion.com\/p\//);assert.equal(body.url,null);}
      else {assert.equal(body.debrief,null);assert.ok(body.url);}
    }
  }
});

function browser() {
  class Element {
    hidden=true; textContent=''; childNodes=[]; attrs={}; value='participant'; listeners={};
    replaceChildren(){this.childNodes=[];}
    append(child){this.childNodes.push(child);}
    removeAttribute(name){delete this.attrs[name];}
    hasAttribute(name){return name in this.attrs;}
    set src(value){this.attrs.src=value;}
    set href(value){this.attrs.href=value;}
    addEventListener(name,fn){this.listeners[name]=fn;}
  }
  const elements=new Map(); const events={}; const pending=[];
  const document={body:{dataset:{stage:'review'}},hidden:false,querySelector(selector){if(!elements.has(selector))elements.set(selector,new Element());return elements.get(selector);},createElement(){return new Element();},addEventListener(){}};
  const window={addEventListener(name,fn){events[name]=fn;}};
  const context=vm.createContext({document,window,URL,AbortController,setTimeout(){return 1;},clearTimeout(){},fetch(){return new Promise(resolve=>pending.push(value=>resolve(Response.json(value))));}});
  vm.runInContext(readFileSync(new URL('../docs/survey.js',import.meta.url),'utf8'),context);
  async function respond(body){pending.shift()(body);await new Promise(resolve=>setImmediate(resolve));}
  return {elements,events,respond};
}

test('inline debrief is literal text; external link appears after submission and resets on close',async()=>{
  const b=browser();
  await b.respond({submitted:false,url:'https://docs.google.com/forms/test',debrief:{text:'Must not show'}});
  assert.equal(b.elements.get('#study-debrief').hidden,true);
  const check=b.events['survey:open']();
  await b.respond({submitted:true,debrief:{text:'<script>unsafe()</script>\n\nSecond paragraph',url:'https://app.notion.com/p/test'}});
  await check;
  assert.equal(b.elements.get('#study-debrief').hidden,false);
  assert.equal(b.elements.get('#study-debrief-text').childNodes[0].textContent,'<script>unsafe()</script>');
  assert.equal(b.elements.get('#study-debrief-text').childNodes.length,2);
  assert.equal(b.elements.get('#google-form-embed').hidden,true);
  b.events['survey:close']();
  assert.equal(b.elements.get('#study-debrief').hidden,true);
  assert.equal(b.elements.get('#study-debrief-text').childNodes.length,0);
  assert.equal(b.elements.get('#study-debrief-link').attrs.href,undefined);
});

test('participant changes hide prior debrief immediately; unsafe URLs are rejected',async()=>{
  const b=browser();
  await b.respond({submitted:true,debrief:{url:'https://app.notion.com/p/test'}});
  assert.equal(b.elements.get('#study-debrief').hidden,false);
  b.elements.get('#speaker-name').value='someone-else';
  const check=b.events['survey:open']();
  assert.equal(b.elements.get('#study-debrief').hidden,true);
  await b.respond({submitted:true,debrief:{url:'javascript:alert(1)'}});
  await check;
  assert.equal(b.elements.get('#study-debrief').hidden,true);
});

test('a stale response cannot reveal a debrief after closing',async()=>{
  const b=browser(); b.events['survey:close']();
  await b.respond({submitted:true,debrief:{text:'Hidden'}});
  assert.equal(b.elements.get('#study-debrief').hidden,true);
});

test('debrief link opens in a new tab outside the form',()=>{
  const html=readFileSync(new URL('../docs/index.html',import.meta.url),'utf8');
  assert.match(html,/<\/iframe>.*<section id="study-debrief"/s);
  assert.match(html,/<a id="study-debrief-link" target="_blank" rel="noopener noreferrer"/);
});
