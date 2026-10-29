import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  envDir: '../..',
  server: {
    port: 5173,
    host: '127.0.0.1',
    // This local file is served only by the authenticated administrator API.
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/adminInterviewScript.json'] },
  },
})
