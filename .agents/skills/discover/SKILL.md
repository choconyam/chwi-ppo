---
name: discover
description: 검증된 개인 프로필을 기준으로 현재 채용 공고를 찾고 공식 출처·마감·지원 자격을 확인한 뒤 직무 적합도와 지원 우선순위를 정해 캘린더에 등록한다.
---

# Discover 오케스트레이터

## 선행 조건

`profile/PROFILE.md`가 없으면 실행하지 말고 intake가 필요하다고 보고한다. 지원 산업·직무·지역·입사 가능 시점 중 검색에 필요한 값이 `[확인 필요]`이면 먼저 사용자에게 묻는다.

## 실행

1. 검색 범위와 기준일을 정하고 `.work/discover/<run-id>/`를 만든다.
2. `job-finder`를 efficient 등급으로 실행해 후보와 발견 URL을 모은다. 회사군이 독립적이면 서로 다른 후보 파일로 병렬화할 수 있다.
3. `posting-verifier`를 efficient 등급으로 실행해 공식 URL·마감 원문·지원 자격·확인일을 검증한다.
4. 공식 검증된 공고마다 `companies/<회사>/<직무>/00_JD.md`를 만들고 `jd-analyzer`를 efficient 등급으로 실행한다.
5. `role-fit-checker`를 strategic 등급으로 실행해 지원 자격과 직무 적합도를 `진행 | 주의 | 재검토`로 판정한다.
6. 결과를 `schemas/opportunity.schema.json`에 맞춰 `data/opportunities.json`에 병합한다.
7. `node scripts/validate-opportunities.mjs`를 통과한 뒤 `node scripts/sync-dashboard-data.mjs`로 React 데이터를 갱신한다.

## 검증 원칙

- 채용 포털은 후보 발견에만 사용한다.
- 공식 URL·마감 원문·확인일이 없으면 verification을 `needs-review`로 둔다.
- 지원 요건이 모호하면 Luna가 확정하지 않고 strategic 등급으로 올린다.
- 공식 확인이 안 된 마감은 캘린더에 확정 일정처럼 표시하지 않는다.
- 중복지원 규칙과 동일 회사 복수 직무는 별도 위험으로 기록한다.

## 완료 보고

지원 가능·확인 필요·지원 불가를 분리하고, 마감순 추천 목록과 공식 링크를 보여 준다. 실제 지원이나 외부 전송은 하지 않는다.

데이터 필드가 필요할 때만 [docs/DATA_CONTRACTS.md](../../../docs/DATA_CONTRACTS.md)를 읽는다.
