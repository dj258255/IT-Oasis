import fs from 'node:fs';
import path from 'node:path';

export interface Project {
  title: string;
  titleEn: string;
  description: string;
  descriptionEn: string;
  image: string;
  tags: string[];
  category: string;
  date: string;
  github: string;
  website: string;
  story: string;
  order?: number;
}

const projDir = path.join(process.cwd(), 'src/data/projects');
const files = fs.existsSync(projDir)
  ? fs.readdirSync(projDir).filter(f => f.endsWith('.json'))
  : [];

export const projects: Project[] = files
  .map(file => {
    const data = JSON.parse(fs.readFileSync(path.join(projDir, file), 'utf-8'));
    return {
      title: data.title || '',
      titleEn: data.titleEn || data.title || '',
      description: data.description || '',
      descriptionEn: data.descriptionEn || '',
      image: data.image || '',
      tags: data.tags || [],
      category: data.category || '',
      date: data.date ? new Date(data.date).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '',
      github: data.github || '',
      website: data.website || '',
      story: data.story || '',
      order: data.order ?? 999,
    };
  })
  .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
