import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPacket, checkpointDraft, prepare, recordReview, validateDraft } from '../apply-packet.mjs';
import { digest, readClaims } from '../lib/profile.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chwi-apply-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, text) => { const p = path.join(root, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  put('profile/PROFILE.md', '# 프로필\n지원 형태: 경력\n');
  put('profile/experiences/work.md', '# 서비스 운영\n- 본인 역할: API 개발\n\n### WORK-001\n- 사실: API를 개발했다.\n- 근거: 업무일지 2쪽\n- 상태: 검증됨\n\n### WORK-002\n- 사실: 처리 시간이 줄었다.\n- 근거: 확인 대기\n- 상태: 확인 필요\n\n## 사용하면 안 되는 표현\n- 팀 운영 성과를 단독 성과로 쓰지 않는다.\n');
  for (const name of ['jd', 'analysis', 'fit']) put(`company/${name}.md`, `# ${name}\n공식 입력 자료\n`);
  const request = { version: 1, official: { status: 'verified', url: 'https://example.com/jobs/1', checkedAt: '2026-09-05T00:00:00+09:00' },
    eligibility: { status: 'eligible' }, fit: { decision: 'proceed' }, documents: { jd: 'company/jd.md', analysis: 'company/analysis.md', fit: 'company/fit.md' },
    questions: [{ id: 'Q1', prompt: '직무 관련 성과를 설명하세요.', source: '지원화면 1번', limit: 500, claimIds: ['WORK-001'] }] };
  const requestFile = put('company/request.json', JSON.stringify(request));
  return { root, put, request, requestFile };
}

test('배정한 검증 사실과 역할 제한만 전달하고 확인 필요 claim은 차단', t => {
  const { root, request } = fixture(t);
  const packet = buildPacket(root, request);
  assert.equal(packet.questions[0].claims.length, 1);
  assert.match(packet.questions[0].claims[0].cautions, /단독 성과/);
  request.questions[0].claimIds.push('WORK-002');
  assert.throws(() => buildPacket(root, request), /검증된 claim이 아닙니다/);
});
test('packet.md는 원문 반복 없이 claim 사전·표현 제한을 한 번만 두고 문항별 배정을 보존', t => {
  const { root, put, request, requestFile } = fixture(t);
  put('profile/experiences/work.md', '# 서비스 운영\n- 본인 역할: API 개발\n\n### WORK-001\n- 사실: API를 개발했다.\n- 근거: 업무일지 2쪽\n- 상태: 검증됨\n\n### WORK-003\n- 사실: 장애 원인을 분석했다.\n- 근거: 장애 기록 3쪽\n- 상태: 검증됨\n\n## 사용하면 안 되는 표현\n- 팀 운영 성과를 단독 성과로 쓰지 않는다.\n');
  put('company/jd.md', '# jd\nJD 전체 전문에만 있는 문자열\n');
  put('company/analysis.md', '# analysis\n작성에 필요한 분석 문자열\n');
  put('company/fit.md', '# fit\nFIT 전체 전문에만 있는 문자열\n');
  request.questions[0].claimIds = ['WORK-001', 'WORK-003'];
  request.questions.push({ ...request.questions[0], id: 'Q2', claimIds: ['WORK-001'] });
  fs.writeFileSync(requestFile, JSON.stringify(request));
  const out = path.join(root, '.work/packet.json');
  prepare(root, requestFile, out);
  const markdown = fs.readFileSync(out.replace(/\.json$/, '.md'), 'utf8');
  const occurrences = pattern => [...markdown.matchAll(pattern)].length;
  assert.doesNotMatch(markdown, /JD 전체 전문에만 있는 문자열|FIT 전체 전문에만 있는 문자열/);
  assert.match(markdown, /작성에 필요한 분석 문자열/);
  assert.equal(occurrences(/^### WORK-001$/gm), 1);
  assert.equal(occurrences(/팀 운영 성과를 단독 성과로 쓰지 않는다\./g), 1);
  assert.match(markdown, /## Q1:[\s\S]*배정 claim-id: WORK-001, WORK-003/);
  assert.match(markdown, /## Q2:[\s\S]*배정 claim-id: WORK-001/);
  assert.match(markdown, /- 공식 JD: company\/jd\.md/);
  assert.match(markdown, /- 적합도 판단: company\/fit\.md/);
});
test('자격·공식검증·문항 제한 미확인 및 근거없는 문항 차단', t => {
  const { root, request } = fixture(t);
  for (const change of [r => r.eligibility.status = 'needs-review', r => r.official.status = 'needs-review', r => r.questions[0].limit = null, r => r.questions[0].claimIds = []]) {
    const copy = structuredClone(request); change(copy);
    assert.throws(() => buildPacket(root, copy));
  }
});
test('최초 초안은 형식 검사 체크포인트 뒤 검수 호출 없이 재사용', t => {
  const { root, put, requestFile, request } = fixture(t);
  const out = path.join(root, '.work/packet.json');
  const packet = prepare(root, requestFile, out);
  assert.equal(packet.questions[0].action, 'draft');
  const draft = '```text\nAPI를 개발했습니다.\n```\n|근거|WORK-001|\n';
  put('company/draft.md', draft);
  checkpointDraft(root, out, 'Q1', 'company/draft.md');
  const reused = prepare(root, requestFile, out, out).questions[0];
  assert.equal(reused.action, 'reuse-draft');
  assert.equal(reused.state, 'draft');
  assert.equal(reused.finalReview, undefined);
});
test('사용자 본문 수정은 이전 PASS가 아니며 수정본 체크포인트도 최종으로 승격되지 않음', t => {
  const { root, put, requestFile } = fixture(t);
  const out = path.join(root, '.work/packet.json');
  const packet = prepare(root, requestFile, out);
  const draft = '```text\nAPI를 개발했습니다.\n```\n|근거|WORK-001|\n';
  put('company/draft.md', draft);
  put('company/final.md', `- 검수 단계: final\n- 판정: PASS\n- 입력 해시: ${packet.questions[0].inputHash}\n- 본문 해시: ${digest(draft)}\n`);
  recordReview(root, out, 'Q1', 'company/draft.md', 'company/final.md', 'final');
  assert.equal(prepare(root, requestFile, out, out).questions[0].action, 'reuse-final');
  put('company/draft.md', draft.replace('개발했습니다', '설계했습니다'));
  const changed = prepare(root, requestFile, out, out).questions[0];
  assert.equal(changed.action, 'reuse-draft');
  assert.equal(changed.finalReview, undefined);
});
test('동일 입력·동일 실제 본문의 checkpoint는 유효한 fact/final PASS를 보존', t => {
  const { root, put, requestFile } = fixture(t);
  const out = path.join(root, '.work/packet.json');
  const packet = prepare(root, requestFile, out);
  const draft = '```text\nAPI를 개발했습니다.\n```\n|근거|WORK-001|\n';
  put('company/draft.md', draft);
  put('company/fact.md', `- 검수 단계: fact\n- 판정: PASS\n- 입력 해시: ${packet.questions[0].inputHash}\n- 본문 해시: ${digest(draft)}\n`);
  recordReview(root, out, 'Q1', 'company/draft.md', 'company/fact.md', 'fact');
  let checked = checkpointDraft(root, out, 'Q1', 'company/draft.md');
  assert.equal(checked.factReview?.status, 'PASS');
  assert.equal(checked.state, 'fact-reviewed-draft');
  put('company/final.md', `- 검수 단계: final\n- 판정: PASS\n- 입력 해시: ${packet.questions[0].inputHash}\n- 본문 해시: ${digest(draft)}\n`);
  recordReview(root, out, 'Q1', 'company/draft.md', 'company/final.md', 'final');
  checked = checkpointDraft(root, out, 'Q1', 'company/draft.md');
  assert.equal(checked.finalReview?.status, 'PASS');
  assert.equal(checked.action, 'reuse-final');
  assert.equal(checked.state, 'final-reviewed');
});
test('checkpoint는 본문·추적표 또는 검수 보고서 변경·삭제 시 PASS를 폐기', t => {
  const { root, put, requestFile } = fixture(t);
  const out = path.join(root, '.work/packet.json');
  let packet = prepare(root, requestFile, out);
  const draft = '```text\nAPI를 개발했습니다.\n```\n|근거|WORK-001|\n';
  put('company/draft.md', draft);
  const recordFinal = () => {
    packet = JSON.parse(fs.readFileSync(out, 'utf8'));
    put('company/final.md', `- 검수 단계: final\n- 판정: PASS\n- 입력 해시: ${packet.questions[0].inputHash}\n- 본문 해시: ${digest(draft)}\n`);
    recordReview(root, out, 'Q1', 'company/draft.md', 'company/final.md', 'final');
  };
  recordFinal();
  put('company/draft.md', draft.replace('|근거|', '|근거 추적|'));
  let checked = checkpointDraft(root, out, 'Q1', 'company/draft.md');
  assert.equal(checked.finalReview, undefined, '추적표 변경도 실제 파일 해시 변경이다');
  put('company/draft.md', draft);
  recordFinal();
  put('company/draft.md', draft.replace('개발했습니다', '설계했습니다'));
  checked = checkpointDraft(root, out, 'Q1', 'company/draft.md');
  assert.equal(checked.finalReview, undefined, '본문 변경 시 PASS를 폐기한다');
  put('company/draft.md', draft);
  recordFinal();
  put('company/final.md', `${fs.readFileSync(path.join(root, 'company/final.md'), 'utf8')}\n수정됨\n`);
  checked = checkpointDraft(root, out, 'Q1', 'company/draft.md');
  assert.equal(checked.finalReview, undefined, '보고서 수정 시 PASS를 폐기한다');
  recordFinal();
  fs.rmSync(path.join(root, 'company/final.md'));
  checked = checkpointDraft(root, out, 'Q1', 'company/draft.md');
  assert.equal(checked.finalReview, undefined, '보고서 삭제 시 PASS를 폐기한다');
});
test('final은 실제 검수 단계·입력·본문 해시의 PASS가 있어야 재사용', t => {
  const { root, put, requestFile } = fixture(t);
  const out = path.join(root, '.work/packet.json');
  const packet = prepare(root, requestFile, out);
  const draft = '```text\nAPI를 개발했습니다.\n```\n|근거|WORK-001|\n';
  put('company/draft.md', draft);
  checkpointDraft(root, out, 'Q1', 'company/draft.md');
  put('company/review.md', `- 판정: PASS\n- 입력 해시: ${packet.questions[0].inputHash}\n- 본문 해시: ${digest(draft)}\n`);
  recordReview(root, out, 'Q1', 'company/draft.md', 'company/review.md');
  assert.equal(prepare(root, requestFile, out, out).questions[0].action, 'reuse-draft', '중간 사실 검수는 final이 아니다');
  assert.throws(() => recordReview(root, out, 'Q1', 'company/draft.md', 'company/review.md', 'final'), /단계가 final/);
  put('company/final.md', `- 검수 단계: final\n- 판정: PASS\n- 입력 해시: ${packet.questions[0].inputHash}\n- 본문 해시: ${digest(draft)}\n`);
  recordReview(root, out, 'Q1', 'company/draft.md', 'company/final.md', 'final');
  const final = prepare(root, requestFile, out, out).questions[0];
  assert.equal(final.action, 'reuse-final');
  assert.equal(final.state, 'final-reviewed');
});
test('문항·근거 입력 변경은 초안 체크포인트와 final PASS를 모두 재평가', t => {
  const { root, put, requestFile, request } = fixture(t);
  const out = path.join(root, '.work/packet.json');
  const packet = prepare(root, requestFile, out);
  const draft = '```text\nAPI를 개발했습니다.\n```\n|근거|WORK-001|\n';
  put('company/draft.md', draft);
  put('company/final.md', `- 검수 단계: final\n- 판정: PASS\n- 입력 해시: ${packet.questions[0].inputHash}\n- 본문 해시: ${digest(draft)}\n`);
  recordReview(root, out, 'Q1', 'company/draft.md', 'company/final.md', 'final');
  request.questions[0].prompt = '다른 질문'; put('company/request.json', JSON.stringify(request));
  assert.throws(() => checkpointDraft(root, out, 'Q1', 'company/draft.md'), /입력 근거가 변경/);
  const changed = prepare(root, requestFile, out, out).questions[0];
  assert.equal(changed.action, 'draft');
  assert.equal(changed.previousDraft, 'company/draft.md');
  assert.equal(changed.finalReview, undefined);
  assert.throws(() => recordReview(root, out, 'Q1', 'company/draft.md', 'company/final.md', 'final'), /입력|본문과 일치/);
});
test('사용금지 승격·claim 수정·JD 수정은 캐시 입력을 변경, 무관 경험은 영향 없음', t => {
  const { root, put, request } = fixture(t);
  const before = buildPacket(root, request).questions[0].inputHash;
  put('profile/experiences/unrelated.md', '# 다른 경험\n### ETC-001\n- 사실: 다른 경험\n- 근거: 별도 기록\n- 상태: 검증됨\n');
  assert.equal(buildPacket(root, request).questions[0].inputHash, before);
  const file = path.join(root, 'profile/experiences/work.md');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('API를 개발했다.', 'API를 공동 개발했다.'));
  assert.notEqual(buildPacket(root, request).questions[0].inputHash, before);
  fs.writeFileSync(file, text.replace('상태: 검증됨', '상태: 사용 금지'));
  assert.throws(() => buildPacket(root, request), /검증된 claim/);
  fs.writeFileSync(file, text); put('company/jd.md', '변경된 JD');
  assert.notEqual(buildPacket(root, request).questions[0].inputHash, before);
});
test('누락/중복 claim·제한 초과·미배정 인용을 차단', t => {
  const { root, request, put } = fixture(t);
  const q = buildPacket(root, request).questions[0];
  assert.throws(() => validateDraft('```text\n본문\n```\nWORK-999', q), /배정되지 않은/);
  assert.throws(() => validateDraft('```text\n' + '가'.repeat(501) + '\n```\nWORK-001', q), /글자수/);
  put('profile/experiences/dup.md', '### WORK-001\n- 사실: 중복\n- 근거: 원문\n- 상태: 검증됨\n');
  assert.throws(() => readClaims(root), /중복/);
});
test('한 문항의 근거나 제한이 없으면 그 문항만 보류하고 검증된 문항은 계속 진행', t => {
  const { root, request } = fixture(t);
  request.questions.push({ ...request.questions[0], id: 'Q2', claimIds: ['WORK-002'] });
  request.questions.push({ ...request.questions[0], id: 'Q3', limit: null });
  const result = buildPacket(root, request);
  assert.deepEqual(result.questions.map(q => q.id), ['Q1']);
  assert.deepEqual(result.blockedQuestions.map(q => q.id), ['Q2', 'Q3']);
  assert.match(result.blockedQuestions[0].reason, /검증된 claim/);
});
test('같은 공식 내용의 재확인 시각만 갱신하면 기존 작성 입력을 재사용', t => {
  const { root, request } = fixture(t);
  const before = buildPacket(root, request).questions[0].inputHash;
  request.official.checkedAt = '2026-09-06T00:00:00+09:00';
  assert.equal(buildPacket(root, request).questions[0].inputHash, before);
  request.official.url = 'https://example.com/jobs/2';
  assert.notEqual(buildPacket(root, request).questions[0].inputHash, before);
});
