import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const coveragePath = path.resolve(root, process.argv[2] ?? '.work/discover/coverage.json');
const watchlistPath = path.resolve(root, process.argv[3] ?? 'data/company-watchlist.json');
const allowedStatuses = new Set(['candidates-found', 'no-fit-opening', 'no-open-posting', 'access-failed']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const watchlist = readJson(watchlistPath);
const coverage = readJson(coveragePath);
const expected = [...new Set((watchlist.groups ?? []).flatMap((group) => group.companies ?? []))];
const rows = Array.isArray(coverage.companies) ? coverage.companies : [];
const errors = [];

if (!coverage.checkedAt) errors.push('coverage.checkedAt이 없습니다.');

const seen = new Set();
for (const row of rows) {
  if (!row?.company) {
    errors.push('회사명이 없는 coverage 항목이 있습니다.');
    continue;
  }
  if (seen.has(row.company)) errors.push(`${row.company}: coverage 중복`);
  seen.add(row.company);
  if (!allowedStatuses.has(row.status)) errors.push(`${row.company}: 허용되지 않은 상태 ${row.status}`);
  if (!row.officialCareersUrl) errors.push(`${row.company}: 공식 채용 사이트 URL 누락`);
  if (!row.checkedAt) errors.push(`${row.company}: 확인 시각 누락`);
}

for (const company of expected) {
  if (!seen.has(company)) errors.push(`${company}: 검색 결과 누락`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`공고 탐색 범위 검증 통과: ${expected.length}개 회사, 누락 0개`);
