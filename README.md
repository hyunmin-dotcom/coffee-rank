.github/workflows/update-rankings.yml
# COFFEE RANK — 네이버 검색 트렌드 연동 가이드

이 폴더는 정적 페이지(`index.html`)와, 실제 네이버 검색 트렌드 데이터를
가져와 `data/rankings.json`을 갱신하는 백엔드 스크립트(`backend/fetch-trends.mjs`),
그리고 그걸 매시간 자동 실행하는 GitHub Actions 워크플로로 구성되어 있습니다.

## 동작 방식

```
GitHub Actions (매시간)
   └─ backend/fetch-trends.mjs 실행
        └─ 네이버 데이터랩 검색어트렌드 API 호출 (카테고리별 전 항목)
        └─ data/rankings.json 갱신 후 저장소에 커밋
                └─ Render(정적 사이트)가 자동 재배포
                        └─ index.html이 data/rankings.json을 fetch해서 화면에 표시
```

`index.html`은 `data/rankings.json`을 우선 사용하고, 파일이 없거나 아직
한 번도 갱신되지 않았다면 화면에 표시되는 값은 데모용 mock 데이터로
자동 대체됩니다. 화면 상단 "실시간 · 데이터 갱신 …" 문구로 지금 실데이터인지
데모 데이터인지 바로 구분할 수 있습니다.

## 중요 — 네이버 데이터랩 API의 한계

- **완전한 실시간이 아닙니다.** 네이버 데이터랩 검색어트렌드 API는 보통
  하루 정도의 지연이 있는 일 단위 데이터를 제공합니다. "실시간처럼 자주
  갱신되는 순위"는 가능하지만, 초/분 단위로 변하는 진짜 실시간 검색량은
  네이버가 외부에 공개하지 않습니다.
- **절대 검색량이 아니라 상대 지수**입니다. 한 번의 API 요청 안에서
  1위를 100으로 환산한 상대값이라, 서로 다른 카테고리(예: '생두'와
  '커피툴')의 지수를 직접 비교할 수는 없습니다. (지금 페이지도 카테고리
  내부에서만 비교하도록 만들어져 있어 문제 없습니다.)
- 요청당 최대 5개 키워드 그룹까지만 가능해서, 항목이 10개인 카테고리는
  API를 2번 나눠서 호출합니다.
- **일간/주간/월간/연간 4개 구간을 모두 수집**하므로, 카테고리당 API 호출이
  약 4배로 늘어납니다 (카테고리 23개 × 평균 2회 × 4구간 ≈ 180회/실행). 네이버
  API 일일 호출 한도에 여유가 있는지 확인하고, 필요하면 워크플로 주기를
  줄이세요 (예: 매시간 → 하루 1~3회).

## 설정 방법

### 1. 네이버 API 키 발급
1. https://developers.naver.com/apps 에서 애플리케이션 등록
2. 사용 API에 **"검색어트렌드"** 추가
3. 발급된 **Client ID / Client Secret** 확보

### 2. GitHub 저장소 설정
1. 이 폴더를 GitHub 저장소로 push
2. 저장소 Settings → Secrets and variables → Actions 에서 등록:
   - `NAVER_CLIENT_ID`
   - `NAVER_CLIENT_SECRET`
3. Actions 탭에서 "Update Coffee Rankings" 워크플로를 한 번 수동 실행
   (workflow_dispatch) 해서 `data/rankings.json`이 정상적으로 갱신되는지 확인

이후로는 매시간 자동으로 실행되어 `data/rankings.json`을 커밋합니다.

### 3. Render 배포 (정적 사이트)
1. Render 대시보드 → New → Static Site → 이 저장소 연결
2. `render.yaml`이 있으므로 Build Command / Publish 경로는 자동 인식됩니다
   (Build Command: 없음, Publish 경로: 저장소 루트)
3. GitHub Actions가 `data/rankings.json`을 커밋할 때마다 Render가 자동으로
   재배포되어 최신 데이터가 반영됩니다

### 4. 로컬에서 직접 테스트
```bash
export NAVER_CLIENT_ID=발급받은값
export NAVER_CLIENT_SECRET=발급받은값
node backend/fetch-trends.mjs
# data/rankings.json이 갱신되는지 확인
python3 -m http.server 8000
# http://localhost:8000 접속
```

## 파일 구조

```
index.html                          메인 페이지 (실데이터 우선, mock 폴백)
data/rankings.json                  최신 랭킹 데이터 (자동 갱신됨, 지금은 시드값)
backend/fetch-trends.mjs            네이버 API 호출 + 랭킹 산출 스크립트
.github/workflows/update-rankings.yml   매시간 자동 실행 워크플로
render.yaml                         Render 정적 사이트 배포 설정
```

## 갱신 주기 바꾸기

`.github/workflows/update-rankings.yml`의 `cron: '0 * * * *'` 부분을
원하는 주기로 바꾸면 됩니다 (예: 매 30분마다 `*/30 * * * *`). 네이버 API가
일 단위 데이터를 주는 만큼, 너무 잦은 호출은 큰 의미가 없을 수 있습니다 —
1~3시간 주기를 권장합니다.
