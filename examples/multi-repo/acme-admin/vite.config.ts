import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served under /admin in production (and through the Stagecraft proxy).
export default defineConfig({ base: '/admin/', plugins: [react()], server: { port: 5192, strictPort: true } });
