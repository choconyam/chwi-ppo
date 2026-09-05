import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { buildDiscoveryQueue, canonicalizeUrl } from '../lib/discovery.mjs';

const NOW = '2026-09-05T00:00:00.000Z';

function source(overrides = {}) {
  return {
    id: 'portal-a',
    url: 'https://portal.example/jobs',
    checkedAt: NOW,
    query: '반도체 공정',
    complete: true,
    pagesVisited: 1,
    expectedPages: 1,
    listedCount: 1,
    accessStatus: 'ok',
    ...overrides,
  };
}

function posting(overrides = {}) {
  return {
    sourceId: 'portal-a',
    sourceRowId: 'row-1',
    url: 'https://portal.example/jobs/1',
    company: '임의회사',
    title: '2026 하반기 채용',
    careerTypes: ['new'],
    deadline: '2026-10-01T14:59:59.000Z',
    roles: [{ id: 'process', title: '공정기술', careerTypes: ['new'], keywords: ['반도체'] }],
    rawEvidence: { title: '포털 표시 원문' },
    ...overrides,
  };
}

function snapshot(postings, sourceOverrides = {}) {
  return { sources: [source({ listedCount: postings.length, ...sourceOverrides })], postings };
}

test('canonical URL과 role id가 같은 행은 병합하되 ledger에는 모두 남긴다', () => {
  const first = posting();
  const second = posting({
    sourceRowId: 'row-2',
    url: 'https://portal.example/jobs/1?utm_source=calendar&gclid=abc',
  });
  const result = buildDiscoveryQueue(snapshot([first, second]), { careerTypes: ['new'] }, { now: NOW });

  assert.equal(canonicalizeUrl(second.url), first.url);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.ledger.length, 2);
  assert.deepEqual(result.ledger.map((row) => row.disposition), ['retained', 'retained']);
  assert.ok(result.ledger[1].roleDecisions[0].reasons.includes('duplicate-merged'));
});

test('canonical URL은 확실한 tracking query만 제거하고 ref와 hash route는 보존한다', () => {
  assert.equal(
    canonicalizeUrl('https://jobs.example/list?ref=internal&utm_source=mail#role/process'),
    'https://jobs.example/list?ref=internal#role/process',
  );
});

test('같은 회사라도 다른 공고 URL이나 다른 role은 별도 후보로 보존한다', () => {
  const postings = [
    posting({ sourceRowId: 'a', url: 'https://portal.example/jobs/a', roles: [{ id: 'process', title: '공정', careerTypes: ['new'] }] }),
    posting({ sourceRowId: 'b', url: 'https://portal.example/jobs/b', roles: [{ id: 'process', title: '공정', careerTypes: ['new'] }] }),
    posting({ sourceRowId: 'c', url: 'https://portal.example/jobs/a', roles: [{ id: 'quality', title: '품질', careerTypes: ['new'] }] }),
  ];
  const result = buildDiscoveryQueue(snapshot(postings), { careerTypes: ['new'] }, { now: NOW });

  assert.equal(result.candidates.length, 3);
});

test('회사 watchlist 없이 KT처럼 임의의 회사도 후보로 유지한다', () => {
  const result = buildDiscoveryQueue(
    snapshot([posting({ company: 'KT', sourceRowId: 'kt-1' })]),
    { careerTypes: ['new'], keywords: ['네트워크'] },
    { now: NOW },
  );

  assert.equal(result.candidates[0].company, 'KT');
  assert.equal(result.ledger[0].disposition, 'retained');
  assert.equal(result.candidates[0].keywordMismatchIsExclusion, false);
});

test('혼합 공고는 신입과 경력 지원자 모두에게 열리고 인턴 전용과는 구분된다', () => {
  const mixed = posting({
    roles: [{ id: 'mixed-role', title: '통합 직무', careerTypes: ['mixed'] }],
  });
  const newResult = buildDiscoveryQueue(snapshot([mixed]), { careerTypes: ['new'] }, { now: NOW });
  const experiencedResult = buildDiscoveryQueue(snapshot([mixed]), { careerTypes: ['experienced'] }, { now: NOW });
  const internResult = buildDiscoveryQueue(snapshot([mixed]), { careerTypes: ['intern'] }, { now: NOW });

  assert.equal(newResult.stats.retained, 1);
  assert.equal(experiencedResult.stats.retained, 1);
  assert.equal(internResult.stats.excluded, 1);
  assert.ok(internResult.ledger[0].roleDecisions[0].reasons.includes('career-type-mismatch'));
});

test('criteria의 경력이 미상이면 신입으로 가정하지 않고 경력 공고도 검증 대상으로 둔다', () => {
  const experienced = posting({
    careerTypes: ['experienced'],
    roles: [{ id: 'experienced-role', title: '경력 직무', careerTypes: ['experienced'] }],
  });
  const result = buildDiscoveryQueue(snapshot([experienced]), {}, { now: NOW });

  assert.equal(result.stats.retained, 1);
  assert.deepEqual(result.criteria.careerTypes, []);
});

test('알 수 없는 careerTypes와 기타 기업규모는 명시 불일치로 제외하지 않는다', () => {
  const unknown = posting({
    size: '기타기업',
    careerTypes: ['미정'],
    roles: [{ id: 'unknown', title: '상세 확인 직무', careerTypes: ['미정'] }],
  });
  const result = buildDiscoveryQueue(
    snapshot([unknown]),
    { careerTypes: ['new'], sizes: ['large'] },
    { now: NOW },
  );

  assert.equal(result.stats.retained, 1);
  assert.ok(result.candidates[0].unknowns.includes('career-types-unknown'));
  assert.ok(result.candidates[0].unknowns.includes('company-size-unknown'));
});

test('역할 목록이 없는 그룹 공고는 회사명이나 키워드로 제외하지 않고 inspect-roles로 미룬다', () => {
  const result = buildDiscoveryQueue(
    snapshot([posting({ company: '아무그룹', roles: [], careerTypes: undefined, keywords: [] })]),
    { careerTypes: ['new'], keywords: ['양자컴퓨팅'] },
    { now: NOW },
  );

  assert.equal(result.ledger[0].disposition, 'deferred');
  assert.equal(result.candidates[0].action, 'inspect-roles');
  assert.ok(result.candidates[0].unknowns.includes('roles-unresolved'));
});

test('불완전 페이지와 접근 실패는 partial이며 결과 0을 채용 없음으로 승격하지 않는다', () => {
  const result = buildDiscoveryQueue(
    snapshot([], {
      complete: false,
      accessStatus: 'blocked',
      pagesVisited: 1,
      expectedPages: 4,
      listedCount: 0,
      expectedCount: 30,
    }),
    { careerTypes: [] },
    { now: NOW },
  );

  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.observedPostingRows, 0);
  assert.equal(result.coverage.zeroObservedIsNoHiring, false);
  assert.ok(result.coverage.sources[0].reasons.includes('pages-not-fully-visited'));
  assert.ok(result.coverage.sources[0].reasons.includes('access-blocked'));
});

test('complete 표시가 있어도 listedCount보다 snapshot 행이 적으면 silent truncation으로 판정한다', () => {
  const result = buildDiscoveryQueue(
    snapshot([posting()], { complete: true, listedCount: 20, accessStatus: 'ok' }),
    { careerTypes: ['new'] },
    { now: NOW },
  );

  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.sources[0].observedRows, 1);
  assert.ok(result.coverage.sources[0].reasons.includes('snapshot-rows-below-listed-count'));
});

test('complete 출처의 기준 count/page 필드가 빠졌거나 observedRows가 expectedCount보다 적으면 partial이다', () => {
  const missingVisited = buildDiscoveryQueue(
    snapshot([posting()], { pagesVisited: undefined, expectedPages: 2 }),
    { careerTypes: ['new'] },
    { now: NOW },
  );
  const missingListed = buildDiscoveryQueue(
    snapshot([posting()], { expectedPages: undefined, expectedCount: 2, listedCount: undefined }),
    { careerTypes: ['new'] },
    { now: NOW },
  );
  const observedShort = buildDiscoveryQueue(
    snapshot([posting()], { expectedPages: undefined, expectedCount: 2, listedCount: 2 }),
    { careerTypes: ['new'] },
    { now: NOW },
  );

  assert.ok(missingVisited.coverage.sources[0].reasons.includes('pages-visited-missing'));
  assert.ok(missingListed.coverage.sources[0].reasons.includes('listed-count-missing'));
  assert.ok(observedShort.coverage.sources[0].reasons.includes('snapshot-rows-below-expected-count'));
  assert.throws(() => buildDiscoveryQueue({ sources: [], postings: [] }, {}, { now: NOW }), /하나 이상/);
});

test('확정 최소 경력이 알려진 지원자 경력보다 길 때만 자동 제외한다', () => {
  const job = posting({
    roles: [{ id: 'senior', title: '경력 공정', careerTypes: ['experienced'], requiredExperienceMonths: 24 }],
  });
  const shortage = buildDiscoveryQueue(
    snapshot([job]),
    { careerTypes: ['experienced'], experienceMonths: 12, experienceMonthsBasis: 'verified-relevant' },
    { now: NOW },
  );
  const unknown = buildDiscoveryQueue(snapshot([job]), { careerTypes: ['experienced'] }, { now: NOW });

  assert.equal(shortage.stats.excluded, 1);
  assert.ok(shortage.ledger[0].roleDecisions[0].reasons.includes('confirmed-experience-shortage'));
  assert.equal(unknown.stats.retained, 1);
  assert.ok(unknown.candidates[0].unknowns.includes('candidate-verified-relevant-experience-unknown'));
});

test('혼합/신입 경로가 있으면 최소경력 숫자는 경력 분기에만 적용한다', () => {
  const mixed = posting({
    roles: [{ id: 'mixed', title: '신입·경력 직무', careerTypes: ['mixed'], requiredExperienceMonths: 36 }],
  });
  const result = buildDiscoveryQueue(
    snapshot([mixed]),
    { careerTypes: ['new', 'experienced'], experienceMonths: 0, experienceMonthsBasis: 'verified-relevant' },
    { now: NOW },
  );

  assert.equal(result.stats.retained, 1);
  assert.equal(result.ledger[0].officialEligibility, 'unverified');
  assert.equal(result.ledger[0].decisionScope, 'portal-candidate-filter');
});

test('명시된 기업 규모 불일치와 종료 시각만 hard exclusion으로 처리한다', () => {
  const sizeMismatch = buildDiscoveryQueue(
    snapshot([posting({ size: 'large' })]),
    { careerTypes: ['new'], sizes: ['startup'] },
    { now: NOW },
  );
  const dateOnlyStillOpen = buildDiscoveryQueue(
    snapshot([posting({ deadline: '2026-09-05' })]),
    { careerTypes: ['new'] },
    { now: '2026-09-05T03:00:00.000Z' },
  );
  const ended = buildDiscoveryQueue(
    snapshot([posting({ deadline: '2026-09-04' })]),
    { careerTypes: ['new'] },
    { now: NOW },
  );

  assert.ok(sizeMismatch.ledger[0].roleDecisions[0].reasons.includes('company-size-mismatch'));
  assert.equal(dateOnlyStillOpen.stats.retained, 1);
  assert.ok(ended.ledger[0].roleDecisions[0].reasons.includes('deadline-ended'));
});

test('첫 8개만 batch로 꺼내고 나머지 후보도 모두 queue에 보존한다', () => {
  const postings = Array.from({ length: 11 }, (_, index) => posting({
    sourceRowId: `row-${index}`,
    url: `https://portal.example/jobs/${index}`,
    roles: [{ id: `role-${index}`, title: `직무 ${index}`, careerTypes: ['new'] }],
  }));
  const result = buildDiscoveryQueue(snapshot(postings), { careerTypes: ['new'] }, { now: NOW });

  assert.equal(result.queue.firstBatch.length, 8);
  assert.equal(result.queue.remaining.length, 3);
  assert.equal(result.queue.all.length, 11);
  assert.equal(result.queue.truncated, false);
});

test('공고 내용 또는 criteria가 바뀌면 fingerprint가 바뀌며 fresh 공식 캐시만 재사용한다', () => {
  const job = posting();
  const base = buildDiscoveryQueue(snapshot([job]), { careerTypes: ['new'] }, { now: NOW });
  const previous = structuredClone(base);
  previous.candidates[0].verification = {
    state: 'verified',
    source: 'official',
    officialStatus: 'open',
    checkedAt: '2026-09-04T12:00:00.000Z',
    closesAt: '2026-10-01T14:59:59.000Z',
    officialUrl: 'https://company.example/careers/1',
    evidence: ['공식 채용 페이지 원문'],
  };

  const hit = buildDiscoveryQueue(snapshot([job]), { careerTypes: ['new'] }, { now: NOW, previous });
  assert.equal(hit.stats.cacheHits, 1);
  assert.equal(hit.queue.all.length, 0);

  const changedCriteria = buildDiscoveryQueue(snapshot([job]), { careerTypes: ['new'], keywords: ['공정'] }, { now: NOW, previous });
  assert.equal(changedCriteria.stats.cacheHits, 0);
  assert.notEqual(changedCriteria.candidates[0].fingerprint, base.candidates[0].fingerprint);

  const changedPosting = buildDiscoveryQueue(
    snapshot([posting({ rawEvidence: { title: '지원 조건 변경' } })]),
    { careerTypes: ['new'] },
    { now: NOW, previous },
  );
  assert.equal(changedPosting.stats.cacheHits, 0);
});

test('24시간 경계의 캐시와 지난 마감 캐시는 다시 공식 확인 큐에 넣는다', () => {
  const job = posting({ deadline: undefined });
  const base = buildDiscoveryQueue(snapshot([job]), { careerTypes: ['new'] }, { now: NOW });
  const expired = structuredClone(base);
  expired.candidates[0].verification = {
    state: 'verified', source: 'official', officialStatus: 'open',
    checkedAt: '2026-09-04T00:00:00.000Z', closesAt: '2026-10-01T00:00:00.000Z',
    officialUrl: 'https://company.example/careers/1', evidence: ['공식 근거'],
  };
  const pastClose = structuredClone(base);
  pastClose.candidates[0].verification = {
    state: 'verified', source: 'official', officialStatus: 'open',
    checkedAt: '2026-09-04T12:00:00.000Z', closesAt: '2026-09-01T00:00:00.000Z',
    officialUrl: 'https://company.example/careers/1', evidence: ['공식 근거'],
  };

  const expiredResult = buildDiscoveryQueue(snapshot([job]), { careerTypes: ['new'] }, { now: NOW, previous: expired });
  const closeResult = buildDiscoveryQueue(snapshot([job]), { careerTypes: ['new'] }, { now: NOW, previous: pastClose });
  assert.equal(expiredResult.candidates[0].verification.cacheReason, 'cache-expired');
  assert.equal(closeResult.candidates[0].verification.cacheReason, 'past-close-recheck');
  assert.equal(closeResult.queue.all.length, 1);
});

test('공식 URL/근거가 없거나 needs-review인 verification은 fresh여도 cache hit가 아니다', () => {
  const job = posting();
  const base = buildDiscoveryQueue(snapshot([job]), { careerTypes: ['new'] }, { now: NOW });
  const incomplete = structuredClone(base);
  incomplete.candidates[0].verification = {
    state: 'verified', source: 'official', officialStatus: 'open', checkedAt: '2026-09-04T12:00:00.000Z',
  };
  const needsReview = structuredClone(base);
  needsReview.candidates[0].verification = {
    state: 'needs-review', source: 'official', officialStatus: 'needs-review',
    checkedAt: '2026-09-04T12:00:00.000Z', officialUrl: 'https://company.example/careers/1', evidence: ['모호함'],
  };

  const noEvidenceResult = buildDiscoveryQueue(snapshot([job]), { careerTypes: ['new'] }, { now: NOW, previous: incomplete });
  const reviewResult = buildDiscoveryQueue(snapshot([job]), { careerTypes: ['new'] }, { now: NOW, previous: needsReview });
  assert.equal(noEvidenceResult.candidates[0].verification.cacheReason, 'official-cache-url-missing');
  assert.equal(reviewResult.candidates[0].verification.cacheReason, 'official-cache-not-complete');
  assert.equal(noEvidenceResult.queue.all.length, 1);
  assert.equal(reviewResult.queue.all.length, 1);
});

test('포털 rawEvidence의 verified 표시는 공식 검증 상태로 승격하지 않는다', () => {
  const job = posting({ rawEvidence: { officialStatus: 'verified', checkedAt: NOW } });
  const result = buildDiscoveryQueue(snapshot([job]), { careerTypes: ['new'] }, { now: NOW });

  assert.equal(result.candidates[0].verification.officialStatus, 'unverified');
  assert.equal(result.candidates[0].verification.source, null);
});

test('CLI가 예시 입력을 읽어 ledger와 전체 잔여 큐를 파일로 쓴다', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-plan-'));
  const outPath = path.join(tempDir, 'queue.json');
  const projectRoot = path.resolve(import.meta.dirname, '..', '..');
  const run = spawnSync(process.execPath, [
    path.join(projectRoot, 'scripts', 'discovery-plan.mjs'),
    '--snapshot', path.join(projectRoot, 'data', 'discovery-snapshot.example.json'),
    '--criteria', path.join(projectRoot, 'data', 'search-criteria.example.json'),
    '--out', outPath,
    '--now', NOW,
  ], { encoding: 'utf8' });

  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(result.stats.postingRows, result.stats.ledgerRows);
  assert.equal(result.queue.truncated, false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
