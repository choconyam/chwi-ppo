# Apply 실행 계약

## compact 입력

```powershell
node scripts/apply-packet.mjs catalog --out .work/apply/claims.md
```

catalog는 검증된 사실과 정본 위치만 보여 준다. 소재 매핑 뒤 회사/직무 폴더에 다음 `application-request.json`을 둔다.

```json
{
  "version": 1,
  "official": {"status":"verified", "url":"https://회사공식사이트/공고", "checkedAt":"2026-09-05T09:00:00+09:00"},
  "eligibility": {"status":"eligible", "reason":"공식 요건과 확인된 사용자 조건 대조"},
  "fit": {"decision":"proceed"},
  "documents": {"jd":"companies/회사/직무/00_JD.md", "analysis":"companies/회사/직무/01_JD분석.md", "fit":"companies/회사/직무/02_직무적합성.md"},
  "questions": [{"id":"Q1", "prompt":"공식 문항 원문", "source":"공식 지원화면 1번", "limit":1000, "claimIds":["WORK-001"], "instructions":"사용자 요청"}]
}
```

JSON 표시는 공식 검증을 대신하지 않는다. 문항 원문·제한·출처가 없거나 자격이 미확정이면 해당 문항을 보류한다.

```powershell
node scripts/apply-packet.mjs prepare --request companies/회사/직무/application-request.json --out .work/apply/current/packet.json
node scripts/apply-packet.mjs prepare --request companies/회사/직무/application-request.json --previous .work/apply/current/packet.json --out .work/apply/current/packet.json
```

먼저 모델용 compact `packet.md`를 읽는다. 검증용 `packet.json`은 입력 문서 전문/hash를 유지하지만, Markdown은 입력 문서 경로와 JD 분석, 선택 claim 공통 사전, 역할·상태·표현 제한을 중복 없이 담는다. 충분하면 `00_JD.md`나 경험 원문 전체를 다시 읽지 않고, 누락·모순이 있을 때만 연결된 정본의 해당 위치를 확인한다. 근거가 없는 문항만 blockedQuestions로 두고 나머지는 계속한다.

- `draft`: 새 작성 또는 바뀐 입력만 반영한다. `previousDraft`는 참고본이다.
- `reuse-draft`: 현재 입력에서 checkpoint를 통과한 검수 전 초안이다. PASS·ready·최종본이 아니다.
- `reuse-final`: 현재 입력 해시와 실제 본문 해시에 대한 final PASS가 남아 있다. 같은 입력과 본문이면 final을 다시 호출하지 않는다.

## 기본 초안과 일반 수정

소수 문항의 claim 배치·작성·수정은 메인이 수행한다. 큰 독립 묶음만 matcher/writer에 한 번에 맡긴다. unknown 사실만 질문하거나 제외하고, 확인된 문항은 즉시 작성한다.

packet이 있는 초안은 checkpoint 한 번으로 text 블록·placeholder·claim 추적·배정 claim·글자수를 함께 검사한다.

```powershell
node scripts/apply-packet.mjs checkpoint --packet .work/apply/current/packet.json --question Q1 --draft companies/회사/직무/04_초안/Q1.md
```

packet에 속하지 않는 독립 지원서 파일만 별도 검사한다.

```powershell
node scripts/check-submission.mjs <파일> <글자수제한>
```

기본 `/apply`는 checkpoint를 통과한 `검수 전 초안`을 바로 전달한다. fact-reviewer·revision-editor·final reviewer·자동 재검수 릴레이를 실행하지 않는다. “이 문장 바꿔 줘”, “최종 문장 좀 바꿔” 같은 일반 수정은 요청 부분만 직접 바꾸고 checkpoint만 갱신한다. 이는 제출 전 전체 검수나 제출본 확정 요청이 아니다. 새 사실이 필요한 부분만 질문한다.

checkpoint는 동일한 입력 해시와 본문 전체 바이트 해시이고 기존 검수 보고서 해시도 유효하면 fact/final PASS를 보존한다. 본문이나 보고서가 변경·삭제되면 PASS를 폐기하고, 현재 입력에서 본문 형식이 유효할 때 `reuse-draft`로 둔다. 입력이 바뀌면 checkpoint를 거부하므로 먼저 prepare를 다시 실행해 그 문항을 `draft`와 기존 초안 참고 상태로 갱신한다.

사용자가 중간 사실 검수를 명시적으로 요청했을 때만 별도 fact-reviewer가 다음 머리글로 실제 파일을 검수하고 기록한다.

```text
- 검수 단계: fact
- 판정: PASS
- 입력 해시: packet.json의 해당 문항 inputHash
- 본문 해시: apply-packet.mjs hash --file <검수 본문>의 값
```

```powershell
node scripts/apply-packet.mjs record --stage fact --packet .work/apply/current/packet.json --question Q1 --draft companies/회사/직무/04_초안/Q1.md --review companies/회사/직무/05_사실검수_Q1.md
```

fact PASS는 final PASS가 아니다. humanizer-ko는 사용자가 명시적으로 요청했을 때만 final 전에 적용하고, 바뀐 문항의 checkpoint만 갱신한다.

## 제출 전 final

`final`, “실제 제출 전 전체 검수”, “제출본으로 확정”처럼 내용 확정 후 제출용 전체 검수가 분명할 때만 실행한다. 표현에 “최종”이 들어갔다는 이유만으로 final 의도를 추정하지 않는다. 공고 상태·자격·문항 변경 여부를 확인하되 변경 없으면 기존 분석·매핑을 재사용한다.

작성 문맥을 상속하지 않은 final-red-team-reviewer(Sol XHigh) 하나가 현재 전체 문항을 한 묶음으로 한 번 검수한다. 범위는 제출에 영향 있는 확인 가능한 결함, 즉 공식 문항·자격 미충족, 사실·수치·기간·역할·상태의 claim 불일치, 문항 미충족, 문항 간 모순이다. 인용된 verified claim과 compact packet을 우선하고 실제 불일치가 있을 때만 해당 원자료 위치를 추가로 읽는다. 문체 취향, 근거 없는 가상 우려, 원래 주장하지 않은 연구 재현·학술 재감사는 REVISE 사유가 아니다. 예상 면접 질문·면접 방어성 검토는 서류 합격 뒤 사용자가 면접 준비를 명시적으로 요청할 때 별도로 진행하며 이 final에 포함하지 않는다.

보고서에는 `검수 단계: final`, 판정, 현재 입력 해시, 실제 본문 해시를 남긴다.

```powershell
node scripts/apply-packet.mjs record --stage final --packet .work/apply/current/packet.json --question Q1 --draft companies/회사/직무/04_초안/Q1.md --review companies/회사/직무/07_최종검수_Q1.md
```

record는 형식·글자수·claim 추적·입력/본문 해시와 PASS를 대조한다. 같은 입력+본문의 final PASS는 재호출하지 않는다. REVISE면 지적된 범위만 수정하고 checkpoint한 뒤 그 지적과 수정 영향만 독립 검수자에게 한 번 재확인한다. 자동 반복하지 않으며 남은 결함은 사용자에게 보고한다. 현재 모든 문항이 final PASS이고 민감정보 검사도 통과해야 `최종/`에 복사하고 ready로 둘 수 있다. submitted는 사용자가 실제 제출을 확인한 경우에만 기록한다.
