const FORMS = Object.freeze({
  shared: 'https://docs.google.com/forms/d/e/1FAIpQLSfE3zVMUF7Vhy-ZqAA47HYjv3880pw99WswhVsZphc5hhV3Kw/viewform',
  isolated: 'https://docs.google.com/forms/d/e/1FAIpQLSeyNKhB_Dvb-udkmOxTuuhoBLXynMQgF6pqFry6x6__RzHebg/viewform',
});
function formAddress(value) {
  const url = new URL(value);
  if (url.origin !== 'https://docs.google.com' || !/^\/forms\/d\/e\/[^/]+\/viewform\/?$/.test(url.pathname)) throw new Error('Invalid full Google Form address');
  url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/\/$/, '');
  return url.href;
}
function formConfig(env, mode) {
  const prefix = mode === 'shared' ? 'SURVEY_SHARED' : 'SURVEY_SEPARATE';
  const entry = env[prefix + '_ENTRY_ID'];
  if (!/^entry\.\d+$/.test(entry || '')) throw new Error('Missing survey entry identifier');
  return { url: formAddress(env[prefix + '_FORM_URL'] || FORMS[mode]), entry };
}
const reply = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const tokenPattern = /^[a-f0-9]{64}$/;
async function data(request) {
  const raw = await request.text();
  if (raw.length > 6000) throw new Error('Request too large');
  return JSON.parse(raw);
}
export async function surveyAccess(request, env, cors) {
  if (!env.LOG_DB || !env.SURVEY_SIGNING_KEY) return reply({error:'The host needs to finish survey setup.'},503,cors);
  try {
    const input = await data(request);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40) return reply({error:'Enter your name ID again.'},400,cors);
    if (env.DEMO_RATE_LIMITER) {
      const limited = await env.DEMO_RATE_LIMITER.limit({key:'survey:'+input.name.trim().toLowerCase()});
      if (!limited.success) return reply({error:'Please wait a minute before checking the survey again.'},429,cors);
    }
    // Read the existing assignment; never accept a browser-supplied mode or reassign an ID.
    const assignment = await env.LOG_DB.prepare('SELECT mode FROM memory_assignments WHERE name_id = ?').bind(input.name.trim().toLowerCase()).first();
    if (!assignment || !['shared', 'isolated'].includes(assignment.mode)) return reply({error:'Please return to setup and load your name ID before opening the survey.'},409,cors);
    let selected;
    try { selected = formConfig(env, assignment.mode); }
    catch { return reply({error:'The host needs to finish survey setup.'},503,cors); }
    const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(env.SURVEY_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signature = await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('travel-survey-v1:'+input.name.trim().toLowerCase()));
    const token = Array.from(new Uint8Array(signature),v=>v.toString(16).padStart(2,'0')).join('');
    await env.LOG_DB.prepare('INSERT INTO survey_receipts(token) VALUES (?) ON CONFLICT(token) DO NOTHING').bind(token).run();
    await env.LOG_DB.prepare('UPDATE survey_receipts SET form_url = ? WHERE token = ? AND form_url IS NULL AND response_id IS NULL').bind(selected.url,token).run();
    const row = await env.LOG_DB.prepare('SELECT response_id, form_url FROM survey_receipts WHERE token = ?').bind(token).first();
    if (!row.response_id && row.form_url !== selected.url) return reply({error:'Survey configuration changed. Please contact the study host.'},409,cors);
    const url = new URL(selected.url); url.searchParams.set('embedded','true');url.searchParams.set(selected.entry,token);
    return reply({submitted:!!row.response_id,url:row.response_id ? null : url.href},200,cors);
  } catch { return reply({error:'Could not check survey access. Please try again.'},503,cors); }
}
export async function surveyReceipt(request, env) {
  const expected = env.SURVEY_RECEIPT_KEY;
  const given = request.headers.get('authorization') || '';
  if (!expected || given !== 'Bearer '+expected) return reply({error:'Unauthorized.'},401);
  if (!env.LOG_DB) return reply({error:'Database unavailable.'},503);
  try {
    const input = await data(request);
    if (typeof input.responseId !== 'string' || !input.responseId || input.responseId.length > 300) return reply({accepted:false},400);
    if (!tokenPattern.test(input.token || '')) return reply({accepted:false,reason:'invalid_code'});
    let submittedForm;
    try { submittedForm = formAddress(input.formUrl); }
    catch { return reply({error:'Update the Google Forms script and run its installer before submitting.'},400); }
    // A single atomic update claims the first response, only for its assigned form.
    await env.LOG_DB.prepare('UPDATE survey_receipts SET response_id = ?, edit_url = ?, submitted_at = CURRENT_TIMESTAMP WHERE token = ? AND form_url = ? AND response_id IS NULL').bind(input.responseId,null,input.token,submittedForm).run();
    const row = await env.LOG_DB.prepare('SELECT response_id, form_url FROM survey_receipts WHERE token = ?').bind(input.token).first();
    if (!row) return reply({accepted:false,reason:'unknown_code'});
    if (row.form_url !== submittedForm) return reply({accepted:false,reason:'wrong_form'});
    return reply({accepted:row.response_id === input.responseId,reason:row.response_id === input.responseId?'accepted':'duplicate',...(row.response_id !== input.responseId && {acceptedResponseId:row.response_id})});
  } catch { return reply({error:'Receipt could not be processed; retry later.'},503); }
}
