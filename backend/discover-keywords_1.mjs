// backend/discover-keywords.mjs
// Two-stage pipeline for the "인기검색어 · 자동발견" category:
//
//   Stage 1 — DISCOVERY (Naver SearchAd API, 연관키워드 조회)
//     Given seed keywords, returns a wide pool of real coffee-related
//     search terms with monthly search volume. This is what lets new
//     keywords surface without anyone manually adding them.
//
//   Stage 2 — PERIOD RANKING (Naver DataLab Search Trend API)
//     Takes that discovered pool and, for each of the four period windows
//     (daily/weekly/monthly/yearly), asks DataLab for relative trend data
//     so the four period tabs actually differ — the SearchAd API alone
//     only returns a single monthly-volume snapshot, which is why the
//     tabs looked identical before this stage was added.
//
// Requires Node.js 18+ (built-in fetch, crypto) and FIVE env vars:
//   NAVER_AD_API_KEY, NAVER_AD_SECRET_KEY, NAVER_AD_CUSTOMER_ID
//     (from https://searchad.naver.com -> 광고시스템 -> 도구 -> API 사용 관리)
//   NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
//     (same DataLab credentials already used by backend/fetch-trends.mjs)
//
// Call volume note: this now adds ~4 periods x ~8 DataLab calls (40
// candidates / 5 per request) = ~32 DataLab calls per run, on top of the
// curated categories in fetch-trends.mjs. See README for schedule guidance.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const AD_API_KEY = process.env.NAVER_AD_API_KEY;
const AD_SECRET_KEY = process.env.NAVER_AD_SECRET_KEY;
const AD_CUSTOMER_ID = process.env.NAVER_AD_CUSTOMER_ID;
const DL_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const DL_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

if (!AD_API_KEY || !AD_SECRET_KEY || !AD_CUSTOMER_ID) {
  console.error('Missing NAVER_AD_API_KEY / NAVER_AD_SECRET_KEY / NAVER_AD_CUSTOMER_ID env vars.');
  process.exit(1);
}
if (!DL_CLIENT_ID || !DL_CLIENT_SECRET) {
  console.error('Missing NAVER_CLIENT_ID / NAVER_CLIENT_SECRET env vars (DataLab credentials).');
  process.exit(1);
}

const AD_BASE_URL = 'https://api.naver.com';
const AD_URI = '/keywordstool';

const SEED_GROUPS = [
  ['커피', '원두', '생두', '커피머신', '커피그라인더'],
  ['핸드드립', '커피드리퍼', '에스프레소머신', '커피로스터기', '카페창업'],
  ['스페셜티커피', '커피브랜드', '커피용품', '드립커피', '캡슐커피'],
];

const CANDIDATE_POOL_SIZE = 40; // how many discovered keywords advance to Stage 2
const FINAL_LIST_SIZE = 30;     // how many make it into the published ranking

const RELEVANCE_PATTERN = /커피|원두|생두|카페|드립|에스프레소|바리스타|로스팅|로스터|그라인더|디카페인|콜드브루|라떼/;

const PERIODS = { daily: { days: 1 }, weekly: { days: 7 }, monthly: { days: 30 }, yearly: { days: 365 } };

// ---------- Stage 1: SearchAd discovery ----------

function sign(timestamp, method, uri) {
  const message = `${timestamp}.${method}.${uri}`;
  return crypto.createHmac('sha256', AD_SECRET_KEY).update(message).digest('base64');
}

function adAuthHeaders(method, uri) {
  const timestamp = Date.now().toString();
  return {
    'X-Timestamp': timestamp,
    'X-API-KEY': AD_API_KEY,
    'X-Customer': AD_CUSTOMER_ID,
    'X-Signature': sign(timestamp, method, uri),
    'Content-Type': 'application/json; charset=UTF-8',
  };
}

function parseVolume(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.includes('<')) return 5; // "< 10"
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function fetchRelatedKeywords(seedKeywords) {
  // The SearchAd keyword-tool API rejects any hintKeywords value containing
  // whitespace (400 error) — strip it defensively even though today's
  // SEED_GROUPS happen to be space-free, so this doesn't silently break if
  // someone adds a multi-word seed later.
  const hints = seedKeywords.map(k => String(k).replace(/\s+/g, ''));
  const qs = `?hintKeywords=${encodeURIComponent(hints.join(','))}&showDetail=1`;
  const res = await fetch(AD_BASE_URL + AD_URI + qs, { headers: adAuthHeaders('GET', AD_URI) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Naver SearchAd API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.keywordList || [];
}

async function discoverCandidates() {
  const found = new Map();
  for (const seeds of SEED_GROUPS) {
    try {
      const list = await fetchRelatedKeywords(seeds);
      for (const item of list) {
        const name = item.relKeyword;
        if (!name || !RELEVANCE_PATTERN.test(name)) continue;
        const total = parseVolume(item.monthlyPcQcCnt) + parseVolume(item.monthlyMobileQcCnt);
        if (!found.has(name) || found.get(name) < total) found.set(name, total);
      }
    } catch (e) {
      console.error('discovery failed for seeds', seeds, e.message);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CANDIDATE_POOL_SIZE)
    .map(([name]) => name);
}

// ---------- Stage 2: DataLab period ranking ----------

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function toDateStr(d) { return d.toISOString().slice(0, 10); }

async function fetchTrendGroup(names, startDate, endDate) {
  const body = {
    startDate, endDate, timeUnit: 'date',
    keywordGroups: names.map(name => ({ groupName: name, keywords: [name] })),
  };
  const res = await fetch('https://openapi.naver.com/v1/datalab/search', {
    method: 'POST',
    headers: {
      'X-Naver-Client-Id': DL_CLIENT_ID,
      'X-Naver-Client-Secret': DL_CLIENT_SECRET,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Naver DataLab API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function rankForWindow(candidates, days) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const scored = {};
  for (const group of chunk(candidates, 5)) {
    try {
      const data = await fetchTrendGroup(group, toDateStr(start), toDateStr(end));
      for (const series of data.results) {
        const points = series.data || [];
        const avg = points.length ? points.reduce((s, p) => s + p.ratio, 0) / points.length : 0;
        scored[series.title] = avg;
      }
    } catch (e) {
      console.error('trend fetch failed for group', group, e.message);
    }
    await new Promise(r => setTimeout(r, 350));
  }
  return Object.entries(scored)
    .sort((a, b) => b[1] - a[1])
    .slice(0, FINAL_LIST_SIZE)
    .map(([name, index], i) => ({ rank: i + 1, name, index: Number(index.toFixed(1)) }));
}

// ---------- glue ----------

function loadPrevious() {
  try {
    return JSON.parse(fs.readFileSync(path.join('data', 'discovered.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function withDelta(rows, prevRows) {
  const prevRankMap = {};
  (prevRows || []).forEach(r => { prevRankMap[r.name] = r.rank; });
  return rows.map(r => {
    const prevRank = prevRankMap[r.name];
    return { ...r, delta: prevRank ? prevRank - r.rank : 0 };
  });
}

async function main() {
  const candidates = await discoverCandidates();
  console.log(`discovered ${candidates.length} candidate keywords`);

  const previous = loadPrevious();
  const out = {
    generatedAt: new Date().toISOString(),
    category: {
      title: '인기검색어 · 자동발견',
      sub: 'AUTO-DISCOVERED (SearchAd 발견 + DataLab 기간별 트렌드)',
      periods: {},
    },
  };

  for (const [periodName, { days }] of Object.entries(PERIODS)) {
    try {
      const rows = await rankForWindow(candidates, days);
      const prevRows = previous?.category?.periods?.[periodName]?.rows;
      out.category.periods[periodName] = { rows: withDelta(rows, prevRows) };
      console.log('ok:', periodName, '-', rows.length, 'rows');
    } catch (e) {
      console.error('failed:', periodName, e.message);
      const prev = previous?.category?.periods?.[periodName];
      if (prev) out.category.periods[periodName] = prev;
    }
  }

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(path.join('data', 'discovered.json'), JSON.stringify(out, null, 2));
  console.log('wrote data/discovered.json');
}

main();
