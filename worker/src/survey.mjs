const FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSe6Ga8K_yKNxnJBQC4qrZ-K5cDIAaLTrSf6mq1cwKtGe-nMJQ/viewform';
const reply = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const tokenPattern = /^[a-f0-9]{64}$/;
async function data(request) {
  const raw = await request.text();
  if (raw.length > 6000) throw new Error('Request too large');
  return JSON.parse(raw);
}
export async function surveyAccess(request, env, cors) {
  if (!env.LOG_DB || !env.SURVEY_SIGNING_KEY || !/^entry\.\d+$/.test(env.SURVEY_ENTRY_ID || '')) return reply({error:'The host needs to finish survey setup.'},503,cors);
  try {
    const input = await data(request);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40) return reply({error:'Enter your name ID again.'},400,cors);
    if (env.DEMO_RATE_LIMITER) {
      const limited = await env.DEMO_RATE_LIMITER.limit({key:'survey:'+input.name.trim().toLowerCase()});
      if (!limited.success) return reply({error:'Please wait a minute before checking the survey again.'},429,cors);
    }
    const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(env.SURVEY_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signature = await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('travel-survey-v1:'+input.name.trim().toLowerCase()));
    const token = Array.from(new Uint8Array(signature),v=>v.toString(16).padStart(2,'0')).join('');
    await env.LOG_DB.prepare('INSERT INTO survey_receipts(token) VALUES (?) ON CONFLICT(token) DO NOTHING').bind(token).run();
    const row = await env.LOG_DB.prepare('SELECT response_id, edit_url FROM survey_receipts WHERE token = ?').bind(token).first();
    const url = new URL(FORM); url.searchParams.set('embedded','true');url.searchParams.set(env.SURVEY_ENTRY_ID,token);
    return reply({submitted:!!row.response_id,url:row.response_id ? null : url.href,editUrl:row.edit_url || null},200,cors);
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
    if (!tokenPattern.test(input.token || '')) return reply({accepted:false});
    let editUrl = null;
    if (input.editUrl) {
      const url = new URL(input.editUrl);
      if (url.origin !== 'https://docs.google.com' || !url.pathname.startsWith('/forms/')) return reply({accepted:false},400);
      editUrl = url.href;
    }
    // A single atomic update claims the first response, even if two arrive together.
    await env.LOG_DB.prepare('UPDATE survey_receipts SET response_id = ?, edit_url = ?, submitted_at = CURRENT_TIMESTAMP WHERE token = ? AND response_id IS NULL').bind(input.responseId,editUrl,input.token).run();
    const row = await env.LOG_DB.prepare('SELECT response_id FROM survey_receipts WHERE token = ?').bind(input.token).first();
    return reply({accepted:row?.response_id === input.responseId});
  } catch { return reply({error:'Receipt could not be processed; retry later.'},503); }
}
