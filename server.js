require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();

app.use(express.json({ limit: '2mb' }));
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

function makeSafetyIdentifier(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId || 'anon')).digest('hex').slice(0, 32);
}

function extractOutputText(resp) {
  if (resp.output_text) return resp.output_text;
  let texts = [];
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
    updated_state: {
      problem_location: "",
      likely_cause: "",
      business_impact: "",
      why_it_matters: ""
    },
    question_rationale: reason || "Fallback question used because the AI response was not returned in the expected format.",
    problem_complete: false,
    ask_other_problems: false,
    transition_statement: "",
    summary_statement: ""
  };
}

function stripCdata(str = '') {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function decodeEntities(str = '') {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseRssItems(xml = '') {
  const items = [];
  const matches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const itemXml of matches) {
    const title = decodeEntities(stripCdata((itemXml.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1]));
    const link = decodeEntities(stripCdata((itemXml.match(/<link>([\s\S]*?)<\/link>/i) || [, ''])[1]));
    const pubDate = decodeEntities(stripCdata((itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [, ''])[1]));
    const source = decodeEntities(stripCdata((itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [, ''])[1]));
    if (title && link) items.push({ title, link, pubDate, source });
  }
  return items;
}

function uniqByLink(items) {
  const seen = new Set();
  return items.filter(item => {
    if (!item.link || seen.has(item.link)) return false;
    seen.add(item.link);
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

async function fetchNewsSignals(companyInput) {
  const queries = [
    `"${companyInput}" inventory OR warehouse OR supply chain`,
    `"${companyInput}" ERP OR "system upgrade" OR "digital transformation"`,
    `"${companyInput}" "capital expenditure" OR IT OR technology`,
    `"${companyInput}" operations OR logistics OR manufacturing`
  ];

  const all = [];
  for (const q of queries) {
    try {
      const url = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const xml = await res.text();
      all.push(...parseRssItems(xml));
    } catch (err) {
      // ignore query-level errors so the route still works
    }
  }

  const unique = uniqByLink(all).map(item => ({
    signal: item.title,
    date: formatDate(item.pubDate),
    source_name: item.source || '',
    source_url: item.link
  }));

  return sortSignalsByMostRecent(unique).slice(0, 10);
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({
    pain_points: PAIN_POINTS,
    modelConfigured: !!OPENAI_API_KEY,
    model: OPENAI_MODEL
  });
});

app.post('/api/company-insight', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY not configured' });
    }

    const { company_input } = req.body || {};
    const newsItems = await fetchNewsSignals(company_input || '');

    const instructions = `
You are a value engineering research assistant helping a BDR prepare for a discovery conversation.

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
- If the company is not well known, make cautious, practical inferences for company overview and industry.
- Focus on inventory, operations, and systems.
- Keep outputs concise and practical for a BDR.
- "opening_hook" should sound natural and informed, but must not claim specific recent events unless they are directly reflected in the provided news items.
- "smart_first_questions" must be discovery-led, not product-led.
- "likely_operational_triggers" must be dynamic to the company and industry, not generic, and each trigger must include:
  - why this may be occurring
  - why this is inferred
  - why it matters
  - one suggested discovery question
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

Sourced recent news items:
${JSON.stringify(newsItems, null, 2)}`
        }]
      }],
      temperature: 0.2,
      max_output_tokens: 1400,
      store: false
    };

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    if (!response.ok) {
      return res.status(500).json({ ok: false, error: raw });
    }

    const parsedBody = JSON.parse(raw);
    const text = extractOutputText(parsedBody);
    const parsed = parseJsonFromText(text);

    parsed.recent_signals = newsItems;
    if (!Array.isArray(parsed.likely_operational_triggers)) parsed.likely_operational_triggers = [];
    res.json({ ok: true, result: parsed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Unknown server error' });
  }
});

app.post('/api/next-step', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY is not configured on the server.' });
    }

    const { session_id, selected_pain_points, active_problem, transcript, known_state, latest_response } = req.body || {};

    const instructions = `You are an AI-assisted Value Discovery Guide for a BDR working live with a prospect.
Your job is to help the BDR ask smarter discovery questions and know when to transition to Sales / Presales.

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
- If a field is not yet clearly established, use the next question to clarify it.
- If the latest response is vague, propose a more specific follow-up question.
- Use consultative language, not product pitching.
- Only set stage to "complete" when the problem is sufficiently explored or the user says there are no more problems to explore.
- The transition statement should sound like a natural move to a meeting with Sales / Presales and should be based on the discovered problem and impact.
- Keep the summary statement concise and sales-ready.`;

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
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    if (!response.ok) {
      return res.status(500).json({ ok: false, error: raw });
    }

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

app.listen(PORT, () => {
  console.log(`Value Discovery Guide AI Assisted running on port ${PORT}`);
});
