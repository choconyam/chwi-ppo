import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const codexRoot = path.join(root, '.agents', 'skills');
const claudeRoot = path.join(root, '.claude', 'skills');

const names = fs.readdirSync(codexRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const errors = [];
for (const name of names) {
  const codexFile = path.join(codexRoot, name, 'SKILL.md');
  const claudeFile = path.join(claudeRoot, name, 'SKILL.md');
  if (!fs.existsSync(claudeFile)) {
    errors.push(`${name}: Claude Code 스킬 누락`);
    continue;
  }
  const codexContent = fs.readFileSync(codexFile, 'utf8').replaceAll('\r\n', '\n');
  const claudeContent = fs.readFileSync(claudeFile, 'utf8').replaceAll('\r\n', '\n');
  if (codexContent !== claudeContent) errors.push(`${name}: Codex·Claude Code 스킬 내용 불일치`);
}

const extras = fs.readdirSync(claudeRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !names.includes(entry.name))
  .map((entry) => entry.name);
for (const name of extras) errors.push(`${name}: Claude Code에만 존재하는 스킬`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`스킬 동기화 확인: ${names.length}개, 불일치 0건`);
