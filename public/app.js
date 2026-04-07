
const DEFAULT_PAIN_DESC = 'Common operational issue worth exploring through value discovery.';
const state = {
  selectedProblems: [],
  currentProblem: null,
  completedProblems: [],
  discovered: {},
  transcript: [],
  sessionId: 'sess_' + Math.random().toString(36).slice(2),
  config: null
};

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
  template: document.getElementById('questionTemplate'),
  configNotice: document.getElementById('configNotice')
};

function escapeHtml(text){ return String(text || '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }
function statusFromValue(value){ return value ? {text:'Found', cls:'status-found'} : {text:'Not found', cls:''}; }

async function loadConfig(){
  const r = await fetch('/api/config');
  const data = await r.json();
  state.config = data;
  el.configNotice.textContent = data.modelConfigured
    ? `AI is configured. Model: ${data.model || 'configured'}`
    : 'AI is not configured. Add OPENAI_API_KEY on the server to enable adaptive questioning.';
  renderPainGrid(data.pain_points || []);
}

function renderPainGrid(points){
  el.painPointGrid.innerHTML = '';
  points.forEach(title => {
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const card = document.createElement('div');
    card.className = 'pain-item';
    card.innerHTML = `<label><input type="checkbox" data-id="${id}"><div><div class="title">${title}</div><div class="desc">${DEFAULT_PAIN_DESC}</div></div></label>`;
    card.querySelector('input').addEventListener('change', e => toggleProblem({id, title, desc: DEFAULT_PAIN_DESC}, e.target.checked));
    el.painPointGrid.appendChild(card);
  });
}

function toggleProblem(problem, checked){
  const existing = state.selectedProblems.find(p => p.id === problem.id);
  if(checked && !existing) state.selectedProblems.push(problem);
  if(!checked){
    state.selectedProblems = state.selectedProblems.filter(p => p.id !== problem.id);
    if(state.currentProblem && state.currentProblem.id === problem.id) state.currentProblem = null;
  }
  renderSelectedProblems();
  if(!state.currentProblem && state.selectedProblems.length) startProblem(state.selectedProblems[0]);
}

function addOtherProblem(){
  const text = el.otherProblem.value.trim();
  if(!text) return;
  const item = { id:'other_' + Date.now(), title:text, desc:'Custom problem entered by the BDR.' };
  state.selectedProblems.push(item);
  el.otherProblem.value = '';
  renderSelectedProblems();
  if(!state.currentProblem) startProblem(item);
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
      if(state.currentProblem && state.currentProblem.id === p.id) state.currentProblem = null;
      renderSelectedProblems();
      if(!state.selectedProblems.length) newSession();
      else if(!state.currentProblem) {
        const next = state.selectedProblems.find(x => !state.completedProblems.includes(x.id)) || state.selectedProblems[0];
        startProblem(next);
      }
    });
    el.selectedList.appendChild(chip);
  });
}

function startProblem(problem){
  state.currentProblem = problem;
  if(!state.discovered[problem.id]){
    state.discovered[problem.id] = { title: problem.title, problem_location:'', likely_cause:'', business_impact:'', why_it_matters:'' };
  }
  el.emptyState.classList.add('hidden');
  renderActivePain();
  askNextQuestion('', true);
}

function renderActivePain(){
  el.activePainCard.classList.remove('hidden');
  el.activePainCard.innerHTML = `<div class="summary-box"><div class="title">Active pain point</div><div><strong>${escapeHtml(state.currentProblem.title)}</strong></div><div class="sub" style="margin-top:6px;">The AI guide will adapt the next question based on what has already been uncovered.</div></div>`;
  updateMetrics();
}

async function askNextQuestion(latestResponse){
  if(!state.config?.modelConfigured){
    addQuestionCard('location', state.currentProblem ? `Where does "${state.currentProblem.title}" show up most clearly in the operation today?` : 'Select a problem first.', '');
    return;
  }

  const payload = {
    session_id: state.sessionId,
    selected_pain_points: state.selectedProblems.map(p => p.title),
    active_problem: state.currentProblem.title,
    transcript: state.transcript,
    known_state: state.discovered[state.currentProblem.id],
    latest_response: latestResponse
  };

  const r = await fetch('/api/next-step', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if(!data.ok){
    addQuestionCard('error', data.error || 'Unable to get AI response.', '');
    return;
  }
  const result = data.result;
  state.discovered[state.currentProblem.id] = { title: state.currentProblem.title, ...(result.updated_state || {}) };
  updateMetrics();

  if(result.stage === 'complete' || result.problem_complete){
    finishCurrentProblem(result);
    return;
  }
  addQuestionCard(result.stage, result.next_question, result.question_rationale || '');
}

function addQuestionCard(stage, question, rationale){
  const tpl = el.template.content.cloneNode(true);
  const card = tpl.querySelector('.question-card');
  card.dataset.stage = stage;
  card.querySelector('.question-stage').textContent = stage;
  card.querySelector('.question-text').textContent = question;
  card.querySelector('.save-response').addEventListener('click', () => saveResponse(card, stage, question));
  if(rationale){
    const insight = document.createElement('div');
    insight.className = 'insight-view';
    insight.innerHTML = `<div class="response-label">Why this question</div><div>${escapeHtml(rationale)}</div>`;
    card.appendChild(insight);
  }
  el.conversation.appendChild(card);
  card.scrollIntoView({behavior:'smooth', block:'start'});
}

async function saveResponse(card, stage, question){
  const value = card.querySelector('.response-input').value.trim();
  if(!value) return;
  state.transcript.push({ problem: state.currentProblem.title, stage, question, response: value });
  card.querySelector('.response-input').setAttribute('disabled','disabled');
  card.querySelector('.save-response').setAttribute('disabled','disabled');
  const view = document.createElement('div');
  view.className = 'response-view';
  view.innerHTML = `<div class="response-label">Prospect response</div><div>${escapeHtml(value)}</div>`;
  card.appendChild(view);
  await askNextQuestion(value);
}

function updateMetrics(){
  if(!state.currentProblem){
    ['mLocation','mCause','mImpact','mUrgency'].forEach(k => el[k].textContent = 'Not found');
    return;
  }
  const d = state.discovered[state.currentProblem.id] || {};
  [[el.mLocation,d.problem_location],[el.mCause,d.likely_cause],[el.mImpact,d.business_impact],[el.mUrgency,d.why_it_matters]].forEach(([node, value]) => {
    const s = statusFromValue(value);
    node.textContent = s.text;
    node.className = 'value ' + s.cls;
  });
}

function finishCurrentProblem(result){
  state.completedProblems.push(state.currentProblem.id);
  state.discovered[state.currentProblem.id] = {
    ...state.discovered[state.currentProblem.id],
    transition_statement: result.transition_statement || '',
    summary_statement: result.summary_statement || ''
  };
  const next = state.selectedProblems.find(p => !state.completedProblems.includes(p.id));
  if(next && result.ask_other_problems){
    state.currentProblem = null;
    startProblem(next);
    return;
  }
  state.currentProblem = null;
  finishSession(result.transition_statement || '', result.summary_statement || '');
}

function finishSession(transition, summaryStatement){
  el.activePainCard.classList.add('hidden');
  el.completionBox.classList.remove('hidden');
  const summaries = Object.values(state.discovered);
  const summaryHtml = summaries.map(item => `
    <div class="summary-box">
      <div class="title">${escapeHtml(item.title || '')}</div>
      <div><strong>Where:</strong> ${escapeHtml(item.problem_location || 'Not captured')}</div>
      <div><strong>Cause:</strong> ${escapeHtml(item.likely_cause || 'Not captured')}</div>
      <div><strong>Impact:</strong> ${escapeHtml(item.business_impact || 'Not captured')}</div>
      <div><strong>Why it matters:</strong> ${escapeHtml(item.why_it_matters || 'Not captured')}</div>
    </div>`).join('');
  el.completionBox.innerHTML = `
    <h3 style="margin-top:0;">Suggested next step</h3>
    <p class="sub">The selected pain points have been explored. Use the summary and transition below to move the conversation to Sales / Presales.</p>
    <div class="summary-grid">${summaryHtml}</div>
    <div class="transition-box"><div class="title">Suggested summary</div><div>${escapeHtml(summaryStatement || 'No summary generated.')}</div></div>
    <div class="transition-box"><div class="title">Suggested transition statement</div><div>${escapeHtml(transition || 'No transition generated.')}</div></div>
    <div class="completion-actions">
      <button id="printBtn" class="btn primary">Print Conversation</button>
      <button id="newSessionBtn" class="btn secondary">Start New Session</button>
    </div>`;
  document.getElementById('printBtn').addEventListener('click', () => window.print());
  document.getElementById('newSessionBtn').addEventListener('click', newSession);
}

function newSession(){
  state.selectedProblems = [];
  state.currentProblem = null;
  state.completedProblems = [];
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

loadConfig();
