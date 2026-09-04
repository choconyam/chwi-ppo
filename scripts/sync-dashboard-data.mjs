import fs from 'node:fs';
import path from 'node:path';

import { readRegistry, validateRegistry } from './lib/opportunities.mjs';

const root = path.resolve(import.meta.dirname, '..');
const actual = path.join(root, 'data', 'opportunities.json');
const example = path.join(root, 'data', 'opportunities.example.json');
const source = fs.existsSync(actual) ? actual : example;
const destination = path.join(root, 'dashboard', 'public', 'opportunities.json');
const { value } = readRegistry(source);
const errors = validateRegistry(value);

if (errors.length > 0) {
  console.error('캘린더 동기화 중단: 공고 데이터 검증 실패');
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
console.log(`캘린더 데이터 동기화: ${path.relative(root, source)} → ${path.relative(root, destination)}`);
