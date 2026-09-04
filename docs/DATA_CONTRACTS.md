# 데이터 계약

## 개인 경험

사람이 읽는 Markdown이 정본이다.

- 기본 정보: `profile/PROFILE.md`
- 경험: `profile/experiences/<경험명>.md`
- 템플릿: `profile/PROFILE_TEMPLATE.md`, `profile/experiences/_EXPERIENCE_TEMPLATE.md`

검증 가능한 사실에는 고유한 `claim-id`를 붙인다. 형식은 `<경험약어>-<세 자리 번호>`를 권장한다.

```markdown
### CARDIAC-017
- 사실: VitalDB 6,388건 중 3,295건을 분석 대상으로 선별
- 근거: 프로젝트 README의 데이터 전처리 절
- 상태: 검증됨
```

허용 상태는 `검증됨`, `확인 필요`, `사용 금지`다. `apply`는 `검증됨`만 사용할 수 있다.

## 공고 데이터

`data/opportunities.json`은 에이전트와 React 화면이 공유하는 구조 데이터다. 사용자는 JSON을 직접 읽지 않아도 되며 캘린더에서 확인한다. 공개 저장소에는 `data/opportunities.example.json`만 포함한다.

필수 필드:

- 고유 ID, 회사, 직무, 공식 URL
- 마감 날짜·시간과 시간 확인 여부
- 공식 확인 상태·확인일·근거 문장
- 지원 자격 판정과 근거
- 적합도 등급과 이유
- 작성 진행 상태

상세 형식은 `schemas/opportunity.schema.json`을 따른다.

진행 상태는 회사·직무 레코드마다 관리한다. `ready`는 제출만 남은 상태이며, `submitted`는 사용자가 실제 제출을 명시적으로 확인한 경우에만 기록한다. `submitted`에는 `submissionConfirmedAt`이 반드시 있어야 한다. 최종본 파일의 존재만으로 제출을 추정하지 않는다.

## 회사별 파일

```text
companies/<회사>/<직무>/
├─ 00_JD.md
├─ 01_JD분석.md
├─ 02_직무적합성.md
├─ 03_소재매핑.md
├─ 04_초안/
├─ 05_사실검수.md
├─ 06_수정본/
├─ 07_최종검수.md
└─ 최종/
```

`00_JD.md`는 공식 원문 보관용이며 후속 에이전트가 수정하지 않는다. `최종/`은 final-audit가 `PASS`를 낸 경우에만 생성한다.
