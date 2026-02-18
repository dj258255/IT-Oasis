/**
 * Shared configuration & data loading for the entire site.
 * All data is cached at module level (safe for Astro SSG builds).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { categoryIconPaths, defaultIconPath } from './utils';

// ── Base URL ──────────────────────────────────────────────
export const base = import.meta.env.BASE_URL.replace(/\/$/, '');

export function assetPath(p: string): string {
  return encodeURI(`${base}/${p.replace(/^\//, '')}`);
}

// ── Site Settings ─────────────────────────────────────────
let _settings: Record<string, any> | null = null;

export function getSiteSettings(): Record<string, any> {
  if (!_settings) {
    const filePath = join(process.cwd(), 'src/data/site/settings.json');
    _settings = JSON.parse(readFileSync(filePath, 'utf-8'));
  }
  return _settings!;
}

// ── Category i18n (KO name → EN name) ────────────────────
let _catI18n: Map<string, string> | null = null;

export function getCategoryI18n(): Map<string, string> {
  if (!_catI18n) {
    _catI18n = new Map();
    const catDir = join(process.cwd(), 'src/data/categories');
    try {
      for (const file of readdirSync(catDir).filter(f => f.endsWith('.json'))) {
        const data = JSON.parse(readFileSync(join(catDir, file), 'utf-8'));
        _catI18n.set(data.name, data.nameEn || data.name);
        for (const sub of data.subcategories || []) {
          _catI18n.set(sub.name, sub.nameEn || sub.name);
        }
      }
    } catch {}
  }
  return _catI18n;
}

// ── Category display names (identifier → Korean display) ──
let _catDisplayKo: Map<string, string> | null = null;

export function getCategoryDisplayKo(): Map<string, string> {
  if (!_catDisplayKo) {
    _catDisplayKo = new Map();
    const catDir = join(process.cwd(), 'src/data/categories');
    try {
      for (const file of readdirSync(catDir).filter(f => f.endsWith('.json'))) {
        const data = JSON.parse(readFileSync(join(catDir, file), 'utf-8'));
        if (data.nameKo) _catDisplayKo.set(data.name, data.nameKo);
        for (const sub of data.subcategories || []) {
          if (sub.nameKo) _catDisplayKo.set(sub.name, sub.nameKo);
        }
      }
    } catch {}
  }
  return _catDisplayKo;
}

// ── Category Metadata (icons + translations) ─────────────
export interface CategoryMeta {
  icon: string;
  nameEn: string;
  order: number;
}

let _catMeta: Map<string, CategoryMeta> | null = null;

export function getCategoryMeta(): Map<string, CategoryMeta> {
  if (!_catMeta) {
    _catMeta = new Map();
    const catDir = join(process.cwd(), 'src/data/categories');
    try {
      for (const file of readdirSync(catDir).filter(f => f.endsWith('.json'))) {
        const data = JSON.parse(readFileSync(join(catDir, file), 'utf-8'));
        _catMeta.set(data.name, {
          icon: categoryIconPaths[data.icon] || defaultIconPath,
          nameEn: data.nameEn || data.name,
          order: typeof data.order === 'number' ? data.order : 999,
        });
      }
    } catch {}
  }
  return _catMeta;
}

// ── Subcategory order map (parent/child → order) ─────────
let _subCatOrder: Map<string, number> | null = null;

export function getSubcategoryOrder(): Map<string, number> {
  if (!_subCatOrder) {
    _subCatOrder = new Map();
    const catDir = join(process.cwd(), 'src/data/categories');
    try {
      for (const file of readdirSync(catDir).filter(f => f.endsWith('.json'))) {
        const data = JSON.parse(readFileSync(join(catDir, file), 'utf-8'));
        for (const sub of data.subcategories || []) {
          _subCatOrder.set(`${data.name}/${sub.name}`, typeof sub.order === 'number' ? sub.order : 999);
        }
      }
    } catch {}
  }
  return _subCatOrder;
}
