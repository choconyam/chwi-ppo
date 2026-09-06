# 워크플로 실행 계약

아래 명령은 메인 에이전트가 실행한다. 사용자는 원자료 경로, 검색 조건, 선택한 직무를 자연어로 말하면 된다. Node.js 20.19 이상, 추가 API 키·상시 서버 없이 동작한다. 모델은 해석·작성·검수를 맡고 스크립트는 변경·중복·현재 입력 일치를 확인한다.

## intake: 최초 정리, 작은 작업, 중단 후 이어하기

intake는 매번 실행하는 작업이 아니다. 최초 정리 후에는 새 경험·사용자 정정만 갱신한다. 기존 `.work/intake/<run-id>/run.json`이 있으면 먼저 `status`로 재개 위치를 확인한다. 완료된 추출을 다시 시키지 않고, 실행 중인 worker는 플랫폼의 실제 상태를 확인한다. 날짜나 응답 시간 초과만으로 종료를 추정하지 않는다.

### 계획과 읽기 범위

```powershell
node scripts/intake-plan.mjs plan --source "C:\내자료" --out .work/intake/current/plan.json
node scripts/intake-plan.mjs plan --out .work/intake/next/plan.json
```

두 번째 명령은 마지막으로 등록한 source 경로를 재사용한다. `--source`는 여러 번 지정할 수 있다. 다른 workspace 테스트는 `--root`로 지정한다.

- 계획: JSON과 같은 이름의 Markdown. `files`의 id/path/sha256/status와 `execution.requiredFileIds`를 사용한다.
- `new/changed`: 실제로 새로 읽을 파일. `unchanged`: 기존 정본 재사용.
- `removed`: 접근 가능한 원자료 폴더 안에서 없어진 파일. 해당 claim을 검토하되 자동 삭제하지 않는다.
- source 전체가 없어지거나 접근이 막혔으면 삭제로 계산하지 않는다. 해당 source를 해결하기 전 commit은 보류한다.
- 기본 CLI 계획은 `summaryOnly`다. 프로젝트 README·요약은 해시를 읽고, 하위 상세 문서·실행 로그·코드·데이터·큰 파일은 `inventory`에 경로·크기만 남긴다. 이들은 읽거나 처리 완료로 등록한 자료가 아니다. 폴더 안의 프로젝트도 구분한다. 필요한 상세 문서는 개별 `--source`로 지정한다. 전체 내용 해시 목록이 명시적으로 필요할 때만 `--full-inventory`를 사용한다.
- `legacy-review`: 기존 프로필이 있지만 처리 이력이 없다. 기존 경험과 원자료 링크를 대조한 범위만 처리한다. 전체 재작성이나 무조건 baseline 등록은 금지한다. 별도의 사용자 승인 절차를 새로 요구하지 않으며 사실 충돌만 질문한다.
- `modelCalls=0`이면 선택된 읽기 범위의 원자료 변경이 없다는 뜻이다. inventory의 내용까지 동일하다고 보증하지 않는다. 양수는 변경 목록의 영향 확인이 필요함을 뜻하며 실제 위임 횟수·토큰 측정값이 아니다. 코드·데이터 갱신을 사용자가 알리면 관련 claim의 근거 파일만 추가로 지정한다.

### 작업별 저장과 재개

```powershell
node scripts/intake-run.mjs start --plan .work/intake/current/plan.json --run .work/intake/current/run.json
node scripts/intake-run.mjs status --run .work/intake/current/run.json
node scripts/intake-run.mjs claim --run .work/intake/current/run.json --worker main-1
```

메인이 claim의 `id`, `lease`, `sourcePath`, `scope`, `outputPath`를 추출자에게 전달한다. 소량은 메인 자신이 수행하고 큰 독립 묶음만 위임한다. 같은 worker의 중복 claim은 기존 작업을 반환하며 실행 중인 작업은 기본 최대 2개다. API 키·백그라운드 서버·별도 AI 호출은 이 스크립트에 없다.

- 텍스트는 원문 행 번호를 유지하며 최대 12,000자 단위로 나뉜다. 지정한 행만 읽고 모든 구간을 한 프롬프트에 다시 합치지 않는다.
- PDF·Office·큰 파일은 `needs-scope`다. 목차·페이지/시트/슬라이드를 확인하고 필요한 실제 범위를 JSON 문자열 배열로 적어 분할한다. 예: `["slides 1-4", "slides 5-8"]`. 각 구간의 추출 텍스트도 약 12,000자 이내가 되게 나눈다. 실제로 읽지 않은 나머지 부분까지 검토했다고 표현하지 않는다.
- 사용 가능한 로컬 추출기를 우선한다. MarkItDown 설치나 모든 자료의 MD 변환은 선행 조건이 아니다. 변환 사본은 원문 대체·사실 검증이 아니며 표·그림·성적·수치는 원본 위치를 대조한다. 외부 OCR/AI 전송을 자동 활성화하지 않는다.

```powershell
node scripts/intake-run.mjs split --run .work/intake/current/run.json --unit <id> --scopes .work/intake/current/scopes.json
node scripts/intake-run.mjs record --run .work/intake/current/run.json --unit <id> --worker main-1 --lease <claim의-lease> --facts <outputPath>
```

각 구간이 끝나면 즉시 record한다. `outputPath`에는 `- 사실:`, `- 출처:`, `- 상태:`를 적고 관련 사실이 없으면 `- 추출 결과: 관련 사실 없음`과 확인 위치를 적는다. 원자료 해시와 구간·결과 해시가 연결된 사본을 facts/에 보존한다. 추출 완료는 의미 검증·프로필 반영과 별개다. run 상태는 원자적으로 저장하며 controller 명령의 동시 쓰기를 막는다.

```powershell
node scripts/intake-run.mjs fail --run .work/intake/current/run.json --unit <id> --worker main-1 --lease <claim의-lease> --reason "해당 PDF 텍스트 추출 실패"
node scripts/intake-run.mjs recover --run .work/intake/current/run.json --unit <id> --confirmed-stopped
```

실패한 자료만 보류하고 다른 자료를 계속한다. running의 recover는 메인이 해당 worker 종료를 실제로 확인했을 때만 허용한다. blocked에는 종료 확인 플래그가 필요 없다. 최대 2번 시도(최초+재시도 1회) 뒤에는 원인 확인·구간 축소 또는 사용자 확인으로 넘긴다. 오래됐다는 이유로 살아 있는 worker를 재실행하지 않으며, 이전 시도의 늦은 결과는 lease가 달라 거부된다.

status는 전체 구간/추출 완료/실행 중/대기/범위 지정/보류와 미선택 파일 수를 보여준다. 완료 원자료나 facts가 바뀌면 그 작업만 보류한다. 원자료 변경에는 새 plan과 다른 run 경로를 사용한다. `start --plan <새 plan> --run <새 run> --previous <이전 run>`은 원자료 해시·구간·규칙과 결과 해시가 일치하는 완료 항목만 재사용한다. 기존 plan/run은 덮어쓰지 않는다.

### 통합과 부분 반영

통합 작성자는 한 명이다. 기존 claim-id·사실·사용자 확인을 먼저 대조하므로 통합 도중 중단되어도 같은 사실을 다시 추가하지 않는다. 검토가 끝난 주요 경험으로 프로필을 먼저 만들 수 있으며, 상세 자료 하나가 미완료라고 discover까지 막지 않는다.

프로필 의미 검토와 형식 검증 후 다음 통합 검수 기록을 작성한다. fileIds는 해당 파일의 선택 구간을 모두 추출하고 프로필에 검토·반영한 대상만 적는다. 개인정보 원문은 복사하지 않는다.

```json
{
  "fileIds": ["검토한 파일 ID"],
  "validation": {"status": "passed"},
  "outputs": ["profile/PROFILE.md", "profile/experiences/경험.md"],
  "legacyReviewApproved": true
}
```

```powershell
node scripts/validate-profile.mjs
node scripts/intake-run.mjs receipt --run .work/intake/current/run.json --review .work/intake/current/merge-review.json --out .work/intake/current/receipt.json
node scripts/intake-plan.mjs commit --plan .work/intake/current/plan.json --receipt .work/intake/current/receipt.json
```

이 receipt는 `partial:true`이며 처리한 원자료·산출물 해시·실제 확인 구간만 기록한다. 접근 실패한 다른 원자료는 해당 묶음의 반영을 막지 않는다. 대기·보류·미선택 파일은 manifest에 처리 완료로 넣지 않는다. 반영 후 남은 자료를 계속하려면 새 plan과 `--previous`로 기존 완료 결과를 연결한다. 부분 반영 전에 만든 오래된 plan의 재반영은 거부된다.

접근 실패한 source 경로도 상태와 함께 보존하므로 다음 실행에서 다시 확인한다. plan은 기존 claim-id·상태도 저장한다. 기존 사실을 삭제하거나 상태를 높이는 경우에는 merge-review의 `claimChanges`에 `id`, `action`(`remove`/`verify`), `reason`, `evidence`를 추가한다. evidence는 해당 claim-id와 실제 사용자 확인/원문 검토 내용을 담은 `.work/intake/` 내 기록 경로다. receipt는 이 기록의 hash를 연결하고 commit은 변경 근거가 없는 삭제·승격을 거부한다. 파일이 존재한다는 검사만으로 사용자 확인의 진실성이나 의미 검수를 대신하지 않는다. 확인을 받지 않았다면 기록을 만들지 말고 기존 사실·확인 필요 상태를 보존한다.

### 기존 일괄 receipt 호환

추출자는 실제 읽은 파일 id/sha256과 결과를 staging에 남긴다. 통합 후 프로필 형식 검증을 실행한다.

```powershell
node scripts/validate-profile.mjs
node scripts/intake-plan.mjs commit --plan .work/intake/current/plan.json --receipt .work/intake/current/receipt.json
```

receipt 최소 형식:

```json
{
  "schemaVersion": 1,
  "planId": "plan.json의 planId",
  "status": "success",
  "validation": {"status": "passed"},
  "outputs": ["profile/PROFILE.md", "profile/experiences/경험.md"],
  "processedFiles": [{"id": "실제 파일 ID", "sha256": "plan의 내용 hash", "outcome": "extracted"}],
  "removedFiles": [],
  "legacyReviewApproved": true
}
```

부분 반영이 아닌 기존 일괄 receipt의 `processedFiles`는 계획의 receiptFileIds 전체에 대해 작성한다. 실제 추출은 extracted, 기존 정본 대조는 reviewed, 선택적 상세읽기 미수행은 deferred로 남긴다. 필수 요약을 deferred로 통과시킬 수 없다. 선택적 파일은 원자료로 새 주장을 만들 때 실제로 읽어야 한다. 삭제 검토는 removedFiles에 id와 삭제 전 hash를 적는다. legacyReviewApproved는 legacy일 때 기존 정본 대조를 마쳤다는 기록이다.

commit은 원자료가 계획 시점 그대로인지, 산출물과 claim 형식이 있는지, 처리 항목이 누락되지 않았는지 확인한다. 성공할 때만 `state/intake-manifest.json`에 반영한다. receipt의 검증 표시는 사람/모델의 의미 검수를 대체하지 않는다.

## discover: 포털 목록 → 기업의 세부 JD

### 목록 수집

기본 출발점은 사용자가 말한 채용 포털이다. 자소설닷컴은 다음 수집기를 먼저 사용한다.

```powershell
node scripts/collect-jasoseol.mjs --out .work/discover/current/snapshot.json
node scripts/collect-jasoseol.mjs --out .work/discover/current/snapshot.json --resume .work/discover/current/snapshot.json
```

공개 검색 페이지의 구조화된 데이터를 코드로 읽어 회사·세부 직무·채용형태·출처를 저장한다. 요청한 페이지와 마감 제외 필터가 실제 적용됐는지도 확인한다. 한 실행의 기본 페이지 예산은 20이며 `--max-pages`로 조정할 수 있다. 전체가 더 많으면 nextPage부터 재개한다. 모든 페이지·표시 총수·고유 공고 수가 맞아야 해당 필터 범위 수집 완료다. 목록 변동, 접근 차단, 사이트 형식 변경은 부분 수집과 오류로 남기고 우회하지 않는다. 24시간 넘은 snapshot은 재개 대신 새로 수집한다.

마감 공고 제외 목록에는 접수 예정·상시 공고도 있을 수 있다. 수집 성공은 현재 지원 가능 판정이 아니다. 회사 규모·지원 유형을 수집 단계에서 좁히지 않고 다음 단계에서 판단해 기타/미상 기업이나 혼합 공고의 누락을 줄인다. rawEvidence.employmentPageUrl은 공식 확인을 시작할 후보 URL이다.

수집기 실패 또는 다른 포털에서는 아래 절차를 사용한다. 자소설닷컴의 [달력](https://jasoseol.com/recruit)이 날짜만 반환하면 [공고 목록](https://jasoseol.com/search)을 연다. 2026-09-05 목록 UI에서 `excludeClosed=true`, `page=2`와 실제 결과 변화까지 확인했다. 이 동작은 사이트 변경에 따라 달라질 수 있다.

1. 포털 UI에서 기업 규모·신입/경력·기간을 설정하고 현재 필터를 기록한다. 산업은 기업의 업종만 보고 좁히지 않는다. 예: 금융회사의 데이터 직무도 대상일 수 있다.
2. 화면 또는 접근 가능한 공개 목록에서 표시된 행을 수집한다. 페이지 번호/더 보기/표시 총수를 기록한다. 다음 페이지 URL은 실제 링크나 UI에서 확인하고 임의 파라미터를 만들지 않는다.
3. 검색 결과 일부만 반환되면 `complete:false`로 보관한다. 다른 포털 또는 공식 사이트 검색은 누락 구간/사용자가 지정한 기업 보충용이다. 접근 실패는 재시도 한 번 후 대체 수단으로 이동한다. 대체도 실패하면 알려진 후보 작업을 먼저 계속한다.
4. 해당 검색 범위의 행을 전부 수집하기 전에는 “전체 기업 탐색 완료”라 하지 않는다. 시간을 나눠 처리할 때는 수집한 페이지·미수집 구간·다음 재개 지점을 보고한다.

snapshot 형식은 [예시](../data/discovery-snapshot.example.json)를 따른다. sources에는 id/url/checkedAt/query 또는 filters/complete/pagesVisited/expectedPages 또는 expectedCount/listedCount/accessStatus를 둔다. postings는 sourceId, sourceRowId 또는 url, company/title, 알려진 size/careerTypes/deadline, roles를 담는다. 한 공고의 세부 직무 각각을 roles에 넣고 보이지 않으면 빈 배열로 둔다. 원문 근거는 rawEvidence에 남긴다.

완전성 숫자는 추정하지 않는다. `listedCount`는 읽은 페이지에서 실제 보인 행 수, `expectedCount`는 같은 필터의 전체 표시 수다. 총수가 없으면 끝 페이지 확인으로 expectedPages를 기록한다. 각 관측 행은 처리 결과 ledger에 대응한다.

### 조건과 큐

```powershell
node scripts/discovery-plan.mjs --snapshot .work/discover/current/snapshot.json --criteria .work/discover/current/criteria.json --out .work/discover/current/queue.json --now "2026-09-05T09:00:00+09:00"
```

[검색 조건 예시](../data/search-criteria.example.json)를 사용자 PROFILE에서 만든다. 지원 유형 careerTypes는 new/experienced/any/mixed/intern 또는 한글 값을 사용한다. 모르면 빈 배열이다. `experienceMonths`는 검증된 관련 경력 개월 수일 때만 `experienceMonthsBasis:"verified-relevant"`를 함께 기록한다. 총 경력이 곧 모든 직무의 관련 경력은 아니므로 분야가 달라지면 null로 두고 공식 검증 때 확인한다. 겹치는 근무/인턴/연구 경력을 자동 합산하지 않는다.

sizes/keywords/regions/industries는 사용자 조건이다. 스크립트는 알려진 채용형태·규모·명확한 경력 부족·기간 종료만 자동 제외하고, 지역/산업과 기술 연결은 후보 비교 역할이 판단한다. 키워드는 조회 순서이며 적합도 점수가 아니다. 모르는 값과 역할 미상 공고는 추가 확인 대상으로 남긴다.

출력에는 모든 후보와 원본 행별 ledger, coverage, 첫 8개 검증 대상과 remaining이 있다. 첫 묶음을 처리한 뒤 남은 후보를 이어서 검토한다. 좁은 상위 후보 추천을 요청했으면 미처리 수와 이유를 명시하고, 전수 검색 요청이면 큐와 수집 구간이 끝날 때까지 이어간다.

모델은 큰 queue.json 전체 대신 함께 생성되는 queue.brief.md 기업 인덱스부터 읽는다. 연결된 queue.companies/ 파일에는 그 기업의 모든 후보 직무와 공식 확인 출발 URL이 있다. 미리보기의 직무명 6개 제한은 표시 분량일 뿐 제외 기준이 아니다. 관련되거나 모호한 기업은 상세 직무를 읽고 결정한다.

### 공식 확인·캐시

같은 회사의 공통 조건을 한 번 읽고 세부 JD를 비교한다. companyChecks에는 포털의 현재 공고가 경력 조건에 맞지 않아도 기업의 다른 공고를 확인할 대상이 남는다. 공식 채용 목록에서 다른 신입/경력/상시 JD를 확인하고 추천 직무를 선택한다. 유망 후보에만 00/01 파일을 작성하고 Sol High가 여러 후보를 한 번에 적합성 비교한다.

공식 본문이 이미지라 웹 텍스트가 비었으면 브라우저의 해당 표·자격 영역을 읽는다. 접근 실패로 해석해 건너뛰거나 포털 요약을 공식 본문으로 대체하지 않는다. 이미지도 확인할 수 없으면 그 요건만 미확인으로 둔다. 공식 문항이 로그인 뒤에 있으면 그 부분만 사용자에게 요청한다.

검증 완료 후보의 queue.candidates[].verification에 다음 값을 저장한다.

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

다음 실행에서 `--previous <기존 queue.json>`을 넘긴다. 같은 내용·조건과 유효한 공식 확인만 재사용한다. 기본 TTL은 24시간, 마감 경과와 내용 변경은 즉시 재확인한다. 상시 공고의 closesAt은 null일 수 있으며 최종 작성 시 접수 상태를 확인한다. 원문 파일이 없거나 변경됐으면 해당 00/01 산출물을 먼저 복구/갱신한다. 캐시 적중이 새 지원자에게 자격을 승인한다는 뜻은 아니다.

### 추천 산출

02_직무적합성.md에는 자격 판정, 경험 연결, 부족 요건, 우선순위와 사용 claim-id를 적는다. 신입/경력 혼합 공고의 각각 다른 경력 기준을 구분한다. 추천 표는 회사·직무별로 쓰고 적합한 직무가 없는 회사와 미확인 회사를 구분한다. 일정 반영은 이 결과를 받은 뒤 track이 수행한다.

## apply: 필요한 근거만 전달하고 변경된 문항만 작성

```powershell
node scripts/apply-packet.mjs catalog --out .work/apply/claims.md
```

catalog는 검증된 사실과 정본 위치만 보여준다. 개인 사실은 Markdown 정본을 유지한다. 소재매핑을 수행한 뒤 회사/직무 폴더에 application-request.json을 저장한다.

```json
{
  "version": 1,
  "official": {"status":"verified", "url":"https://회사공식사이트/공고", "checkedAt":"2026-09-05T09:00:00+09:00"},
  "eligibility": {"status":"eligible", "reason":"공식 요건과 확인된 사용자 조건 대조"},
  "fit": {"decision":"proceed"},
  "documents": {"jd":"companies/회사/직무/00_JD.md", "analysis":"companies/회사/직무/01_JD분석.md", "fit":"companies/회사/직무/02_직무적합성.md"},
  "questions": [{"id":"Q1", "prompt":"공식 문항 원문", "source":"공식 지원화면 1번", "limit":1000, "claimIds":["WORK-001"], "instructions":"사용자가 원하는 서술 형식"}]
}
```

이 값은 공식 검증·적합성 결과를 옮긴 것이다. JSON에 verified/eligible을 적는 것만으로 검증을 대신할 수 없다. 문항 제한과 출처가 없거나 자격이 미확정이면 해당 직무의 제출용 문장을 생성하지 않는다.

```powershell
node scripts/apply-packet.mjs prepare --request companies/회사/직무/application-request.json --out .work/apply/current/packet.json
node scripts/apply-packet.mjs prepare --request companies/회사/직무/application-request.json --previous .work/apply/current/packet.json --out .work/apply/current/packet.json
```

packet.md는 문항별 글자수·작성 요청·배정된 검증 사실·역할 제한·JD를 담는다. 근거/문항 정보가 없는 항목은 blockedQuestions로 분리하고 나머지는 진행한다. 모두 보류면 입력 보완을 요청한다. 일반적인 소수 문항은 메인이 작성하며 복잡한 묶음만 draft-writer에 맡긴다.

문항 상태는 다음처럼 구분한다.

- `draft`: 새로 작성하거나 현재 입력에 맞게 기존 초안을 부분 수정한다. `previousDraft`가 있으면 참고하되 현재 근거를 다시 확인한다.
- `reuse-draft`: 현재 입력에서 글자수·형식을 통과한 검수 전 초안이다. 직접 편집된 본문도 prepare가 다시 검사해 이 상태로 보존할 수 있다. PASS·`ready`·최종본이 아니다.
- `reuse-final`: 현재 입력과 실제 본문 해시에 대한 독립 최종 검수 PASS가 남아 있다.

초안을 `04_초안/`에 저장하고 문항별로 검사·체크포인트한다. 사용자가 정확한 분량을 요청하지 않았다면 제한 이내로 쓰며 예시의 1000자를 강제로 채우지 않는다.

```powershell
node scripts/check-submission.mjs companies/회사/직무/04_초안/Q1.md 1000
node scripts/apply-packet.mjs checkpoint --packet .work/apply/current/packet.json --question Q1 --draft companies/회사/직무/04_초안/Q1.md
```

여기까지가 기본 `/apply`다. 검수 전 초안을 사용자에게 바로 전달하고, 일반 수정은 요청한 부분만 바꾼 뒤 같은 검사를 갱신한다. 근거가 부족하면 그 부분만 질문하거나 제외한다. fact-reviewer·revision-editor·자동 재검수는 기본 실행에 넣지 않는다.

사용자가 중간 사실 검수를 명시적으로 요청하면 작성자와 분리된 fact-reviewer가 실제 파일을 읽고 문항별 보고서 머리에 다음 항목을 기록한다.

```text
- 검수 단계: fact
- 판정: PASS
- 입력 해시: packet.json의 해당 문항 inputHash
- 본문 해시: apply-packet.mjs hash --file <검수 본문>의 값
```

```powershell
node scripts/apply-packet.mjs record --stage fact --packet .work/apply/current/packet.json --question Q1 --draft companies/회사/직무/04_초안/Q1.md --review companies/회사/직무/05_사실검수_Q1.md
```

이 기록은 선택적 중간 검수이며 final PASS가 아니다. humanizer-ko는 사용자가 명시적으로 요청했을 때만 final 전에 적용하고, 바뀐 파일을 다시 검사·체크포인트한다.

사용자가 내용 확정 뒤 `final` 또는 제출본 확정을 요청하면 별도 fact 검수를 추가하지 않고 final-red-team-reviewer(Sol XHigh)를 한 번 독립 실행한다. 현재 전체 문항의 사실·수치·역할·질문 충족·일관성을 함께 검수하고 문항별 보고서에 `검수 단계: final`과 현재 입력/실제 본문 해시를 남긴다.

```powershell
node scripts/apply-packet.mjs record --stage final --packet .work/apply/current/packet.json --question Q1 --draft companies/회사/직무/04_초안/Q1.md --review companies/회사/직무/07_최종검수_Q1.md
```

record는 실제 본문 글자수·claim 추적표·입력/본문 해시와 PASS를 대조한다. 문항·claim·JD·본문이 바뀌면 이전 final PASS를 재사용하지 않는다. REVISE면 revision-editor가 지적 범위만 별도 수정하고, 형식 검사 뒤 기존 지적과 변경 영향·문항 간 일관성을 한 번 재검수한다. 문제가 남으면 자동으로 반복하지 않고 보고한다. 현재 모든 문항에 final PASS가 있고 민감정보 검사도 통과해야 `최종/`에 복사하고 `ready`로 둘 수 있다. `submitted`는 사용자의 실제 제출 확인이 있어야 한다.

## 검증과 기록

`npm run test:workflow`는 Node 기본 테스트로 변경분, 신입/경력 후보 처리, 수집 중단·재개, 페이지 누락, 중복, cache 만료, 근거·검수 재사용과 전체 파일 연결을 확인한다. 실제 사이트와 모델 판단을 대신 검증하지 않는다. live 수집 시험은 이 명령과 별도로 실행하고, 선택한 공식 JD·추천·본문을 직접 대조한다.

실행별 보고에는 읽은 파일/변경 파일 수, 수집 범위와 후보/잔여 수, 실제 위임 횟수, 검증 결과와 재개 위치를 짧게 남긴다. 측정하지 않은 시간·토큰 절감률이나 모든 채용시장 탐색 보장은 쓰지 않는다.
