import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dashboard', 'dist');
const sourceFile = path.join(dist, 'index.html');
const outputFile = path.join(root, 'dashboard', 'standalone-shell.html');

let html = fs.readFileSync(sourceFile, 'utf8').replace(/\r\n?/g, '\n');

const scriptMatch = html.match(/<script\s+type="module"[^>]*src="([^"]+)"[^>]*><\/script>/);
const styleMatch = html.match(/<link\s+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);

if (!scriptMatch || !styleMatch) {
  throw new Error('Vite 산출물의 script 또는 stylesheet를 찾지 못했습니다.');
}

const assetPath = (url) => path.join(dist, url.replace(/^\//, ''));
const script = fs.readFileSync(assetPath(scriptMatch[1]), 'utf8').replaceAll('</script>', '<\\/script>');
const style = fs.readFileSync(assetPath(styleMatch[1]), 'utf8');

html = html
  // 함수형 replacer를 사용해야 번들 안의 `$&`, `$1` 같은 문자열이
  // String.replace의 치환 토큰으로 다시 해석되지 않는다.
  // type="module"도 유지해야 head 안의 번들이 문서 파싱 후 실행된다.
  .replace(scriptMatch[0], () => `<script type="module">${script}</script>`)
  .replace(styleMatch[0], () => `<style>${style}</style>`);

if ((html.match(/<!doctype html>/gi) ?? []).length !== 1) {
  throw new Error('독립 실행 HTML 안에 문서 본문이 중복 삽입되었습니다.');
}

if (!/<script[^>]*id="opportunity-data"[^>]*><\/script>/.test(html)) {
  throw new Error('opportunity-data 삽입 위치를 찾지 못했습니다.');
}

fs.writeFileSync(outputFile, html, 'utf8');
console.log(`독립 실행 HTML 셸 생성: ${path.relative(root, outputFile)}`);
