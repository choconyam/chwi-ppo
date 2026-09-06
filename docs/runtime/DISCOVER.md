# Discover 실행 계약

## 목록 수집

기본 출발점은 사용자가 지정한 포털이다. 자소설닷컴은 다음 수집기를 먼저 쓴다.

```powershell
node scripts/collect-jasoseol.mjs --out .work/discover/current/snapshot.json
node scripts/collect-jasoseol.mjs --out .work/discover/current/snapshot.json --resume .work/discover/current/snapshot.json
```

공개 목록의 회사·세부 직무·채용형태·출처와 실제 필터를 저장한다. 기본 페이지 예산은 20이며 `--max-pages`로 조정한다. 전체가 더 많으면 nextPage부터 재개한다. 모든 페이지·표시 총수·고유 공고 수가 맞아야 해당 범위를 완료로 표시한다. 목록 변동·접근 차단·형식 변경은 부분 수집/오류로 남기고, 24시간 넘은 snapshot은 재개하지 않고 새로 수집한다.

마감 제외 목록에도 접수 예정·상시가 섞일 수 있어 수집 성공은 지원 가능 판정이 아니다. 규모·지원 유형을 수집 단계에서 좁히지 않는다. `rawEvidence.employmentPageUrl`은 공식 확인 출발점일 뿐 공식 근거가 아니다.

수집기 실패나 다른 포털은 UI의 실제 필터, 확인 시각, 페이지/더보기/표시 총수와 관측 행을 기록한다. 다음 페이지 URL은 실제 링크나 UI에서 확인한다. 일부만 반환되면 `complete:false`로 남기고 재시도 한 번 뒤 대체 수단으로 이동한다. 접근 실패와 채용 없음, 첫 페이지와 전체 검색을 구분한다.

snapshot은 [예시](../../data/discovery-snapshot.example.json)를 따른다. sources에는 id/url/checkedAt/query 또는 filters/complete/pagesVisited/expectedPages 또는 expectedCount/listedCount/accessStatus를, postings에는 sourceId, sourceRowId 또는 url, company/title, 알려진 size/careerTypes/deadline, roles와 rawEvidence를 둔다. 완전성 숫자는 추정하지 않고 모든 관측 행을 ledger 결과에 연결한다.

## 조건과 큐

```powershell
node scripts/discovery-plan.mjs --snapshot .work/discover/current/snapshot.json --criteria .work/discover/current/criteria.json --out .work/discover/current/queue.json --now "2026-09-05T09:00:00+09:00"
```

[검색 조건 예시](../../data/search-criteria.example.json)는 PROFILE에서 만든다. careerTypes는 new/experienced/any/mixed/intern 또는 한글 값이며 모르면 빈 배열이다. `experienceMonths`는 검증된 관련 경력일 때만 `experienceMonthsBasis:"verified-relevant"`와 기록한다. 분야가 다르면 null로 두고, 겹치는 근무·인턴·연구 경력을 자동 합산하지 않는다.

스크립트는 알려진 채용형태·규모·명확한 경력 부족·마감만 자동 제외한다. 지역/산업/기술 연결은 후보 비교에서 판단하며, 미상·역할 미상은 추가 확인으로 남긴다. 첫 8개 검증 대상 뒤 remaining을 이어 처리한다. 전수 요청이면 큐와 수집 범위가 끝날 때까지 진행하고, 좁은 추천이면 미처리 수와 이유를 밝힌다.

모델은 `queue.json` 전체 대신 `queue.brief.md`부터 읽고 관련·모호 기업만 `queue.companies/`에서 확인한다. 미리보기 직무 수 제한은 제외 기준이 아니다.

## 공식 확인·조기 종료·캐시

같은 회사의 공통 조건은 한 번 읽고 세부 JD에 재사용한다. 공식 목록에서 포털에 잡힌 공고 외 관련 신입·경력·상시 JD도 확인한다. 공식 본문이 이미지면 해당 자격/JD 영역을 브라우저로 읽고, 확인 불가 부분만 미확인으로 둔다. 로그인 뒤 문항은 그 문항만 사용자에게 요청한다.

학위·전공·졸업 시점·필수 경력처럼 공통 자격이 명백히 충족되지 않으면 공통 요건 근거와 한 줄 사유를 queue/추천 결과에 남기고 그 직무의 긴 `00~02` 보고서와 개인 경험 재비교를 만들지 않는다. 공식 확인이 필요한 모호한 자격은 조기 탈락시키지 않는다. 유망하거나 모호한 후보만 `00_JD.md`, `01_JD분석.md`, `02_직무적합성.md`로 진행한다.

검증 완료 후보의 queue verification은 다음 정보를 저장한다.

```json
{
  "state": "verified",
  "source": "official",
  "officialStatus": "open",
  "officialUrl": "https://회사공식사이트/공고",
  "checkedAt": "2026-09-05T09:00:00+09:00",
  "closesAt": "2026-09-21T18:00:00+09:00",
  "evidence": "공식 접수 상태·기간·세부 JD의 근거"
}
```

다음 실행은 `--previous <기존 queue.json>`으로 같은 내용·조건과 유효한 공식 확인을 재사용한다. 기본 TTL 24시간이며 마감 경과·내용 변경은 즉시 재확인한다. 상시 공고는 closesAt이 null일 수 있고 final 때 접수 상태를 다시 확인한다. 원문 파일이 없거나 변경됐으면 해당 00/01만 복구·갱신한다. 캐시 적중은 새 지원자의 자격 승인이 아니다.

`02_직무적합성.md`에는 자격, 경험 연결, 부족 요건, 우선순위와 claim-id를 적는다. 신입/경력 혼합 경로와 동일 회사 복수 지원 제한을 구분한다. 결과 뒤 일정 반영은 track이 선택적으로 수행한다.
