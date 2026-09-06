---
name: track
description: 로컬 공고 데이터의 마감·지원 가능·작성·검수·제출 상태를 조회하거나 갱신하고 React 캘린더 데이터를 동기화한다. 지원 사이트 제출은 하지 않는다.
---

# Track 오케스트레이터

## 조회

`data/opportunities.json`을 읽어 다음을 보여 준다.

단순 조회는 현재 기록만 읽고 동기화·생성·별도 모델 재감사를 실행하지 않는다.

- 7일 안에 마감되는 지원 가능 공고
- 공식 확인이 필요한 날짜·자격
- 작성 중, 검수 대기, 제출 준비, 제출 완료 상태
- 적합도와 마감 기준의 다음 작업

## 갱신

사용자가 명시한 변경만 해당 opportunity에 반영한다. 제출 여부를 파일 존재, 최종본 생성, `ready` 상태만으로 추정하지 않는다.

허용 진행 상태:

```text
discovered → analyzing → writing → review → ready → submitted
                                      └──────> closed
```

- `ready`: 지원서 작성과 검수가 끝나 제출만 남은 상태다.
- `submitted`: 사용자가 "제출했다"고 명시적으로 확인한 경우에만 사용하고 `submissionConfirmedAt`을 기록한다.
- 사용자의 표현이 "끝난 것 같다", "최종본이 있다"처럼 모호하면 `ready`를 유지하고 제출 여부를 한 번 묻는다.

마감·자격·공식 URL을 바꿀 때는 공식 근거와 확인일이 필요하다. 근거가 없으면 `needs-review`로 바꾼다.

## 동기화

1. `node scripts/sync-dashboard-data.mjs`로 registry 검증과 데이터 동기화를 함께 수행한다.
2. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/generate-dashboard.ps1`로 읽기 전용 HTML을 갱신한다.
3. 결과와 남은 경고를 사용자에게 보고한다.

`node scripts/validate-opportunities.mjs`는 스키마 오류를 따로 진단할 때만 단독 실행하며 기본 동기화 전에 중복 실행하지 않는다. 세부 계약이 필요할 때만 [track 실행 계약](../../../docs/runtime/TRACK.md)을 읽는다.

이 스킬은 로컬 상태만 관리한다. 외부 지원서 제출·취소·메시지 전송은 하지 않는다.
