require('dotenv').config();
const express = require('express');
const path = require('path');
const { staticFeeds } = require('./feedCatalog');

const app = express();
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();

app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PAIN_POINTS = [
  'Inventory accuracy issues',
  'Receiving delays',
  'Shipping delays',
  'Too much manual work',
  'Lack of real-time visibility',
  'Spreadsheet reliance',
  'Too much safety stock',
  'Picking errors',
  'Inconsistent processes across locations',
  'System / integration gaps'
];

const MAX_SIGNAL_RESULTS = 24;
const FEED_FETCH_TIMEOUT_MS = 9000;
const FEED_LOOKBACK_YEARS = 5;
const MAX_PAGES_PER_DOMAIN = 20;
const MAX_LINKED_DOMAINS = 8;
const MAX_PDFS_PER_RUN = 16;
const MAX_TEXT_CHARS = 180000;

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
    stage: 'impact',
    next_question: 'When that happens, what does it impact most in the business?',
    updated_state: { problem_location: '', likely_cause: '', business_impact: '', why_it_matters: '' },
    question_rationale: reason || 'Fallback question used because the AI response was not returned in the expected format.',
    problem_complete: false,
    ask_other_problems: false,
    transition_statement: '',
    summary_statement: ''
  };
}
function stripCdata(str = '') {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}
function decodeEntities(str = '') {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function decodeHtmlBasic(str = '') {
  return decodeEntities(String(str)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}
function firstGroup(re, text) {
  const m = String(text || '').match(re);
  return m ? m[1] : '';
}
function uniqueStrings(arr) {
  return [...new Set((arr || []).filter(Boolean).map(x => String(x).trim()).filter(Boolean))];
}
function absoluteUrl(baseUrl, href) {
  try { return new URL(href, baseUrl).href; } catch { return ''; }
}
function normalizeDomainLike(value = '') {
  try {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const u = new URL(withScheme);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return String(value || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  }
}
function normalizedText(...parts) {
  return parts.join(' ')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function normalizeForDedupe(value = '') {
  return normalizedText(String(value || '')
    .replace(/\b(updated|update|breaking|exclusive|analysis|opinion|press release|news release)\b/gi, ' '));
}
function normalizeHeadlineForDedupe(value = '') {
  return normalizeForDedupe(String(value || '')
    .replace(/\s*[|\-–—:]\s*(reuters|bloomberg|yahoo|google news|bing news|pr newswire|prnewswire|globenewswire|access newswire|accesswire).*$/i, ''));
}
function confidenceRank(value = '') {
  const v = String(value || '').toLowerCase();
  if (v === 'high') return 3;
  if (v === 'medium') return 2;
  if (v === 'low') return 1;
  return 0;
}
function sortSignalsByMostRecent(items) {
  return [...items].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });
}
function cutoffDateYearsAgo(years = FEED_LOOKBACK_YEARS) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.getTime();
}
function formatDate(dateStr = '') {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
function isLikelyUrl(value = '') {
  const raw = String(value || '').trim();
  return /^https?:\/\//i.test(raw) || /\.[a-z]{2,}(\/|$)/i.test(raw);
}
function buildSearchEntity(company = '', website = '') {
  const domain = normalizeDomainLike(website);
  return {
    company_name: company,
    website_url: website,
    domain,
    company_normalized: normalizedText(company),
    labels: uniqueStrings([company, domain, website])
  };
}
function hasCompanyOrDomain(entity = {}) {
  return !!(entity.company_name || entity.domain || entity.website_url);
}
function containsExactCompanyPhrase(text, exactPhrase) {
  if (!exactPhrase) return false;
  const escaped = exactPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i').test(text);
}
function containsExactDomain(text, domain) {
  if (!domain) return false;
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s|https?://|www\\.)${escaped}(\\s|/|$)`, 'i').test(text);
}
function isRelevantToEntity(item, entity = {}) {
  const text = normalizedText(item.title, item.description, item.link, item.source);
  const companyMatch = entity.company_normalized ? containsExactCompanyPhrase(text, entity.company_normalized) : false;
  const domainMatch = entity.domain ? containsExactDomain(text, entity.domain) : false;
  return companyMatch || domainMatch;
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
function sourceQualityRank(item = {}) {
  const sourceName = normalizeForDedupe(item.source_name || item.feed_name || item.source || item.source_type || '');
  const sourceUrl = String(item.source_url || item.link || '');
  const domain = normalizeDomainLike(sourceUrl);
  const checks = [sourceName, domain].filter(Boolean).join(' ');
  const patterns = [
    [/\bannual report\b|\bfinancial report\b|\bnon financial performance\b|\besg report\b|\bsustainability report\b/, 125],
    [/\binvestor\b|\bgovernance\b|\bcompany report\b|\bofficial company\b/, 118],
    [/\bpress release\b|\bnewsroom\b/, 112],
    [/\bsec\.gov\b|\bsec\b/, 110],
    [/\breuters\b/, 100],
    [/\bbloomberg\b/, 98],
    [/\bwsj\b|\bwall street journal\b|\bft\.com\b|\bfinancial times\b/, 96],
    [/\bapnews\b|\bassociated press\b/, 94],
    [/\bjoc\b|\bjournal of commerce\b/, 92],
    [/\bfreightwaves\b|\bttnews\b|\btransport topics\b|\bsupply chain brain\b|\blogistics management\b|\bscmr\b|\bsupply chain management review\b|\bdcvelocity\b|\bindustryweek\b|\bmanufacturing\.net\b/, 90],
    [/\bprnewswire\b|\bglobenewswire\b|\baccesswire\b|\bnewswire\b/, 78],
    [/\bgoogle news\b|\bbing news\b/, 40]
  ];
  for (const [re, score] of patterns) if (re.test(checks)) return score;
  if (domain) return 70;
  return 50;
}
function signalDuplicateKey(item = {}) {
  const titleKey = normalizeHeadlineForDedupe(item.signal || item.title || '');
  const domain = normalizeDomainLike(item.source_url || item.link || '');
  const yyyymmdd = String(item.date || '').slice(0, 10);
  return [titleKey, yyyymmdd || '', domain].filter(Boolean).join('|') || titleKey;
}
function signalTopicKey(item = {}) {
  return normalizeHeadlineForDedupe(item.signal || item.title || '');
}
function chooseBestSignal(current, candidate) {
  const score = (x) => [confidenceRank(x.confidence), sourceQualityRank(x), x.date ? new Date(x.date).getTime() : 0];
  const a = score(current), b = score(candidate);
  for (let i = 0; i < a.length; i += 1) {
    if (b[i] > a[i]) return candidate;
    if (b[i] < a[i]) return current;
  }
  return current;
}
function dedupeAndRankSignals(items = []) {
  const exact = new Map();
  for (const item of items) {
    const key = signalDuplicateKey(item);
    if (!key) continue;
    exact.set(key, exact.has(key) ? chooseBestSignal(exact.get(key), item) : item);
  }
  const byTopic = new Map();
  for (const item of exact.values()) {
    const topicKey = signalTopicKey(item);
    if (!topicKey) continue;
    byTopic.set(topicKey, byTopic.has(topicKey) ? chooseBestSignal(byTopic.get(topicKey), item) : item);
  }
  return [...byTopic.values()].sort((a, b) => {
    const conf = confidenceRank(b.confidence) - confidenceRank(a.confidence);
    if (conf !== 0) return conf;
    const qual = sourceQualityRank(b) - sourceQualityRank(a);
    if (qual !== 0) return qual;
    const db = b.date ? new Date(b.date).getTime() : 0;
    const da = a.date ? new Date(a.date).getTime() : 0;
    return db - da;
  });
}
function noteDuplicateKey(note = '') {
  return normalizeForDedupe(note)
    .replace(/\b(the|a|an|this|that|these|those|is|are|was|were|has|have|had|company|business|group|corp|corporation|inc|llc|ltd|limited|pty|plc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function dedupeAndRankEntityNotes(items = []) {
  const bestByKey = new Map();
  for (const item of items) {
    const key = noteDuplicateKey(item.note || '');
    if (!key) continue;
    const existing = bestByKey.get(key);
    const candidateScore = [confidenceRank(item.confidence), sourceQualityRank(item), (item.note || '').length];
    const existingScore = existing ? [confidenceRank(existing.confidence), sourceQualityRank(existing), (existing.note || '').length] : null;
    const better = !existingScore || candidateScore[0] > existingScore[0] || (candidateScore[0] === existingScore[0] && (candidateScore[1] > existingScore[1] || (candidateScore[1] === existingScore[1] && candidateScore[2] > existingScore[2])));
    if (better) bestByKey.set(key, item);
  }
  return [...bestByKey.values()].sort((a, b) => {
    const conf = confidenceRank(b.confidence) - confidenceRank(a.confidence);
    if (conf !== 0) return conf;
    const qual = sourceQualityRank(b) - sourceQualityRank(a);
    if (qual !== 0) return qual;
    return (b.note || '').length - (a.note || '').length;
  });
}
function parseFeedItems(xml = '') {
  const items = [];
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const itemXml of rssItems) {
    const title = decodeEntities(stripCdata((itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]));
    const link = decodeEntities(stripCdata((itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [, ''])[1]));
    const pubDate = decodeEntities(stripCdata((itemXml.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i) || [, ''])[1]));
    const description = decodeEntities(stripCdata((itemXml.match(/<(?:description|summary|content:encoded)[^>]*>([\s\S]*?)<\/(?:description|summary|content:encoded)>/i) || [, ''])[1]));
    const source = decodeEntities(stripCdata((itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [, ''])[1]));
    if (title && link) items.push({ title, link, pubDate, description, source });
  }
  const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const entryXml of atomEntries) {
    const title = decodeEntities(stripCdata((entryXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]));
    const link = decodeEntities(stripCdata((entryXml.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/i) || [, ''])[1]));
    const pubDate = decodeEntities(stripCdata((entryXml.match(/<(?:published|updated)[^>]*>([\s\S]*?)<\/(?:published|updated)>/i) || [, ''])[1]));
    const description = decodeEntities(stripCdata((entryXml.match(/<(?:summary|content)[^>]*>([\s\S]*?)<\/(?:summary|content)>/i) || [, ''])[1]));
    if (title && link) items.push({ title, link, pubDate, description, source: '' });
  }
  return items;
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
function likelyAboutLinks(links = [], baseDomain = '') {
  const allow = ['about', 'company', 'who we are', 'our company', 'leadership', 'investor', 'investors', 'corporate', 'overview', 'governance'];
  return links.filter(l => {
    const h = normalizedText(l.href);
    const label = normalizedText(l.label);
    const sameDomain = normalizeDomainLike(l.href) === baseDomain;
    return sameDomain && allow.some(x => h.includes(normalizedText(x)) || label.includes(normalizedText(x)));
  }).slice(0, 6);
}
function extractStructuredEntityNotes(text = '', sourceUrl = '', evidenceType = 'website') {
  const lines = String(text).split(/(?<=[.!?])\s+/).slice(0, 300);
  const out = [];
  const patterns = [
    /\b(parent company|owned by|part of|subsidiary of|a subsidiary of|division of|affiliate of|member of)\b/i,
    /\b(llc|inc|corp|corporation|ltd|limited|pty|pty ltd|plc)\b/i,
    /\b(global website|worldwide|operates in|headquartered in)\b/i
  ];
  for (const line of lines) {
    if (patterns.some(p => p.test(line))) {
      out.push({
        note: line.trim(),
        source_url: sourceUrl || '',
        source_type: evidenceType,
        confidence: sourceUrl ? 'High' : 'Medium',
        evidence_type: evidenceType
      });
    }
  }
  return out;
}
async function fetchWithTimeout(url, options = {}, timeoutMs = FEED_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function mapWithConcurrency(items = [], limit = 8, handler = async () => null) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 0) }, async () => {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await handler(items[current], current);
      } catch {
        results[current] = null;
      }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}
function operationalKeywordMatches(item) {
  const keywords = [
    'inventory','warehouse','supply chain','logistics','erp','system upgrade','digital transformation',
    'automation','distribution','manufacturing','operations','facility','expansion','technology',
    'integration','oracle','sap','fusion','capital expenditure','capex','maintenance','service expansion',
    'network','modernization','migration','implementation','rollout','fulfillment','distribution center',
    'wms','procurement','material handling','plant','factory','fleet','divestiture','acquisition','merger',
    'funding','private equity','investment','r&d','production site'
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
function confidenceForEntitySignal(item, entity = {}) {
  const text = normalizedText(item.title, item.description, item.link, item.source);
  const companyMatch = entity.company_normalized ? containsExactCompanyPhrase(text, entity.company_normalized) : false;
  const domainMatch = entity.domain ? containsExactDomain(text, entity.domain) : false;
  const opMatches = operationalKeywordMatches(item).length;
  if ((companyMatch || domainMatch) && opMatches >= 2) return 'High';
  if ((companyMatch || domainMatch) && opMatches >= 1) return 'Medium';
  if (companyMatch || domainMatch) return 'Low';
  return 'Low';
}
function fiveYearAfterDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - FEED_LOOKBACK_YEARS);
  return d.toISOString().slice(0, 10);
}
function encodeGoogleNewsQuery(query = '') {
  return encodeURIComponent(String(query || '').trim()).replace(/%20/g, '+');
}
function buildEntityDrivenFeeds(entity = {}) {
  const afterDate = fiveYearAfterDate();
  const companyTerm = entity.company_name ? `\"${entity.company_name}\"` : '';
  const domainTerm = entity.domain ? `\"${entity.domain}\"` : '';
  const baseTerms = [companyTerm, domainTerm].filter(Boolean).join(' OR ');
  if (!baseTerms) return [];
  const queries = [
    `${baseTerms} after:${afterDate}`,
    `${baseTerms} (inventory OR warehouse OR logistics OR supply chain OR manufacturing OR distribution) after:${afterDate}`,
    `${baseTerms} (ERP OR WMS OR TMS OR automation OR implementation OR upgrade OR migration) after:${afterDate}`,
    `${baseTerms} (funding OR acquisition OR merger OR expansion OR facility OR plant OR distribution center) after:${afterDate}`
  ];
  const googleFeeds = queries.map((query, i) => ({
    name: `Google News Company Search ${i + 1}`,
    url: `https://news.google.com/rss/search?q=${encodeGoogleNewsQuery(query)}&hl=en-US&gl=US&ceid=US:en`,
    category: 'Google News Company Search'
  }));
  const bingFeeds = queries.map((query, i) => ({
    name: `Bing News Company Search ${i + 1}`,
    url: `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`,
    category: 'Bing News Company Search'
  }));
  return [...googleFeeds, ...bingFeeds];
}
async function fetchFeedEntries(feed = {}) {
  try {
    const res = await fetchWithTimeout(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseFeedItems(xml).map(item => ({ ...item, feed_name: feed.name, feed_category: feed.category }));
  } catch {
    return [];
  }
}
async function resolveOfficialDomain(companyInput = '') {
  const target = String(companyInput || '').trim();
  if (isLikelyUrl(target)) return { official_domain: normalizeDomainLike(target), official_url: /^https?:\/\//i.test(target) ? target : `https://${normalizeDomainLike(target)}` };
  const queries = [`"${companyInput}" official site`, `"${companyInput}" company`, `"${companyInput}" about`];
  for (const q of queries) {
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-US`;
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const html = await res.text();
      const candidates = [...html.matchAll(/<a[^>]+href="(https?:\/\/[^\"]+)"/gi)].map(m => m[1]);
      for (const c of candidates) {
        const domain = normalizeDomainLike(c);
        if (!domain) continue;
        if (['bing.com','microsoft.com','youtube.com','linkedin.com','facebook.com','instagram.com','x.com','twitter.com'].some(x => domain.includes(x))) continue;
        return { official_domain: domain, official_url: `https://${domain}` };
      }
    } catch {}
  }
  return { official_domain: '', official_url: '' };
}
async function fetchPage(url = '') {
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000);
    if (!res.ok) return { url, html: '', text: '', status: res.status };
    const html = await res.text();
    return { url, html, text: decodeHtmlBasic(html).slice(0, 30000), status: res.status };
  } catch {
    return { url, html: '', text: '', status: 0 };
  }
}
async function fetchPdfText(url = '') {
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/pdf,*/*' } }, 15000);
    if (!res.ok) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    const raw = buf.toString('latin1');
    const text = raw
      .replace(/\r/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\(([^)]{2,200})\)/g, ' $1 ')
      .replace(/[^\x20-\x7E]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 35000);
  } catch {
    return '';
  }
}
async function fetchCompanyEntityIntelligence(companyInput = '') {
  const domainInfo = await resolveOfficialDomain(companyInput);
  if (!domainInfo.official_url) return {
    official_domain: '',
    official_company_name: '',
    legal_entity_name: '',
    parent_entities: [],
    subsidiary_entities: [],
    entity_notes: []
  };

  const home = await fetchPage(domainInfo.official_url);
  const homeLinks = extractLinks(home.html, domainInfo.official_url);
  const relatedLinks = likelyAboutLinks(homeLinks, domainInfo.official_domain);
  const relatedPages = [];
  for (const link of relatedLinks.slice(0, 3)) relatedPages.push(await fetchPage(link.href));

  const allHtml = [home.html, ...relatedPages.map(p => p.html)].join('\n');
  const titleName = firstGroup(/<title[^>]*>([\s\S]*?)<\/title>/i, home.html);
  const ogSiteName = firstGroup(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i, home.html);
  const appName = firstGroup(/<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["']/i, home.html);
  const jsonLdData = findOrgDataFromJsonLd(extractJsonLdObjects(allHtml));

  const companyNames = uniqueStrings([
    ...jsonLdData.names,
    decodeEntities(titleName).split('|')[0].trim(),
    decodeEntities(ogSiteName).trim(),
    decodeEntities(appName).trim()
  ]).filter(x => x.length >= 3);

  const entityNotes = [];
  entityNotes.push(...extractStructuredEntityNotes(home.text, home.url, 'website'));
  for (const p of relatedPages) entityNotes.push(...extractStructuredEntityNotes(p.text, p.url, 'website'));

  const dedupedNotes = dedupeAndRankEntityNotes(entityNotes).slice(0, 10);

  return {
    official_domain: domainInfo.official_domain,
    official_company_name: companyNames[0] || '',
    legal_entity_name: uniqueStrings(jsonLdData.legalNames)[0] || '',
    parent_entities: uniqueStrings(jsonLdData.parents),
    subsidiary_entities: uniqueStrings(jsonLdData.subs),
    entity_notes: dedupedNotes
  };
}
async function fetchAllSignals(searchEntityInput) {
  const entity = typeof searchEntityInput === 'string'
    ? (isLikelyUrl(searchEntityInput) ? buildSearchEntity('', searchEntityInput) : buildSearchEntity(searchEntityInput, ''))
    : buildSearchEntity(searchEntityInput?.company_name || '', searchEntityInput?.website_url || '');
  if (!hasCompanyOrDomain(entity)) return [];
  const cutoff = cutoffDateYearsAgo(FEED_LOOKBACK_YEARS);
  const feeds = [...staticFeeds, ...buildEntityDrivenFeeds(entity)];
  const feedResults = await mapWithConcurrency(feeds, 8, async (feed) => fetchFeedEntries(feed));
  const flattened = feedResults.flat();
  const combined = flattened
    .filter(item => isRelevantToEntity(item, entity))
    .map(item => ({
      signal: item.title,
      date: formatDate(item.pubDate),
      source_name: item.source || item.feed_name || 'Source',
      source_url: item.link,
      category: item.feed_category || categorizeSignal(item),
      confidence: confidenceForEntitySignal(item, entity),
      description: item.description || '',
      source_type: 'news'
    }))
    .filter(item => {
      if (!item.date) return true;
      const t = new Date(item.date).getTime();
      return !isNaN(t) && t >= cutoff;
    });
  return dedupeAndRankSignals(uniqByLink(combined)).slice(0, MAX_SIGNAL_RESULTS);
}

function getAnalysisOptions(input = {}) {
  const defaults = {
    siteDiscovery: true,
    reports: true,
    operationalFootprint: true,
    linkedEntities: true,
    recursiveAffiliateReview: true
  };
  return { ...defaults, ...(input || {}) };
}
function classifyPageType(url = '', label = '') {
  const text = normalizedText(url, label);
  if (/press|newsroom|news|media/.test(text)) return 'press';
  if (/governance|investor|annual report|financial report|reports|sustainability|esg|csr|nfps/.test(text)) return 'reports';
  if (/career|jobs|vacancies/.test(text)) return 'careers';
  if (/manufacturing|production|plant|facility|sites|operations|footprint|r d|research/.test(text)) return 'operations';
  if (/affiliate|global|worldwide|countries|locations|subsidiar|brands|group/.test(text)) return 'entities';
  return 'general';
}
function scoreCandidateLink(url = '', label = '') {
  const text = normalizedText(url, label);
  let score = 0;
  const tests = [
    [/press|newsroom|news|media/, 30],
    [/governance|investor|annual report|financial report|reports|sustainability|esg|csr|nfps/, 35],
    [/manufacturing|production|plant|facility|sites|operations|footprint|r d|research/, 28],
    [/affiliate|global|worldwide|countries|locations|subsidiar|brands|group/, 25],
    [/careers|jobs/, 8],
    [/\.pdf$/, 26]
  ];
  for (const [re, points] of tests) if (re.test(text)) score += points;
  if (/about|company|corporate|overview/.test(text)) score += 12;
  return score;
}
function rootDomain(host = '') {
  const parts = normalizeDomainLike(host).split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}
function looksLikeAffiliateDomain(candidate = '', root = '') {
  const d = normalizeDomainLike(candidate);
  if (!d || d === root) return false;
  const r = rootDomain(root);
  return d.endsWith(`.${r}`) || d.includes(r.split('.')[0]);
}
function extractMetaDescription(html = '') {
  return decodeEntities(firstGroup(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i, html) || firstGroup(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i, html));
}
function classifyDocument(title = '', url = '', text = '') {
  const all = normalizedText(title, url, text.slice(0, 4000));
  if (/annual report/.test(all)) return 'Annual Report';
  if (/financial report|financial statements|results/.test(all)) return 'Financial Report';
  if (/non financial performance|nfps/.test(all)) return 'Non-Financial Performance Statement';
  if (/sustainability|esg|csr/.test(all)) return 'Sustainability / ESG Report';
  if (/governance/.test(all)) return 'Governance Document';
  if (/operat|manufacturing|production|supply chain|logistics/.test(all)) return 'Operational Report';
  if (/press release|news release/.test(all)) return 'Press Release';
  return 'Document';
}
function extractYear(text = '') {
  const m = String(text).match(/\b(20\d{2})\b/);
  return m ? m[1] : '';
}
function summarizeSnippet(text = '', maxSentences = 2) {
  const clean = decodeHtmlBasic(text).replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.slice(0, maxSentences).join(' ').slice(0, 420);
}
function extractOperationalFacts(text = '', sourceUrl = '', sourceType = 'website') {
  const clean = String(text || '');
  const sentences = clean.split(/(?<=[.!?])\s+/).slice(0, 300);
  const facts = [];
  const patterns = [
    { topic: 'Manufacturing / Production', re: /\b(manufacturing|production site|production sites|plant|plants|factory|factories|facility|facilities)\b/i },
    { topic: 'R&D / Innovation', re: /\b(r&d|research and development|research center|innovation center|lab|laboratory)\b/i },
    { topic: 'Logistics / Distribution', re: /\b(logistics|distribution center|distribution centres|warehouse|warehouses|fulfillment|supply chain|cold chain)\b/i },
    { topic: 'Geographic Footprint', re: /\b(countries|country|worldwide|global|regions|sites worldwide|employees)\b/i },
    { topic: 'Operational Performance', re: /\b(capacity|throughput|quality|service level|availability|inventory|operations)\b/i }
  ];
  for (const sentence of sentences) {
    for (const p of patterns) {
      if (p.re.test(sentence)) {
        facts.push({
          topic: p.topic,
          statement: sentence.trim().slice(0, 380),
          source_url: sourceUrl,
          source_type: sourceType,
          confidence: sourceType === 'document' ? 'High' : 'Medium'
        });
        break;
      }
    }
  }
  const best = new Map();
  for (const fact of facts) {
    const key = noteDuplicateKey(`${fact.topic} ${fact.statement}`);
    if (!best.has(key)) best.set(key, fact);
  }
  return [...best.values()].slice(0, 20);
}
function extractEntityMentions(text = '', rootCompany = '') {
  const out = [];
  const patterns = [
    /\bpart of\s+([A-Z][A-Za-z0-9&.,\- ]{2,80})/g,
    /\bsubsidiary of\s+([A-Z][A-Za-z0-9&.,\- ]{2,80})/g,
    /\baffiliate(?:s)?\s+of\s+([A-Z][A-Za-z0-9&.,\- ]{2,80})/g,
    /\b([A-Z][A-Za-z0-9&\- ]{2,60})\s+Group\b/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = String(m[1] || m[0]).trim();
      if (name && normalizedText(name) !== normalizedText(rootCompany)) out.push(name);
    }
  }
  return uniqueStrings(out).slice(0, 20);
}
function evaluateLinkRelationship(link, rootDomainValue, companyName = '') {
  const domain = normalizeDomainLike(link.href);
  const label = link.label || domain;
  const sameDomain = domain === rootDomainValue;
  const affiliateLike = looksLikeAffiliateDomain(domain, rootDomainValue);
  const text = normalizedText(link.href, link.label);
  let confidence = 0;
  if (sameDomain) confidence += 95;
  if (affiliateLike) confidence += 60;
  if (/global|group|worldwide|country|affiliate|subsidiary|brand|division|business unit|poultry|swine|equine|companion/.test(text)) confidence += 20;
  if (companyName && normalizedText(label).includes(normalizedText(companyName).split(' ')[0] || '')) confidence += 10;
  const relationshipType = sameDomain ? 'same-domain section' : affiliateLike ? 'affiliate / related site' : 'external / unknown';
  return {
    entity_name: label || domain,
    website: link.href,
    relationship_type: relationshipType,
    entity_confidence: Math.min(100, confidence),
    discovery_reason: classifyPageType(link.href, label)
  };
}
async function discoverSiteStructure(startUrl, companyName = '', options = getAnalysisOptions()) {
  const root = normalizeDomainLike(startUrl);
  const start = /^https?:\/\//i.test(startUrl) ? startUrl : `https://${root}`;
  const home = await fetchPage(start);
  const homeLinks = extractLinks(home.html, start);
  const prioritized = homeLinks
    .map(link => ({ ...link, score: scoreCandidateLink(link.href, link.label), page_type: classifyPageType(link.href, link.label) }))
    .filter(link => normalizeDomainLike(link.href))
    .sort((a, b) => b.score - a.score);

  const keyPages = [];
  const seen = new Set();
  for (const link of prioritized) {
    const domain = normalizeDomainLike(link.href);
    const key = `${domain}|${link.href}`;
    if (seen.has(key)) continue;
    const allowSame = domain === root;
    const allowAffiliate = options.recursiveAffiliateReview && looksLikeAffiliateDomain(domain, root);
    if (!allowSame && !allowAffiliate) continue;
    if (link.score < 8) continue;
    seen.add(key);
    keyPages.push(link);
    if (keyPages.length >= MAX_PAGES_PER_DOMAIN) break;
  }

  const pages = [{ url: start, html: home.html, text: home.text, title: decodeEntities(firstGroup(/<title[^>]*>([\s\S]*?)<\/title>/i, home.html)), page_type: 'home' }];
  for (const link of keyPages.slice(0, 12)) {
    const p = await fetchPage(link.href);
    pages.push({ url: link.href, html: p.html, text: p.text, title: decodeEntities(firstGroup(/<title[^>]*>([\s\S]*?)<\/title>/i, p.html)), page_type: link.page_type, label: link.label, meta_description: extractMetaDescription(p.html) });
  }

  const allLinks = uniqueStrings([].concat(...pages.map(p => extractLinks(p.html, p.url).map(x => x.href))));
  const discoveredDocs = [];
  const linkedEntities = [];
  for (const p of pages) {
    for (const link of extractLinks(p.html, p.url)) {
      const href = link.href;
      const domain = normalizeDomainLike(href);
      if (!href || !domain) continue;
      if (/\.pdf($|\?)/i.test(href) || /annual report|financial report|sustainability|esg|csr|nfps/i.test(`${link.label} ${href}`)) {
        discoveredDocs.push({
          title: link.label || decodeURIComponent(href.split('/').pop() || 'Document'),
          url: href,
          document_type: classifyDocument(link.label, href, ''),
          year: extractYear(`${link.label} ${href}`),
          source_type: domain === root ? 'official company report' : 'linked report',
          confidence: domain === root ? 'High' : 'Medium'
        });
      }
      if ((domain !== root && looksLikeAffiliateDomain(domain, root)) || /global|group|worldwide|country|affiliate|subsidiary|brand|division/.test(normalizedText(link.label, href))) {
        linkedEntities.push(evaluateLinkRelationship(link, root, companyName));
      }
    }
  }

  const pageBuckets = {
    press: pages.filter(p => p.page_type === 'press').map(p => ({ title: p.title || p.label || p.url, url: p.url })),
    reports: pages.filter(p => p.page_type === 'reports').map(p => ({ title: p.title || p.label || p.url, url: p.url })),
    operations: pages.filter(p => p.page_type === 'operations').map(p => ({ title: p.title || p.label || p.url, url: p.url })),
    entities: pages.filter(p => p.page_type === 'entities').map(p => ({ title: p.title || p.label || p.url, url: p.url }))
  };

  return {
    root_domain: root,
    root_url: start,
    page_buckets: pageBuckets,
    pages,
    linked_entities: linkedEntities.filter(x => x.entity_confidence >= 40).slice(0, MAX_LINKED_DOMAINS),
    candidate_documents: dedupeDocuments(discoveredDocs).slice(0, MAX_PDFS_PER_RUN),
    all_links_count: allLinks.length
  };
}
function dedupeDocuments(items = []) {
  const best = new Map();
  for (const item of items) {
    const key = normalizeForDedupe(`${item.title} ${item.year} ${normalizeDomainLike(item.url)}`);
    const existing = best.get(key);
    if (!existing) best.set(key, item);
    else if (sourceQualityRank(item) > sourceQualityRank(existing)) best.set(key, item);
  }
  return [...best.values()].sort((a,b) => sourceQualityRank(b) - sourceQualityRank(a));
}
async function enrichDocuments(docs = [], options = getAnalysisOptions()) {
  const selected = docs.slice(0, MAX_PDFS_PER_RUN);
  const enriched = [];
  let processed = 0;
  for (const doc of selected) {
    const text = /\.pdf($|\?)/i.test(doc.url) ? await fetchPdfText(doc.url) : '';
    const summary = summarizeSnippet(text || doc.title, 2);
    enriched.push({
      ...doc,
      year: doc.year || extractYear(text || doc.title),
      summary,
      source_quality: sourceQualityRank(doc),
      operational_mentions: options.operationalFootprint ? extractOperationalFacts(text, doc.url, 'document').slice(0, 6) : []
    });
    processed += 1;
    if (processed >= MAX_PDFS_PER_RUN) break;
  }
  return dedupeDocuments(enriched);
}
async function reviewLinkedEntity(entity, options = getAnalysisOptions()) {
  if (!entity || !entity.website || entity.entity_confidence < 40) return null;
  const site = await discoverSiteStructure(entity.website, entity.entity_name, { ...options, recursiveAffiliateReview: false });
  const entityNotes = [];
  for (const page of site.pages.slice(0, 4)) {
    entityNotes.push(...extractStructuredEntityNotes(page.text, page.url, 'linked-site'));
  }
  const docs = options.reports ? await enrichDocuments(site.candidate_documents.slice(0, 4), options) : [];
  const operationalFacts = options.operationalFootprint
    ? site.pages.flatMap(p => extractOperationalFacts(p.text, p.url, 'linked-site')).slice(0, 8)
    : [];
  return {
    ...entity,
    page_count: site.pages.length,
    discovered_pages: site.page_buckets,
    supporting_notes: dedupeAndRankEntityNotes(entityNotes).slice(0, 5),
    documents: docs.slice(0, 4),
    top_operational_facts: operationalFacts.slice(0, 5)
  };
}
function buildWebsiteIntelligenceSummary(rootSite, docs, linkedReviews, entityIntel) {
  const allDomains = uniqueStrings([rootSite.root_domain, ...linkedReviews.map(x => normalizeDomainLike(x.website))]);
  return {
    official_domain: entityIntel.official_domain || rootSite.root_domain,
    official_company_name: entityIntel.official_company_name || '',
    pages_reviewed: rootSite.pages.length,
    total_links_seen: rootSite.all_links_count,
    report_pages_found: rootSite.page_buckets.reports.length,
    press_pages_found: rootSite.page_buckets.press.length,
    operations_pages_found: rootSite.page_buckets.operations.length,
    linked_domains_identified: allDomains.length,
    domains: allDomains,
    discovery_highlights: [
      rootSite.page_buckets.press.length ? `Detected ${rootSite.page_buckets.press.length} press/news page(s).` : '',
      rootSite.page_buckets.reports.length ? `Detected ${rootSite.page_buckets.reports.length} governance/report page(s).` : '',
      docs.length ? `Captured ${docs.length} report/document candidate(s).` : '',
      linkedReviews.length ? `Identified ${linkedReviews.length} linked entity site(s) worth review.` : ''
    ].filter(Boolean)
  };
}
function buildOperationalFootprint(rootSite, docs, linkedReviews) {
  const facts = [];
  for (const page of rootSite.pages) facts.push(...extractOperationalFacts(page.text, page.url, 'website'));
  for (const doc of docs) facts.push(...(doc.operational_mentions || []));
  for (const entity of linkedReviews) facts.push(...(entity.top_operational_facts || []));
  const deduped = [];
  const seen = new Set();
  for (const fact of facts) {
    const key = noteDuplicateKey(`${fact.topic} ${fact.statement}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(fact);
  }
  const byTopic = {};
  for (const fact of deduped) {
    if (!byTopic[fact.topic]) byTopic[fact.topic] = [];
    byTopic[fact.topic].push(fact);
  }
  return {
    topics: Object.keys(byTopic).map(topic => ({ topic, items: byTopic[topic].slice(0, 4) })),
    total_facts: deduped.length
  };
}
function mergeSignalsWithWebsiteEvidence(signals = [], docs = [], rootSite = null) {
  const websiteSignals = [];
  for (const doc of docs) {
    websiteSignals.push({
      signal: doc.title,
      date: doc.year ? `${doc.year}-01-01` : '',
      source_name: doc.document_type,
      source_url: doc.url,
      category: doc.document_type,
      confidence: doc.confidence || 'Medium',
      description: doc.summary || '',
      source_type: 'website_document'
    });
  }
  if (rootSite) {
    for (const p of rootSite.page_buckets.press.slice(0, 8)) {
      websiteSignals.push({
        signal: p.title,
        date: '',
        source_name: 'Official Company Page',
        source_url: p.url,
        category: 'Official Website',
        confidence: 'Medium',
        description: 'Official page discovered during site review.',
        source_type: 'website_page'
      });
    }
  }
  return dedupeAndRankSignals([...signals, ...websiteSignals]).slice(0, MAX_SIGNAL_RESULTS);
}
async function runDeepDive(searchEntity, entityIntel, analysisOptions) {
  const seedUrl = searchEntity.website_url || entityIntel.official_domain || '';
  if (!seedUrl) {
    return {
      analysis_options: analysisOptions,
      website_intelligence_summary: null,
      corporate_reports: [],
      operational_footprint: { topics: [], total_facts: 0 },
      linked_entities_review: [],
      evidence_graph_stats: { pages_reviewed: 0, documents_reviewed: 0, linked_entities_reviewed: 0 }
    };
  }
  const rootSite = analysisOptions.siteDiscovery
    ? await discoverSiteStructure(seedUrl, searchEntity.company_name || entityIntel.official_company_name || '', analysisOptions)
    : { root_domain: normalizeDomainLike(seedUrl), root_url: seedUrl, page_buckets: { press: [], reports: [], operations: [], entities: [] }, pages: [], linked_entities: [], candidate_documents: [], all_links_count: 0 };

  const docs = analysisOptions.reports ? await enrichDocuments(rootSite.candidate_documents, analysisOptions) : [];
  const linkedSeed = analysisOptions.linkedEntities ? rootSite.linked_entities.slice(0, MAX_LINKED_DOMAINS) : [];
  const linkedReviews = analysisOptions.recursiveAffiliateReview
    ? (await mapWithConcurrency(linkedSeed, 3, async (entity) => reviewLinkedEntity(entity, analysisOptions))).filter(Boolean)
    : linkedSeed.map(entity => ({ ...entity, supporting_notes: [], documents: [], top_operational_facts: [] }));

  return {
    analysis_options: analysisOptions,
    website_intelligence_summary: buildWebsiteIntelligenceSummary(rootSite, docs, linkedReviews, entityIntel),
    corporate_reports: docs.slice(0, 12),
    operational_footprint: analysisOptions.operationalFootprint ? buildOperationalFootprint(rootSite, docs, linkedReviews) : { topics: [], total_facts: 0 },
    linked_entities_review: linkedReviews.slice(0, MAX_LINKED_DOMAINS),
    evidence_graph_stats: {
      pages_reviewed: rootSite.pages.length + linkedReviews.reduce((sum, x) => sum + (x.page_count || 0), 0),
      documents_reviewed: docs.length + linkedReviews.reduce((sum, x) => sum + ((x.documents || []).length), 0),
      linked_entities_reviewed: linkedReviews.length
    },
    root_site_data: rootSite
  };
}

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json({ pain_points: PAIN_POINTS, modelConfigured: !!OPENAI_API_KEY, model: OPENAI_MODEL }));

app.post('/api/company-insight', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY not configured' });
    const { company_input, company_name, website_url, persona_level, analysis_options } = req.body || {};
    const effectiveCompanyName = String(company_name || '').trim() || (isLikelyUrl(company_input || '') ? '' : String(company_input || '').trim());
    const effectiveWebsiteUrl = String(website_url || '').trim() || (isLikelyUrl(company_input || '') ? String(company_input || '').trim() : '');
    const searchEntity = buildSearchEntity(effectiveCompanyName, effectiveWebsiteUrl);
    const lookupSeed = effectiveWebsiteUrl || effectiveCompanyName || company_input || '';
    const options = getAnalysisOptions(analysis_options);

    const [newsItems, entityIntel] = await Promise.all([
      fetchAllSignals(searchEntity),
      fetchCompanyEntityIntelligence(lookupSeed)
    ]);
    const deepDive = await runDeepDive(searchEntity, entityIntel, options);
    const mergedSignals = mergeSignalsWithWebsiteEvidence(newsItems, deepDive.corporate_reports, deepDive.root_site_data);

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
- Do NOT fabricate recent public signals, legal names, domains, parent companies, subsidiaries, report titles, or benchmarks.
- Recent signals are handled outside your response and must only come from the provided sourced signals list.
- Company identity details, website intelligence, reports, and linked entities are handled outside your response and must only come from provided evidence.
- Benchmarks must be directional and framed as typical ranges, not company-specific claims.
- Adapt wording to persona level.
- Keep outputs concise and practical for a BDR or sales rep.
- Use the website deep-dive evidence to strengthen your discovery angles, hypotheses, and why-now notes.
`;

    const payload = {
      model: OPENAI_MODEL,
      instructions,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: `Company name: ${effectiveCompanyName || ''}
Website URL: ${effectiveWebsiteUrl || ''}
Combined lookup seed: ${lookupSeed || ''}

Sourced recent signals over the last ${FEED_LOOKBACK_YEARS} years:
${JSON.stringify(mergedSignals, null, 2)}

Resolved domain and entity evidence:
${JSON.stringify(entityIntel, null, 2)}

Website deep-dive evidence:
${JSON.stringify({
  analysis_options: deepDive.analysis_options,
  website_intelligence_summary: deepDive.website_intelligence_summary,
  corporate_reports: deepDive.corporate_reports,
  operational_footprint: deepDive.operational_footprint,
  linked_entities_review: deepDive.linked_entities_review,
  evidence_graph_stats: deepDive.evidence_graph_stats
}, null, 2)}`
        }]
      }],
      temperature: 0.2,
      max_output_tokens: 2600,
      store: false
    };

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    if (!response.ok) return res.status(500).json({ ok: false, error: raw });

    const parsedBody = JSON.parse(raw);
    const parsed = parseJsonFromText(extractOutputText(parsedBody));
    parsed.recent_signals = mergedSignals;
    parsed.company_identity = entityIntel;
    parsed.analysis_options = deepDive.analysis_options;
    parsed.website_intelligence_summary = deepDive.website_intelligence_summary;
    parsed.corporate_reports = deepDive.corporate_reports;
    parsed.operational_footprint = deepDive.operational_footprint;
    parsed.linked_entities_review = deepDive.linked_entities_review;
    parsed.evidence_graph_stats = deepDive.evidence_graph_stats;
    for (const key of ['likely_operational_triggers','bdr_company_notes','why_this_matters_now','buying_group_intelligence','working_hypotheses','likely_pushback','impact_benchmarks']) {
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
    const { selected_pain_points, active_problem, transcript, known_state, latest_response, persona_level } = req.body || {};
    const instructions = `You are an AI-assisted Value Discovery Guide for a BDR working live with a prospect.
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
      input: [{ role: 'user', content: [{ type: 'input_text', text: `Selected pain points:\n${JSON.stringify(selected_pain_points || [], null, 2)}\n\nActive problem:\n${active_problem || ''}\n\nKnown state:\n${JSON.stringify(known_state || {}, null, 2)}\n\nTranscript:\n${JSON.stringify(transcript || [], null, 2)}\n\nLatest prospect response:\n${latest_response || ''}` }] }],
      temperature: 0.3,
      max_output_tokens: 900,
      store: false
    };

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    if (!response.ok) return res.status(500).json({ ok: false, error: raw });

    let parsed;
    try {
      const parsedBody = JSON.parse(raw);
      parsed = parseJsonFromText(extractOutputText(parsedBody));
    } catch {
      parsed = fallbackResult('Fallback question used because the server could not safely interpret the AI response.');
    }
    res.json({ ok: true, result: parsed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Unknown server error' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((req, res) => res.status(404).send('Not Found'));
app.listen(PORT, () => console.log(`Value Discovery Guide AI Assisted running on port ${PORT}`));
