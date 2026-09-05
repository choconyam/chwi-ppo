import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readClaims } from './lib/profile.mjs';

const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
function localPath(root, relative) {
  assert(typeof relative === 'string' && relative, '파일 경로가 필요합니다.');
  const file = path.resolve(root, relative);
  const rel = path.relative(root, file);
  assert(rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel), '파일은 작업공간 내부여야 합니다.');
  return file;
}

export function buildPacket(root, request) {
  assert(request.version === 1, '요청 version은 1이어야 합니다.');
  assert(request.official?.status === 'verified' && /^https:\/\//.test(request.official.url ?? ''), '공식 JD 확인이 필요합니다.');
  assert(Number.isFinite(Date.parse(request.official.checkedAt)), '공식 확인 시각이 필요합니다.');
  assert(request.eligibility?.status === 'eligible', '지원 자격 확인 또는 충족이 필요합니다.');
  assert(['proceed', 'caution'].includes(request.fit?.decision), '직무 선택 또는 적합성 재검토가 필요합니다.');
  const documents = ['jd', 'analysis', 'fit'].map(key => {
    const relative = request.documents?.[key];
    const content = fs.readFileSync(localPath(root, relative), 'utf8');
    assert(content.trim(), `${key} 문서가 비어 있습니다.`);
    return { key, file: relative, content, hash: digest(content) };
  });
  const claims = readClaims(root);
  assert(Array.isArray(request.questions) && request.questions.length, '공식 문항이 필요합니다.');
  const ids = new Set();
  const questions = [];
  const blockedQuestions = [];
  for (const question of request.questions) {
    assert(/^[a-zA-Z0-9_-]+$/.test(question.id ?? '') && !ids.has(question.id), '문항 ID가 없거나 중복됩니다.');
    ids.add(question.id);
    try {
    assert(question.prompt?.trim() && question.source?.trim(), `${question.id}: 문항 원문·확인 위치가 필요합니다.`);
    assert(Number.isInteger(question.limit) && question.limit > 0, `${question.id}: 글자수 제한 확인 필요`);
    assert(Array.isArray(question.claimIds) && question.claimIds.length, `${question.id}: 소재 갭 — 필요한 경험만 intake 갱신`);
    const selected = [...new Set(question.claimIds)].map(id => {
      const claim = claims.get(id);
      assert(claim?.status === '검증됨', `${question.id}: ${id}는 검증된 claim이 아닙니다.`);
      return claim;
    });
    const inputHash = digest(JSON.stringify({ question, claims: selected, documents: documents.map(d => d.hash),
      official: { status: request.official.status, url: request.official.url }, eligibility: request.eligibility, fit: request.fit, format: request.format ?? '' }));
      questions.push({ ...question, claims: selected, inputHash });
    } catch (error) {
      blockedQuestions.push({ id: question.id, action: 'blocked', reason: error.message });
    }
  }
  assert(questions.length, blockedQuestions.map(q => q.reason).join('\n'));
  return { version: 1, documents, questions, blockedQuestions };
}

export function validateDraft(content, question) {
  const blocks = [...content.matchAll(/```text\r?\n([\s\S]*?)```/g)];
  assert(blocks.length === 1, '제출 본문 text 블록은 하나여야 합니다.');
  const body = blocks[0][1].replaceAll('\r\n', '\n').trimEnd();
  assert(body.length && body.length <= question.limit, `글자수 오류: ${body.length}/${question.limit}`);
  assert(!/\[확인 필요|TODO|TBD|<회사명>|<직무명>/.test(body), '본문에 미완성 항목이 있습니다.');
  const tracking = content.replace(blocks[0][0], '');
  const references = [...new Set(tracking.match(/\b[A-Z][A-Z0-9-]*-\d{3,}\b/g) ?? [])];
  assert(references.length, '본문 아래에 claim 추적표가 필요합니다.');
  assert(references.every(id => question.claimIds.includes(id)), '배정되지 않은 claim이 인용되었습니다.');
  return { characters: body.length, references };
}

function reusable(root, question, cached) {
  if (cached?.inputHash !== question.inputHash || cached.review?.status !== 'PASS') return false;
  try {
    const draft = fs.readFileSync(localPath(root, cached.review.draft), 'utf8');
    const report = fs.readFileSync(localPath(root, cached.review.report), 'utf8');
    return digest(draft) === cached.review.draftHash && digest(report) === cached.review.reportHash;
  } catch { return false; }
}

export function prepare(root, requestFile, outputFile, previousFile) {
  const request = json(requestFile);
  const packet = buildPacket(root, request);
  const previous = previousFile && fs.existsSync(previousFile) ? json(previousFile) : null;
  packet.requestFile = path.relative(root, requestFile).replaceAll('\\', '/');
  for (const question of packet.questions) {
    const cached = previous?.questions?.find(q => q.id === question.id);
    question.action = reusable(root, question, cached) ? 'reuse' : 'draft';
    if (question.action === 'reuse') question.review = cached.review;
  }
  write(outputFile, `${JSON.stringify(packet, null, 2)}\n`);
  const markdown = ['# 지원서 작성 입력', '', '이 자료에는 배정된 검증 사실만 포함합니다. 원자료 재수집은 필요하지 않습니다.', '',
    ...packet.blockedQuestions.map(q => `- ${q.id} 보류: ${q.reason}`), '',
    ...packet.documents.flatMap(doc => [`## ${doc.key}: ${doc.file}`, '', doc.content, '']),
    ...packet.questions.flatMap(q => [`## ${q.id}: ${q.action === 'reuse' ? '검수 통과본 재사용' : '작성·검수 필요'}`, '',
      `- 문항: ${q.prompt}`, `- 원문 위치: ${q.source}`, `- 제한: ${q.limit}자`, `- 입력 해시: ${q.inputHash}`, '',
      ...(q.instructions ? [`- 작성 요청: ${q.instructions}`, ''] : []),
      ...q.claims.flatMap(c => [`### ${c.id}`, `- 사실: ${c.fact}`, `- 근거: ${c.evidence}`, `- 정본: ${c.file}:${c.line}`, `- 표현 범위 참고(새 주장으로 사용하지 않음):\n${c.cautions}`, ''])])].join('\n');
  write(outputFile.replace(/\.json$/, '') + '.md', markdown);
  return packet;
}

export function recordReview(root, packetFile, questionId, draftRelative, reportRelative) {
  const packet = json(packetFile);
  const question = packet.questions.find(q => q.id === questionId);
  assert(question, '해당 문항이 없습니다.');
  const current = buildPacket(root, json(localPath(root, packet.requestFile))).questions.find(q => q.id === questionId);
  assert(current?.inputHash === question.inputHash, '입력 근거가 변경되었습니다. prepare를 다시 실행하세요.');
  const draft = fs.readFileSync(localPath(root, draftRelative), 'utf8');
  const report = fs.readFileSync(localPath(root, reportRelative), 'utf8');
  validateDraft(draft, question);
  const draftHash = digest(draft);
  const field = name => report.match(new RegExp(`^- ${name}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  assert(field('판정') === 'PASS', '검수가 PASS가 아닙니다.');
  assert(field('입력 해시') === question.inputHash && field('본문 해시') === draftHash, '검수가 현재 입력·본문과 일치하지 않습니다.');
  question.review = { status: 'PASS', draft: draftRelative, report: reportRelative, draftHash, reportHash: digest(report) };
  question.action = 'reuse';
  write(packetFile, `${JSON.stringify(packet, null, 2)}\n`);
  return question;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(args[i]?.startsWith('--') && args[i + 1], '옵션에는 값이 필요합니다.');
    options[args[i].slice(2)] = args[i + 1];
  }
  const root = path.resolve(options.root ?? path.join(import.meta.dirname, '..'));
  if (command === 'catalog') {
    const claims = [...readClaims(root).values()].filter(c => c.status === '검증됨');
    const content = ['# 검증된 경험 요약', '', ...claims.map(c => `- ${c.id}: ${c.fact} (${c.file}:${c.line})`)].join('\n');
    write(localPath(root, options.out), content + '\n');
    console.log(`검증된 claim ${claims.length}개를 요약했습니다.`);
  } else if (command === 'prepare') {
    const packet = prepare(root, localPath(root, options.request), localPath(root, options.out), options.previous && localPath(root, options.previous));
    console.log(`진행 문항 ${packet.questions.length}개: 재사용 ${packet.questions.filter(q => q.action === 'reuse').length}, 작성·검수 ${packet.questions.filter(q => q.action === 'draft').length}, 보류 ${packet.blockedQuestions.length}`);
  } else if (command === 'record') {
    recordReview(root, localPath(root, options.packet), options.question, options.draft, options.review);
    console.log('현재 입력·본문에 대한 검수 PASS를 기록했습니다. 최종 검수는 별도입니다.');
  } else if (command === 'hash') {
    console.log(digest(fs.readFileSync(localPath(root, options.file), 'utf8')));
  } else throw new Error('사용법: apply-packet.mjs catalog | prepare | record | hash (docs/WORKFLOW_RUNTIME.md 참조)');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
