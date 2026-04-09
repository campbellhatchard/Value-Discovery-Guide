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

function makeSafetyIdentifier(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId || 'anon')).digest('hex').slice(0, 32);
}
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
function fallbackResult(reason) {
  return {
    stage: "impact",
    next_question: "When that happens, what does it impact most in the business?",
    updated_state: { problem_location: "", likely_cause: "", business_impact: "", why_it_matters: "" },
    question_rationale: reason || "Fallback question used because the AI response was not returned in the expected format.",
    problem_complete: false,
    ask_other_problems: false,
    transition_statement: "",
    summary_statement: ""
  };
}
function stripCdata(str = '') { return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim(); }
function decodeEntities(str = '') {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
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
  return parts.join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function companyTokens(company) {
  return normalizedText(company).split(' ').filter(x => x.length >= 3);
}
function isRelevantToCompany(item, company) {
  const text = normalizedText(item.title, item.description);
  const tokens = companyTokens(company);
  if (!tokens.length) return false;
  const exactPhrase = normalizedText(company);
  if (exactPhrase && text.includes(exactPhrase)) return true;
  const matchedTokens = tokens.filter(t => text.includes(t));
  if (tokens.length === 1) return matchedTokens.length === 1;
  return matchedTokens.length >= Math.min(2, tokens.length);
}
function operationalKeywordMatches(item) {
  const keywords = [
    "inventory","warehouse","supply chain","logistics","erp","system upgrade","digital transformation",
    "automation","distribution","manufacturing","operations","facility","expansion","technology",
    "integration","oracle","sap","fusion","capital expenditure","capex","maintenance",
    "service expansion","network","modernization","migration","implementation","rollout",
    "fulfillment","distribution center","wms","procurement","material handling","plant",
    "factory","fleet","divestiture","acquisition","merger","funding","private equity","investment"
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
function confidenceForSignal(item, company) {
  const text = normalizedText(item.title, item.description);
  const exactCompany = normalizedText(company);
  const tokens = companyTokens(company);
  const matchedTokens = tokens.filter(t => text.includes(t)).length;
  const opMatches = operationalKeywordMatches(item).length;
  if (exactCompany && text.includes(exactCompany) && opMatches >= 2) return 'High';
  if (matchedTokens >= Math.min(2, tokens.length) && opMatches >= 1) return 'Medium';
  return 'Low';
}
async function fetchBingNewsSignals(companyInput) {
  const queries = [
    `"${companyInput}" inventory OR warehouse OR supply chain`,
    `"${companyInput}" ERP OR "system upgrade" OR "digital transformation" OR Oracle OR SAP OR Fusion`,
    `"${companyInput}" "capital expenditure" OR IT OR technology OR modernization OR transformation`,
    `"${companyInput}" operations OR logistics OR manufacturing OR distribution`,
    `"${companyInput}" maintenance OR service expansion OR facility OR expansion`,
    `"${companyInput}" press release OR investor OR earnings OR results OR partnership`
  ];
  const all = [];
  for (const q of queries) {
    try {
      const url = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const xml = await res.text();
      all.push(...parseRssItems(xml).map(item => ({ ...item, feed_name: 'Bing News' })));
    } catch (err) {}
  }
  return all;
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
    } catch (err) {}
  }
  return results;
}
async function fetchAllSignals(companyInput) {
  const cutoff = cutoffDateMonthsAgo(36);
  const [bingSignals, industrySignals] = await Promise.all([
    fetchBingNewsSignals(companyInput),
    fetchIndustrySignals(companyInput)
  ]);
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
    const newsItems = await fetchAllSignals(company_input || '');

    const instructions = `
You are a value engineering research assistant helping a BDR prepare for a discovery conversation.

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
  ]
}

Rules:
- Do NOT fabricate recent public signals. Recent signals are handled outside your response and must only come from the provided sourced news items.
- Adapt the opening hook, first questions, why it matters, and suggested question to the persona level.
- Manager language: practical, day-to-day, workflow oriented.
- Director language: performance, KPI, efficiency, cross-functional outcomes.
- Executive language: growth, risk, customer impact, margin, scalability.
- Keep outputs concise and practical for a BDR.
- "smart_first_questions" must be discovery-led, not product-led.
- "likely_operational_triggers" must be dynamic to the company and industry, not generic.
- Rank the likely_operational_triggers from most likely to least likely.
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
${JSON.stringify(newsItems, null, 2)}`
        }]
      }],
      temperature: 0.2,
      max_output_tokens: 1600,
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
    if (!Array.isArray(parsed.likely_operational_triggers)) parsed.likely_operational_triggers = [];
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

You must adapt:
- question wording
- business language
- impact framing
- transition statement

Guidelines by persona:
Manager: workflow, tasks, errors, delays, day-to-day friction.
Director: KPIs, efficiency, cross-functional performance, labor, service levels, cost.
Executive: revenue, risk, customer impact, growth, scale, margin.

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
- If the latest response is vague, propose a more specific follow-up question.
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
      store: false,
      safety_identifier: makeSafetyIdentifier(session_id)
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
