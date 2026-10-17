import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  // .env.local lives at the repo root, shared with the desktop app
  envDir: '..',
  server: {
    host: '127.0.0.1',
    port: 8888,
    strictPort: true,
    proxy: {
      '/api/musicae': {
        target: 'https://spotify-extended-audio-features-api.p.rapidapi.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/musicae/, '')
      }
    }
  }
})
