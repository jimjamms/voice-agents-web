// Keep debrief content on the server until a survey receipt is confirmed.
// Set STUDY_DEBRIEF_TEXT to the approved plain text to display it inline.
const DEBRIEF_URL = 'https://app.notion.com/p/Sage-Astra-Travel-AI-Agents-Study-Debrief-40d311cd62a980ca89aec3d6823fe1a5';

export function studyDebrief(env, submitted) {
  if (!submitted) return null;
  return {
    url: DEBRIEF_URL,
    text: typeof env.STUDY_DEBRIEF_TEXT === 'string' ? env.STUDY_DEBRIEF_TEXT.trim() : '',
  };
}
