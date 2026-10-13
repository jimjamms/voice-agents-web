(() => {
  const OUTBOX='sage-astra-log-outbox-v1', CLIENT='sage-astra-log-client-v1';
  class RemoteLogger {
    constructor(options) {
      this.options=options; this.running=false; this.timer=null;
      try { this.queue=JSON.parse(localStorage.getItem(OUTBOX)||'[]'); this.client=localStorage.getItem(CLIENT)||crypto.randomUUID(); localStorage.setItem(CLIENT,this.client); }
      catch { this.queue=[]; this.client=crypto.randomUUID(); }
      if (!Array.isArray(this.queue)) this.queue=[];
      window.addEventListener('online',()=>this.flush());
      window.addEventListener('pagehide',()=>this.flush(true));
    }
    status(text) { if(this.options.status) this.options.status.textContent=text; }
    persist() { try { localStorage.setItem(OUTBOX,JSON.stringify(this.queue)); } catch { this.status('Chat upload pending; keep this tab open.'); } }
    forget(name) {
      this.queue = this.queue.filter(turn => turn.speaker.trim().toLowerCase() !== name);
      this.persist();
    }
    record(turn) {
      turn.turn_id ||= crypto.randomUUID(); turn.participant_id ||= this.client;
      const value={ turn_id:turn.turn_id, participant_id:turn.participant_id, session_id:turn.session_id, timestamp:turn.timestamp,
        agent:turn.agent, engine:turn.engine, memory_sharing_mode:turn.memory_sharing_mode, speaker:turn.speaker,
        user_text:String(turn.user_text||'').slice(0,3500), agent_reply:String(turn.agent_reply||'').slice(0,3500), interrupted:turn.interrupted===true };
      const index=this.queue.findIndex(item=>item.turn_id===value.turn_id);
      if(index>=0)this.queue[index]=value; else this.queue.push(value);
      this.persist(); this.flush();
    }
    flush(keepalive=false) {
      if (this.inFlight) return this.inFlight;
      if (!this.queue.length || !this.options.base() || !this.options.code()) return Promise.resolve();
      const task = this.send(keepalive); this.inFlight = task;
      task.finally(() => { if (this.inFlight === task) this.inFlight = null; });
      return task;
    }
    async send(keepalive=false) {
      const base=this.options.base(),code=this.options.code();
      if(this.running||!this.queue.length||!base||base.includes('REPLACE-ME')||!code)return;
      clearTimeout(this.timer);this.timer=null;this.running=true;
      const batch=[];
      for(const turn of this.queue.slice(0,25)) {
        const next=[...batch,turn]; if(new TextEncoder().encode(JSON.stringify({turns:next})).length>48000)break;
        batch.push(turn);
      }
      if(!batch.length){this.running=false;this.status('One chat turn is too large to upload.');return;}
      const snapshots=new Map(batch.map(item=>[item.turn_id,JSON.stringify(item)]));
      let retry=false;
      const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),20000);
      try {
        const response=await fetch(`${base.replace(/\/$/,'')}/logs`,{method:'POST',headers:{'content-type':'application/json','x-demo-code':code},body:JSON.stringify({turns:batch}),keepalive,signal:controller.signal});
        const result=await response.json();
        if(!response.ok||!Array.isArray(result.saved)){retry=response.status!==401;throw new Error();}
        const saved=new Set(result.saved);
        this.queue=this.queue.filter(item=>!saved.has(item.turn_id)||snapshots.get(item.turn_id)!==JSON.stringify(item));
        this.persist();this.status(result.discarded?.length ? 'Older chat uploads were discarded after host deletion.' : this.queue.length?'Chat upload pending…':'Chat saved for the host.');
      } catch {this.status('Chat upload pending. It will retry when connected.');retry=true;}
      finally {
        clearTimeout(timeout);this.running=false;
        if(this.queue.length)this.timer=setTimeout(()=>this.flush(),retry?30000:100);
      }
    }
  }
  window.createRemoteLogger=options=>new RemoteLogger(options);
})();
