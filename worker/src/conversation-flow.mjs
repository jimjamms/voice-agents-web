// A bounded clarification is different from repeatedly asking for motivations.
const broadInterests = /\b(?:free afternoon|free time|spare time|hobbies|interests|enjoy doing|do for fun|free day)\b/i;
const categories = [
  {match:/^(?:playing )?(?:video |board |computer )?games?$/i,question:'What kinds of games do you enjoy?',topic:/\bgames?\b/i},
  {match:/^(?:listening to )?music$/i,question:'What kinds of music do you enjoy?',topic:/\bmusic\b/i},
  {match:/^(?:trying |eating )?(?:food|cooking)$/i,question:'What foods do you enjoy trying?',topic:/\b(?:foods?|cooking)\b/i},
  {match:/^(?:being )?(?:outdoors|outside|nature)$/i,question:'What do you enjoy doing outdoors?',topic:/\b(?:outdoors|outside|nature)\b/i},
  {match:/^(?:reading |reading|books|reading books)$/i,question:'What do you enjoy reading?',topic:/\b(?:read\w*|books?)\b/i},
  {match:/^(?:art|the arts)$/i,question:'What kinds of art do you enjoy?',topic:/\bart\b/i},
];
const previousQuestion = history => [...history].reverse().find(m=>m.role==='assistant')?.content.match(/[^.!?]*\?/g)?.at(-1) || '';
const stop = text => /\b(?:rather not|not sure|don't know|don't want|do not want|skip|no (?:more )?questions|move on|just proceed|go ahead|switch to|talk to|approve|looks good|finish|finalize)\b/i.test(text);
export function interestClarification({agent,transcript='',history=[],greeting=false,tripChoices={},resumeInterest=false}) {
  if(agent!=='Sage' || greeting || tripChoices?.finalized || stop(transcript) || transcript.includes('?')) return null;
  const previous=previousQuestion(history);
  // Only the direct answer to an opening interests question gets this exception.
  if(!broadInterests.test(previous) && !resumeInterest) return null;
  let interestText=transcript;
  if(resumeInterest && !broadInterests.test(previous)) {
    interestText='';
    for(let i=history.length-1;i>=1;i--) if(history[i].role==='user' && history[i-1].role==='assistant' && broadInterests.test(history[i-1].content)) { interestText=history[i].content; break; }
  }
  let answer=interestText.trim().replace(/[.!]+$/,'').replace(/^(?:I\s+(?:(?:really|mostly|usually)\s+)?(?:like|love|enjoy)|I(?:'m| am) into)\s+/i,'').replace(/\s+(?:a lot|in my free time)$/i,'').replace(/^(?:to\s+)?play\s+/i,'playing ');
  const category=categories.find(c=>c.match.test(answer));
  if(!category) return null; // Specific interests or an explained preference can be used immediately.
  const question = /\bboard games?\b/i.test(answer) ? 'What kinds of board games do you enjoy?' : /\bvideo games?\b/i.test(answer) ? 'What kinds of video games do you enjoy?' : category.question;
  if(history.some(m=>m.role==='assistant' && isInterestDetailQuestion(m.content) && category.topic.test(m.content))) return null;
  return {question,topic:category.topic};
}
export function isInterestClarification(question,clarification) {
  return typeof question==='string' && /^(?:what|which|how)\b/i.test(question.trim()) && clarification?.topic.test(question);
}
export function interestProgress({agent,transcript='',history=[],tripChoices={},memories=[]}) {
  if(agent!=='Sage' || !transcript.trim() || stop(transcript) || transcript.includes('?') || tripChoices?.finalized) return '';
  const previous=previousQuestion(history);
  if(!broadInterests.test(previous) && !isInterestDetailQuestion(previous)) return '';
  const questions=history.filter(m=>m.role==='assistant').flatMap(m=>m.content.match(/[^.!?]*\?/g)||[]);
  const countries=Array.isArray(tripChoices?.countries)?tripChoices.countries:[];
  const cities=Array.isArray(tripChoices?.cities)?tripChoices.cities:[];
  // Be conservative with lagging public notes: don't repeat an existing place question
  // or contradict a saved destination. The model can still use that context normally.
  if(!countries.length && !cities.length && !questions.some(q=>/\bcountr(?:y|ies)\b/i.test(q)) && !(Array.isArray(memories)?memories:[]).some(m=>/\b(?:country|visit|trip to|travel to)\b/i.test(typeof m==='string'?m:m?.fact||''))) return 'Which country would you like to visit?';
  if(countries.length && !cities.length && !questions.some(q=>/\bcit(?:y|ies)\b/i.test(q))) return 'Which city would you like to explore first?';
  return '';
}
export function acknowledgementOnly(text) {
  const value=String(text).trim();
  return !value || (value.split(/\s+/).length<=45 && !/\b(?:visit|try|schedule|choose|recommend|book|walk|explore|spend|include|reserve|arcades?|cafes?|cafés?|escape rooms?|gardens?|museums?)\b/i.test(value));
}
export const FLOW_RULES = `Keep the conversation moving after a user answers. A brief acknowledgement alone is insufficient when a discovery answer leaves a useful next step. If the answer to an opening interests question is broad, such as "I like playing games", allow ONE contextual clarification such as "What kinds of games do you enjoy?" This clarification is an exception to the personal-question pause; it is not permission for a chain of why questions. Do not repeat the benefit explanation. If the answer is already specific or explained, use it rather than ask for more. After the clarification answer, propose a concrete trip connection or ask the next genuinely missing destination/activity decision. Do not infer a favorite genre, venue or destination from an unspecified hobby. A pause limits repeated personal probing, not useful trip planning. A substantive answer or concrete suggestion can stand alone; never add a question merely to fill a quota. Respect skips, direct requests, completed approval and the current memory boundary.`;

export function isInterestDetailQuestion(text) {
  return (String(text).match(/[^.!?]*\?/g)||[]).some(q=>categories.some(c=>isInterestClarification(q,c)));
}

// Recognize choosing an option recommended for an already supplied preference.
// This reuses the recommendation's basis; it does NOT invent an additional user motive.
const contextWords = value => new Set((String(value).toLowerCase().match(/[a-z]{3,}/g)||[]).map(w=>
 /^(games?|gaming)$/.test(w)?'game':/^(quiet|quieter|quietest)$/.test(w)?'quiet':/^(hike|hikes|hiking)$/.test(w)?'hike':w.replace(/s$/,'')
).filter(w=>!new Set(['the','and','for','your','you','that','this','with','like','love','enjoy','prefer','interest','want','really','would','could','should','travel','trip','place','visit','there','have','about','into','user','traveler']).has(w)));
export function acceptedRecommendation(transcript,history=[],memories=[]) {
  if(!transcript || transcript.length>100 || transcript.includes('?') || stop(transcript) || /\b(?:not|instead|maybe|perhaps|rather|avoid|skip|don't|do not)\b/i.test(transcript)) return null;
  const option=transcript.trim().replace(/[.!]+$/,'').replace(/^(?:I(?:'d| would)?\s+(?:choose|pick|like|prefer|want)|let['’]s\s+(?:do|go with|go to)|we(?:'d| would)?\s+(?:choose|pick|like|prefer|want))\s+/i,'').replace(/\s+(?:please|it is|then|sounds good)$/i,'').trim();
  if(!/^[\p{L}][\p{L} '-]{1,65}$/u.test(option) || /^(?:yes|sure|okay|ok|sounds good)$/i.test(option)) return null;
  const reply=[...history].reverse().find(m=>m.role==='assistant')?.content || '';
  const escaped=option.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const named=new RegExp('\\b'+escaped+'\\b','i');
  const sentences=reply.split(/(?<=[.!?])\s+/).filter(s=>named.test(s) && !s.includes('?') && /\b(?:for your|for you|because|since you|given your|based on|fit.*(?:interest|prefer|enjoy)|suit.*(?:interest|prefer|enjoy))\b/i.test(s));
  if(!sentences.length) return null;
  const personal = /\b(?:like|love|enjoy|prefer|avoid|dislike|hate|need|play|into|hobb|interest|no longer)\w*\b/i;
  const facts=[...history].reverse().filter(m=>m.role==='user' && personal.test(m.content) && !m.content.includes('?') && !/^(?:do I|would I|can I|what|why|how|is there)\b/i.test(m.content)).map(m=>m.content);
  for(const m of (Array.isArray(memories)?memories:[]).slice(-20).reverse()) if(['preference','constraint','avoidance','past_experience','travel_companion'].includes(m?.type) && typeof m.fact==='string') facts.push(m.fact);
  const seen=new Set();
  for(const fact of facts) {
    const terms=[...contextWords(fact)].filter(w=>!seen.has(w));
    for(const w of contextWords(fact)) seen.add(w);
    for(const sentence of sentences) {
      if(!terms.some(w=>contextWords(sentence).has(w))) continue;
      if(/\b(?:don't|do not|no longer|not sure|unsure|maybe|not|dislike|hate)\b/i.test(fact) && !/\b(?:avoid|away|instead|without|skip)\b/i.test(sentence)) continue;
      return {option,preference:fact,rationale:sentence};
    }
  }
  return null;
}
export const RECOMMENDATION_CONTEXT_RULES = `When the user chooses an option you just recommended for a preference already supplied, retain that recommendation context instead of treating the selection as a new unexplained preference. For example, games interest -> Japan recommended for gaming -> user chooses Japan does not need "Why Japan?" or "What appeals about Japan?" A useful next question learns missing detail, such as the kind of games, a city or a specific experience. Do not ask for a second explanation merely because the selected place name differs from the original preference words. This applies to your own supplied history and permitted memories in either mode. Reuse the basis for the suggestion without claiming the user confirmed an additional motivation, genre, venue or booking. Do not turn every short yes into approval of competing options. New independent choices, genuine changes and conflicting preferences can still need clarification. Prefer the latest user correction to an older preference.`;
