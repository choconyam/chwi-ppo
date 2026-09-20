import fs from 'node:fs';
import path from 'node:path';
import { readClaims, readExperiences, checkExperiences, unresolvedProfileIds } from './lib/profile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const profile = path.join(root, 'profile', 'PROFILE.md');
const experienceDir = path.join(root, 'profile', 'experiences');

let claims;
try {
  claims = readClaims(root);
} catch (error) {
  console.error(`프로필 검증 실패: ${error.message}`);
  process.exit(1);
}

if (!fs.existsSync(profile)) {
  console.error('검증 실패: profile/PROFILE.md가 없습니다. intake를 먼저 실행하세요.');
  process.exit(1);
}

const files = fs.readdirSync(experienceDir)
  .filter((name) => name.endsWith('.md') && !name.startsWith('_'))
  .map((name) => path.join(experienceDir, name));

if (files.length === 0) {
  console.error('검증 실패: 등록된 경험 Markdown이 없습니다.');
  process.exit(1);
}

const contents = [profile, ...files].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const unresolved = [...claims.values()].filter(claim => claim.status === '확인 필요').length;
const claimIds = [...contents.matchAll(/^###\s+([A-Z][A-Z0-9-]*-\d{3,})\s*$/gm)].map((match) => match[1]);
const duplicates = claimIds.filter((id, index) => claimIds.indexOf(id) !== index);

if (duplicates.length > 0) {
  console.error(`검증 실패: 중복 claim-id ${[...new Set(duplicates)].join(', ')}`);
  process.exit(1);
}

// experience-v2 표시가 있는 경험에만 강화된 구조 검사를 적용한다.
const experiences = readExperiences(root);
const structureErrors = checkExperiences(root, claims, experiences);
if (structureErrors.length > 0) {
  console.error(`검증 실패: experience-v2 구조 오류 ${structureErrors.length}건`);
  console.error(structureErrors.join('\n'));
  process.exit(1);
}

const upgraded = [...experiences.values()].filter((meta) => meta.version === 2).length;
console.log(`프로필 검증: 경험 ${files.length}건, claim ${claims.size}건, 확인 필요 claim ${unresolved}건, experience-v2 ${upgraded}건`);
const unresolvedIds = unresolvedProfileIds(root, claims);
if (unresolvedIds.length > 0) {
  console.log(`주의: PROFILE.md 문장에 인용됐지만 claim 블록이 없는 ID ${unresolvedIds.length}개 — ${unresolvedIds.join(', ')}`);
  console.log('      이 ID는 catalog에 나오지 않고 문항·JD 매칭에 배정할 수 없습니다. 사실·근거·상태를 갖춘 claim 블록으로 옮기세요.');
}
console.log('구조 검사만 통과했습니다. 의미상 완전성·본인 기여 충분성·직무 적합성은 사람이 확인합니다.');
