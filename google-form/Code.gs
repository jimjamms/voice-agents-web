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
  if(destinationId) {
    SpreadsheetApp.openById(destinationId); // Request spreadsheet permission during installation.
    console.log('Linked response spreadsheet enabled.');
  }
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
  if(!receipt.accepted) {
    if(receipt.reason !== 'duplicate') {
      // Configuration problems must not silently destroy a participant's answers.
      props.setProperty('review:'+id,receipt.reason || 'unclassified_rejection');
      props.deleteProperty('pending:'+id);
      console.error('Response retained for host review: '+(receipt.reason || 'update Worker to classify rejection'));
      return;
    }
    const form=FormApp.openById(props.getProperty('FORM_ID'));
    if(!removeDuplicateSheetRow_(form,response,token,props,receipt.acceptedResponseId)) throw new Error('Duplicate spreadsheet row not ready or ambiguous; retained for automatic retry.');
    form.deleteResponse(id);
    props.deleteProperty('sheet-delete:'+id);
  }
  props.deleteProperty('review:'+id);
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

/* Remove only an unambiguous row in THIS form's linked response tab.
 * Journal the intent first so a retry after deletion does not remove a second row.
 */
function removeDuplicateSheetRow_(form,response,token,props,acceptedResponseId) {
  const id=response.getId(), journal='sheet-delete:'+id;
  let destinationId;
  try { destinationId=form.getDestinationId(); }
  catch(error) { if(/no response destination/i.test(String(error.message || error))) return true; throw error; }
  if(!destinationId) return true;
  if(!acceptedResponseId) throw new Error('Update the Worker before spreadsheet duplicate cleanup.');
  const acceptedTimestamp=form.getResponse(acceptedResponseId).getTimestamp().getTime();
  const timestamp=response.getTimestamp().getTime();
  const book=SpreadsheetApp.openById(destinationId);
  const publicUrl=form.getPublishedUrl().split('?')[0].replace(/\/$/,'');
  const candidates=[];
  let foundResponseTab=false;
  for(const sheet of book.getSheets()) {
    const linked=sheet.getFormUrl();
    if(!linked) continue;
    const clean=linked.split('?')[0].replace(/\/$/,'');
    if(!clean.includes('/forms/d/'+form.getId()+'/') && clean!==publicUrl) continue;
    foundResponseTab=true;
    const rows=sheet.getDataRange().getValues();
    const columns=rows[0].flatMap((value,index)=>String(value).trim()==='Survey code'?[index]:[]);
    if(columns.length!==1) throw new Error('Keep exactly one Survey code column in the linked response tab.');
    const column=columns[0];
    for(let i=1;i<rows.length;i++) {
      const at=rows[i][0];
      if(String(rows[i][column]).trim()!==token || !at || typeof at.getTime!=='function') continue;
      // Never delete the accepted row, even when Sheets rounds its timestamp.
      if(Math.abs(at.getTime()-acceptedTimestamp)<=1000) continue;
      const difference=Math.abs(at.getTime()-timestamp);
      if(difference<=1000) candidates.push({sheet,row:i+1,column,timestamp:at.getTime(),difference});
    }
  }
  if(!foundResponseTab) throw new Error('Could not identify this form response tab. No spreadsheet rows were deleted.');
  const exact=candidates.filter(row=>row.difference===0);
  const matches=exact.length?exact:candidates;
  if(matches.length===0) return !!props.getProperty(journal);
  if(matches.length!==1) return false;
  const match=matches[0];
  // Recheck after locating the row, in case its position changed.
  const latest=match.sheet.getRange(match.row,1,1,match.column+1).getValues()[0];
  if(String(latest[match.column]).trim()!==token || typeof latest[0]?.getTime!=='function' || latest[0].getTime()!==match.timestamp) return false;
  props.setProperty(journal,'1');
  match.sheet.deleteRow(match.row);
  return true;
}

/* Run manually after fixing a code/form configuration problem. */
function retryReviewReceipts() {
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  try {
    const props=PropertiesService.getScriptProperties();
    const form=FormApp.openById(props.getProperty('FORM_ID'));
    for(const key of props.getKeys().filter(key=>key.startsWith('review:')).slice(0,25)) {
      const id=key.slice(7);props.setProperty('pending:'+id,'1');
      try { processReceipt_(form.getResponse(id),props); }
      catch(error) { console.error('Review retry pending: '+error.message); }
    }
  } finally {lock.releaseLock();}
}
