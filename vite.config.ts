import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// 当前版本号只从 package.json 读取，与 Cargo.toml、tauri.conf.json 的一致性由 npm run version:check 保证。
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// 开发模式下页面自己不是本地服务，用它转发 API 请求，让前端只依赖同源相对路径。
const apiProxy = {
  '/api': { target: 'http://127.0.0.1:8765' },
  '/health': { target: 'http://127.0.0.1:8765' },
}

export default defineConfig({
  plugins: [react()],
  define: { APP_VERSION: JSON.stringify(version) },
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
})
