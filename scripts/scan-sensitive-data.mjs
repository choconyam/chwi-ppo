import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const publicTargets = [
  'AGENTS.md', 'CLAUDE.md', 'README.md', 'LICENSE.md', 'LICENSE_KO.md', 'NOTICE.md', 'assets', '.gitignore', 'package.json',
  'VERSION', 'run-dashboard.cmd', 'run-dashboard-dev.cmd', 'update-chwi-ppo.cmd',
  'docs', '.agents', '.claude', '.codex', 'schemas', 'scripts', 'data/opportunities.example.json',
  'profile/README.md', 'profile/PROFILE_TEMPLATE.md',
  'profile/experiences/_EXPERIENCE_TEMPLATE.md', 'companies/README.md',
  'companies/_템플릿', 'dashboard/src', 'dashboard/index.html', 'dashboard/package.json',
  'dashboard/package-lock.json', 'dashboard/tsconfig.json', 'dashboard/vite.config.ts',
  'dashboard/standalone-shell.html',
];
const textExtensions = new Set(['.md', '.json', '.mjs', '.js', '.ts', '.tsx', '.css', '.html', '.yml', '.yaml', '.ps1', '.cmd', '.toml']);
const patterns = [
  ['이메일', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  ['휴대전화', /01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/g],
  ['주민등록번호 형태', /\b\d{6}[-\s]?[1-4]\d{6}\b/g],
];

function collect(target) {
  const absolute = path.join(root, target);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'public'].includes(entry.name)) return [];
    return collect(path.relative(root, path.join(absolute, entry.name)));
  });
}

const findings = [];
for (const file of publicTargets.flatMap(collect)) {
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern) ?? [];
    for (const match of matches) {
      if (match.endsWith('@example.com')) continue;
      findings.push(`${path.relative(root, file)}: ${label} 의심 값 ${match}`);
    }
  }
}

if (findings.length > 0) {
  console.error('공개 대상에서 민감정보 의심 값이 발견되었습니다.');
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}

console.log('공개 대상 민감정보 패턴 검사 통과');
