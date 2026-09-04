# 에이전트 계층 구조

## 설계 원칙

1. 사용자가 실행하는 단위는 스킬, 판단 단위는 에이전트, 규칙 검사는 스크립트로 나눈다.
2. 에이전트는 자기 산출물만 쓰며 다른 에이전트의 파일을 임의로 수정하지 않는다.
3. 단계 간 전달은 대화 기억이 아니라 파일과 명시된 판정값으로 한다.
4. 작성자와 검수자를 분리하고 최종 검수는 새 문맥에서 실행한다.
5. 개인정보와 실제 지원 결과는 공개 저장소에서 제외한다.

## 전체 구조

```text
career-orchestrator
│
├─ intake
│  ├─ document-extractor       efficient
│  ├─ project-extractor        efficient
│  └─ profile-synthesizer      efficient
│
├─ discover
│  ├─ job-finder               efficient
│  ├─ posting-verifier         efficient
│  ├─ jd-analyzer              efficient
│  └─ role-fit-checker         strategic
│
├─ apply
│  ├─ evidence-matcher         efficient
│  ├─ draft-writer             strategic
│  ├─ fact-reviewer            strategic / read-only
│  ├─ revision-editor          strategic
│  └─ final-red-team-reviewer  final-audit / read-only
│
└─ track
   ├─ opportunity validator    deterministic
   ├─ submission checker       deterministic
   ├─ privacy scanner          deterministic
   └─ React dashboard
```

## 모델 등급

### efficient

- Codex: `gpt-5.6-luna`, reasoning `max`
- 대상: 반복량이 많고 입출력이 고정된 추출·검색·분류·매칭
- 실패 처리: 추측하지 않고 `확인 필요` 또는 `needs-review`

### strategic

- Codex: `gpt-5.6-sol`, reasoning `high`
- 대상: 상충하는 근거 판단, 직무 선택, 설득 구조, 수정
- 입력: 앞 단계의 제한된 산출물만 전달

### final-audit

- Codex: `gpt-5.6-sol`, reasoning `xhigh`
- 대상: 실제 제출 직전의 최종 지원서만
- 권한: 읽기 전용. `PASS | REVISE | BLOCK`만 판정
- 독립성: 초안 작성 대화와 이전 결론을 전달하지 않는다.

### deterministic

- 모델을 사용하지 않는다.
- 날짜, URL, 중복 ID, 허용 상태, 글자수, 빈 placeholder, 민감정보 패턴을 검사한다.

## 최소 컨텍스트 원칙

서브에이전트에는 다음만 전달한다.

```text
역할 문서
입력 파일 경로
출력 파일 경로
통과·중단 기준
```

Codex에서 지원되면 `fork_turns="none"` 또는 최소 대화 상속을 사용한다. 원자료가 여러 종류일 때 document-extractor와 project-extractor는 서로 다른 staging 파일에 병렬로 쓸 수 있다. 동일 파일을 수정하는 작업은 순차 실행한다.

## 게이트와 되돌림

```text
profile 미완성 ───────────> intake로 복귀
공식 공고 확인 실패 ──────> discover에서 보류
적합도 재검토 ────────────> 사용자 직무 선택 대기
근거 부족 ────────────────> intake 갱신 필요
사실 검수 REVISE ─────────> revision-editor
최종 검수 REVISE ─────────> revision-editor → 변경 문장만 재검수
최종 검수 BLOCK ──────────> 최종본 생성 금지
```

## 책임 경계

| 역할 | 해도 되는 일 | 하면 안 되는 일 |
|---|---|---|
| document/project extractor | 원문 사실과 위치 추출 | 해석을 성과로 승격 |
| profile synthesizer | 중복 통합, 사람용 Markdown 작성 | 직무에 맞춰 사실 선택 |
| job finder | 후보와 URL 수집 | 마감·자격 확정 |
| posting verifier | 공식 원문 대조 | 적합도 판단 |
| JD analyzer | JD 요구 구조화 | 개인 경험 읽기 |
| role-fit checker | 프로필과 JD 비교 | 지원서 문장 작성 |
| evidence matcher | verified claim 배정 | 새 사실 추가 |
| draft writer | 승인된 근거로 작성 | 근거 없는 연결 만들기 |
| fact reviewer | 오류와 누락 판정 | 문장 직접 수정 |
| revision editor | 지적된 범위 수정 | 새 주장 추가 |
| final reviewer | 독립 최종 판정 | 직접 수정·제출 |
