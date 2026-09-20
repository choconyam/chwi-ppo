import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMap, compareMap, localFile } from './lib/jd-map.mjs';

export function runMap(root, command, options) {
  if (!['check', 'record'].includes(command)) throw new Error('사용법: jd-map.mjs check|record --jd <MD> --analysis <MD> --fit <MD> --state <JSON> [--root <경로>]');
  const current = inspectMap(root, options);
  const state = localFile(root, options.state);
  const stateRelative = path.relative(root, state).replaceAll('\\', '/');
  if (!stateRelative.startsWith('.work/') || !stateRelative.endsWith('.json')) throw new Error('state는 .work/ 아래 JSON이어야 합니다.');
  if (Object.values({ jd: options.jd, analysis: options.analysis, fit: options.fit }).some(file => localFile(root, file) === state)) throw new Error('state가 입력 파일과 같습니다.');
  const previous = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : null;
  const diff = compareMap(current, previous);
  if (command === 'record') {
    if (options.reviewed !== 'yes') throw new Error('원문 분해·변경 항목을 검토한 뒤 record --reviewed yes로 기록하세요.');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    // A receipt of the caller's review, never an automatic semantic PASS.
    fs.writeFileSync(state, JSON.stringify({ ...current, reviewedAt: new Date().toISOString() }, null, 2) + '\n');
  }
  return { command, requirements: current.entries.length, ...diff,
    note: '구조 검사와 변경 비교입니다. 원문 분해의 완전성·매칭 타당성·지원 자격 PASS를 판정하지 않습니다.' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!args[i].startsWith('--') || !args[i + 1]) throw new Error('옵션에는 값이 필요합니다.');
      options[args[i].slice(2)] = args[i + 1];
    }
    console.log(JSON.stringify(runMap(path.resolve(options.root ?? path.join(import.meta.dirname, '..')), command, options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
