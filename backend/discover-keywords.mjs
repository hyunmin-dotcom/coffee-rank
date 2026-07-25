// backend/discover-keywords.mjs
// Discovers coffee-related search keywords using the Naver Search Ad API's
// "연관키워드 조회" (related keyword lookup) endpoint, ranks them by
// monthly search volume (PC + Mobile), and writes the result into
// data/rankings.json under a new 'discovered-trending' category.
//
// Unlike the DataLab Search Trend API (backend/fetch-trends.mjs), this API
// is built for keyword *discovery* — given a seed keyword, it returns
// hundreds of related keywords with actual monthly search volume, which is
// what lets this category surface items that were never manually added to
// the curated category lists.
//
// Requires Node.js 18+ (built-in fetch, crypto) and three env vars, issued
// from https://searchad.naver.com -> 광고시스템 -> 도구 -> API 사용 관리:
//   NAVER_AD_API_KEY       (Access License)
//   NAVER_AD_SECRET_KEY    (Secret Key)
//   NAVER_AD_CUSTOMER_ID   (Customer ID, numeric)
//
// Naver Search Ad API notes:
//   - Search volumes under 10 are returned as the string "< 10"; treated as 5 here.
//   - Up to 5 seed keywords per request (hintKeywords, comma-separated).
//   - Free to use with a 네이버 광고 account; has a daily call quota.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const API_KEY = process.env.NAVER_AD_API_KEY;
const SECRET_KEY = process.env.NAVER_AD_SECRET_KEY;
const CUSTOMER_ID = process.env.NAVER_AD_CUSTOMER_ID;

if (!API_KEY || !SECRET_KEY || !CUSTOMER_ID) {
  console.error('Missing NAVER_AD_API_KEY / NAVER_AD_SECRET_KEY / NAVER_AD_CUSTOMER_ID env vars.');
  process.exit(1);
}

const BASE_URL = 'https://api.naver.com';
const URI = '/keywordstool';

// Seed keywords covering the breadth of the site — the API expands each
// into many related real-world search terms, so this list stays short.
const SEED_GROUPS = [
  ['커피', '원두', '생두', '커피머신', '커피그라인더'],
  ['핸드드립', '커피드리퍼', '에스프레소머신', '커피로스터기', '카페창업'],
  ['스페셜티커피', '커피브랜드', '커피용품', '드립커피', '캡슐커피'],
];

// Keep only results that plausibly relate to coffee (the API's expansion
// can drift into unrelated territory for broad seeds like "머신").
const RELEVANCE_PATTERN = /커피|원두|생두|카페|드립|에스프레소|바리스타|로스팅|로스터|그라인더|디카페인|콜드브루|라떼/;

function sign(timestamp, method, uri) {
  const message = `${timestamp}.${method}.${uri}`;
  return crypto.createHmac('sha256', SECRET_KEY).update(message).digest('base64');
}

function authHeaders(method, uri) {
  const timestamp = Date.now().toString();
  return {
    'X-Timestamp': timestamp,
    'X-API-KEY': API_KEY,
    'X-Customer': CUSTOMER_ID,
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
  const qs = `?hintKeywords=${encodeURIComponent(seedKeywords.join(','))}&showDetail=1`;
  const headers = authHeaders('GET', URI);
  const res = await fetch(BASE_URL + URI + qs, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Naver SearchAd API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.keywordList || [];
}

async function discoverAll() {
  const found = new Map(); // name -> total monthly volume
  for (const seeds of SEED_GROUPS) {
    try {
      const list = await fetchRelatedKeywords(seeds);
      for (const item of list) {
        const name = item.relKeyword;
        if (!name || !RELEVANCE_PATTERN.test(name)) continue;
        const pc = parseVolume(item.monthlyPcQcCnt);
        const mobile = parseVolume(item.monthlyMobileQcCnt);
        const total = pc + mobile;
        // keep the max if the same keyword surfaces from multiple seed groups
        if (!found.has(name) || found.get(name) < total) found.set(name, total);
      }
    } catch (e) {
      console.error('discovery failed for seeds', seeds, e.message);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return found;
}

function loadPrevious() {
  try {
    return JSON.parse(fs.readFileSync(path.join('data', 'rankings.json'), 'utf-8'));
  } catch {
    return null;
  }
}

async function main() {
  const found = await discoverAll();
  const ranked = [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30) // top 30 discovered keywords
    .map(([name, volume], i) => ({ rank: i + 1, name, index: volume }));

  const previous = loadPrevious();
  const out = previous || { generatedAt: new Date().toISOString(), categories: {} };
  out.generatedAt = new Date().toISOString();

  const prevRows = out.categories?.['discovered-trending']?.periods?.daily?.rows;
  const prevRankMap = {};
  (prevRows || []).forEach(r => { prevRankMap[r.name] = r.rank; });
  const rowsWithDelta = ranked.map(r => {
    const prevRank = prevRankMap[r.name];
    return { ...r, delta: prevRank ? prevRank - r.rank : 0 };
  });

  out.categories['discovered-trending'] = {
    title: '인기검색어 · 자동발견',
    sub: 'AUTO-DISCOVERED (Naver SearchAd, monthly search volume)',
    // same data across all four period tabs — the SearchAd keyword tool
    // returns a single monthly-volume snapshot, not day/week/month/year splits
    periods: {
      daily: { rows: rowsWithDelta },
      weekly: { rows: rowsWithDelta },
      monthly: { rows: rowsWithDelta },
      yearly: { rows: rowsWithDelta },
    },
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(path.join('data', 'rankings.json'), JSON.stringify(out, null, 2));
  console.log(`wrote ${rowsWithDelta.length} discovered keywords into data/rankings.json`);
}

main();
