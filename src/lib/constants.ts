/** Tag color class names, cycled by index */
export const TAG_COLORS = ['tag-violet', 'tag-cyan', 'tag-rose', 'tag-emerald', 'tag-amber'] as const;

/** Parent category → color class mapping */
export const CAT_COLOR_MAP: Record<string, string> = {
  '개발': 'cat-dev',
  '일상': 'cat-life',
};
