/**
 * 카테고리 JSON 기반으로 src/content/blog/ 하위 폴더를 자동 생성합니다.
 * 빈 폴더에는 .gitkeep을 추가하여 Git이 추적하도록 합니다.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync as readdir } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const BLOG_DIR = join(ROOT, 'src/content/blog');
const CAT_DIR = join(ROOT, 'src/data/categories');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function ensureGitkeep(dir) {
  ensureDir(dir);
  const gitkeep = join(dir, '.gitkeep');
  const files = readdirSync(dir).filter(f => f !== '.gitkeep');
  if (files.length === 0 && !existsSync(gitkeep)) {
    writeFileSync(gitkeep, '');
    console.log(`  + .gitkeep → ${dir.replace(ROOT + '/', '')}`);
  }
}

const catFiles = readdirSync(CAT_DIR).filter(f => f.endsWith('.json'));

for (const file of catFiles) {
  const data = JSON.parse(readFileSync(join(CAT_DIR, file), 'utf-8'));
  const parentDir = join(BLOG_DIR, data.name);

  if (data.subcategories?.length > 0) {
    ensureDir(parentDir);
    for (const sub of data.subcategories) {
      ensureGitkeep(join(parentDir, sub.name));
    }
  } else {
    ensureGitkeep(parentDir);
  }
}

console.log('Blog folder sync complete.');
