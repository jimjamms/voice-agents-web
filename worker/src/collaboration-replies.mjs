// Plain-language provenance replies, without exposing condition labels or mechanisms.
export function collaborationReply({agent,transcript='',history=[],evidence=[],greeting=false}) {
 if(greeting || !['Sage','Astra'].includes(agent)) return null;
 const other=agent==='Sage'?'Astra':'Sage';
 const text=String(transcript).replace(/[’‘]/g,"'");
 // Keep this narrowly about conversational provenance, not deletion, retention or privacy requests.
 if(/\b(?:delete|erase|export|retain|retention|consent|opt out|privacy policy)\b/i.test(text)) return null;
 const knows=/\b(?:how (?:did|do|can|could|would) (?:you|u) (?:know|remember|find out|learn)|where did (?:you|u) (?:hear|learn|get)|who (?:told|gave)|how come (?:you|u) know)\b/i.test(text);
 const named=new RegExp('\\b'+other+'\\b','i').test(text);
 const fromOther=named && /\b(?:did|does|has|have|are|is)\b/i.test(text) && new RegExp('\\b'+other+'\\s+(?:(?:actually|already|ever|just|also)\\s+)?(?:tell|told|share|shared|talk|talking|mention|mentioned|pass|passed|know)\\b','i').test(text);
 const previous=[...history].reverse().find(m=>m.role==='assistant')?.content || '';
 const justAttributed=new RegExp('\\b'+other+'\\s+(?:mentioned|shared|said|noted|learned)\\b','i').test(previous);
 if(!(knows && (named || justAttributed)) && !fromOther) return null;
 if(evidence.length) return `${other} and I are working together to help plan your trip.`;
 // Team framing must not assert access to a private chat that is not supplied.
 if(justAttributed) return `I shouldn't have implied I knew that detail from ${other}. We're both here to help with your trip.`;
 return `${other} and I are both here to help plan your trip. I'm going by the details available in this conversation and the trip notes.`;
}
export const COLLABORATION_RULES = `If the user asks how you know a fact they told the other agent, answer briefly in everyday collaboration language, for example "Sage and I are working together to help plan your trip" (Astra speaking) or "Astra and I are working together to help plan your trip" (Sage speaking), when the relevant supplied context supports it. Do not name Shared or Separate mode, assigned conditions, experiment hypotheses, databases, extraction, JSON, tools or backend mechanics in this conversational provenance reply. Do not claim a live message, an unseen conversation, or access to a fact not actually supplied. If you previously implied unsupported knowledge, briefly correct it rather than inventing an explanation. Public trip facts can come from the trip notes; do not misattribute those to a private chat. Do not coach survey answers. This rule does not justify making up answers to explicit privacy, deletion, retention or consent questions. Normal relevant source attribution still works both ways: Sage may use genuinely supplied personal facts learned by Astra, and Astra may use genuinely supplied personal facts learned by Sage, with one truthful brief source mention when applying the fact to a concrete decision. Keep itinerary approval requests in plain spoken text; the website formats Astra's approval question visually, so do not add asterisks or HTML to spoken replies.`;
