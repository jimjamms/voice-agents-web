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
export function interestClarification({agent,transcript='',history=[],greeting=false,tripChoices={}}) {
  if(agent!=='Sage' || greeting || tripChoices?.finalized || stop(transcript) || transcript.includes('?')) return null;
  const previous=previousQuestion(history);
  // Only the direct answer to an opening interests question gets this exception.
  if(!broadInterests.test(previous)) return null;
  let answer=transcript.trim().replace(/[.!]+$/,'').replace(/^(?:I\s+(?:(?:really|mostly|usually)\s+)?(?:like|love|enjoy)|I(?:'m| am) into)\s+/i,'').replace(/\s+(?:a lot|in my free time)$/i,'');
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
