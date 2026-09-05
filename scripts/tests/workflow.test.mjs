import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIntakePlan, commitIntakePlan } from '../lib/intake.mjs';
import { buildDiscoveryQueue } from '../lib/discovery.mjs';
import { prepare, recordReview } from '../apply-packet.mjs';
import { digest } from '../lib/profile.mjs';
import { collect, parseSearchPage } from '../collect-jasoseol.mjs';
import { writeDiscoveryBrief } from '../lib/discovery-brief.mjs';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chwi-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
  };
  return { root, put };
}

function pageHtml(page, { totalCount = 4, rows, excludeClosed = true } = {}) {
  rows ??= Array.from({ length: 2 }, (_, i) => ({ id: (page - 1) * 2 + i + 1,
    name: `예시기업${page}-${i}`, title: '신입·경력 채용', company_group: { business_size: 'big_business' },
    end_time: '2026-09-30T18:00:00+09:00', employment_page_url: 'https://example.com/jobs',
    employments: [{ id: page * 100 + i, field: '데이터 분석', division: i ? [2] : [1, 2] }] }));
  return rows.map(row => `<a href="/recruit/${row.id}">공고</a>`).join('')
    + `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: {
      initialFilters: { excludeClosed }, dehydratedState: { queries: [{ queryKey: ['jobSearch'],
        state: { data: { page, perPage: 2, totalCount, data: rows } } }] } } } })}</script>`;
}

test('공개 목록 수집 → 페이지 예산 중단 → 재개 → 신입/경력별 세부 직무 큐', async t => {
  const { root } = workspace(t);
  const output = path.join(root, 'snapshot.json');
  const calls = [];
  const fetchPage = async url => { const page = Number(new URL(url).searchParams.get('page')); calls.push(page); return pageHtml(page); };
  const now = () => '2026-09-05T10:00:00+09:00';
  const first = await collect({ output, maxPages: 1, fetchPage, now });
  assert.equal(first.sources[0].complete, false);
  assert.equal(first.collection.nextPage, 2);
  const final = await collect({ output, resume: output, fetchPage, now });
  assert.deepEqual(calls, [1, 2]); // 재개 때 이미 읽은 페이지 재수집 없음
  assert.equal(final.sources[0].complete, true);
  assert.equal(final.postings.length, 4);
  const beginner = buildDiscoveryQueue(final, { careerTypes: ['new'] }, { now: now() });
  const experienced = buildDiscoveryQueue(final, { careerTypes: ['experienced'] }, { now: now() });
  assert.equal(beginner.candidates.length, 2);
  assert.equal(experienced.candidates.length, 4);
  assert.equal(beginner.ledger.length, 4);
  assert(beginner.candidates.every(c => c.verification.state === 'pending'));
  const brief = writeDiscoveryBrief(experienced, path.join(root, 'queue.json'));
  assert.equal(brief.roles, 4);
  const detailFiles = fs.readdirSync(path.join(root, 'queue.companies'));
  const details = detailFiles.map(f => fs.readFileSync(path.join(root, 'queue.companies', f), 'utf8')).join('\n');
  for (const candidate of experienced.candidates) assert(details.includes(candidate.id));
});

test('페이지/필터 미적용·접근 실패·중복 목록을 전체 수집 성공으로 처리하지 않음', async t => {
  const { root } = workspace(t);
  assert.throws(() => parseSearchPage(pageHtml(1), 'https://jasoseol.com/search?page=2&excludeClosed=true'), /적용되지/);
  assert.throws(() => parseSearchPage(pageHtml(1, { excludeClosed: false }), 'https://jasoseol.com/search?excludeClosed=true'), /적용되지/);
  assert.throws(() => parseSearchPage('<html>Forbidden</html>', 'https://jasoseol.com/search'), /차단/);
  const broken = await collect({ output: path.join(root, 'broken.json'), fetchPage: async () => { throw new Error('HTTP 429'); } });
  assert.equal(broken.sources[0].complete, false);
  assert.equal(broken.collection.nextPage, 1);
  assert.equal(broken.postings.length, 0);
  const repeated = await collect({ output: path.join(root, 'repeated.json'), fetchPage: async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    const rows = [{ id: 1, name: '가상기업', title: '공고', employments: [] }, { id: 2, name: '가상기업', title: '공고2', employments: [] }];
    return pageHtml(page, { rows });
  } });
  assert.equal(repeated.sources[0].complete, false);
  assert.equal(repeated.collection.errors.length, 1);
});

test('잘못된 날짜를 마감 확정으로 쓰지 않고 접수 종료 캐시도 추천에 재사용하지 않음', () => {
  const snapshot = { sources: [{ id: 's', url: 'https://example.com/list', checkedAt: '2026-09-05T00:00:00Z', complete: true, expectedPages: 1, pagesVisited: 1, listedCount: 1, accessStatus: 'ok' }],
    postings: [{ sourceId: 's', sourceRowId: '1', company: '가상기업', title: '공고', url: 'https://example.com/1', deadline: '2026-02-30', roles: [{ id: 'data', title: '데이터' }] }] };
  const now = '2026-09-05T00:00:00Z';
  const queue = buildDiscoveryQueue(snapshot, {}, { now });
  assert.equal(queue.candidates.length, 1);
  assert.equal(queue.candidates[0].deadline.at, null);
  queue.candidates[0].verification = { state: 'verified', source: 'official', officialStatus: 'closed', officialUrl: 'https://example.com/official', checkedAt: now, evidence: '접수 종료' };
  assert.equal(buildDiscoveryQueue(snapshot, {}, { now, previous: queue }).stats.cacheHits, 0);
});

test('경력 지원자가 신입 공고에서 발견한 회사도 다른 공식 경력 공고 확인 대상으로 보존', t => {
  const { root } = workspace(t);
  const parsed = parseSearchPage(pageHtml(1, { rows: [{ id: 10, name: '가상기업', title: '신입 공채', employments: [{ id: 11, field: '신입 직무', division: [1] }] }], totalCount: 1 }), 'https://jasoseol.com/search?excludeClosed=true');
  const snapshot = { sources: [{ id: 'jasoseol-search', url: 'https://jasoseol.com/search', checkedAt: '2026-09-05T00:00:00Z', accessStatus: 'ok', complete: true, expectedPages: 1, pagesVisited: 1, listedCount: 1 }], postings: parsed.postings };
  const queue = buildDiscoveryQueue(snapshot, { careerTypes: ['experienced'] });
  assert.equal(queue.candidates.length, 0);
  assert.equal(queue.companyChecks.length, 1);
  assert.equal(queue.companyChecks[0].action, 'inspect-official-openings');
  const brief = writeDiscoveryBrief(queue, path.join(root, 'queue.json'));
  assert(fs.readFileSync(brief.briefPath, 'utf8').includes('가상기업'));
});

for (const careerType of ['new', 'experienced']) test(`${careerType}: 원자료 → 프로필 → 기업/JD 선별 → 근거별 문항 → 수정 범위 재사용`, async t => {
  const { root, put } = workspace(t);
  const source = put('raw/README.md', '공개 데이터의 필수 항목 검사와 결과 대조 코드를 작성했다.\n팀 최종 발표에는 참여했다.');
  const plan = await createIntakePlan({ root, sources: [source] });
  put('profile/PROFILE.md', `# 프로필\n- 지원 형태: ${careerType}\n- 핵심 경험: 데이터 검증\n`);
  put('profile/experiences/data.md', '# 데이터 검증\n- 본인 역할: 검사 코드 작성\n### DATA-001\n- 사실: 공개 데이터 필수 항목 검사와 결과 대조 코드를 작성했다.\n- 근거: raw/README.md 1행\n- 상태: 검증됨\n');
  const pendingPath = put('profile/experiences/team.md', '# 팀 활동\n### TEAM-001\n- 사실: 팀 최종 발표에 참여했다.\n- 근거: raw/README.md 2행\n- 상태: 검증됨\n### TEAM-002\n- 사실: 전체 프로젝트를 혼자 수행했다.\n- 근거: 사용자 역할 확인 전\n- 상태: 확인 필요\n');
  await commitIntakePlan({ root, plan, receipt: { schemaVersion: 1, planId: plan.planId, status: 'success', validation: { status: 'passed' },
    outputs: ['profile/PROFILE.md', 'profile/experiences/data.md'], processedFiles: plan.files.map(f => ({ id: f.id, sha256: f.sha256, outcome: 'extracted' })), removedFiles: [] } });
  const unchanged = await createIntakePlan({ root });
  assert.equal(unchanged.modelCalls, 0);
  assert.equal(unchanged.execution.receiptFileIds.length, 0);

  const snapshot = { sources: [{ id: 'portal', url: 'https://example.com/list', checkedAt: '2026-09-05T09:00:00+09:00', accessStatus: 'ok', complete: true, pagesVisited: 1, expectedPages: 1, listedCount: 1 }],
    postings: [{ sourceId: 'portal', sourceRowId: '1', company: '가상기업', title: '전체 채용', url: 'https://example.com/posting/1', careerTypes: ['mixed'],
      roles: [{ id: 'data', title: '데이터 품질 분석', careerTypes: ['mixed'] }, { id: 'legal', title: '법무 경력', careerTypes: ['experienced'], requiredExperienceMonths: 120 }] }] };
  const queue = buildDiscoveryQueue(snapshot, { careerTypes: [careerType], keywords: ['데이터'], experienceMonths: careerType === 'new' ? 0 : 36, experienceMonthsBasis: 'verified-relevant' }, { now: '2026-09-05T10:00:00+09:00' });
  assert.equal(queue.candidates.length, 1);
  assert.equal(queue.candidates[0].title, '데이터 품질 분석');
  assert.equal(queue.candidates[0].verification.state, 'pending');

  // 공식 확인/의미 판단은 외부 검수 역할. 이 fixture는 그 이후 파일 연결과 재사용 조건만 검증한다.
  const documents = { jd: 'companies/가상기업/데이터/00_JD.md', analysis: 'companies/가상기업/데이터/01_JD분석.md', fit: 'companies/가상기업/데이터/02_직무적합성.md' };
  put(documents.jd, '# 가상 공식 JD\n데이터 필수 항목 검사·대조 자동화. 신입/경력 지원 가능.\n문항: 직무 경험을 쓰세요(500자), 협업 경험을 쓰세요(500자).');
  put(documents.analysis, '# JD 분석\n필수 항목 검사와 재현 가능한 대조 코드.');
  put(documents.fit, '# 적합성\nDATA-001 검사 코드 작성 경험과 연결. 경력 요건은 이 가상 JD에 없음.');
  const request = { version: 1, official: { status: 'verified', url: 'https://example.com/official/data', checkedAt: '2026-09-05T10:00:00+09:00' },
    eligibility: { status: 'eligible' }, fit: { decision: 'proceed' }, documents,
    questions: [{ id: 'Q1', prompt: '직무 경험을 쓰세요.', source: '00_JD.md', limit: 500, claimIds: ['DATA-001'] }, { id: 'Q2', prompt: '협업 경험을 쓰세요.', source: '00_JD.md', limit: 500, claimIds: ['TEAM-001'] }, { id: 'Q3', prompt: '단독 수행 경험을 쓰세요.', source: '미확인 사용자 소재', limit: 500, claimIds: ['TEAM-002'] }] };
  const requestFile = put('companies/request.json', JSON.stringify(request));
  const out = path.join(root, '.work/apply/packet.json');
  const packet = prepare(root, requestFile, out);
  assert.equal(packet.questions.length, 2);
  assert.equal(packet.blockedQuestions.length, 1);
  for (const q of packet.questions) {
    const draft = `\`\`\`text\n${q.claims[0].fact}\n\`\`\`\n근거: ${q.claimIds.join(', ')}\n`;
    put(`companies/${q.id}.md`, draft);
    put(`companies/review-${q.id}.md`, `- 판정: PASS\n- 입력 해시: ${q.inputHash}\n- 본문 해시: ${digest(draft)}\n`);
    recordReview(root, out, q.id, `companies/${q.id}.md`, `companies/review-${q.id}.md`);
  }
  assert(prepare(root, requestFile, out, out).questions.every(q => q.action === 'reuse'));
  fs.writeFileSync(pendingPath, fs.readFileSync(pendingPath, 'utf8').replace('팀 최종 발표에 참여했다.', '팀 최종 발표 준비에 참여했다.'));
  const changed = prepare(root, requestFile, out, out);
  assert.equal(changed.questions.find(q => q.id === 'Q1').action, 'reuse');
  assert.equal(changed.questions.find(q => q.id === 'Q2').action, 'draft');
  fs.appendFileSync(source, '\n새 검증 단계 추가');
  assert.equal((await createIntakePlan({ root })).summary.files.changed, 1);
  assert.equal(fs.existsSync(path.join(root, 'data/opportunities.json')), false, '캘린더가 없어도 작성 가능');
});
