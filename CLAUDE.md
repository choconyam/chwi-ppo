@AGENTS.md

<!-- 규칙의 정본은 AGENTS.md다. 이 파일에는 중복 규칙을 추가하지 않는다. -->

## Claude Code 실행 참고

- `/intake`, `/discover`, `/apply`, `/track`이 `.claude/agents/`의 역할 문서를 서브에이전트로 실행한다.
- 역할 문서의 `model-tier`를 Claude 환경에서 사용 가능한 경량·고성능 모델에 대응한다.
- 각 서브에이전트에는 전체 대화 대신 입력 파일, 출력 파일, 중단 조건만 전달한다.
- 최종 검수는 초안을 작성한 세션과 분리한다.
