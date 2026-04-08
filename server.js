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

function parseJsonFromText(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON object found in model response');
    return JSON.parse(match[0]);
  } catch (err) {
    return fallbackResult("Fallback question used because the AI response was not returned in the expected format.");
  }
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({
    pain_points: PAIN_POINTS,
    modelConfigured: !!OPENAI_API_KEY,
    model: OPENAI_MODEL
  });
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
