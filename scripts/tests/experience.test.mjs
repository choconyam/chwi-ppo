import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaims, readExperiences, checkExperiences, parseExperience } from '../lib/profile.mjs';
import { catalog, buildPacket, prepare } from '../apply-packet.mjs';
import { inspectMap, compareMap } from '../lib/jd-map.mjs';
import { runMap } from '../jd-map.mjs';

// 모든 fixture는 가상 사례다. 실제 개인 경험을 넣지 않는다.
const legacyExperience = `# 기존 가상 경험

- 본인 역할: 분석 담당
- 현재 상태: 완료

## 배경과 목표

- 기존 형식을 그대로 유지한다.

## 검증된 사실

### OLD-001
- 사실: 기존 형식으로 적은 사실이다.
- 근거: 가상 테스트 기록
- 상태: 검증됨

## 사용하면 안 되는 표현

- 팀 성과를 본인 성과로 쓰지 않는다.

## 원자료

- 가상 경로
`;

const projectExperience = `# 가상 재고 예측 프로젝트

- 경험 형식: experience-v2
- 경험 유형: 프로젝트
- 기간: 2026.01~2026.03
- 소속·형태: 교내 가상 팀 프로젝트
- 본인 역할: 데이터 정제와 모델 비교를 맡은 팀원
- 현재 상태: 완료

## 문제와 목표

- 재고 부족과 과잉이 반복돼 발주 기준을 정하기 어려웠다.

## 본인의 판단과 행동

- 결측 구간을 버리지 않고 보간하기로 판단하고 직접 전처리를 작성했다.

## 데이터·도구·방법

- 가상 판매 기록을 Python pandas로 정제하고 Prophet과 회귀를 비교했다.

## 산출물·결과·한계

- 발주 기준 문서를 만들었고 실제 매장 적용은 하지 않았다.

## 검증된 사실

### PROJ-001
- 사실: 결측 구간 보간 기준을 정해 전처리 절차를 만들었다.
- 근거: 가상 저장소 README 전처리 절
- 상태: 검증됨
- 유형: 판단
- 본인 기여: 보간 기준 선택과 구현을 직접 수행
- 방법·도구: pandas 기반 시계열 보간

### PROJ-002
- 사실: 두 예측 방법의 오차를 같은 기간으로 비교했다.
- 근거: 가상 실험 로그
- 상태: 검증됨
- 유형: 결과
- 결과·상태: 검증 구간 기준 비교 완료, 실제 매장 적용은 미검증

## 사용하면 안 되는 표현

- 매장 매출이 개선됐다고 쓰지 않는다.

## 원자료

- 가상 저장소 경로
`;

const credentialExperience = `# 가상 어학 성적

- 경험 형식: experience-v2
- 경험 유형: 자격
- 기간: 2026.02
- 소속·형태: 가상 공인 어학 시험
- 현재 상태: 완료

## 검증된 사실

### CERT-001
- 사실: 가상 어학 시험에서 중급 등급을 취득했다.
- 근거: 가상 성적표 1쪽
- 상태: 검증됨
- 유형: 역량

## 원자료

- 가상 성적표 경로
`;

function fixture(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chwi-experience-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, content) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  const get = file => fs.readFileSync(path.join(root, file), 'utf8');
  put('profile/PROFILE.md', '# 가상 프로필\n');
  put('profile/experiences/_EXPERIENCE_TEMPLATE.md', '# 템플릿\n- 경험 형식: experience-v2\n');
  for (const [file, content] of Object.entries(files)) put(file, content);
  return { root, put, get };
}

test('기존 형식 경험은 추가 구조 요구 없이 그대로 통과한다', t => {
  const { root } = fixture(t, { 'profile/experiences/legacy.md': legacyExperience });
  const claims = readClaims(root);
  assert.equal(claims.size, 1);
  assert.deepEqual(checkExperiences(root), []);
  assert.equal(readExperiences(root).get('profile/experiences/legacy.md').version, 1);
  // v2 추가 필드가 비어 있으면 직렬화에서 빠져 기존 문항 입력 해시를 바꾸지 않는다.
  const serialized = Object.keys(JSON.parse(JSON.stringify(claims.get('OLD-001'))));
  for (const key of ['type', 'contribution', 'method', 'outcome']) assert.equal(serialized.includes(key), false);
  // 템플릿 파일은 경험으로 읽지 않는다.
  assert.equal(readExperiences(root).has('profile/experiences/_EXPERIENCE_TEMPLATE.md'), false);
});

test('유효한 프로젝트형·자격형 v2 경험과 추가 claim 필드 파싱', t => {
  const { root } = fixture(t, {
    'profile/experiences/project.md': projectExperience,
    'profile/experiences/cert.md': credentialExperience,
  });
  assert.deepEqual(checkExperiences(root), []);
  const claims = readClaims(root);
  const proj = claims.get('PROJ-001');
  assert.equal(proj.type, '판단');
  assert.equal(proj.contribution, '보간 기준 선택과 구현을 직접 수행');
  assert.equal(proj.method, 'pandas 기반 시계열 보간');
  assert.equal(claims.get('PROJ-002').outcome, '검증 구간 기준 비교 완료, 실제 매장 적용은 미검증');
  const meta = readExperiences(root).get('profile/experiences/project.md');
  assert.equal(meta.version, 2);
  assert.equal(meta.type, '프로젝트');
  assert.equal(meta.role, '데이터 정제와 모델 비교를 맡은 팀원');
  // 자격형은 서사 절 없이도 통과한다.
  const cert = readExperiences(root).get('profile/experiences/cert.md');
  assert.equal(cert.sections.has('본인의 판단과 행동'), false);
});

test('경험 유형별로 필수 구조가 다르다', t => {
  const { root, put } = fixture(t, { 'profile/experiences/cert.md': credentialExperience });
  // 같은 본문을 프로젝트로 선언하면 서사 절·역할·표현 제한이 필요해진다.
  put('profile/experiences/cert.md', credentialExperience.replace('경험 유형: 자격', '경험 유형: 프로젝트'));
  const errors = checkExperiences(root).join('\n');
  for (const expected of ['본인 역할 누락', '문제와 목표 절 누락', '본인의 판단과 행동 절 누락', '표현 제한 절 누락']) {
    assert.match(errors, new RegExp(expected));
  }
  // 자격형으로 되돌리면 같은 본문이 통과한다.
  put('profile/experiences/cert.md', credentialExperience);
  assert.deepEqual(checkExperiences(root), []);
});

test('v2 필수 필드 누락·잘못된 값·중복 ID를 차단한다', t => {
  const { root, put } = fixture(t, { 'profile/experiences/project.md': projectExperience });
  for (const [content, expected] of [
    [projectExperience.replace('- 경험 유형: 프로젝트\n', ''), /경험 유형 누락/],
    [projectExperience.replace('경험 유형: 프로젝트', '경험 유형: 사이드'), /잘못된 경험 유형/],
    [projectExperience.replace('- 현재 상태: 완료\n', ''), /현재 상태 누락/],
    [projectExperience.replace('## 원자료\n\n- 가상 저장소 경로\n', ''), /원자료 절 누락/],
    [projectExperience.replace('- 유형: 판단\n', ''), /PROJ-001: claim 유형 누락/],
    [projectExperience.replace('- 유형: 판단', '- 유형: 소감'), /잘못된 claim 유형 소감/],
    [projectExperience.replace('- 결과·상태: 검증 구간 기준 비교 완료, 실제 매장 적용은 미검증\n', ''), /PROJ-002: 결과 claim에 결과·상태가 없습니다/],
    [projectExperience.replace('현재 상태: 완료', '현재 상태: 진행 중이며 결과는 확인 필요'), /PROJ-002: 현재 상태가 미확인인데 결과 claim이 검증됨/],
  ]) {
    put('profile/experiences/project.md', content);
    assert.match(checkExperiences(root).join('\n'), expected);
  }
  put('profile/experiences/project.md', projectExperience);
  put('profile/experiences/duplicate.md', projectExperience.replace('# 가상 재고 예측 프로젝트', '# 복제본'));
  assert.throws(() => readClaims(root), /중복 claim-id: PROJ-001/);
});

test('catalog는 사실 문장에 없는 도구·방법도 찾고 인덱스에 유형·역할·claim 수를 보여준다', t => {
  const { root } = fixture(t, {
    'profile/experiences/project.md': projectExperience,
    'profile/experiences/cert.md': credentialExperience,
    'profile/experiences/legacy.md': legacyExperience,
  });
  // Prophet은 어떤 사실 문장에도 없고 데이터·도구·방법 절에만 있다.
  assert.equal(readClaims(root).get('PROJ-001').fact.includes('Prophet'), false);
  const byTool = catalog(root, { query: 'prophet' });
  assert.match(byTool, /PROJ-001/);
  assert.match(byTool, /PROJ-002/);
  assert.doesNotMatch(byTool, /CERT-001|OLD-001/);
  // claim 단위 필드도 검색된다.
  assert.match(catalog(root, { query: 'pandas' }), /PROJ-001/);
  const index = catalog(root, { mode: 'index' });
  assert.match(index, /project\.md: 가상 재고 예측 프로젝트 \(유형 프로젝트 \/ 역할 데이터 정제와 모델 비교를 맡은 팀원 \/ 검증 claim 2개\)/);
  assert.match(index, /cert\.md: 가상 어학 성적 \(유형 자격 \/ 검증 claim 1개\)/);
  // 기존 형식 경험은 유형 없이 역할·claim 수만 나온다.
  assert.match(index, /legacy\.md: 기존 가상 경험 \(역할 분석 담당 \/ 검증 claim 1개\)/);
  assert.match(index, /미검토/);
  // claim 목록에는 유형과 방법·도구가 함께 보인다.
  const claimRows = catalog(root, { mode: 'claims', files: 'profile/experiences/project.md' });
  assert.match(claimRows, /- PROJ-001 \[판단\]: .*방법·도구: pandas 기반 시계열 보간/);
  assert.match(catalog(root, { query: '없는검색어' }), /조건에 맞는 claim: 0개/);
});

// --- JD 매칭 연동 -------------------------------------------------------
const requirement = (id, quote) => `### ${id}\n- 구분: 업무\n- 원문: ${quote}\n- 출처: 00_JD.md 수행업무\n- 업무 해석: [합리적 추정] 관련 업무\n- 산출물: [합리적 추정] 보고서\n- 필요 역량: 문제 정의\n\n`;
const mapping = (id, claims) => `### ${id}\n- 판정: 직접\n- claim: ${claims}\n- 연결 이유: 같은 방법을 사용한 근거\n- 한계: 도메인은 다름\n- 탐색 범위: 지정 파일만 확인\n\n`;

function matchingFixture(t) {
  const base = fixture(t, {
    'profile/experiences/project.md': projectExperience,
    'profile/experiences/other.md': credentialExperience,
  });
  const options = { jd: 'company/00_JD.md', analysis: 'company/01_JD분석.md', fit: 'company/02_직무적합성.md', state: '.work/map.json' };
  base.put(options.jd, '# JD\n데이터 정제\n예측 비교\n');
  base.put(options.analysis, '# 분석\n- 매칭 형식: jd-map-v1\n\n' + requirement('JD-001', '데이터 정제') + requirement('JD-002', '예측 비교'));
  base.put(options.fit, '# 적합성\n진행 판단은 별도입니다.\n\n' + mapping('JD-001', 'PROJ-001') + mapping('JD-002', 'PROJ-002'));
  return { ...base, options, record: () => runMap(base.root, 'record', { ...options, reviewed: 'yes' }) };
}

test('무관한 경험 변경은 기존 JD 매칭과 문항을 무효화하지 않는다', t => {
  const { root, put, get, options, record } = matchingFixture(t);
  const before = inspectMap(root, options);
  record();
  // 연결되지 않은 다른 경험의 본문과 claim 필드를 바꾼다.
  put('profile/experiences/other.md', get('profile/experiences/other.md')
    .replace('중급 등급을 취득했다', '중급 등급을 취득해 두었다').replace('- 유형: 역량', '- 유형: 산출물'));
  const diff = compareMap(inspectMap(root, options), before);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.sourceReviewRequired, false);
  assert.deepEqual(diff.candidateClaims, ['CERT-001']);
  assert.deepEqual(runMap(root, 'check', options).changed, []);
});

test('연결된 claim의 v2 필드 변경은 해당 요구만 재검토 대상이 된다', t => {
  const { root, put, get, options } = matchingFixture(t);
  const before = inspectMap(root, options);
  const file = 'profile/experiences/project.md';
  for (const [from, to] of [
    ['- 본인 기여: 보간 기준 선택과 구현을 직접 수행', '- 본인 기여: 팀과 함께 보간 기준을 정함'],
    ['- 방법·도구: pandas 기반 시계열 보간', '- 방법·도구: numpy 기반 시계열 보간'],
  ]) {
    const original = get(file);
    put(file, original.replace(from, to));
    assert.deepEqual(compareMap(inspectMap(root, options), before).changed, ['JD-001']);
    put(file, original);
  }
  // 결과·상태는 JD-002에 연결된 claim의 필드다.
  put(file, get(file).replace('실제 매장 적용은 미검증', '실제 매장 적용은 예정 없음'));
  assert.deepEqual(compareMap(inspectMap(root, options), before).changed, ['JD-002']);
  // 본인 역할·표현 제한은 파일 공통 문맥이므로 그 파일의 모든 연결을 재검토한다.
  put(file, projectExperience.replace('본인 역할: 데이터 정제와 모델 비교를 맡은 팀원', '본인 역할: 팀원'));
  assert.deepEqual(compareMap(inspectMap(root, options), before).changed, ['JD-001', 'JD-002']);
});

test('v2 필드는 packet에 전달되고 표현 제한 절 제목이 달라도 함께 실린다', t => {
  const { root, put, get, options, record } = matchingFixture(t);
  record();
  const request = {
    version: 1, official: { status: 'verified', url: 'https://example.com/jobs/1', checkedAt: '2026-09-01T00:00:00Z' },
    eligibility: { status: 'eligible' }, fit: { decision: 'proceed' },
    documents: { jd: options.jd, analysis: options.analysis, fit: options.fit }, matchingState: options.state,
    questions: [{ id: 'Q1', prompt: '직무 경험', source: '가상 문항', limit: 500, claimIds: ['PROJ-001'], requirementIds: ['JD-001'] }],
  };
  const requestFile = put('company/request.json', JSON.stringify(request));
  const out = path.join(root, '.work/packet.json');
  prepare(root, requestFile, out);
  const markdown = fs.readFileSync(out.replace('.json', '.md'), 'utf8');
  assert.match(markdown, /- 본인 기여: 보간 기준 선택과 구현을 직접 수행/);
  assert.match(markdown, /- 방법·도구: pandas 기반 시계열 보간/);
  assert.match(markdown, /매장 매출이 개선됐다고 쓰지 않는다/);
  // 표현 제한 절 제목을 "사용 시 주의"로 바꿔도 제한이 packet에 유지된다.
  put('profile/experiences/project.md', get('profile/experiences/project.md').replace('## 사용하면 안 되는 표현', '## 사용 시 주의'));
  record();
  prepare(root, requestFile, out);
  assert.match(fs.readFileSync(out.replace('.json', '.md'), 'utf8'), /매장 매출이 개선됐다고 쓰지 않는다/);
});

test('parseExperience는 CRLF와 표시 없는 문서를 안전하게 처리한다', () => {
  const meta = parseExperience(projectExperience.replaceAll('\n', '\r\n'));
  assert.equal(meta.version, 2);
  assert.equal(meta.type, '프로젝트');
  assert.equal(meta.cautionHeading, '사용하면 안 되는 표현');
  const bare = parseExperience('# 제목만 있는 문서\n');
  assert.equal(bare.version, 1);
  assert.equal(bare.type, undefined);
  assert.equal(bare.sections.size, 0);
});
