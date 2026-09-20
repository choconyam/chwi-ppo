import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const claimPattern = /^[A-Z][A-Z0-9-]*-\d{3,}$/;

// experience-v2는 opt-in 표시다. 표시가 없는 기존 경험에는 추가 구조를 요구하지 않는다.
export const experienceMarker = '- 경험 형식: experience-v2';
export const experienceTypes = ['업무', '연구', '프로젝트', '수업', '자격', '활동'];
// 서사형만 문제-행동 구조를 요구한다. 자격·수업·활동에는 강요하지 않는다.
export const narrativeTypes = ['업무', '연구', '프로젝트'];
export const claimTypes = ['문제', '판단', '행동', '산출물', '결과', '협업', '역량', '한계'];
export const narrativeSections = ['문제와 목표', '본인의 판단과 행동'];
export const cautionHeadings = ['사용하면 안 되는 표현', '사용 시 주의'];

const claimBlocks = () => /^###\s+([A-Z][A-Z0-9-]*-\d{3,})\s*\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/gm;
const sectionBlocks = () => /^##\s+(.+?)[ \t]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm;
const normalize = value => value.replaceAll('\r\n', '\n');
// 값은 같은 줄에서만 시작한다(빈 값이 다음 필드를 삼키지 않게). 들여쓴 이어지는 줄은 한 값으로 합친다.
const fieldOf = (text, key) => {
  const match = text.match(new RegExp(`^- ${key}:[ \\t]*(.*(?:\\n[ \\t]+(?!- ).+)*)$`, 'm'));
  return match?.[1]?.replace(/\s*\n\s*/g, ' ').trim() || undefined;
};

export function parseExperience(content) {
  const text = normalize(content);
  // 머리 정보는 첫 소제목(## 또는 ### claim) 앞까지다.
  const header = text.split(/^#{2,3}\s/m)[0];
  const sections = new Map();
  for (const match of text.matchAll(sectionBlocks())) sections.set(match[1].trim(), match[2]);
  const cautionHeading = cautionHeadings.find(name => sections.has(name));
  // 검증된 사실 절은 claim 자체이므로 경험 단위 검색 문맥에서 제외한다.
  const narrative = [...sections].filter(([name]) => name !== '검증된 사실')
    .map(([name, body]) => `${name}\n${body}`).join('\n');
  return {
    // 머리 정보의 독립된 줄일 때만 opt-in이다. 본문 산문에 같은 문자열이 있어도 v2로 보지 않는다.
    version: header.split('\n').some(line => line.trim() === experienceMarker) ? 2 : 1,
    title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '',
    type: fieldOf(header, '경험 유형'),
    period: fieldOf(header, '기간'),
    role: fieldOf(header, '본인 역할'),
    state: fieldOf(header, '현재 상태'),
    sections,
    cautionHeading,
    // 표현 제한은 기존 형식과 동일하게 유지하되 절 제목의 표기 차이를 함께 인식한다.
    cautions: [...text.matchAll(/^- (?:본인 역할|현재 상태):.*$/gm)].map(m => m[0]).join('\n')
      + '\n' + (cautionHeading ? sections.get(cautionHeading).trim() : ''),
    searchText: `${header}\n${narrative}`,
  };
}

function experienceFiles(root) {
  const profileFile = path.join(root, 'profile', 'PROFILE.md');
  const experienceDir = path.join(root, 'profile', 'experiences');
  return [
    ...(fs.existsSync(profileFile) ? [profileFile] : []),
    ...(fs.existsSync(experienceDir) ? fs.readdirSync(experienceDir)
      .filter(name => name.endsWith('.md') && !name.startsWith('_'))
      .sort().map(name => path.join(experienceDir, name)) : []),
  ];
}

const relativePath = (root, file) => path.relative(root, file).split(path.sep).join('/');

export function readExperiences(root) {
  const experiences = new Map();
  for (const file of experienceFiles(root)) {
    experiences.set(relativePath(root, file), parseExperience(fs.readFileSync(file, 'utf8')));
  }
  return experiences;
}

export function readClaims(root) {
  const profileFile = path.join(root, 'profile', 'PROFILE.md');
  if (!fs.existsSync(profileFile)) throw new Error('profile/PROFILE.md가 없습니다. intake가 필요합니다.');
  const claims = new Map();
  const errors = [];
  for (const file of experienceFiles(root)) {
    const content = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    const blocks = claimBlocks();
    const matches = [...content.matchAll(blocks)];
    // Preserve shared context/constraints, but do not invalidate other claims when one changes.
    const contextHash = digest(content.replace(blocks, '').trim());
    const experience = parseExperience(content);
    for (const match of matches) {
      const field = key => fieldOf(match[2], key);
      // v2 추가 필드는 값이 없으면 직렬화에서 빠지므로 기존 문항 입력 해시를 바꾸지 않는다.
      const claim = { id: match[1], fact: field('사실'), evidence: field('근거'), status: field('상태'),
        type: field('유형'), contribution: field('본인 기여'), method: field('방법·도구'), outcome: field('결과·상태'),
        file: relativePath(root, file), line: content.slice(0, match.index).split('\n').length,
        sourceHash: digest(content),
        claimHash: digest(match[2].trim()), contextHash,
        cautions: experience.cautions };
      if (claims.has(claim.id)) errors.push(`중복 claim-id: ${claim.id}`);
      if (!claim.fact || !claim.evidence || !['검증됨', '확인 필요', '사용 금지'].includes(claim.status)) {
        errors.push(`${claim.id}: 사실·근거·상태를 확인하세요.`);
      }
      claims.set(claim.id, claim);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  if (!claims.size) throw new Error('구조화된 claim이 없습니다. 기존 Markdown을 intake에서 연결하세요.');
  return claims;
}

// 구조만 검사한다. 의미상 완전성·기여도·인과관계·JD 적합성은 판정하지 않는다.
export function checkExperiences(root, claims = readClaims(root), experiences = readExperiences(root)) {
  const errors = [];
  for (const [file, meta] of experiences) {
    if (meta.version !== 2) continue;
    if (!meta.type) errors.push(`${file}: 경험 유형 누락 (${experienceTypes.join(' | ')})`);
    else if (!experienceTypes.includes(meta.type)) errors.push(`${file}: 잘못된 경험 유형 ${meta.type}`);
    if (!meta.state) errors.push(`${file}: 현재 상태 누락`);
    if (!meta.sections.has('원자료')) errors.push(`${file}: 원자료 절 누락`);
    if (narrativeTypes.includes(meta.type)) {
      if (!meta.role) errors.push(`${file}: 본인 역할 누락`);
      for (const name of narrativeSections) {
        if (!meta.sections.has(name)) errors.push(`${file}: ${name} 절 누락`);
      }
      if (!meta.cautionHeading) errors.push(`${file}: 표현 제한 절 누락 (${cautionHeadings.join(' 또는 ')})`);
    }
    const fileClaims = [...claims.values()].filter(c => c.file === file);
    if (!fileClaims.length) errors.push(`${file}: 검증된 사실에 claim이 없습니다.`);
    // 상태 문장 속 단어가 아니라 현재 상태 칸 자체가 미정일 때만 구조적 모순으로 본다.
    const stateUnresolved = /^\[?확인 필요/.test(meta.state ?? '');
    for (const claim of fileClaims) {
      if (!claim.type) errors.push(`${claim.id}: claim 유형 누락 (${claimTypes.join(' | ')})`);
      else if (!claimTypes.includes(claim.type)) errors.push(`${claim.id}: 잘못된 claim 유형 ${claim.type}`);
      if (claim.type === '결과' && !claim.outcome) errors.push(`${claim.id}: 결과 claim에 결과·상태가 없습니다.`);
      if (claim.type === '결과' && claim.status === '검증됨' && stateUnresolved) {
        errors.push(`${claim.id}: 현재 상태가 확인 필요인데 결과 claim이 검증됨입니다.`);
      }
    }
  }
  return errors;
}
