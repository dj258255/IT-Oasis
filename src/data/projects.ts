import fs from 'node:fs';
import path from 'node:path';

export interface LinkItem {
  label: string;
  labelEn: string;
  url: string;
}

export type LinkField = string | LinkItem[];

export interface Project {
  title: string;
  titleEn: string;
  description: string;
  descriptionEn: string;
  image: string;
  tags: string[];
  category: string;
  date: string;
  github: LinkField;
  website: LinkField;
  story: string;
  order?: number;
  /** true면 프로젝트 카드를 목록에서 숨긴다 (포스트의 draft와 같은 개념). */
  draft?: boolean;
}

const projDir = path.join(process.cwd(), 'src/data/projects');
const files = fs.existsSync(projDir)
  ? fs.readdirSync(projDir).filter(f => f.endsWith('.json'))
  : [];

export const projects: Project[] = files
  .map(file => JSON.parse(fs.readFileSync(path.join(projDir, file), 'utf-8')))
  .filter(data => !(data.draft ?? false))
  // 최신순(날짜 내림차순)으로 정렬한다. 날짜가 같으면 order를 보조 키로 쓴다.
  .sort((a, b) => {
    const diff = new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
    return diff !== 0 ? diff : (a.order ?? 999) - (b.order ?? 999);
  })
  .map(data => ({
    title: data.title || '',
    titleEn: data.titleEn || data.title || '',
    description: data.description || '',
    descriptionEn: data.descriptionEn || '',
    image: data.image || '',
    tags: data.tags || [],
    category: data.category || '',
    date: data.date ? new Date(data.date).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '',
    github: Array.isArray(data.github) ? data.github : (data.github || ''),
    website: Array.isArray(data.website) ? data.website : (data.website || ''),
    story: data.story || '',
    order: data.order ?? 999,
    draft: data.draft ?? false,
  }));
