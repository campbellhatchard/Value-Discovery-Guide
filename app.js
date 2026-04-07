
const PAIN_POINTS = [
  {id:'inventory_accuracy', title:'Inventory accuracy issues', desc:'Inventory is not where the system says it is, leading to search time and rework.'},
  {id:'receiving_delays', title:'Receiving delays', desc:'Backlog at receiving or long time before stock becomes available.'},
  {id:'shipping_delays', title:'Shipping delays', desc:'Orders are not going out on time and service levels are at risk.'},
  {id:'manual_work', title:'Too much manual work', desc:'Paper, spreadsheets, or manual updates are slowing the team down.'},
  {id:'visibility_gaps', title:'Lack of real-time visibility', desc:'Status and location information is hard to trust or not current.'},
  {id:'spreadsheet_reliance', title:'Spreadsheet reliance', desc:'The team depends on spreadsheets because systems do not reflect reality.'},
  {id:'buffer_stock', title:'Too much safety stock', desc:'Extra inventory is carried because the team does not trust the data.'},
  {id:'picking_errors', title:'Picking errors', desc:'Mispicks and outbound mistakes are creating rework and service issues.'},
  {id:'site_inconsistency', title:'Inconsistent processes across locations', desc:'Each site works differently and standardization is difficult.'},
  {id:'integration_gaps', title:'System / integration gaps', desc:'ERP, warehouse, and operational processes do not align well.'}
];

const state = { selectedProblems: [], problemQueue: [], currentProblem: null, discovered: {}, transcript: [] };
const el = {
  painPointGrid: document.getElementById('painPointGrid'),
  otherProblem: document.getElementById('otherProblem'),
  addOtherBtn: document.getElementById('addOtherBtn'),
  selectedList: document.getElementById('selectedList'),
  selectedCount: document.getElementById('selectedCount'),
  conversation: document.getElementById('conversation'),
  emptyState: document.getElementById('emptyState'),
  completionBox: document.getElementById('completionBox'),
  activePainCard: document.getElementById('activePainCard'),
  mLocation: document.getElementById('mLocation'),
  mCause: document.getElementById('mCause'),
  mImpact: document.getElementById('mImpact'),
  mUrgency: document.getElementById('mUrgency'),
  newSessionTop: document.getElementById('newSessionTop'),
  printTop: document.getElementById('printTop'),
  template: document.getElementById('questionTemplate')
};

function statusText(value){
  if(value === 'found') return {text:'Found', cls:'status-found'};
  if(value === 'partial') return {text:'Partial', cls:'status-partial'};
  return {text:'Not found', cls:''};
}
function escapeHtml(text){ return String(text || '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }

function renderPainGrid(){
  el.painPointGrid.innerHTML = '';
  PAIN_POINTS.forEach(p => {
    const card = document.createElement('div');
    card.className = 'pain-item';
    card.innerHTML = `<label><input type="checkbox" data-id="${p.id}"><div><div class="title">${p.title}</div><div class="desc">${p.desc}</div></div></label>`;
    card.querySelector('input').addEventListener('change', e => toggleProblem(p, e.target.checked));
    el.painPointGrid.appendChild(card);
  });
}

function toggleProblem(problem, checked){
  const existing = state.selectedProblems.find(p => p.id === problem.id);
  if(checked && !existing) state.selectedProblems.push({...problem});
  if(!checked){
    state.selectedProblems = state.selectedProblems.filter(p => p.id !== problem.id);
    state.problemQueue = state.problemQueue.filter(p => p.id !== problem.id);
    if(state.currentProblem && state.currentProblem.id === problem.id) state.currentProblem = null;
  }
  renderSelectedProblems();
  if(!state.currentProblem && state.selectedProblems.length) startNextProblem();
}

function addOtherProblem(){
  const text = el.otherProblem.value.trim();
  if(!text) return;
  state.selectedProblems.push({id:'other_' + Date.now(), title:text, desc:'Custom problem entered by the BDR.'});
  el.otherProblem.value = '';
  renderSelectedProblems();
  if(!state.currentProblem) startNextProblem();
}

function renderSelectedProblems(){
  el.selectedCount.textContent = `${state.selectedProblems.length} selected`;
  el.selectedList.innerHTML = '';
  state.selectedProblems.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'selected-chip';
    chip.innerHTML = `<span>${p.title}</span><button title="Remove">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      state.selectedProblems = state.selectedProblems.filter(x => x.id !== p.id);
      const checkbox = document.querySelector(`input[data-id="${p.id}"]`);
      if(checkbox) checkbox.checked = false;
      state.problemQueue = state.problemQueue.filter(x => x.id !== p.id);
      if(state.currentProblem && state.currentProblem.id === p.id) state.currentProblem = null;
      renderSelectedProblems();
      if(!state.currentProblem && state.selectedProblems.length) startNextProblem();
      if(!state.selectedProblems.length) resetConversation();
    });
    el.selectedList.appendChild(chip);
  });
}

function resetConversation(){
  state.problemQueue = [];
  state.currentProblem = null;
  state.discovered = {};
  state.transcript = [];
  el.conversation.innerHTML = '';
  el.emptyState.classList.remove('hidden');
  el.completionBox.classList.add('hidden');
  el.activePainCard.classList.add('hidden');
  updateMetrics();
}

function buildQueue(){
  const usedIds = new Set(state.problemQueue.map(p => p.id));
  state.selectedProblems.forEach(p => {
    if(!usedIds.has(p.id) && !(state.currentProblem && state.currentProblem.id === p.id) && !state.discovered[p.id]?.completed){
      state.problemQueue.push(p);
    }
  });
}

function startNextProblem(){
  buildQueue();
  if(!state.problemQueue.length){ finishSession(); return; }
  state.currentProblem = state.problemQueue.shift();
  if(!state.discovered[state.currentProblem.id]){
    state.discovered[state.currentProblem.id] = { title:state.currentProblem.title, location:'', cause:'', impact:'', urgency:'', extraProblems:'', completed:false };
  }
  el.emptyState.classList.add('hidden');
  renderActivePain();
  askQuestion('location');
}

function renderActivePain(){
  el.activePainCard.classList.remove('hidden');
  el.activePainCard.innerHTML = `<div class="summary-box"><div class="title">Active pain point</div><div><strong>${state.currentProblem.title}</strong></div><div class="sub" style="margin-top:6px;">Use the guided questions below to work from symptom to value.</div></div>`;
  updateMetrics();
}

function stageConfig(stage){
  const title = state.currentProblem.title;
  return {
    location:{label:'Problem location', question:`Where does "${title}" show up most clearly in the operation today?`},
    cause:{label:'Likely cause', question:'What tends to cause that, or what do you believe is driving it?'},
    impact:{label:'Business impact', question:'When that happens, what does it impact most — labor, fulfillment, inventory availability, service, or something else?'},
    urgency:{label:'Why it matters', question:'Why does this matter now, and what happens if it continues as it is?'},
    other:{label:'Additional pain points', question:`Apart from "${title}", are there any other operational or business problems worth exploring? If yes, what else is happening?`}
  }[stage];
}

function askQuestion(stage){
  const tpl = el.template.content.cloneNode(true);
  const card = tpl.querySelector('.question-card');
  const cfg = stageConfig(stage);
  card.dataset.stage = stage;
  card.querySelector('.question-stage').textContent = cfg.label;
  card.querySelector('.question-text').textContent = cfg.question;
  card.querySelector('.save-response').addEventListener('click', () => saveResponse(card, stage));
  el.conversation.appendChild(card);
  card.scrollIntoView({behavior:'smooth', block:'start'});
}

function saveResponse(card, stage){
  const value = card.querySelector('.response-input').value.trim();
  if(!value) return;
  const store = state.discovered[state.currentProblem.id];
  if(stage === 'location') store.location = value;
  if(stage === 'cause') store.cause = value;
  if(stage === 'impact') store.impact = value;
  if(stage === 'urgency') store.urgency = value;
  if(stage === 'other') store.extraProblems = value;

  state.transcript.push({ problem: state.currentProblem.title, stage, question: stageConfig(stage).question, response: value });

  card.querySelector('.response-input').setAttribute('disabled','disabled');
  card.querySelector('.save-response').setAttribute('disabled','disabled');
  const view = document.createElement('div');
  view.className = 'response-view';
  view.innerHTML = `<div class="response-label">Prospect response</div><div>${escapeHtml(value)}</div>`;
  card.appendChild(view);

  updateMetrics();

  if(stage === 'location') askQuestion('cause');
  else if(stage === 'cause') askQuestion('impact');
  else if(stage === 'impact') askQuestion('urgency');
  else if(stage === 'urgency') askQuestion('other');
  else if(stage === 'other') handleOtherProblems(value);
}

function updateMetrics(){
  if(!state.currentProblem){
    const nf = statusText('not');
    el.mLocation.textContent = nf.text; el.mCause.textContent = nf.text; el.mImpact.textContent = nf.text; el.mUrgency.textContent = nf.text;
    return;
  }
  const d = state.discovered[state.currentProblem.id] || {};
  [[el.mLocation,d.location],[el.mCause,d.cause],[el.mImpact,d.impact],[el.mUrgency,d.urgency]].forEach(([node, value]) => {
    const s = statusText(value ? 'found' : 'not');
    node.textContent = s.text;
    node.className = 'value ' + s.cls;
  });
}

function handleOtherProblems(value){
  const yes = /\b(yes|yep|yeah|also|another|additional|there is|we do|we have more)\b/i.test(value);
  state.discovered[state.currentProblem.id].completed = true;
  if(yes){
    const normalized = value.replace(/^yes[,\s-]*/i, '').trim();
    if(normalized && normalized.length > 3){
      state.selectedProblems.push({ id:'other_' + Date.now(), title: normalized, desc:'Additional problem discovered during conversation.' });
      renderSelectedProblems();
    }
  }
  startNextProblem();
}

function finishSession(){
  el.activePainCard.classList.add('hidden');
  el.completionBox.classList.remove('hidden');
  const summaries = Object.values(state.discovered).filter(x => x.completed || x.location || x.cause || x.impact || x.urgency);
  const summaryHtml = summaries.map(item => `
    <div class="summary-box">
      <div class="title">${item.title}</div>
      <div><strong>Where:</strong> ${escapeHtml(item.location || 'Not captured')}</div>
      <div><strong>Cause:</strong> ${escapeHtml(item.cause || 'Not captured')}</div>
      <div><strong>Impact:</strong> ${escapeHtml(item.impact || 'Not captured')}</div>
      <div><strong>Why it matters:</strong> ${escapeHtml(item.urgency || 'Not captured')}</div>
    </div>`).join('');
  const transition = buildTransition(summaries);
  el.completionBox.innerHTML = `
    <h3 style="margin-top:0;">Suggested next step</h3>
    <p class="sub">The selected pain points have been explored. Use the summary below to guide the transition to Sales / Presales.</p>
    <div class="summary-grid">${summaryHtml}</div>
    <div class="transition-box"><div class="title">Suggested transition statement</div><div>${escapeHtml(transition)}</div></div>
    <div class="completion-actions">
      <button id="printBtn" class="btn primary">Print Conversation</button>
      <button id="newSessionBtn" class="btn secondary">Start New Session</button>
    </div>`;
  document.getElementById('printBtn').addEventListener('click', () => window.print());
  document.getElementById('newSessionBtn').addEventListener('click', newSession);
}

function buildTransition(items){
  const first = items[0];
  if(!first) return 'Thanks for the conversation. It would make sense to bring in our Sales and Presales team to determine whether any of these issues are worth exploring further.';
  return `Based on what you've shared, it sounds like ${first.title.toLowerCase()} is showing up in ${first.location || 'the operation'} and creating impact around ${first.impact || 'business performance'}. The next step that typically helps is to bring in our Sales / Presales team to walk through how organizations address issues like this and determine whether it is worth exploring further in your environment.`;
}

function newSession(){
  state.selectedProblems = [];
  state.problemQueue = [];
  state.currentProblem = null;
  state.discovered = {};
  state.transcript = [];
  document.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  el.selectedList.innerHTML = '';
  el.selectedCount.textContent = '0 selected';
  el.conversation.innerHTML = '';
  el.completionBox.classList.add('hidden');
  el.activePainCard.classList.add('hidden');
  el.emptyState.classList.remove('hidden');
  updateMetrics();
}

el.addOtherBtn.addEventListener('click', addOtherProblem);
el.newSessionTop.addEventListener('click', newSession);
el.printTop.addEventListener('click', () => window.print());

renderPainGrid();
updateMetrics();
