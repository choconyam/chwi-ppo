import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const claimPattern = /^[A-Z][A-Z0-9-]*-\d{3,}$/;

export function readClaims(root) {
  const profileFile = path.join(root, 'profile', 'PROFILE.md');
  const experienceDir = path.join(root, 'profile', 'experiences');
  if (!fs.existsSync(profileFile)) throw new Error('profile/PROFILE.md가 없습니다. intake가 필요합니다.');
  const files = [profileFile, ...fs.readdirSync(experienceDir)
    .filter(name => name.endsWith('.md') && !name.startsWith('_'))
    .sort().map(name => path.join(experienceDir, name))];
  const claims = new Map();
  const errors = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    const matches = [...content.matchAll(/^###\s+([A-Z][A-Z0-9-]*-\d{3,})\s*\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/gm)];
    for (const match of matches) {
      const field = key => match[2].match(new RegExp(`^- ${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
      const claim = { id: match[1], fact: field('사실'), evidence: field('근거'), status: field('상태'),
        file: path.relative(root, file).replaceAll('\\', '/'), line: content.slice(0, match.index).split('\n').length,
        sourceHash: digest(content),
        cautions: [
          ...content.matchAll(/^- (?:본인 역할|현재 상태):.*$/gm),
        ].map(m => m[0]).join('\n') + '\n' + (content.match(/^## 사용하면 안 되는 표현\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim() ?? '') };
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
