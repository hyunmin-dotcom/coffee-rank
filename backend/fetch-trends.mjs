// backend/fetch-trends.mjs
// Fetches search-volume trend data from the Naver DataLab Search Trend API
// for every category/item on the COFFEE RANK site, for four time windows
// (daily / weekly / monthly / yearly), ranks each category per window, and
// writes the result to data/rankings.json. Also fetches an absolute monthly
// search-VOLUME figure per item (once, not per window) from the Naver
// SearchAd keyword-tool API, so the frontend can show both the relative
// "검색 지수" and an actual "검색량" number side by side.
//
// Requires Node.js 18+ (built-in fetch) and, at minimum, two env vars:
//   NAVER_CLIENT_ID
//   NAVER_CLIENT_SECRET
// (issued from https://developers.naver.com/apps -> "검색어트렌드" API)
//
// Optionally, for the "검색량" column, also set (same credentials already
// used by backend/discover-keywords.mjs):
//   NAVER_AD_API_KEY, NAVER_AD_SECRET_KEY, NAVER_AD_CUSTOMER_ID
// If these three are missing, volume fetching is skipped gracefully (rows
// simply omit `volume`) — the DataLab ranking logic still runs normally.
//
// Naver DataLab notes:
//   - Data has roughly a 1-day lag; there is no true minute-by-minute feed.
//   - Values are a RELATIVE ratio (0-100) within each request, not absolute
//     search volume, and not comparable across separate requests/categories.
//   - Max 5 keyword groups per request, max 20 keywords per group.
//   - Fetching 4 time windows per category multiplies the call count ~4x —
//     see the README for schedule-frequency guidance.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CLIENT_ID = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const AD_API_KEY = process.env.NAVER_AD_API_KEY;
const AD_SECRET_KEY = process.env.NAVER_AD_SECRET_KEY;
const AD_CUSTOMER_ID = process.env.NAVER_AD_CUSTOMER_ID;
const VOLUME_ENABLED = !!(AD_API_KEY && AD_SECRET_KEY && AD_CUSTOMER_ID);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing NAVER_CLIENT_ID / NAVER_CLIENT_SECRET env vars.');
  process.exit(1);
}
if (!VOLUME_ENABLED) {
  console.warn('NAVER_AD_API_KEY / NAVER_AD_SECRET_KEY / NAVER_AD_CUSTOMER_ID not set — skipping 검색량 (volume) lookup, rankings will not include it.');
}

const CATS = {
    'green-bean-specialty': { title: '생두 · 스페셜티', sub: 'SPECIALTY GREEN BEAN', items: [
      '파나마 게이샤','에티오피아 예가체프 G1','케냐 AA','코스타리카 따라주 게이샤','르완다 부지제로',
      '콜롬비아 게이샤','온두라스 SHG COE','인도네시아 만델링 G1','과테말라 안티구아 SHB','엘살바도르 파카마라'
    ]},
    'green-bean-commercial': { title: '생두 · 커머셜', sub: 'COMMERCIAL GREEN BEAN', items: [
      '브라질 산토스','베트남 로부스타','콜롬비아 수프리모','인도네시아 만델링 G4','과테말라 수프리모',
      '온두라스 HG','인도 로부스타','우간다 로부스타','에티오피아 G4','베트남 아라비카'
    ]},
    'roasted-bean-specialty': { title: '원두 · 스페셜티', sub: 'SPECIALTY ROASTED BEAN', items: [
      '테라로사 원두','프릳츠 커피 원두','블루보틀 원두','모모스커피 원두','커피리브레 원두',
      '나무사이로 원두','앤트러사이트 원두','센터커피 원두','리사르커피 원두','스타벅스 리저브 원두'
    ]},
    'roasted-bean-md': { title: '원두 · MD', sub: 'READY-TO-DRINK & CONVENIENCE COFFEE', items: [
      '스타벅스 비아 인스턴트','네스프레소 오리지널 캡슐','일리 이지에스프레소 캡슐','조지아 크래프트 RTD','폴바셋 드립백',
      '커피빈 드립백','남양 프렌치카페 카페믹스','동서 맥심 화이트골드','스타벅스 더블샷 RTD','돌체구스토 캡슐'
    ]},
    'trend-beverage': { title: '커피트렌드 · 음료', sub: 'TREND BEVERAGE', items: [
      '더치커피','아인슈페너','돌체라떼','흑당라떼','코코넛라떼',
      '디카페인 커피','콜드브루','오트밀크 라떼','시나몬 돌체라떼','피스타치오 라떼'
    ]},
    'trend-book': { title: '커피트렌드 · 커피서적', sub: 'TREND BOOK', items: [
      '커피 인사이드','커피 공부','커피 과학','스페셜티 커피 대백과','커피 로스팅',
      '커피 아틀라스','카페를 하다','홈카페의 정석','바리스타를 위한 커피 과학','커피 테이스팅'
    ]},
    'trend-tool': { title: '커피트렌드 · 커피툴', sub: 'TREND TOOL & ACCESSORY', items: [
      '탬퍼','디스트리뷰터','넉박스','밀크저그','WDT 툴',
      '퍽 스크리너','샷글라스','커피 온도계','클리닝 브러시','포터필터 홀더'
    ]},
    'cafe': { title: '카페 · 스페셜티 카페', sub: 'SPECIALTY CAFE', items: [
      '테라로사','프릳츠커피컴퍼니','앤트러사이트','센터커피','모모스커피',
      '커피리브레','나무사이로','리사르커피','어니언','대림창고'
    ]},
    'franchise': { title: '카페 · 프랜차이즈', sub: 'FRANCHISE CAFE', items: [
      '스타벅스','이디야커피','투썸플레이스','메가커피','컴포즈커피',
      '빽다방','커피빈','할리스','폴바셋','던킨'
    ]},
    'bakery': { title: '카페 · 베이커리', sub: 'BAKERY CAFE', items: [
      '오월의종','밀도','아우어베이커리','도레도레','파리바게뜨',
      '뚜레쥬르','성심당','런던베이글뮤지엄','노티드','이성당'
    ]},
    'barista-domestic': { title: '바리스타 · 국내', sub: 'DOMESTIC BARISTA', items: [
      '신창호','임정환','방현영','전주연','서필훈',
      '박이추','강훈','김사홍'
    ]},
    'barista-intl': { title: '바리스타 · 해외', sub: 'INTERNATIONAL BARISTA', items: [
      '샤샤 세스틱','팀 웬델보','히데노리 이자키','피트 리카타','아그니에슈카 로예프스카',
      '디에고 캄포스','마이클 필립스','앤더스 크리스티안센','궬림 데이비스','베르그 우'
    ]},
    'grinder-commercial': { title: '상업용 · 그라인더', sub: 'COMMERCIAL GRINDER', items: [
      'Mahlkonig EK43','Mahlkonig E65S','Ditting KR804','Anfim SP2','Compak K10',
      'Nuova Simonelli Mythos','Victoria Arduino Mythos One','Fiorenzato F64E','Mazzer Robur','Baratza Forte'
    ]},
    'auto-commercial': { title: '상업용 · 자동머신', sub: 'COMMERCIAL AUTOMATIC', items: [
      'Franke A600','WMF 1500S+','Schaerer Coffee Art Plus','Egro One','Melitta Cafina XT6',
      'La Cimbali S30','Necta','Jura GIGA X8 Professional','Thermoplan Black&White3','San Remo Automatic'
    ]},
    'semi-auto-commercial': { title: '상업용 · 반자동머신', sub: 'COMMERCIAL SEMI-AUTO', items: [
      'La Marzocco Linea PB','La Marzocco GB5','Victoria Arduino Eagle One','Nuova Simonelli Aurelia',
      'Rancilio Classe 9','Wega','Dalla Corte XT','San Remo Verona','Rocket Boxer','Slayer Steam'
    ]},
    'drip-machine-commercial': { title: '상업용 · 드립머신', sub: 'COMMERCIAL BATCH BREWER', items: [
      'Fetco CBS-2131','Bunn ICB','Wilbur Curtis G4','Marco Jet','Newco',
      'Grindmaster','Curtis ThermoPro','Bonavita Commercial','Moccamaster Commercial','Technivorm Commercial'
    ]},
    'roaster-sample-home': { title: '로스터기 · 샘플/홈', sub: 'SAMPLE & HOME ROASTER', items: [
      'Aillio Bullet R1','Hottop','Kaldi','Behmor 1600','IKAWA Pro',
      'Probatino','Giesen W1A','San Franciscan','Gene Cafe','코레토 홈로스터'
    ]},
    'roaster-commercial': { title: '로스터기 · 상업용', sub: 'COMMERCIAL ROASTER', items: [
      'Giesen','Probat','Loring Smart Roast','태환 로스터','Diedrich',
      'San Franciscan','Toper','Coffee-Tech','Ozturk','Union'
    ]},
    'grinder-home': { title: '홈카페 · 그라인더', sub: 'HOME GRINDER', items: [
      'Comandante C40','1Zpresso JX-Pro','Fellow Ode','Timemore Slim','Niche Zero',
      'Baratza Encore ESP','DF64','Weber Workshops EG-1','Eureka Mignon','Origin Grinder'
    ]},
    'auto-home': { title: '홈카페 · 자동머신', sub: 'HOME AUTOMATIC', items: [
      "De'Longhi Magnifica",'Breville Barista Express','Philips LatteGo','지멜코스타','Saeco',
      'Gaggia','Smeg','Melitta','Jura','Nespresso'
    ]},
    'dripper': { title: '추출도구 · 커피드리퍼', sub: 'COFFEE DRIPPER', items: [
      '하리오 V60 드리퍼','칼리타 웨이브 드리퍼','고노 드리퍼','오리가미 드리퍼','케맥스 드리퍼',
      '클레버 드리퍼','하리오 스위치 드리퍼','MHW-3BOMBER UFO 드리퍼','오레아 드리퍼','블루보틀 드리퍼'
    ]},
    'scale': { title: '추출도구 · 저울', sub: 'COFFEE SCALE', items: [
      'Acaia Pearl','Acaia Lunar','Timemore Black Mirror','Timemore Nano','Hario V60 Drip Scale',
      'Brewista Smart Scale','Coffee Sensor Scale','디지털 커피저울','타이머 겸용 커피저울','휴대용 커피저울'
    ]},
    'pot': { title: '추출도구 · 커피포트', sub: 'COFFEE DRIP POT', items: [
      'Fellow Stagg EKG','Hario Buono','Brewista Artisan','Timemore Fish','Kalita Wave Pot',
      'Bonavita Pot','Wilfa Pot','Espro Pot','스텐 드립포트','커피 드립케틀'
    ]},
    'drip-machine-home': { title: '홈카페 · 드립머신', sub: 'HOME BATCH BREWER', items: [
      'Technivorm Moccamaster','Bonavita BV1900','OXO Brew','Chemex Ottomatic','Ratio Eight',
      'Behmor Brazen','Ninja Coffee Maker','Melitta','Braun','Russell Hobbs'
    ]},
  };

const PERIODS = {
  daily:   { days: 1 },
  weekly:  { days: 7 },
  monthly: { days: 30 },
  yearly:  { days: 365 },
};

function toDateStr(d) { return d.toISOString().slice(0, 10); }

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- 검색량 (absolute monthly volume) via Naver SearchAd keyword tool ----------
// Same auth scheme as backend/discover-keywords.mjs. This is a single snapshot
// (not windowed by day/week/month/year), so it's fetched once per item list
// per run and reused across all four period tabs.

function adSign(timestamp, method, uri) {
  const message = `${timestamp}.${method}.${uri}`;
  return crypto.createHmac('sha256', AD_SECRET_KEY).update(message).digest('base64');
}

function adAuthHeaders(method, uri) {
  const timestamp = Date.now().toString();
  return {
    'X-Timestamp': timestamp,
    'X-API-KEY': AD_API_KEY,
    'X-Customer': AD_CUSTOMER_ID,
    'X-Signature': adSign(timestamp, method, uri),
    'Content-Type': 'application/json; charset=UTF-8',
  };
}

function parseVolume(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.includes('<')) return 5; // "< 10"
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Naver strips spaces when matching hint keywords against relKeyword, so we
// normalize the same way when matching results back to our item names.
function normalizeKeyword(s) { return String(s).replace(/\s+/g, '').toUpperCase(); }

async function fetchVolumeGroup(names) {
  const uri = '/keywordstool';
  const qs = `?hintKeywords=${encodeURIComponent(names.join(','))}&showDetail=1`;
  const res = await fetch('https://api.naver.com' + uri + qs, { headers: adAuthHeaders('GET', uri) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Naver SearchAd API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.keywordList || [];
}

async function fetchVolumesForItems(items) {
  const volumeMap = {};
  if (!VOLUME_ENABLED) return volumeMap;
  const wanted = new Map(items.map(name => [normalizeKeyword(name), name]));
  for (const group of chunk(items, 5)) {
    try {
      const list = await fetchVolumeGroup(group);
      for (const kw of list) {
        const key = normalizeKeyword(kw.relKeyword);
        if (!wanted.has(key)) continue; // only keep exact matches to our own items, not extra related terms
        const pc = parseVolume(kw.monthlyPcQcCnt);
        const mobile = parseVolume(kw.monthlyMobileQcCnt);
        if (pc === null && mobile === null) continue;
        volumeMap[wanted.get(key)] = (pc || 0) + (mobile || 0);
      }
    } catch (e) {
      console.error('volume fetch failed for group', group, e.message);
    }
    await new Promise(r => setTimeout(r, 350));
  }
  return volumeMap;
}

async function fetchGroup(names, startDate, endDate) {
  const body = {
    startDate, endDate, timeUnit: 'date',
    keywordGroups: names.map(name => ({ groupName: name, keywords: [name] })),
  };
  const res = await fetch('https://openapi.naver.com/v1/datalab/search', {
    method: 'POST',
    headers: {
      'X-Naver-Client-Id': CLIENT_ID,
      'X-Naver-Client-Secret': CLIENT_SECRET,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Naver API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function rankForWindow(items, days, volumeMap) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const groups = chunk(items, 5); // Naver limit: 5 keyword groups / request
  const scored = {};
  for (const g of groups) {
    const data = await fetchGroup(g, toDateStr(start), toDateStr(end));
    for (const series of data.results) {
      const points = series.data || [];
      const avg = points.length ? points.reduce((s, p) => s + p.ratio, 0) / points.length : 0;
      scored[series.title] = avg;
    }
    await new Promise(r => setTimeout(r, 350)); // be gentle with the API
  }
  return Object.entries(scored)
    .sort((a, b) => b[1] - a[1])
    .map(([name, index], i) => {
      const row = { rank: i + 1, name, index: Number(index.toFixed(1)) };
      if (Object.prototype.hasOwnProperty.call(volumeMap, name)) row.volume = volumeMap[name];
      return row;
    });
}

function loadPrevious() {
  try {
    return JSON.parse(fs.readFileSync(path.join('data', 'rankings.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function withDelta(rows, prevRows) {
  const prevRankMap = {};
  (prevRows || []).forEach(r => { prevRankMap[r.name] = r.rank; });
  return rows.map(r => {
    const prevRank = prevRankMap[r.name];
    const delta = prevRank ? prevRank - r.rank : 0;
    return { ...r, delta };
  });
}

async function main() {
  const previous = loadPrevious();
  const out = { generatedAt: new Date().toISOString(), categories: {} };
  for (const [key, cat] of Object.entries(CATS)) {
    out.categories[key] = { title: cat.title, sub: cat.sub, periods: {} };
    let volumeMap = {};
    try {
      volumeMap = await fetchVolumesForItems(cat.items);
    } catch (e) {
      console.error('volume lookup failed for category', key, e.message);
    }
    for (const [periodName, { days }] of Object.entries(PERIODS)) {
      try {
        const rows = await rankForWindow(cat.items, days, volumeMap);
        const prevRows = previous?.categories?.[key]?.periods?.[periodName]?.rows;
        out.categories[key].periods[periodName] = { rows: withDelta(rows, prevRows) };
        console.log('ok:', key, periodName);
      } catch (e) {
        console.error('failed:', key, periodName, e.message);
        const prev = previous?.categories?.[key]?.periods?.[periodName];
        if (prev) out.categories[key].periods[periodName] = prev;
      }
    }
  }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(path.join('data', 'rankings.json'), JSON.stringify(out, null, 2));
  console.log('wrote data/rankings.json');
}

main();
