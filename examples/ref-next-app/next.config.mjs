import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  // Monorepo only: workspace packages live outside this folder.
  turbopack: { root: join(here, '../..') },
  transpilePackages: ['@stagecraft/react'],
};
