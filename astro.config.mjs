// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

const isProd = process.env.CI === 'true';

// https://astro.build/config
export default defineConfig({
  site: isProd ? 'https://dj258255.github.io' : 'http://localhost:4321',
  base: isProd ? '/IT-Oasis' : '/',
  output: 'static',
  vite: {
    plugins: [tailwindcss()]
  }
});
