function renderCompanyInsights(data) {
  el.companyResults.classList.remove('hidden');

  const signals = Array.isArray(data.recent_signals) ? [...data.recent_signals] : [];
  signals.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  const recentSignalsHtml = signals.length
    ? signals.slice(0, 5).map(x => `
      <li>
        <div><strong>${escapeHtml(x.signal || '')}</strong></div>
        <div style="font-size:12px;color:#5B7083;margin-top:4px;">
          ${escapeHtml(x.date || '')}${x.source_name ? ' · ' + escapeHtml(x.source_name) : ''}
          ${x.source_url ? ` · <a href="${x.source_url}" target="_blank" rel="noopener noreferrer">Source</a>` : ''}
        </div>
      </li>
    `).join('')
    : `<li>I couldn't find any recent data.</li>`;

  el.companyResults.innerHTML = `
    <div class="summary-box" style="margin-top:14px;">
      <div class="title">Company Overview</div>
      <div>${escapeHtml(data.company_overview || '')}</div>
    </div>
    <div class="summary-box" style="margin-top:10px;">
      <div class="title">Industry</div>
      <div>${escapeHtml(data.industry || '')}</div>
    </div>
    <div class="summary-box" style="margin-top:10px;">
      <div class="title">Recent Signals</div>
      <ul>${recentSignalsHtml}</ul>
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
