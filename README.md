# 취뽀 (chwi-ppo)

![version](https://img.shields.io/badge/version-v1.0.0-blue) ![license](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-orange) ![Codex](https://img.shields.io/badge/Codex-%2Fintake%20%2Fdiscover%20%2Fapply%20%2Ftrack-black) ![Claude Code](https://img.shields.io/badge/Claude%20Code-%2Fintake%20%2Fdiscover%20%2Fapply%20%2Ftrack-D97757)

<p align="center">
  <img src="assets/chwi-ppo-cover.png" alt="chwi-ppo 안내판을 든 벌 캐릭터" width="100%">
</p>

취뽀는 "취업 뽀개기"의 줄임말입니다.

내 경험을 정리하고 공식 공고를 찾아 직무 적합도를 판단한 뒤, 지원서 작성·사실 검수·마감 관리까지 이어 가는 로컬 에이전트 워크벤치입니다. Codex와 Claude Code 모두 저장소의 로컬 스킬을 통해 같은 워크플로를 실행합니다.

**공식 JD와 검증된 본인 경험만 지원서 근거로 사용하며, 면접에서 직접 설명할 수 없는 내용은 만들지 않습니다.**

처음이라면 [다른 사용자를 위한 시작 안내](docs/USER_GUIDE.md)를 따라 하면 됩니다. Codex와 Claude Code 모두 `/intake`, `/discover`, `/apply`, `/track`으로 호출합니다.

## 빠른 설치

Node.js 20.19 이상이 설치되어 있다면 터미널에서 다음 명령을 실행합니다.

```powershell
npm create chwi-ppo@latest
```

현재 위치에 `chwi-ppo` 폴더가 생성됩니다. 다른 폴더명을 쓰려면 이름을 함께 입력합니다.

```powershell
npm create chwi-ppo@latest my-career
```

설치기는 GitHub의 최신 릴리스와 SHA-256을 확인한 뒤 파일을 내려받습니다. 설치가 끝나면 생성된 폴더를 Codex 또는 Claude Code에서 열고 `/intake C:\본인자료폴더`부터 실행합니다. Node.js를 설치하지 않으려면 [GitHub 릴리스](https://github.com/choconyam/chwi-ppo/releases/latest)에서 ZIP을 직접 받을 수 있습니다.

## 전체 흐름

```text
intake 원자료
    ↓
사람이 읽고 고칠 수 있는 경험 Markdown
    ↓
discover 희망 산업·지역·직무
    ↓
지원 가능 공고·적합도·마감 캘린더
    ↓
apply 회사 직무
    ↓
근거 매핑·초안·사실 검수·최종 검수
    ↓
track
    ↓
작성·제출 상태와 마감 관리
```

## 1. 내 자료 정리

이력서·성적표·프로젝트 README·메모가 있는 로컬 경로를 지정합니다.

```text
Codex:       /intake C:\내자료
Claude Code: /intake C:\내자료
```

결과는 `profile/`에 Markdown 파일로 저장됩니다. JSON DB를 직접 읽거나 고칠 필요는 없습니다. 역할·수치·기간 중 불확실한 항목은 `[확인 필요]`로 남고, 사용자가 확인하기 전에는 지원서 근거로 쓰이지 않습니다.

`intake`는 처음 한 번, 그리고 개인 자료가 바뀌었을 때만 다시 실행합니다.

## 2. 맞춤 공고 찾기와 JD 분석

```text
Codex:       /discover 반도체·전자·AI 신입, 수도권·충청권
Claude Code: /discover 반도체·전자·AI 신입, 수도권·충청권
```

`/discover`는 정리된 개인 프로필과 희망 산업·지역·직무를 기준으로 다음 작업을 수행합니다.

1. 현재 지원할 수 있는 채용 공고 후보 탐색
2. 회사 공식 채용 페이지에서 직무·마감·학위·전공·어학 조건 검증
3. 공식 JD의 주요 업무, 필수·우대 역량, 지원 제한, 문항과 글자수 분석
4. JD와 개인 경험을 비교해 직무 적합도와 지원 우선순위 판단
5. 검증된 공고와 마감을 캘린더에 등록

공식 근거를 확인하지 못한 정보는 확정하지 않고 `공식 확인 필요`로 남깁니다. JD 원문은 회사별 `00_JD.md`, 분석 결과는 `01_JD분석.md`, 적합도 판단은 `02_직무적합성.md`에 저장됩니다.

## 3. JD에 맞춘 지원서 만들기

```text
Codex:       /apply 샘플전자 공정기술
Claude Code: /apply 샘플전자 공정기술
```

`/apply`는 선택한 직무의 JD와 `intake`에서 검증된 경험을 연결합니다. 문항마다 사용할 근거를 먼저 배정한 뒤 글자수에 맞춰 초안을 작성하고, 원자료와 대조해 사실·수치·역할·완료 상태를 검수합니다. 검수에서 발견된 문제만 수정하며, 원자료에 없는 경험이나 성과는 추가하지 않습니다.

실제 제출용 독립 최종 검수까지 원하면 끝에 `final`을 붙입니다.

```text
Codex:       /apply 샘플전자 공정기술 final
Claude Code: /apply 샘플전자 공정기술 final
```

`final`은 별도의 읽기 전용 검수 역할이 JD 충족 여부와 사실 일치를 다시 확인하고, 통과한 문서만 `최종/`에 저장합니다.

## 4. 캘린더 실행

프로젝트 루트의 `run-dashboard.cmd`를 더블클릭합니다. Windows 기본 PowerShell이 최신 데이터를 읽기 전용 `career-dashboard.html`에 넣고 기본 브라우저로 엽니다. 캘린더만 볼 때는 Node.js나 별도 프로그램을 설치하지 않아도 됩니다.

실행할 때 하루에 한 번 GitHub 최신 릴리스를 확인합니다. 새 버전이 있으면 스킬·에이전트·검증 코드·대시보드만 갱신하고 개인 프로필·실제 회사 자료·공고 데이터·지원 상태는 보존합니다. 인터넷 연결이 없거나 확인에 실패해도 현재 대시보드는 정상적으로 열립니다.

브라우저에서 마감, 지원 자격, 적합도, 공식 확인 여부, 작성 상태를 확인합니다. 실제 공고 파일이 아직 없으면 가상 회사가 표시되고, 화면 상단에 `예시 데이터`라고 표시됩니다. `/discover`와 `/track`은 해당 회사·직무 레코드만 `data/opportunities.json`에 추가·수정하며 HTML 코드를 다시 쓰지 않습니다. 이렇게 만들어진 실제 데이터와 생성 HTML은 Git에서 제외됩니다.

React 화면 자체를 개발할 때만 Node.js 20.19 이상과 `run-dashboard-dev.cmd`를 사용합니다.

## 자동 업데이트

- 평소에는 `run-dashboard.cmd`가 24시간에 한 번 자동 확인합니다.
- 즉시 확인하려면 `update-chwi-ppo.cmd`를 더블클릭합니다.
- Git으로 받은 사용자는 로컬 변경이 없을 때 `git pull --ff-only`로 갱신합니다.
- ZIP으로 받은 사용자는 GitHub 릴리스 ZIP의 SHA-256과 내부 파일 목록을 검증한 뒤 갱신합니다.
- 교체 전 파일은 `.updates/backups/`에 보관하며 실패하면 이전 파일로 복구합니다.
- 업데이트 기록은 `.updates/state.json`과 `.updates/update.log`에서 확인할 수 있습니다.

자동 업데이트 실행기는 `v1.0.0`부터 포함돼 있습니다. 이후 버전은 위 방식으로 갱신됩니다.

## 선택 사항: humanizer-ko

최종 문장이 번역투이거나 AI 문체처럼 읽힌다면 [humanizer-ko](https://github.com/choconyam/humanizer-ko)를 써 보세요. 사실과 수치는 그대로 두고 한국어 문체만 다듬는 별도 도구이며, 이 파이프라인의 필수 구성은 아닙니다.

## 이용 범위

이 저장소는 [PolyForm Noncommercial License 1.0.0](LICENSE.md)을 적용합니다.

- 개인의 취업 준비·입사 지원·학습·연구를 위한 사용과 수정
- 비상업적 목적의 무료 공유와 재배포
- 비영리기관·교육기관·공공 연구기관의 사용

위 용도는 허용됩니다. 소프트웨어나 그 기능을 판매하거나 유료 서비스에 사용하는 등 상업적 이용에는 저작권자의 사전 허가가 필요합니다. 개인이 취업에 성공해 급여를 받는 것은 금지되는 상업적 이용으로 보지 않습니다. 자세한 범위와 추가 허용 사항은 [영문 공식 라이선스](LICENSE.md), [한국어 안내](LICENSE_KO.md), [프로젝트별 고지](NOTICE.md)를 확인하세요.

## 개인정보와 공개 저장소

다음 파일은 로컬에만 두며 기본 `.gitignore`에 들어 있습니다.

- 원본 이력서·성적표·지원서
- 실제 `profile/PROFILE.md`와 경험 파일
- 실제 공고·적합도·진행 상태 데이터
- 회사별 초안과 최종 지원서
- 캘린더가 읽는 생성 데이터

공개 저장소에는 역할 문서, 스킬, 템플릿, 스크립트, React 화면과 예시 데이터만 올립니다. 공개 전에 `npm run privacy-check`를 실행합니다.

## 구조

```text
├─ AGENTS.md
├─ docs/
├─ .claude/
│  ├─ agents/
│  └─ skills/
├─ .agents/skills/          Codex 저장소 로컬 스킬
├─ .codex/agents/           Codex 역할별 서브에이전트
├─ .codex/config.toml       Codex 모델·동시 실행 기본값
├─ profile/                 사람용 개인 경험 Markdown
├─ companies/               회사·직무별 로컬 산출물
├─ data/                    공고 구조 데이터
├─ scripts/                 결정론적 검증·변환
└─ dashboard/               일반 React 마감 캘린더
```

계층과 모델 배정은 [docs/AGENT_ARCHITECTURE.md](docs/AGENT_ARCHITECTURE.md)에 정리돼 있습니다.

---

© 2026 choconyam. chwi-ppo는 [PolyForm Noncommercial License 1.0.0](LICENSE.md)에 따라 개인의 비상업적 취업 준비·학습·연구에 사용할 수 있습니다. 상업적 이용에는 저작권자의 사전 서면 허가가 필요합니다.
