export interface Project {
  title: string;
  description: string;
  descriptionEn: string;
  image: string;
  tags: string[];
  category: string;
  date: string;
  github: string;
  website: string;
  story: string;
}

export const projects: Project[] = [
  {
    title: 'IT Oasis',
    description: 'Astro 프레임워크로 만든 개인 블로그. Liquid Glass 디자인과 다크모드, 한/영 전환 등 다양한 기능을 직접 구현했습니다.',
    descriptionEn: 'A personal blog built with Astro framework. Features Liquid Glass design, dark mode, KO/EN toggle, and more.',
    image: '/projects/it-oasis.jpg',
    tags: ['Astro', 'Tailwind', 'TypeScript'],
    category: 'Web',
    date: '2026. 02. 14',
    github: 'https://github.com/',
    website: '',
    story: '/blog',
  },
  {
    title: 'Tasty Tower',
    description: '음식 관련 타워 디펜스 게임 프로젝트. 재미있는 게임 메카닉과 귀여운 비주얼이 특징입니다.',
    descriptionEn: 'A food-themed tower defense game project. Features fun game mechanics and cute visuals.',
    image: '/projects/tasty-tower.jpg',
    tags: ['Game', 'JavaScript', 'Canvas'],
    category: 'Game',
    date: '2025. 06. 01',
    github: 'https://github.com/',
    website: '',
    story: '',
  },
  {
    title: 'Scout.gg',
    description: '머신러닝 기반으로 LOL 플레이어의 성장 가능성을 판단하는 AI 프로젝트.',
    descriptionEn: 'An AI project that evaluates LOL player growth potential using machine learning.',
    image: '/projects/scout-gg.jpg',
    tags: ['Python', 'ML', 'React'],
    category: 'AI',
    date: '2024. 09. 15',
    github: 'https://github.com/',
    website: '',
    story: '',
  },
];
