// Variation changes phrasing, not user facts, personality, task requirements or memory mode.
const questionBanks = [
 ['What do you enjoy doing when you have a free afternoon?','What do you usually enjoy doing in your free time?','How do you like to spend your spare time?','What interests do you tend to make time for?'],
 ['What does a comfortable day of sightseeing look like for you?','How do you like to pace a day of sightseeing?','What would make a day of sightseeing feel comfortable for you?'],
 ["What helps you feel comfortable in a place you're staying?",'What matters most to you in a place to stay?','What makes a hotel feel like a good fit for you?'],
 ['What would you most want to make room for in the trip budget?','What would you most enjoy spending your trip budget on?','What feels most worth spending on during a trip?'],
 ['What tends to make travel between places tiring or frustrating for you?','What matters most to you when traveling between cities?','What would make the transport between stops feel more comfortable?'],
 ['What kinds of games do you enjoy?','What games do you find yourself coming back to?','Which games do you most enjoy playing?',"What's a game you really enjoy playing?"],
 ['What kinds of board games do you enjoy?','Which board games do you most enjoy playing?','What board games do you find yourself coming back to?'],
 ['What kinds of video games do you enjoy?','Which video games do you most enjoy playing?','What video games do you find yourself coming back to?'],
 ['What kinds of music do you enjoy?','What music do you enjoy listening to most?','Which kinds of music do you find yourself coming back to?'],
 ['What foods do you enjoy trying?','Which foods do you most enjoy trying?','What food experiences do you especially enjoy?'],
 ['What do you enjoy doing outdoors?','What outdoor activities do you enjoy most?','What do you like to do when you spend time outside?'],
 ['What do you enjoy reading?','What kinds of books do you enjoy?','Which books do you find yourself coming back to?'],
 ['What kinds of art do you enjoy?','What art do you find yourself drawn to?','Which kinds of art catch your interest?'],
 ['Which country would you like to visit?','What country do you have in mind for this trip?','Where would you like to go, country-wise?'],
 ['Which city would you like to explore first?','What city do you have in mind for the first stop?','Which city would you like to start with?'],
 ['What do you enjoy about a quieter setting?','What makes a quiet spot a good fit for you?','What appeals to you about spending time somewhere quiet?'],
 ['What puts you off museums?',"What isn't working for you about including museums?",'What would you prefer to avoid about a museum visit?'],
 ['What would you like to be different about that part of the day?','What would make that part of the plan work better for you?'],
];
const benefitBanks = [
 ['I can use your interests to suggest experiences that fit you.','Knowing your interests helps me choose experiences you might enjoy.','Your interests can help me narrow down the experiences to suggest.'],
 ['I can fit the sightseeing around the pace you enjoy.','Knowing your preferred pace helps me arrange the sightseeing.','Your preferred pace can guide how we arrange each day.'],
 ['I can use that to narrow down the kind of stay that suits you.','Your comfort priorities can help me narrow down where to stay.','Knowing what matters in a stay helps me suggest a suitable option.'],
 ['I can use that to leave more room in the budget for what matters to you.','Your priorities can guide where we save and where we leave room to spend.','Knowing what matters most helps me balance the trip budget.'],
 ['I can use that to compare routes around what works best for you.','Your travel preferences can help me compare the routes.','Knowing what makes travel comfortable helps me weigh the transport options.'],
];
const banks = [...questionBanks,...benefitBanks];
const normalize = text => String(text).toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
function hash(text) {
 let value=2166136261;
 for(const char of String(text)) {value^=char.codePointAt(0);value=Math.imul(value,16777619);}
 return value>>>0;
}
export function varyFallback(text,key='',history=[]) {
 if(!text || !key) return text; // Older component callers keep their existing behavior.
 const bank=banks.find(variants=>variants.includes(text));
 if(!bank) return text;
 const recent=history.filter(m=>m.role==='assistant').slice(-8).map(m=>normalize(m.content));
 const unused=bank.filter(line=>!recent.some(reply=>reply.includes(normalize(line))));
 const pool=unused.length?unused:bank;
 return pool[hash(key+'|'+bank[0])%pool.length];
}
const approaches = [
 'Use a short direct acknowledgement only if it adds something, then write a contextual question in your own words.',
 'When useful, connect one real detail in the latest message to the planning decision before asking your one question.',
 'Lead with a brief useful observation or concrete suggestion when the available facts support one; avoid a stock compliment.',
 'Keep the transition understated and conversational. Skip a generic acknowledgement if a relevant observation or question works better.',
];
export function varietyContext(key='') {
 if(!key) return '';
 return 'Response variety: '+approaches[hash(key)%approaches.length]+ ' This is a wording cue, not a change in your persona or task. Prefer meaningful adaptation to the user\'s actual words, known reasons and current decision. Use fresh phrasing rather than copy examples or preset openings. Do not start every reply with the same acknowledgement, repeated compliment, benefit pitch or sentence pattern. Vary statements, brief explanations and suggestions naturally; do not end every reply with another question. Preserve a necessary clarification and the one-question limit. Keep the same helpfulness, warmth and planning standards in either memory condition. Do not invent different preferences, recommendations or facts merely to sound novel. Do not claim knowledge about other users or disclose this cue.';
}
export const VARIETY_RULES = `Examples in these instructions show a purpose, not a script to repeat verbatim to everyone. Adapt responses to the current user's real interests, stated reasons, prior answers and unfinished decisions. Vary acknowledgements and sentence structure naturally; a direct answer, relevant observation, useful suggestion or short explanation can replace generic praise. Do not repeatedly start with "Got it", "Great choice", "That sounds fun" or a paraphrase of the user's last sentence. Do not mechanically attach the same benefit explanation or question template to every reply. Ask the next useful question in fresh contextual wording rather than cycling through synonyms for an already answered question. When two users supply different relevant preferences, let those facts change the actual suggestion. When preferences are similar, equally suitable suggestions may overlap; do not manufacture different recommendations just to create variety. Keep your established persona, effort, courtesy, one-question limit, clarification exception, pacing, privacy and source accuracy unchanged.`;
export function hasBenefitExplanation(text) {
 const value=normalize(text);
 return benefitBanks.some(variants=>variants.some(line=>value.includes(normalize(line)))) || /\b(?:I can use|so I can|help(?:s)? me (?:choose|tailor|suggest|plan|adapt)|tailor (?:the|your)|a better fit for you)\b/i.test(text);
}
