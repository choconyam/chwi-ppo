import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const limit = process.argv[3] ? Number(process.argv[3]) : null;

if (!file || !fs.existsSync(path.resolve(file))) {
  console.error('사용법: node scripts/check-submission.mjs <지원서.md> [글자수 제한]');
  process.exit(1);
}

const content = fs.readFileSync(path.resolve(file), 'utf8');
const blocks = [...content.matchAll(/```text\r?\n([\s\S]*?)```/g)];
const errors = [];

if (blocks.length !== 1) errors.push(`text 코드 블록은 정확히 1개여야 합니다. 현재 ${blocks.length}개`);
const body = (blocks[0]?.[1] ?? '').replace(/\r\n/g, '\n').trimEnd();
if (!body) errors.push('제출용 본문이 비어 있습니다.');
if (/\[확인 필요|<회사명>|<직무명>|TODO|TBD/.test(body)) errors.push('본문에 미완성 placeholder가 있습니다.');
if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) errors.push('글자수 제한은 양수여야 합니다.');
if (limit !== null && body.length > limit) errors.push(`글자수 초과: ${body.length}/${limit}`);

if (errors.length > 0) {
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(`지원서 형식 통과: ${body.length}${limit ? `/${limit}` : ''}자`);
