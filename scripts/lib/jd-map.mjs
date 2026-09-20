import fs from 'node:fs';
import path from 'node:path';
import { digest, readClaims } from './profile.mjs';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const mapMarker = '- 매칭 형식: jd-map-v1';
export function localFile(root, relative) {
  assert(typeof relative === 'string' && relative, '파일 경로가 필요합니다.');
  const file = path.resolve(root, relative);
  const rel = path.relative(root, file);
  assert(rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel), '파일은 작업공간 내부여야 합니다.');
  return file;
}
const normalize = value => value.replaceAll('\r\n', '\n');
export function parseMap(content) {
  const text = normalize(content);
  const pattern = /^### (JD-\d{3,})\s*\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/gm;
  const entries = new Map();
  for (const match of text.matchAll(pattern)) {
    assert(!entries.has(match[1]), `중복 요구 ID: ${match[1]}`);
    const fields = {};
    for (const field of match[2].matchAll(/^- ([^:\n]+):[ \t]*(.*)$/gm)) {
      assert(!(field[1] in fields), `${match[1]}: 중복 필드 ${field[1]}`);
      fields[field[1]] = field[2].trim();
    }
    entries.set(match[1], { id: match[1], fields, content: match[2].trim() });
  }
  // Unknown/malformed IDs must not silently disappear from coverage.
  for (const heading of text.matchAll(/^#{1,6} (JD-\S+).*$/gm)) {
    assert(/^### JD-\d{3,}[ \t]*$/.test(heading[0]) && entries.has(heading[1]), `잘못된 요구 제목: ${heading[0]}`);
  }
  assert(entries.size, 'JD 요구사항 블록이 없습니다.');
  return { entries, context: text.replace(pattern, '').trim() };
}
export const splitIds = value => value === '없음' ? [] : (value ?? '').split(',').map(s => s.trim()).filter(Boolean);

export function inspectMap(root, files, claims = readClaims(root)) {
  const jd = normalize(fs.readFileSync(localFile(root, files.jd), 'utf8'));
  const analysis = parseMap(fs.readFileSync(localFile(root, files.analysis), 'utf8'));
  const fit = parseMap(fs.readFileSync(localFile(root, files.fit), 'utf8'));
  assert(analysis.context.includes(mapMarker), '매칭 형식 표시가 없습니다.');
  for (const id of fit.entries.keys()) assert(analysis.entries.has(id), `JD에 없는 연결 ID: ${id}`);
  const entries = [];
  for (const [id, requirement] of analysis.entries) {
    const r = requirement.fields;
    for (const key of ['구분', '원문', '출처', '업무 해석', '산출물', '필요 역량']) assert(r[key], `${id}: ${key} 누락`);
    assert(['업무', '필수', '우대', '조건'].includes(r.구분), `${id}: 잘못된 요구 구분`);
    assert(jd.includes(r.원문), `${id}: 원문이 00_JD에 없습니다.`);
    const mapping = fit.entries.get(id);
    assert(mapping, `${id}: 경험 연결 판정 누락`);
    const m = mapping.fields;
    for (const key of ['판정', 'claim', '연결 이유', '한계', '탐색 범위']) assert(m[key], `${id}: ${key} 누락`);
    assert(['직접', '전이', '부분', '미확인', '해당없음'].includes(m.판정), `${id}: 잘못된 연결 판정`);
    const claimIds = splitIds(m.claim);
    assert(new Set(claimIds).size === claimIds.length, `${id}: 중복 claim`);
    const selected = claimIds.map(claimId => {
      const c = claims.get(claimId);
      assert(c?.status === '검증됨', `${id}: ${claimId}는 검증된 claim이 아닙니다.`);
      return [claimId, c.claimHash, c.contextHash];
    });
    assert(!['직접', '전이', '부분'].includes(m.판정) || claimIds.length, `${id}: 연결 근거 claim이 필요합니다.`);
    assert(!['미확인', '해당없음'].includes(m.판정) || !claimIds.length, `${id}: 미확인/해당없음 claim은 없음으로 표시하세요.`);
    entries.push({ id, requirement: requirement.content, mapping: mapping.content, claimIds,
      decision: m.판정, hash: digest(JSON.stringify([requirement.content, mapping.content, selected])) });
  }
  return { version: 1, jdHash: digest(jd), contextHash: digest(analysis.context + '\n' + fit.context),
    analysisContext: analysis.context, fitContext: fit.context, entries,
    claimHashes: Object.fromEntries([...claims].map(([id, c]) => [id, digest(JSON.stringify([c.claimHash, c.contextHash, c.status]))])) };
}

export function compareMap(current, previous) {
  const old = new Map((previous?.entries ?? []).map(e => [e.id, e]));
  const changed = current.entries.filter(e => e.hash !== old.get(e.id)?.hash).map(e => e.id);
  const removed = [...old.keys()].filter(id => !current.entries.some(e => e.id === id));
  const candidateClaims = Object.keys(current.claimHashes).filter(id => current.claimHashes[id] !== previous?.claimHashes?.[id]);
  return { sourceReviewRequired: current.jdHash !== previous?.jdHash,
    contextReviewRequired: current.contextHash !== previous?.contextHash,
    changed, removed, candidateClaims,
    reusable: current.entries.filter(e => !changed.includes(e.id)).map(e => e.id) };
}

export function checkedMap(root, files, stateFile, claims) {
  const current = inspectMap(root, files, claims);
  assert(stateFile, '문장별 매칭 검토 기록 matchingState가 필요합니다.');
  const previous = JSON.parse(fs.readFileSync(localFile(root, stateFile), 'utf8'));
  const diff = compareMap(current, previous);
  assert(previous.version === 1 && previous.reviewedAt && !diff.sourceReviewRequired && !diff.contextReviewRequired
    && !diff.changed.length && !diff.removed.length, 'JD 매칭 입력이 변경됐습니다. check 결과의 해당 항목만 검토하고 record하세요.');
  return current;
}
