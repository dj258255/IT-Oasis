import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catDir = path.join(__dirname, '..', 'src/data/categories');
const outFile = path.join(__dirname, 'category-options.json');

const opts = [];
const files = fs.existsSync(catDir)
  ? fs.readdirSync(catDir).filter(f => f.endsWith('.json'))
  : [];

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(catDir, file), 'utf-8'));
  opts.push({ value: data.name, label: data.name });
  for (const sub of data.subcategories || []) {
    opts.push({
      value: `${data.name}/${sub.name}`,
      label: `${data.name} → ${sub.name}`,
    });
  }
}

fs.writeFileSync(outFile, JSON.stringify(opts, null, 2) + '\n');
