/** Split markdown body into Korean and English parts by <!-- EN --> delimiter */
export function splitContent(body: string): { ko: string; en: string | null } {
  const delimiter = '<!-- EN -->';
  const idx = body.indexOf(delimiter);
  if (idx === -1) {
    return { ko: body, en: null };
  }
  return {
    ko: body.slice(0, idx).trim(),
    en: body.slice(idx + delimiter.length).trim(),
  };
}

export function getReadingTime(content: string): number {
  const words = content.trim().split(/\s+/).length;
  return Math.ceil(words / 200);
}

export function slugify(text: string): string {
  return encodeURIComponent(text.toLowerCase().replace(/\s+/g, '-'));
}

/** Parse a category path like "개발/Frontend" into [parent, child] */
export function parseCategory(category: string): { parent: string; child: string | null; full: string } {
  const parts = category.split('/');
  return {
    parent: parts[0],
    child: parts.length > 1 ? parts.slice(1).join('/') : null,
    full: category,
  };
}

/** Build a hierarchical category tree from posts */
export interface CategoryNode {
  name: string;
  count: number;
  children: Map<string, CategoryNode>;
}

export function buildCategoryTree(categories: string[]): Map<string, CategoryNode> {
  const tree = new Map<string, CategoryNode>();

  for (const cat of categories) {
    const { parent, child } = parseCategory(cat);

    if (!tree.has(parent)) {
      tree.set(parent, { name: parent, count: 0, children: new Map() });
    }

    const parentNode = tree.get(parent)!;
    parentNode.count++;

    if (child) {
      if (!parentNode.children.has(child)) {
        parentNode.children.set(child, { name: child, count: 0, children: new Map() });
      }
      parentNode.children.get(child)!.count++;
    }
  }

  return tree;
}
