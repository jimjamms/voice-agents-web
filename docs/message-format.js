(() => {
  function isItineraryApproval(sentence) {
    const text=String(sentence).replace(/[’‘]/g,"'");
    if(!text.includes('?')) return false;
    const plan=/\b(?:itinerary|plan|trip|route|schedule|budget)\b/i.test(text);
    if(/\bapprov(?:e|al)\b/i.test(text) && (plan || /^\s*(?:do|would|can|could|will)\s+(?:you|u)\s+approve\s*\?\s*$/i.test(text))) return true;
    return plan && /\b(?:sign off|happy with|ready to (?:confirm|finali[sz]e|go ahead)|look(?:s)? (?:good|right)|work(?:s)? for you|confirm (?:this|the|your)|finali[sz]e (?:this|the|your))\b/i.test(text);
  }
  function render(body,text,{role='assistant',agent='sage'}={}) {
    const document=body.ownerDocument;
    const content=String(text || '');
    body.replaceChildren();
    if(role!=='assistant' || agent!=='astra') { body.append(document.createTextNode(content)); return; }
    // Never parse message content as HTML, and keep formatting out of the spoken/logged text.
    const parts=content.match(/[^.!?\n]+[.!?]?|[.!?]+|\n+/g)||[];
    for(const part of parts) {
      if(isItineraryApproval(part)) {
        const strong=document.createElement('strong');strong.className='itinerary-approval';strong.textContent=part;
        body.append(strong);
      } else body.append(document.createTextNode(part));
    }
  }
  window.AgentMessageFormat={render,isItineraryApproval};
})();
