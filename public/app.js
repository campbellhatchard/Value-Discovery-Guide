function renderCompanyInsights(data) {
  if (!el.companyResults) return;
  el.companyResults.classList.remove('hidden');

  state.companyTriggers = Array.isArray(data.likely_operational_triggers) ? data.likely_operational_triggers : [];
  renderTriggerPainGrid();

  const identity = data.company_identity || {};
  const parentHtml = (identity.parent_entities || []).length ? `<ul>${identity.parent_entities.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : `<div>Not found</div>`;
  const subsidiaryHtml = (identity.subsidiary_entities || []).length ? `<ul>${identity.subsidiary_entities.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : `<div>Not found</div>`;
  const noteHtml = (identity.entity_notes || []).length ? `<ul>${identity.entity_notes.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : `<div>None identified</div>`;
  const bdrNotesHtml = (data.bdr_company_notes || []).length ? `<ul>${data.bdr_company_notes.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : `<div>No additional BDR notes generated.</div>`;
  const whyNowHtml = (data.why_this_matters_now || []).length ? `<ul>${data.why_this_matters_now.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : `<div>No urgency notes generated.</div>`;
  const hypothesesHtml = (data.working_hypotheses || []).length ? `<ul>${data.working_hypotheses.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : `<div>No hypotheses generated.</div>`;
  const buyingGroupHtml = (data.buying_group_intelligence || []).length
    ? data.buying_group_intelligence.map(x => `
      <div class="summary-box" style="margin-top:10px;">
        <div class="title">${escapeHtml(x.role_group || '')}</div>
        <div><strong>Likely interest:</strong><br>${escapeHtml(x.likely_interest || '')}</div>
        <div style="margin-top:6px;"><strong>Why they care:</strong><br>${escapeHtml(x.why_they_care || '')}</div>
      </div>`).join('')
    : `<div>No buying group intelligence generated.</div>`;
  const pushbackHtml = (data.likely_pushback || []).length
    ? data.likely_pushback.map(x => `
      <div class="summary-box" style="margin-top:10px;">
        <div class="title">Likely Pushback</div>
        <div><strong>${escapeHtml(x.objection || '')}</strong></div>
        <div style="margin-top:6px;"><strong>Smart response framing:</strong><br>${escapeHtml(x.smart_response_framing || '')}</div>
      </div>`).join('')
    : `<div>No likely pushback generated.</div>`;
  const benchmarksHtml = (data.impact_benchmarks || []).length
    ? data.impact_benchmarks.map(x => `
      <div class="summary-box" style="margin-top:10px;">
        <div class="title">${escapeHtml(x.metric || '')}</div>
        <div><strong>Typical range:</strong> ${escapeHtml(x.typical_range || '')}</div>
        <div style="margin-top:6px;"><strong>Why it matters:</strong><br>${escapeHtml(x.why_it_matters || '')}</div>
      </div>`).join('')
    : `<div>No benchmark ranges generated.</div>`;

  const signals = Array.isArray(data.recent_signals) ? [...data.recent_signals] : [];
  signals.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  const recentSignalsHtml = signals.length
    ? signals.slice(0, 8).map(x => `
      <li>
        <div><strong>${escapeHtml(x.signal || '')}</strong></div>
        <div class="signal-meta">
          ${x.category ? `<span class="badge">${escapeHtml(x.category)}</span>` : ''}
          ${x.confidence ? `<span class="badge ${String(x.confidence).toLowerCase()}">${escapeHtml(x.confidence)} confidence</span>` : ''}
        </div>
        <div style="font-size:12px;color:#5B7083;margin-top:4px;">
          ${escapeHtml(x.date || '')}${x.source_name ? ' · ' + escapeHtml(x.source_name) : ''}
          ${x.source_url ? ` · <a href="${x.source_url}" target="_blank" rel="noopener noreferrer">Source</a>` : ''}
        </div>
      </li>
    `).join('')
    : `<li>No verifiable results found.</li>`;

  const triggersHtml = state.companyTriggers.length
    ? state.companyTriggers.map(t => `
      <div class="summary-box" style="margin-top:10px;">
        <div class="title">${escapeHtml(t.title || '')}</div>
        <div><strong>Why this may be occurring:</strong><br>${escapeHtml(t.why_occurring || '')}</div>
        <div style="margin-top:6px;"><strong>Why this is inferred:</strong><br>${escapeHtml(t.why_inferred || '')}</div>
        <div style="margin-top:6px;"><strong>Why it matters:</strong><br>${escapeHtml(t.why_it_matters || '')}</div>
        ${t.suggested_question ? `<div class="trigger-question"><strong>Suggested discovery question:</strong><br>${escapeHtml(t.suggested_question)}</div>` : ''}
      </div>
    `).join('')
    : `<div class="summary-box" style="margin-top:10px;">No inferred operational triggers were generated.</div>`;

  el.companyResults.innerHTML = `
    <div class="summary-box" style="margin-top:14px;">
      <div class="title">Company Overview</div>
      <div>${escapeHtml(data.company_overview || '')}</div>
    </div>

    <div class="summary-box" style="margin-top:10px;">
      <div class="title">Company Identity</div>
      <div><strong>Official Domain:</strong> ${escapeHtml(identity.official_domain || 'Not found')}</div>
      <div style="margin-top:6px;"><strong>Full Company Name:</strong> ${escapeHtml(identity.official_company_name || 'Not found')}</div>
      <div style="margin-top:6px;"><strong>Legal Entity Name:</strong> ${escapeHtml(identity.legal_entity_name || 'Not found')}</div>
      <div style="margin-top:10px;"><strong>Parent Companies / Related Parent Entities</strong>${parentHtml}</div>
      <div style="margin-top:10px;"><strong>Subsidiaries / Related Entities</strong>${subsidiaryHtml}</div>
      <div style="margin-top:10px;"><strong>Supporting Entity Notes</strong>${noteHtml}</div>
    </div>

    <div class="summary-box" style="margin-top:10px;">
      <div class="title">Why This Matters Now</div>
      ${whyNowHtml}
    </div>

    <div class="summary-box" style="margin-top:10px;">
      <div class="title">BDR Notes on Company Structure</div>
      ${bdrNotesHtml}
    </div>

    <div class="summary-box" style="margin-top:10px;">
      <div class="title">Industry</div>
      <div>${escapeHtml(data.industry || '')}</div>
    </div>

    <div class="summary-box" style="margin-top:10px;">
      <div class="title">Recent Signals</div>
      <ul>${recentSignalsHtml}</ul>
      <div class="summary-box" style="margin-top:10px;">
        <div class="title">Likely Operational Triggers (Inferred)</div>
        <div style="font-size:12px;color:#5B7083;margin-bottom:8px;">
          Based on industry patterns and operating model — validate during discovery
        </div>
        ${triggersHtml}
      </div>
    </div>

    <div class="summary-box" style="margin-top:10px;">
      <div class="title">Working Hypotheses</div>
      ${hypothesesHtml}
    </div>

    <div class="summary-box" style="margin-top:10px;">
      <div class="title">Buying Group Intelligence</div>
      ${buyingGroupHtml}
    </div>

    <div class="summary-box" style="margin-top:10px;">
      <div class="title">Likely Pushback and Smart Response Framing</div>
      ${pushbackHtml}
    </div>

    <div class="summary-box" style="margin-top:10px;">
      <div class="title">Typical Impact Benchmarks</div>
      ${benchmarksHtml}
    </div>

    <div class="summary-box" style="margin-top:10px;">
      <div class="title">Likely Inventory Challenges</div>
      <strong>Warehouse</strong>
      <ul>${((data.inventory_challenges || {}).warehouse || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      <strong>Manufacturing</strong>
      <ul>${((data.inventory_challenges || {}).manufacturing || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      <strong>Field Inventory</strong>
      <ul>${((data.inventory_challenges || {}).field_inventory || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
    </div>

    <div class="summary-box" style="margin-top:10px;">
      <div class="title">Suggested Discovery Angles</div>
      <ul>${(data.discovery_angles || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
    </div>

    <div class="transition-box">
      <div class="title">Opening Hook</div>
      <div>${escapeHtml(data.opening_hook || '')}</div>
    </div>

    <div class="transition-box">
      <div class="title">3 Smart First Questions</div>
      <ol>${(data.smart_first_questions || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ol>
    </div>
  `;
}
