/* Paste into the Apps Script project bound to the study Google Form.
 * Script Properties: WORKER_URL, SURVEY_RECEIPT_KEY.
 * Run installSurveyProtection once. Do not share this script with participants.
 */
function installSurveyProtection() {
  const props=PropertiesService.getScriptProperties();
  const base=(props.getProperty('WORKER_URL') || '').replace(/\/$/,'');
  if(!/^https:\/\//.test(base) || !(props.getProperty('SURVEY_RECEIPT_KEY') || '').trim()) throw new Error('Set WORKER_URL and SURVEY_RECEIPT_KEY in Script Properties first.');
  const form=FormApp.getActiveForm();
  if(!form) throw new Error('Open Apps Script from the Google Form editor.');
  let destinationId = null;
  try { destinationId = form.getDestinationId(); }
  catch (error) {
    // Google throws instead of returning null when no Sheet is linked.
    if (!/no response destination/i.test(String(error.message || error))) throw error;
  }
  if(destinationId) throw new Error('Unlink the response spreadsheet first. Google Forms does not delete duplicate rows from a linked Sheet. Existing sheet data is not changed by this script.');
  const title='Survey code';
  const matches=form.getItems(FormApp.ItemType.TEXT).filter(item=>item.getTitle()===title);
  if(matches.length>1) throw new Error('Keep exactly one short-answer question called Survey code.');
  const item=matches.length?matches[0].asTextItem():form.addTextItem().setTitle(title);
  item.setHelpText('Filled in by the study website. Please leave this code unchanged.').setRequired(true);
  item.setValidation(FormApp.createTextValidation().requireTextMatchesPattern('^[a-f0-9]{64}$').build());
  form.setAllowResponseEdits(false);
  form.setShowLinkToRespondAgain(false);
  props.setProperty('FORM_ID',form.getId());
  props.setProperty('FORM_URL',form.getPublishedUrl());
  props.setProperty('CODE_ITEM_ID',String(item.getId()));
  const url=form.createResponse().withItemResponse(item.createResponse('a'.repeat(64))).toPrefilledUrl();
  const entry=url.match(/[?&](entry\.\d+)=/);
  if(!entry) throw new Error('Could not find the survey-code entry ID.');
  for(const trigger of ScriptApp.getProjectTriggers()) {
    if(['onSurveySubmitted','retryPendingReceipts'].includes(trigger.getHandlerFunction())) ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger('onSurveySubmitted').forForm(form).onFormSubmit().create();
  ScriptApp.newTrigger('retryPendingReceipts').timeBased().everyMinutes(5).create();
  console.log('Survey form URL: '+form.getPublishedUrl());
  console.log('Survey code entry ID: '+entry[1]);
}
function onSurveySubmitted(event) {
  if(!event || !event.response) throw new Error('This function runs from the Form submission trigger.');
  const props=PropertiesService.getScriptProperties();
  props.setProperty('pending:'+event.response.getId(),'1');
  const lock=LockService.getScriptLock();if(!lock.tryLock(30000))return;
  try {
    processReceipt_(event.response,props);
  } finally { lock.releaseLock(); }
}
function processReceipt_(response,props) {
  const id=response.getId();
  const answer=response.getItemResponses().find(answer=>String(answer.getItem().getId())===props.getProperty('CODE_ITEM_ID'));
  const token=String(answer?answer.getResponse():'').trim();
  const result=UrlFetchApp.fetch(props.getProperty('WORKER_URL').replace(/\/$/,'')+'/survey/receipt',{
    method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+props.getProperty('SURVEY_RECEIPT_KEY')},
    payload:JSON.stringify({token,responseId:id,formUrl:props.getProperty('FORM_URL')}),muteHttpExceptions:true
  });
  if(result.getResponseCode()!==200) throw new Error('Receipt pending; Worker returned '+result.getResponseCode()+'. Automatic retry will run.');
  const receipt=JSON.parse(result.getContentText());
  if(typeof receipt.accepted!=='boolean') throw new Error('Invalid receipt. Automatic retry will run.');
  if(!receipt.accepted) FormApp.openById(props.getProperty('FORM_ID')).deleteResponse(id);
  props.deleteProperty('pending:'+id);
}
function retryPendingReceipts() {
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  try {
    const props=PropertiesService.getScriptProperties();const form=FormApp.openById(props.getProperty('FORM_ID'));
    for(const key of props.getKeys().filter(key=>key.startsWith('pending:')).slice(0,25)){
      try { processReceipt_(form.getResponse(key.slice(8)),props); }
      catch(error){ console.error('Receipt retry pending: '+error.message); }
    }
  } finally {lock.releaseLock();}
}
