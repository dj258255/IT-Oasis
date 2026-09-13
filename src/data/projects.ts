import fs from 'node:fs';
import path from 'node:path';

export interface LinkItem {
  label: string;
  url: string;
}

export type LinkField = string | LinkItem[];
export type ProjectType = 'team' | 'side' | 'toy';

export interface Project {
  title: string;
  description: string;
  image: string;
  tags: string[];
  category: string;
  /** 프로젝트 목록에서 사용할 노출 분류. 블로그 카테고리와는 별도로 관리한다. */
  projectType: ProjectType;
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
  .map(file => {
    const data = JSON.parse(fs.readFileSync(path.join(projDir, file), 'utf-8'));
    return {
      ...data,
      // 프로젝트 데이터에 노출 분류가 없으면 기존 team/personal/study 카테고리를
      // 포트폴리오 노출 기준에 맞춰 team/side로 정리한다.
      projectType: data.projectType
        || (data.category === 'team' ? 'team' : 'side'),
    };
  })
  .filter(data => !(data.draft ?? false))
  // 최신순(날짜 내림차순)으로 정렬한다. 날짜가 같으면 order를 보조 키로 쓴다.
  .sort((a, b) => {
    const diff = new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
    return diff !== 0 ? diff : (a.order ?? 999) - (b.order ?? 999);
  })
  .map(data => ({
    title: data.title || '',
    description: data.description || '',
    image: data.image || '',
    tags: data.tags || [],
    category: data.category || '',
    projectType: data.projectType as ProjectType,
    date: data.date ? new Date(data.date).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '',
    github: Array.isArray(data.github) ? data.github : (data.github || ''),
    website: Array.isArray(data.website) ? data.website : (data.website || ''),
    story: data.story || '',
    order: data.order ?? 999,
    draft: data.draft ?? false,
  }));

export const projectTypeLabels: Record<ProjectType, string> = {
  team: '팀 프로젝트',
  side: '사이드 프로젝트',
  toy: '토이 프로젝트',
};
