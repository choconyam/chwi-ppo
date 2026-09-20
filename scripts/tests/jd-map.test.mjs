import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectMap, compareMap, parseMap, checkedMap } from '../lib/jd-map.mjs';
import { runMap } from '../jd-map.mjs';
import { buildPacket, prepare, checkpointDraft, catalog, validateDraft } from '../apply-packet.mjs';

const claim = (id, fact, status = '검증됨') => `### ${id}\n- 사실: ${fact}\n- 근거: 가상 테스트 기록\n- 상태: ${status}\n`;
const requirement = (id, quote) => `### ${id}\n- 구분: 업무\n- 원문: ${quote}\n- 출처: 00_JD.md 수행업무\n- 업무 해석: [합리적 추정] 관련 업무 수행\n- 산출물: [합리적 추정] 분석 보고서\n- 필요 역량: 문제 정의\n\n`;
const mapping = (id, claims = 'WORK-001', decision = '직접') => `### ${id}\n- 판정: ${decision}\n- claim: ${claims}\n- 연결 이유: 같은 방법을 사용한 근거\n- 한계: 산업 도메인은 다름\n- 탐색 범위: work.md 확인, 나머지 미검토\n\n`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chwi-jd-map-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, content) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return target; };
  const get = file => fs.readFileSync(path.join(root, file), 'utf8');
  put('profile/PROFILE.md', '# 테스트 프로필\n');
  put('profile/experiences/work.md', '# 가상 프로젝트\n- 본인 역할: 분석\n\n' + claim('WORK-001', '데이터를 분석했다.') + '\n' + claim('WORK-002', '시각화했다.'));
  const options = { jd: 'company/00_JD.md', analysis: 'company/01_JD분석.md', fit: 'company/02_직무적합성.md', state: '.work/map.json' };
  put(options.jd, '# JD\n데이터 분석\n시각화\n');
  put(options.analysis, '# 분석\n- 매칭 형식: jd-map-v1\n\n' + requirement('JD-001', '데이터 분석') + requirement('JD-002', '시각화'));
  put(options.fit, '# 적합성\n진행 판단은 별도입니다.\n\n' + mapping('JD-001') + mapping('JD-002', 'WORK-002'));
  const record = () => runMap(root, 'record', { ...options, reviewed: 'yes' });
  const request = { version: 1, official: { status: 'verified', url: 'https://example.com/jobs/1', checkedAt: '2026-09-01T00:00:00Z' },
    eligibility: { status: 'eligible' }, fit: { decision: 'proceed' }, documents: { jd: options.jd, analysis: options.analysis, fit: options.fit }, matchingState: options.state,
    questions: [{ id: 'Q1', prompt: '직무 경험', source: '가상 문항', limit: 500, claimIds: ['WORK-001'], requirementIds: ['JD-001'] }] };
  return { root, put, get, options, record, request };
}

test('전체 구조 검사·검토 기록·CRLF·변경 없는 재사용', t => {
  const { root, options, put, get, record } = fixture(t);
  for (const file of [options.jd, options.analysis, options.fit]) put(file, get(file).replaceAll('\n', '\r\n'));
  const first = runMap(root, 'check', options);
  assert.deepEqual(first.changed, ['JD-001', 'JD-002']);
  assert.equal(fs.existsSync(path.join(root, options.state)), false);
  assert.throws(() => runMap(root, 'record', options), /reviewed yes/);
  record();
  assert.deepEqual(runMap(root, 'check', options).changed, []);
  assert.equal(checkedMap(root, options, options.state).entries.length, 2);
  assert.throws(() => runMap(root, 'record', { ...options, state: options.jd, reviewed: 'yes' }), /\.work/);
  assert.throws(() => inspectMap(root, { ...options, jd: '../outside.md' }), /내부/);
});

test('누락·중복·추가·오타 ID와 필수 필드·원문 불일치를 차단', t => {
  const { root, put, get, options } = fixture(t);
  const analysis = get(options.analysis), fit = get(options.fit);
  for (const [file, content, error] of [
    [options.fit, '# fit\n' + mapping('JD-001'), /JD-002.*누락/],
    [options.fit, fit + mapping('JD-003'), /없는 연결/],
    [options.analysis, analysis + requirement('JD-001', '데이터 분석'), /중복 요구/],
    [options.analysis, analysis.replace('JD-002', 'JD-XYZ'), /잘못된 요구 제목/],
    [options.analysis, analysis + '### JD-001 잘못된 중복 제목\n', /잘못된 요구 제목/],
    [options.analysis, analysis.replace('### JD-002', '## JD-002'), /잘못된 요구 제목/],
    [options.analysis, analysis.replace('- 산출물:', '- 결과:'), /산출물 누락/],
    [options.analysis, analysis.replace('- 원문: 데이터 분석', '- 원문: 없는 공고 문구'), /원문이/],
  ]) {
    put(file, content);
    assert.throws(() => inspectMap(root, options), error);
    put(options.analysis, analysis); put(options.fit, fit);
  }
  assert.throws(() => parseMap(requirement('JD-001', 'a') + '- 구분: 필수\n'), /중복 필드/);
});

test('연결은 검증 claim만, 근거가 없으면 미확인·범위를 명시', t => {
  const { root, put, options } = fixture(t);
  for (const [content, error] of [
    [mapping('JD-001', '없는ID'), /검증된 claim/],
    [mapping('JD-001', '없음'), /근거 claim/],
    [mapping('JD-001', 'WORK-001', '미확인'), /없음으로/],
    [mapping('JD-001', 'WORK-001, WORK-001'), /중복 claim/],
  ]) {
    put(options.fit, '# fit\n' + content + mapping('JD-002', '없음', '미확인'));
    assert.throws(() => inspectMap(root, options), error);
  }
  put(options.fit, '# fit\n' + mapping('JD-001') + mapping('JD-002', '없음', '미확인'));
  assert.equal(inspectMap(root, options).entries[1].decision, '미확인');
  put('profile/experiences/work.md', '# 가상\n' + claim('WORK-001', '분석', '확인 필요'));
  assert.throws(() => inspectMap(root, options), /검증된 claim/);
});

test('동일 파일의 특정 claim 변경은 해당 연결만, 역할 제한 변경은 파일의 모든 연결 재검토', t => {
  const { root, put, get, options } = fixture(t);
  const before = inspectMap(root, options);
  const file = 'profile/experiences/work.md';
  put(file, get(file).replace('시각화했다.', '차트를 만들었다.'));
  assert.deepEqual(compareMap(inspectMap(root, options), before).changed, ['JD-002']);
  put(file, get(file).replace('본인 역할: 분석', '본인 역할: 팀 내 분석 담당'));
  assert.deepEqual(compareMap(inspectMap(root, options), before).changed, ['JD-001', 'JD-002']);
});

test('새 경험은 후보 재탐색 안내, 삭제 요구·원문·공통 문맥 변경은 별도 감지', t => {
  const { root, put, get, options } = fixture(t);
  const before = inspectMap(root, options);
  put('profile/experiences/new.md', '# 새 가상 경험\n' + claim('NEW-001', '새 경험'));
  let diff = compareMap(inspectMap(root, options), before);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.candidateClaims, ['NEW-001']);
  put(options.jd, get(options.jd) + '새 필수 조건\n');
  assert.equal(compareMap(inspectMap(root, options), before).sourceReviewRequired, true);
  put(options.fit, '# 공통 판단 변경\n' + mapping('JD-001'));
  put(options.analysis, '# 분석\n- 매칭 형식: jd-map-v1\n\n' + requirement('JD-001', '데이터 분석'));
  diff = compareMap(inspectMap(root, options), before);
  assert.deepEqual(diff.removed, ['JD-002']);
  assert.equal(diff.contextReviewRequired, true);
});

test('매칭 기록 필수, 관련 없는 연결 변경은 문항 해시·초안 재사용 유지', t => {
  const { root, put, get, options, record, request } = fixture(t);
  assert.throws(() => buildPacket(root, request));
  record();
  const requestFile = put('company/request.json', JSON.stringify(request));
  const out = path.join(root, '.work/packet.json');
  const before = prepare(root, requestFile, out);
  put('company/draft.md', '```text\n데이터를 분석했습니다.\n```\nJD-001: WORK-001\n');
  checkpointDraft(root, out, 'Q1', 'company/draft.md');
  put(options.fit, get(options.fit).replace(mapping('JD-002', 'WORK-002'), mapping('JD-002', 'WORK-002').replace('같은 방법', '유사 방법')));
  assert.throws(() => buildPacket(root, request), /입력이 변경/);
  record();
  const after = prepare(root, requestFile, out, out);
  assert.equal(after.questions[0].inputHash, before.questions[0].inputHash);
  assert.equal(after.questions[0].action, 'reuse-draft');
  const markdown = fs.readFileSync(out.replace('.json', '.md'), 'utf8');
  assert.match(markdown, /### JD-001/);
  assert.doesNotMatch(markdown, /JD-002|WORK-002/);
  put(options.fit, get(options.fit).replace('한계: 산업 도메인은 다름', '한계: 결과는 미검증'));
  record();
  assert.notEqual(buildPacket(root, request).questions[0].inputHash, before.questions[0].inputHash);
});

test('문항 요구 ID·배정 claim 교차 검사와 비직무 문항 예외 사유', t => {
  const { root, record, request } = fixture(t); record();
  for (const ids of [['JD-999'], ['JD-002'], ['JD-001', 'JD-001'], []]) {
    const r = structuredClone(request); r.questions[0].requirementIds = ids;
    assert.throws(() => buildPacket(root, r));
  }
  const r = structuredClone(request); r.questions[0].requirementIds = []; r.questions[0].requirementNote = '개인 가치관 문항';
  assert.equal(buildPacket(root, r).questions.length, 1);
  assert.throws(() => validateDraft('```text\n분석\n```\nJD-002 WORK-001', request.questions[0]), /요구 ID/);
});

test('원문·공통 판단 변화는 문항을 무효화하고 형식 표시 제거로 기록을 우회하지 못함', t => {
  const { root, put, get, options, record, request } = fixture(t); record();
  let before = buildPacket(root, request).questions[0].inputHash;
  put(options.fit, get(options.fit).replace('진행 판단은 별도입니다.', '주의: 팀 성과는 개인 성과가 아님.'));
  assert.throws(() => buildPacket(root, request), /입력이 변경/);
  record();
  let after = buildPacket(root, request).questions[0].inputHash;
  assert.notEqual(after, before); before = after;
  put(options.jd, get(options.jd) + '\n공고 변경 안내\n'); record();
  after = buildPacket(root, request).questions[0].inputHash;
  assert.notEqual(after, before);
  put(options.analysis, get(options.analysis).replace('- 매칭 형식: jd-map-v1', ''));
  assert.throws(() => buildPacket(root, request), /형식 표시/);
});

test('CLI는 실제 검사·검토 기록을 실행하고 잘못된 호출을 실패 처리', t => {
  const { root, options } = fixture(t);
  const script = fileURLToPath(new URL('../jd-map.mjs', import.meta.url));
  const args = Object.entries({ ...options, root }).flatMap(([key, value]) => [`--${key}`, value]);
  const run = (...command) => spawnSync(process.execPath, [script, ...command, ...args], { encoding: 'utf8' });
  let result = run('check');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).requirements, 2);
  result = run('record', '--reviewed', 'yes');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(run('check').stdout).changed, []);
  assert.equal(run('invalid').status, 1);
});

test('catalog는 경험 인덱스·선택 파일·검색·분할 표시 및 미검토 범위를 제공', t => {
  const { root, put } = fixture(t);
  put('profile/experiences/extra.md', '# 별도 가상 경험\n' + claim('EXTRA-001', '문서를 썼다.') + claim('EXTRA-002', '미확인', '확인 필요'));
  const index = catalog(root, { mode: 'index', limit: '1' });
  assert.match(index, /표시: 1\/2행.*다음 offset: 1/);
  assert.match(index, /미검토/);
  const selected = catalog(root, { files: 'profile/experiences/work.md', query: '시각화' });
  assert.match(selected, /WORK-002/);
  assert.doesNotMatch(selected, /WORK-001|EXTRA/);
  assert.match(catalog(root, { query: '검색결과없음' }), /조건에 맞는 claim: 0개/);
  assert.throws(() => catalog(root, { limit: '-1' }), /정수/);
});
