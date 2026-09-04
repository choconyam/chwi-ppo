---
name: apply
description: discover에서 검증·선택한 회사와 직무에 verified claim을 배정해 지원서 초안, 사실 검수, 수정본을 만든다. final 요청 시 독립 최종 검수 후 최종본을 생성한다.
---

# Apply 오케스트레이터

사용법: Codex는 `$apply <회사명> <직무명> [문항N] [final]`, Claude Code는 `/apply <회사명> <직무명> [문항N] [final]`

## 선행 조건

- `profile/PROFILE.md`와 경험 Markdown이 존재해야 한다.
- 해당 직무의 `00_JD.md`, `01_JD분석.md`, `02_직무적합성.md`가 있어야 한다.
- 적합성 `재검토` 또는 자격 `needs-review/ineligible`이면 사용자 결정 없이 진행하지 않는다.

## 기본 실행

1. `evidence-matcher`를 efficient 등급으로 실행해 `03_소재매핑.md`를 만든다.
2. `소재 갭 — intake 갱신 필요`가 있으면 중단한다.
3. `draft-writer`를 strategic 등급으로 실행해 `04_초안/`을 만든다.
4. `node scripts/check-submission.mjs`로 형식·placeholder·글자수를 검사한다.
5. `fact-reviewer`를 strategic 등급의 별도 서브에이전트로 실행해 읽기 전용 `05_사실검수.md`를 만든다.
6. 판정이 `REVISE`면 `revision-editor`를 strategic 등급으로 실행해 `06_수정본/`을 만든 뒤 자동검사와 fact-reviewer를 다시 수행한다.
7. `BLOCK`이면 최종본을 만들지 않는다.

기본 실행은 Sol High 검수를 통과한 `06_수정본/`까지다.

## final 모드

사용자가 `final`을 명시하거나 실제 제출 직전 최종본을 요청한 경우에만 실행한다.

1. `final-red-team-reviewer`를 final-audit 등급으로 새 문맥에서 실행한다. 초안 작성 대화나 이전 결론을 전달하지 않는다.
2. `PASS`면 수정본을 `최종/`에 복사한다.
3. `REVISE`면 revision-editor가 지적 범위만 수정하고 변경 문장만 다시 최종 검수한다.
4. `BLOCK`이면 최종본 생성과 제출 준비 완료 표시를 금지한다.

## 경계

- intake처럼 원자료를 재구조화하지 않는다.
- verified가 아닌 claim은 사용하지 않는다.
- fact-reviewer와 final reviewer는 초안을 수정하지 않는다.
- humanizer-ko는 필수가 아니며 자동 실행하지 않는다.
- 지원 사이트 입력·제출은 수행하지 않는다.
