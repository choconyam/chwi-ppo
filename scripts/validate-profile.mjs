import fs from 'node:fs';
import path from 'node:path';
import { readClaims } from './lib/profile.mjs';

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
const claimIds = [...contents.matchAll(/^###\s+([A-Z0-9]+-[0-9]{3})\s*$/gm)].map((match) => match[1]);
const duplicates = claimIds.filter((id, index) => claimIds.indexOf(id) !== index);

if (duplicates.length > 0) {
  console.error(`검증 실패: 중복 claim-id ${[...new Set(duplicates)].join(', ')}`);
  process.exit(1);
}

console.log(`프로필 검증: 경험 ${files.length}건, claim ${claims.size}건, 확인 필요 claim ${unresolved}건`);
