export const ui = {
  // Header
  'nav.about': { ko: '소개', en: 'About' },
  'nav.projects': { ko: '프로젝트', en: 'Projects' },
  'nav.story': { ko: '스토리', en: 'Story' },
  'nav.tags': { ko: '태그', en: 'Tags' },
  'search.placeholder': { ko: '검색어를 입력하세요...', en: 'Search...' },
  'search.empty': { ko: '검색 결과가 없습니다', en: 'No results found' },
  'search.hint': { ko: '제목, 태그, 카테고리로 검색', en: 'Search by title, tags, category' },
  // Sidebar
  'sidebar.bio': { ko: '개발하면서 배운 것들을 기록하는 공간', en: 'A space to record what I learn while developing' },
  'sidebar.all': { ko: '전체', en: 'All' },
  // Home
  'home.greeting': { ko: '안녕하세요', en: 'Hello' },
  'home.subtitle': { ko: '개발하면서 배운 것들을 기록하는 블로그입니다.\n좋은 코드와 깊은 사고를 지향합니다.', en: 'A blog recording what I learn while developing.\nAiming for good code and deep thinking.' },
  'home.cta.blog': { ko: '블로그 읽기', en: 'Read Blog' },
  'home.cta.about': { ko: '더 알아보기', en: 'Learn More' },
  'home.projects': { ko: '프로젝트', en: 'Projects' },
  'home.latest': { ko: '최신 스토리', en: 'Latest Story' },
  // Blog post
  'post.back': { ko: '모든 글', en: 'All Posts' },
  'post.readSuffix': { ko: '읽기', en: 'read' },
  'post.toc': { ko: '목차', en: 'Table of Contents' },
  'post.prev': { ko: '이전 글', en: 'Previous' },
  'post.next': { ko: '다음 글', en: 'Next' },
  'post.author.bio': { ko: '풍부한 상상과 호기심으로 다양한 프로젝트를 만들어갑니다.', en: 'Creating diverse projects with rich imagination and curiosity.' },
  'post.related': { ko: '의 다른 글', en: "'s other posts" },
  // Blog list
  'blog.title': { ko: '스토리 — IT Oasis', en: 'Story — IT Oasis' },
  'blog.subtitle.line1': { ko: '학습하고, 경험한 것 외에', en: 'Beyond learning and experiences,' },
  'blog.subtitle.line2': { ko: '일상 속의 작은 이벤트도 기록합니다.', en: 'I also record small events in daily life.' },
  // About
  'about.title': { ko: '소개 — IT Oasis', en: 'About — IT Oasis' },
  'about.subtitle.line1': { ko: '풍부한 상상과 호기심으로', en: 'Creating diverse projects' },
  'about.subtitle.line2': { ko: '다양한 프로젝트를 만들어갑니다.', en: 'with rich imagination and curiosity.' },
  // Projects
  'projects.subtitle.line1': { ko: '풍부한 상상과 호기심으로 만들어 온', en: 'Introducing diverse projects' },
  'projects.subtitle.line2': { ko: '다양한 프로젝트를 소개합니다.', en: 'created with rich imagination and curiosity.' },
  'projects.website': { ko: '웹사이트 접속하기', en: 'Visit Website' },
  'projects.github': { ko: '깃허브 보기', en: 'View GitHub' },
  'projects.story': { ko: '스토리 보기', en: 'View Story' },
  'projects.empty': { ko: '더 많은 프로젝트가 곧 추가됩니다', en: 'More projects coming soon' },
  // Tags / Categories
  'tags.count': { ko: '개의 태그', en: ' tags' },
  'posts.count': { ko: '개의 글', en: ' posts' },
  'categories.count': { ko: '개의 카테고리', en: ' categories' },
  'tags.back': { ko: '모든 태그', en: 'All Tags' },
  'categories.back': { ko: '모든 카테고리', en: 'All Categories' },
  // Utils
  'reading.suffix': { ko: '분', en: 'min' },
} as const;

export type UIKey = keyof typeof ui;
export function t(key: UIKey, lang: 'ko' | 'en' = 'ko'): string {
  return ui[key][lang];
}
