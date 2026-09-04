---
name: intake
description: 이력서·성적표·프로젝트·메모 등 로컬 원자료를 사람이 검토할 수 있는 개인 프로필과 경험별 Markdown으로 구조화한다. 최초 사용 또는 원자료 변경 시 실행한다.
---

# Intake 오케스트레이터

직무에 맞추기 전의 사실 정본을 만든다. 회사·JD·자소서 문항은 이 단계에서 읽지 않는다.

## 실행

1. 원자료 경로가 없으면 사용자에게 정리할 파일이나 폴더를 묻고 종료한다.
2. `.work/intake/<run-id>/`를 만들고 원자료를 문서와 프로젝트로 구분한다.
3. 문서가 있으면 `document-extractor`를 efficient 등급으로 실행해 `document-facts.md`를 만든다.
4. 프로젝트가 있으면 `project-extractor`를 efficient 등급으로 실행해 `project-facts.md`를 만든다.
5. 두 작업은 서로 다른 파일에 쓰므로 병렬 실행할 수 있다. 해당 자료 종류가 없으면 그 에이전트를 호출하지 않는다.
6. `profile-synthesizer`를 efficient 등급으로 실행해 `profile/PROFILE.md`, 경험별 Markdown, `questions.md`를 만든다.
7. `node scripts/validate-profile.mjs`를 실행한다.
8. `[확인 필요]` 질문을 사용자에게 보여 준다. 답을 받기 전에는 해당 claim을 `검증됨`으로 바꾸지 않는다.

## 완료 조건

- `profile/PROFILE.md`가 존재한다.
- 경험마다 기간·역할·현재 상태·원자료 위치가 있다.
- 지원서에 쓸 사실에는 claim-id와 검증 상태가 있다.
- 원자료와 충돌한 사실이 질문 없이 임의로 합쳐지지 않았다.

프로필을 갱신할 때 기존 claim-id를 불필요하게 바꾸지 않는다. 실제 프로필 파일은 Git에 추가하지 않는다.
