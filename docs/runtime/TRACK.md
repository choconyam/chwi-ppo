# Track 실행 계약

단순 조회는 `data/opportunities.json`의 현재 기록만 읽는다. 데이터를 바꾸지 않는 조회 때문에 동기화·생성·별도 모델 재감사를 실행하지 않는다.

사용자가 상태·마감·자격 변경을 요청하면 해당 opportunity만 수정한다. 공식 URL·마감·자격은 공식 근거와 확인일이 없으면 needs-review로 둔다. ready는 검수 완료 후 제출만 남은 상태이며, submitted는 사용자가 실제 제출을 명시하고 `submissionConfirmedAt`을 남긴 경우뿐이다.

갱신 뒤 기본 동기화는 두 명령이다. `sync-dashboard-data.mjs`가 registry 검증을 포함하므로 `validate-opportunities.mjs`를 먼저 중복 실행하지 않는다.

```powershell
node scripts/sync-dashboard-data.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/generate-dashboard.ps1
```

스키마 오류를 따로 진단할 때만 다음 명령을 단독 실행한다.

```powershell
node scripts/validate-opportunities.mjs
```

이 과정은 로컬 데이터와 읽기 전용 화면만 갱신한다. 외부 지원서 제출·취소·메시지 전송은 하지 않는다.
