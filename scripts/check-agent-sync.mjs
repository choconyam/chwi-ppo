import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const claudeRoot = path.join(root, '.claude', 'agents');
const codexRoot = path.join(root, '.codex', 'agents');

const markdownFiles = fs.readdirSync(claudeRoot)
  .filter((name) => name.endsWith('.md'))
  .sort();
const tomlFiles = fs.readdirSync(codexRoot)
  .filter((name) => name.endsWith('.toml'))
  .sort();

const expected = markdownFiles.map((name) => name.replace(/\.md$/, ''));
const actual = tomlFiles.map((name) => name.replace(/\.toml$/, ''));
const errors = [];

for (const name of expected.filter((item) => !actual.includes(item))) {
  errors.push(`${name}: Codex 에이전트 누락`);
}
for (const name of actual.filter((item) => !expected.includes(item))) {
  errors.push(`${name}: Codex에만 존재하는 에이전트`);
}

function frontmatterValue(frontmatter, key) {
  return frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
}

function tomlValue(toml, key) {
  return toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"$`, 'm'))?.[1];
}

for (const name of expected.filter((item) => actual.includes(item))) {
  const markdown = fs.readFileSync(path.join(claudeRoot, `${name}.md`), 'utf8').replaceAll('\r\n', '\n');
  const toml = fs.readFileSync(path.join(codexRoot, `${name}.toml`), 'utf8').replaceAll('\r\n', '\n');
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    errors.push(`${name}: Claude 에이전트 frontmatter 파싱 실패`);
    continue;
  }

  const [, frontmatter, body] = match;
  const comparisons = [
    ['name', frontmatterValue(frontmatter, 'name')],
    ['description', frontmatterValue(frontmatter, 'description')],
    ['model', frontmatterValue(frontmatter, 'codex-model')],
    ['model_reasoning_effort', frontmatterValue(frontmatter, 'codex-reasoning')],
  ];
  for (const [key, wanted] of comparisons) {
    if (!wanted || tomlValue(toml, key) !== wanted) {
      errors.push(`${name}: ${key} 불일치`);
    }
  }
  if (!toml.includes(body.trim())) {
    errors.push(`${name}: 역할 본문 불일치`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`에이전트 동기화 확인: ${expected.length}개, 불일치 0건`);
