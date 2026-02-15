// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://dj258255.github.io',
  base: '/IT-Oasis',
  output: 'static',
  vite: {
    plugins: [tailwindcss()]
  }
});
