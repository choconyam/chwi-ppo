import fs from 'node:fs';
import path from 'node:path';

// 사용법: node scripts/bump-version.mjs <새 버전>
// VERSION, package.json, dashboard/package.json, dashboard/package-lock.json, README 배지의 버전을 한 번에 바꾼다.

const root = path.resolve(import.meta.dirname, '..');
const next = (process.argv[2] ?? '').trim().replace(/^v/, '');

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('버전 형식이 잘못됐습니다. 예: 1.0.1');
  process.exit(1);
}

const versionPath = path.join(root, 'VERSION');
const current = fs.readFileSync(versionPath, 'utf8').trim().replace(/^v/, '');

const toTuple = (v) => v.split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [toTuple(a), toTuple(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

if (!newer(next, current)) {
  console.error(`새 버전 ${next}은(는) 현재 버전 ${current}보다 커야 합니다.`);
  process.exit(1);
}

const writeText = (file, text) => fs.writeFileSync(file, text, 'utf8');

const editJson = (rel, mutate) => {
  const file = path.join(root, rel);
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  mutate(data);
  const eol = raw.endsWith('\n') ? '\n' : '';
  writeText(file, JSON.stringify(data, null, 2) + eol);
  console.log(`갱신: ${rel}`);
};

writeText(versionPath, `${next}\n`);
console.log('갱신: VERSION');

editJson('package.json', (d) => { d.version = next; });
editJson('dashboard/package.json', (d) => { d.version = next; });
editJson('dashboard/package-lock.json', (d) => {
  d.version = next;
  if (d.packages && d.packages['']) d.packages[''].version = next;
});

const readmePath = path.join(root, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const badge = /(img\.shields\.io\/badge\/version-v)\d+\.\d+\.\d+(-blue)/;
if (!badge.test(readme)) {
  console.error('README.md에서 버전 배지를 찾지 못했습니다.');
  process.exit(1);
}
writeText(readmePath, readme.replace(badge, `$1${next}$2`));
console.log('갱신: README.md 배지');

console.log(`버전 ${current} → ${next}`);
