# Intake 실행 계약

intake는 최초 정리 뒤 새 경험·사용자 정정만 갱신한다. 기존 `.work/intake/<run-id>/run.json`이 있으면 먼저 `status`로 재개 위치를 확인한다. 완료 작업을 다시 시키지 않고, 실행 중 worker는 플랫폼의 실제 상태를 확인한다.

## 계획과 읽기 범위

```powershell
node scripts/intake-plan.mjs plan --source "C:\내자료" --out .work/intake/current/plan.json
node scripts/intake-plan.mjs plan --out .work/intake/next/plan.json
```

두 번째 명령은 마지막 source를 재사용한다. `--source`는 여러 번, 다른 workspace 테스트에는 `--root`를 쓸 수 있다.

- 계획 JSON/Markdown의 `files`에는 id/path/sha256/status, `execution.requiredFileIds`에는 읽을 범위가 있다.
- `new/changed`만 새로 읽고 `unchanged`는 기존 정본을 재사용한다. `removed`는 접근 가능한 원자료 폴더에서 없어진 파일이며 관련 claim을 검토하되 자동 삭제하지 않는다. source 전체가 없거나 접근이 막혔으면 삭제로 계산하지 않고 해결 전 commit을 보류한다.
- 기본 계획은 `summaryOnly`다. 프로젝트 README·요약만 내용 해시를 읽고 상세 문서·로그·코드·데이터·큰 파일은 inventory에 경로·크기만 남긴다. 필요한 상세 파일만 별도 source로 지정하고, 전체 내용 해시가 꼭 필요할 때만 `--full-inventory`를 쓴다.
- `legacy-review`는 기존 경험의 원자료 링크와 지정 자료 요약부터 대조한다. 전체 재작성·무조건 baseline 등록·읽지 않은 자료의 완료 등록은 금지한다. 별도 승인 절차를 만들지 말고 사실 충돌만 질문한다.
- `modelCalls=0`은 선택된 읽기 범위에 변경이 없다는 뜻일 뿐 inventory 내용 동일을 보증하지 않는다. 양수는 변경 목록의 영향 확인이 필요하다는 뜻이지 실제 위임/토큰 수가 아니다.

## 작업별 저장과 재개

```powershell
node scripts/intake-run.mjs start --plan .work/intake/current/plan.json --run .work/intake/current/run.json
node scripts/intake-run.mjs status --run .work/intake/current/run.json
node scripts/intake-run.mjs claim --run .work/intake/current/run.json --worker main-1
```

메인은 claim의 `id`, `lease`, `sourcePath`, `scope`, `outputPath`만 처리자에게 전달한다. 소량은 직접 처리하고 큰 독립 묶음만 위임한다. 같은 worker의 중복 claim은 기존 작업을 반환하며 실행 중 작업은 기본 최대 2개다.

- 텍스트는 행 번호를 유지해 최대 12,000자 단위로 나눈다. 지정 구간을 한 프롬프트에 다시 합치지 않는다.
- PDF·Office·큰 파일의 `needs-scope`는 목차·페이지·시트·슬라이드부터 보고 필요한 실제 범위를 JSON 문자열 배열로 나눈다. 각 추출 텍스트도 약 12,000자 이내로 하고 읽지 않은 범위를 검토했다고 하지 않는다.
- 사용 가능한 로컬 추출기를 우선한다. 변환 사본은 원문 대체나 사실 검증이 아니므로 표·그림·성적·기간·수치는 원본 위치와 대조한다. MarkItDown 설치나 외부 OCR/AI 전송을 자동 선행하지 않는다.

```powershell
node scripts/intake-run.mjs split --run .work/intake/current/run.json --unit <id> --scopes .work/intake/current/scopes.json
node scripts/intake-run.mjs record --run .work/intake/current/run.json --unit <id> --worker main-1 --lease <claim의-lease> --facts <outputPath>
```

`outputPath`에는 `- 사실:`, `- 출처:`, `- 상태:`를 적고 관련 사실이 없으면 `- 추출 결과: 관련 사실 없음`과 확인 위치를 적는다. 각 구간 직후 record하여 원자료 해시·구간·결과 해시가 연결된 facts 사본을 남긴다. 추출 완료는 의미 검증·프로필 반영 완료가 아니다.

```powershell
node scripts/intake-run.mjs fail --run .work/intake/current/run.json --unit <id> --worker main-1 --lease <claim의-lease> --reason "해당 PDF 텍스트 추출 실패"
node scripts/intake-run.mjs recover --run .work/intake/current/run.json --unit <id> --confirmed-stopped
```

실패 구간만 보류하고 다른 자료를 계속한다. running의 recover는 worker 종료를 실제 확인했을 때만, blocked는 종료 확인 없이 허용한다. 최대 2번 시도 뒤 범위를 줄이거나 사용자 확인으로 넘긴다. 시간 경과는 종료 증거가 아니며 다른 lease의 늦은 결과는 거부된다.

완료 원자료나 facts가 바뀌면 그 작업만 보류한다. 원자료가 바뀌면 새 plan/run에 `start --previous <이전 run>`을 사용해 원자료 해시·구간·규칙·결과 해시가 같은 완료 항목만 재사용한다. 기존 plan/run은 덮어쓰지 않는다.

## 통합과 부분 반영

통합 작성자는 한 명이다. PROFILE 인덱스, 이번 통합 대상 claim과 관련 경험만 읽고 기존 claim-id·사용자 확인을 대조한다. 관련 없는 경험 파일 전체를 증분 통합의 기본 입력으로 다시 읽지 않는다. 주요 경험이 준비되면 상세 자료가 남아도 discover를 진행할 수 있다.

프로필 의미 검토 후 다음처럼 이번 반영 범위만 기록한다. 개인정보 원문은 복사하지 않는다.

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

부분 receipt는 `partial:true`이며 실제 처리 원자료·산출물 해시·확인 구간만 포함한다. 대기·보류·미선택 파일은 완료로 넣지 않는다. 접근 실패한 다른 source는 해당 묶음의 반영을 막지 않는다. 부분 반영 뒤 새 plan과 `--previous`로 계속하며, 부분 반영 전에 만든 오래된 plan의 재반영은 거부된다.

기존 사실 삭제·상태 승격은 merge-review의 `claimChanges`에 id, `remove|verify`, 이유, 실제 사용자 확인/원문 검토를 담은 `.work/intake/` 근거 경로를 기록해야 한다. receipt는 근거 hash를 연결한다. 파일 존재만으로 의미 검수를 대신하지 않고, 확인이 없으면 기존 상태를 보존한다.

기존 일괄 receipt 호환 형식은 다음과 같다.

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

일괄 `processedFiles`는 receiptFileIds 전체를 포함한다. 실제 추출은 extracted, 기존 정본 대조는 reviewed, 선택적 상세읽기 미수행은 deferred다. 필수 요약은 deferred로 통과시킬 수 없고 새 주장에 쓸 선택 파일은 실제 읽어야 한다. 삭제 검토는 id와 삭제 전 hash를 남긴다. commit은 원자료 시점·산출물·claim 형식·처리 누락을 검사해 성공할 때만 `state/intake-manifest.json`을 갱신한다.
