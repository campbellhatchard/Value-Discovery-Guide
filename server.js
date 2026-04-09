require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();

app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PAIN_POINTS = [
  "Inventory accuracy issues",
  "Receiving delays",
  "Shipping delays",
  "Too much manual work",
  "Lack of real-time visibility",
  "Spreadsheet reliance",
  "Too much safety stock",
  "Picking errors",
  "Inconsistent processes across locations",
  "System / integration gaps"
];

const RSS_FEEDS = [
  "https://www.supplychaindive.com/feeds/news",
  "https://www.supplychain247.com/rss",
  "https://www.supplychainbrain.com/rss/articles",
  "https://feeds.feedburner.com/logisticsmgmt/latest",
  "https://logisticsviewpoints.com/feed",
  "https://warehousenews.co.uk/feed",
  "https://www.mmh.com/rss",
  "https://www.dcvelocity.com/rss",
  "https://www.extensiv.com/blog/rss.xml",
  "https://www.tecsys.com/blog/rss.xml",
  "https://www.manufacturingdive.com/feeds/news",
  "https://www.industryweek.com/rss",
  "https://www.mdm.com/feed",
  "https://www.inddist.com/feed",
  "https://www.manufacturingtomorrow.com/rss_feed.php",
  "https://news.crunchbase.com/feed",
  "https://www.nytimes.com/svc/collections/v1/publish/www.nytimes.com/topic/subject/mergers-acquisitions-and-divestitures/rss.xml",
  "https://www.theguardian.com/business/mergers-and-acquisitions/rss",
  "https://www.pehub.com/feed",
  "https://peprofessional.com/feed",
  "https://www.venturecapitaljournal.com/feed",
  "https://www.deallawyers.com/blog/feed",
  "https://www.clearymawatch.com/feed"
];

function extractOutputText(resp) {
  if (resp.output_text) return resp.output_text;
  const texts = [];
  for (const item of (resp.output || [])) {
    for (const c of (item.content || [])) {
      if (typeof c.text === 'string') texts.push(c.text);
      else if (c.text && typeof c.text.value === 'string') texts.push(c.text.value);
    }
  }
  return texts.join('\n').trim();
}
function parseJsonFromText(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in model response');
  return JSON.parse(match[0]);
}
function stripCdata(str = '') { return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim(); }
function decodeEntities(str = '') {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function decodeHtmlBasic(str = '') {
  return decodeEntities(String(str).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function parseRssItems(xml = '') {
  const items = [];
  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const itemXml of itemMatches) {
    const title = decodeEntities(stripCdata((itemXml.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1]));
    const link = decodeEntities(stripCdata((itemXml.match(/<link>([\s\S]*?)<\/link>/i) || [, ''])[1]));
    const pubDate = decodeEntities(stripCdata((itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [, ''])[1]));
    const description = decodeEntities(stripCdata((itemXml.match(/<description>([\s\S]*?)<\/description>/i) || [, ''])[1]));
    const source = decodeEntities(stripCdata((itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [, ''])[1]));
    if (title && link) items.push({ title, link, pubDate, description, source });
  }
  return items;
}
function uniqByLink(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.source_url || item.link || '';
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function formatDate(dateStr = '') {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
function sortSignalsByMostRecent(items) {
  return [...items].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });
}
function cutoffDateMonthsAgo(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}
function normalizedText(...parts) {
  return parts.join(' ').toLowerCase().replace(/[^a-z0-9\s.:/_-]/g, ' ').replace(/\s+/g, ' ').trim();
}
function normalizeDomainLike(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .trim();
}
function extractSearchTarget(companyOrUrl = '') {
  const raw = String(companyOrUrl || '').trim();
  const isUrl = /^https?:\/\//i.test(raw) || /\.[a-z]{2,}(\/|$)/i.test(raw);
  if (isUrl) return { mode: 'domain', raw, exact: normalizeDomainLike(raw) };
  return { mode: 'company', raw, exact: normalizedText(raw) };
}
function containsExactCompanyPhrase(text, exactPhrase) {
  if (!exactPhrase) return false;
  const escaped = exactPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i');
  return regex.test(text);
}
function containsExactDomain(text, domain) {
  if (!domain) return false;
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(^|\\s|https?://|www\\.)${escaped}(\\s|/|$)`, 'i');
  return regex.test(text);
}
function isRelevantToCompany(item, companyOrUrl) {
  const target = extractSearchTarget(companyOrUrl);
  const text = normalizedText(item.title, item.description, item.link, item.source);
  if (target.mode === 'domain') return containsExactDomain(text, target.exact);
  return containsExactCompanyPhrase(text, target.exact);
}
function operationalKeywordMatches(item) {
  const keywords = [
    "inventory","warehouse","supply chain","logistics","erp","system upgrade","digital transformation",
    "automation","distribution","manufacturing","operations","facility","expansion","technology",
    "integration","oracle","sap","fusion","capital expenditure","capex","maintenance","service expansion",
    "network","modernization","migration","implementation","rollout","fulfillment","distribution center",
    "wms","procurement","material handling","plant","factory","fleet","divestiture","acquisition","merger",
    "funding","private equity","investment"
  ];
  const text = normalizedText(item.title, item.description);
  return keywords.filter(k => text.includes(normalizedText(k)));
}
function categorizeSignal(item) {
  const text = normalizedText(item.title, item.description);
  if (/(acquisition|acquire|merger|divestiture|private equity|investment|funding|deal|capital raise)/.test(text)) return 'M&A / Funding';
  if (/(oracle|sap|erp|fusion|system upgrade|digital transformation|modernization|migration|implementation|rollout|integration)/.test(text)) return 'ERP / Technology';
  if (/(warehouse|inventory|fulfillment|distribution center|wms|material handling)/.test(text)) return 'Warehouse / Inventory';
  if (/(manufacturing|plant|factory|production|industrial|distribution)/.test(text)) return 'Manufacturing / Distribution';
  if (/(logistics|supply chain|operations|fleet|maintenance|service expansion|facility|expansion)/.test(text)) return 'Operations / Logistics';
  return 'General';
}
function confidenceForSignal(item, companyOrUrl) {
  const target = extractSearchTarget(companyOrUrl);
  const text = normalizedText(item.title, item.description, item.link, item.source);
  const exactMatch = target.mode === 'domain'
    ? containsExactDomain(text, target.exact)
    : containsExactCompanyPhrase(text, target.exact);
  const opMatches = operationalKeywordMatches(item).length;
  if (exactMatch && opMatches >= 2) return 'High';
  if (exactMatch && opMatches >= 1) return 'Medium';
  return 'Low';
}
function firstGroup(re, text) {
  const m = text.match(re);
  return m ? m[1] : '';
}
function uniqueStrings(arr) {
  return [...new Set((arr || []).filter(Boolean).map(x => String(x).trim()).filter(Boolean))];
}
function absoluteUrl(baseUrl, href) {
  try { return new URL(href, baseUrl).href; } catch { return ''; }
}
function extractLinks(html = '', baseUrl = '') {
  const links = [];
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = absoluteUrl(baseUrl, decodeEntities(m[1]));
    const label = decodeHtmlBasic(m[2] || '');
    if (href) links.push({ href, label });
  }
  return links;
}
function likelyAboutLinks(links = [], baseDomain = '') {
  const allow = ['about', 'company', 'who we are', 'our company', 'leadership', 'investor', 'investors', 'corporate', 'overview'];
  return links.filter(l => {
    const h = normalizedText(l.href);
    const label = normalizedText(l.label);
    const sameDomain = normalizeDomainLike(l.href) === baseDomain;
    return sameDomain && allow.some(x => h.includes(normalizedText(x)) || label.includes(normalizedText(x)));
  }).slice(0, 5);
}
function extractJsonLdObjects(html = '') {
  const objs = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = stripCdata(m[1] || '');
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) objs.push(...parsed);
      else objs.push(parsed);
    } catch {}
  }
  return objs;
}
function findOrgDataFromJsonLd(objs = []) {
  const out = { names: [], legalNames: [], parents: [], subs: [] };
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    const t = normalizedText(node['@type'] || node.type || '');
    if (t.includes('organization') || t.includes('corporation') || t.includes('localbusiness')) {
      if (node.name) out.names.push(node.name);
      if (node.legalName) out.legalNames.push(node.legalName);
      const p = node.parentOrganization;
      if (p) {
        if (typeof p === 'string') out.parents.push(p);
        else if (p.name) out.parents.push(p.name);
      }
      const s = node.subOrganization || node.subsidiary;
      if (Array.isArray(s)) s.forEach(x => { if (typeof x === 'string') out.subs.push(x); else if (x && x.name) out.subs.push(x.name); });
      else if (s) { if (typeof s === 'string') out.subs.push(s); else if (s.name) out.subs.push(s.name); }
    }
    Object.values(node).forEach(v => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    });
  }
  objs.forEach(walk);
  out.names = uniqueStrings(out.names);
  out.legalNames = uniqueStrings(out.legalNames);
  out.parents = uniqueStrings(out.parents);
  out.subs = uniqueStrings(out.subs);
  return out;
}
function extractEntitySnippets(text = '') {
  const lines = String(text).split(/(?<=[.!?])\s+/).slice(0, 300);
  const matches = [];
  const patterns = [/\b(parent company|owned by|part of|subsidiary of|a subsidiary of|division of)\b/i, /\b(llc|inc|corp|corporation|ltd|limited|pty|pty ltd|plc)\b/i];
  for (const line of lines) if (patterns.some(p => p.test(line))) matches.push(line.trim());
  return uniqueStrings(matches).slice(0, 8);
}
async function resolveOfficialDomain(companyInput = '') {
  const target = extractSearchTarget(companyInput);
  if (target.mode === 'domain') return { official_domain: target.exact, official_url: `https://${target.exact}` };
  const queries = [`"${companyInput}" official site`, `"${companyInput}" company`, `"${companyInput}" about`];
  for (const q of queries) {
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-US`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const html = await res.text();
      const candidates = [...html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"/gi)].map(m => m[1]);
      for (const c of candidates) {
        const domain = normalizeDomainLike(c);
        if (!domain) continue;
        if (domain.includes('bing.com') || domain.includes('microsoft.com') || domain.includes('youtube.com') || domain.includes('linkedin.com')) continue;
        return { official_domain: domain, official_url: `https://${domain}` };
      }
    } catch {}
  }
  return { official_domain: '', official_url: '' };
}
async function fetchPage(url = '') {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { url, html: '', text: '' };
    const html = await res.text();
    return { url, html, text: decodeHtmlBasic(html) };
  } catch { return { url, html: '', text: '' }; }
}
async function fetchCompanyEntityIntelligence(companyInput = '') {
  const domainInfo = await resolveOfficialDomain(companyInput);
  if (!domainInfo.official_url) return { official_domain: '', official_company_name: '', legal_entity_name: '', parent_entities: [], subsidiary_entities: [], entity_notes: [] };

  const home = await fetchPage(domainInfo.official_url);
  const homeLinks = extractLinks(home.html, domainInfo.official_url);
  const relatedLinks = likelyAboutLinks(homeLinks, domainInfo.official_domain);
  const relatedPages = [];
  for (const link of relatedLinks.slice(0, 3)) relatedPages.push(await fetchPage(link.href));

  const allHtml = [home.html, ...relatedPages.map(p => p.html)].join('\n');
  const allText = [home.text, ...relatedPages.map(p => p.text)].join('\n');

  const titleName = firstGroup(/<title[^>]*>([\s\S]*?)<\/title>/i, home.html);
  const ogSiteName = firstGroup(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i, home.html);
  const appName = firstGroup(/<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["']/i, home.html);
  const jsonLdData = findOrgDataFromJsonLd(extractJsonLdObjects(allHtml));

  const companyNames = uniqueStrings([...jsonLdData.names, decodeEntities(titleName).split('|')[0].trim(), decodeEntities(ogSiteName).trim(), decodeEntities(appName).trim()]).filter(x => x.length >= 3);
  const legalNames = uniqueStrings(jsonLdData.legalNames);
  const parentEntities = uniqueStrings(jsonLdData.parents);
  const subsidiaryEntities = uniqueStrings(jsonLdData.subs);
  const entityNotes = extractEntitySnippets(allText);

  return {
    official_domain: domainInfo.official_domain,
    official_company_name: companyNames[0] || '',
    legal_entity_name: legalNames[0] || '',
    parent_entities: parentEntities,
    subsidiary_entities: subsidiaryEntities,
    entity_notes: entityNotes
  };
}
async function fetchBingNewsSignals(companyInput) {
  const target = extractSearchTarget(companyInput);
  const exactQuery = target.mode === 'domain' ? `"${target.exact}"` : `"${target.raw}"`;
  const queries = [
    `${exactQuery} inventory OR warehouse OR supply chain`,
    `${exactQuery} ERP OR "system upgrade" OR "digital transformation" OR Oracle OR SAP OR Fusion`,
    `${exactQuery} "capital expenditure" OR IT OR technology OR modernization OR transformation`,
    `${exactQuery} operations OR logistics OR manufacturing OR distribution`,
    `${exactQuery} maintenance OR service expansion OR facility OR expansion`,
    `${exactQuery} press release OR investor OR earnings OR results OR partnership`
  ];
  const all = [];
  for (const q of queries) {
    try {
      const url = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const xml = await res.text();
      all.push(...parseRssItems(xml).map(item => ({ ...item, feed_name: 'Bing News' })));
    } catch {}
  }
  return all.filter(item => isRelevantToCompany(item, companyInput));
}
async function fetchIndustrySignals(companyInput) {
  const results = [];
  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetch(feed, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseRssItems(xml);
      for (const item of items) {
        if (isRelevantToCompany(item, companyInput) && operationalKeywordMatches(item).length) {
          results.push({ ...item, feed_name: feed });
        }
      }
    } catch {}
  }
  return results;
}
async function fetchAllSignals(companyInput) {
  const cutoff = cutoffDateMonthsAgo(36);
  const [bingSignals, industrySignals] = await Promise.all([fetchBingNewsSignals(companyInput), fetchIndustrySignals(companyInput)]);
  const combined = [...bingSignals, ...industrySignals].map(item => ({
    signal: item.title,
    date: formatDate(item.pubDate),
    source_name: item.source || item.feed_name || 'Source',
    source_url: item.link,
    category: categorizeSignal(item),
    confidence: confidenceForSignal(item, companyInput),
    description: item.description || ''
  })).filter(item => {
    if (!item.date) return true;
    const t = new Date(item.date).getTime();
    return !isNaN(t) && t >= cutoff;
  });
  return sortSignalsByMostRecent(uniqByLink(combined)).slice(0, 18);
}

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json({ pain_points: PAIN_POINTS, modelConfigured: !!OPENAI_API_KEY, model: OPENAI_MODEL }));

app.post('/api/company-insight', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY not configured' });
    const { company_input, persona_level } = req.body || {};
    const [newsItems, entityIntel] = await Promise.all([fetchAllSignals(company_input || ''), fetchCompanyEntityIntelligence(company_input || '')]);

    const instructions = `
You are a value engineering intelligence assistant helping a BDR or sales rep prepare for a discovery conversation.

The BDR is speaking to a:
- manager → operational focus
- director → performance/KPI focus
- executive → strategic/business outcome focus

Persona level: ${persona_level || 'manager'}

Return ONLY valid JSON in this exact format:
{
  "company_overview": "string",
  "industry": "string",
  "inventory_challenges": {
    "warehouse": ["string"],
    "manufacturing": ["string"],
    "field_inventory": ["string"]
  },
  "discovery_angles": ["string"],
  "opening_hook": "string",
  "smart_first_questions": ["string", "string", "string"],
  "likely_operational_triggers": [
    {
      "title": "string",
      "why_occurring": "string",
      "why_inferred": "string",
      "why_it_matters": "string",
      "suggested_question": "string"
    }
  ],
  "bdr_company_notes": ["string"],
  "why_this_matters_now": ["string"],
  "buying_group_intelligence": [
    {
      "role_group": "string",
      "likely_interest": "string",
      "why_they_care": "string"
    }
  ],
  "working_hypotheses": ["string"],
  "likely_pushback": [
    {
      "objection": "string",
      "smart_response_framing": "string"
    }
  ],
  "impact_benchmarks": [
    {
      "metric": "string",
      "typical_range": "string",
      "why_it_matters": "string"
    }
  ]
}

Rules:
- Do NOT fabricate recent public signals, legal names, domains, parent companies, subsidiaries, or benchmarks.
- Recent signals are handled outside your response and must only come from the provided sourced news items.
- Company identity details are handled outside your response and must only come from provided domain/entity evidence.
- Benchmarks must be directional and framed as typical ranges, not company-specific claims.
- Adapt wording to persona level.
- Keep outputs concise and practical for a BDR or sales rep.
`;

    const payload = {
      model: OPENAI_MODEL,
      instructions,
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: `Company input: ${company_input || ''}

Sourced recent news items from last 36 months:
${JSON.stringify(newsItems, null, 2)}

Resolved domain and entity evidence:
${JSON.stringify(entityIntel, null, 2)}`
        }]
      }],
      temperature: 0.2,
      max_output_tokens: 2200,
      store: false
    };

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    if (!response.ok) return res.status(500).json({ ok: false, error: raw });

    const parsedBody = JSON.parse(raw);
    const parsed = parseJsonFromText(extractOutputText(parsedBody));

    parsed.recent_signals = newsItems;
    parsed.company_identity = entityIntel;

    for (const key of [
      'likely_operational_triggers', 'bdr_company_notes', 'why_this_matters_now',
      'buying_group_intelligence', 'working_hypotheses', 'likely_pushback', 'impact_benchmarks'
    ]) {
      if (!Array.isArray(parsed[key])) parsed[key] = [];
    }

    res.json({ ok: true, result: parsed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Unknown server error' });
  }
});

app.post('/api/next-step', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY is not configured on the server.' });

    const { session_id, selected_pain_points, active_problem, transcript, known_state, latest_response, persona_level } = req.body || {};

    const instructions = `You are an AI-assisted Value Discovery Guide for a BDR working live with a prospect.

The BDR is speaking to a:
- manager → operational focus
- director → performance/KPI focus
- executive → strategic/business outcome focus

Persona level: ${persona_level || 'manager'}

Return ONLY valid JSON in this exact shape:
{
  "stage": "location|cause|impact|urgency|other_problems|complete",
  "next_question": "string",
  "updated_state": {
    "problem_location": "string",
    "likely_cause": "string",
    "business_impact": "string",
    "why_it_matters": "string"
  },
  "question_rationale": "string",
  "problem_complete": true,
  "ask_other_problems": true,
  "transition_statement": "string",
  "summary_statement": "string"
}

Rules:
- Ask one question at a time.
- Questions must be concise, practical, and natural for a BDR to ask live.
- Follow a value discovery flow: location -> cause -> impact -> urgency -> other problems -> transition.
- Use consultative language, not product pitching.
- The transition statement should be conversational and include:
  1. a concise problem statement
  2. a concise impact statement
  3. a proposal to investigate further in a follow-up meeting.`;

    const payload = {
      model: OPENAI_MODEL,
      instructions,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: `Selected pain points:
${JSON.stringify(selected_pain_points || [], null, 2)}

Active problem:
${active_problem || ''}

Known state:
${JSON.stringify(known_state || {}, null, 2)}

Transcript:
${JSON.stringify(transcript || [], null, 2)}

Latest prospect response:
${latest_response || ''}`
        }]
      }],
      temperature: 0.3,
      max_output_tokens: 900,
      store: false
    };

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    if (!response.ok) return res.status(500).json({ ok: false, error: raw });

    let parsed;
    try {
      const parsedBody = JSON.parse(raw);
      parsed = parseJsonFromText(extractOutputText(parsedBody));
    } catch (err) {
      parsed = fallbackResult("Fallback question used because the server could not safely interpret the AI response.");
    }
    res.json({ ok: true, result: parsed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Unknown server error' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((req, res) => res.status(404).send('Not Found'));
app.listen(PORT, () => console.log(`Value Discovery Guide AI Assisted running on port ${PORT}`));
