import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(projectRoot, '.sidecar-build')
const serverSource = join(projectRoot, 'server', 'index.ts')
const target = process.env.TAURI_TARGET ?? execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
const extension = target.includes('windows') ? '.exe' : ''
const blobPath = join(buildDir, 'lingtu-server.blob')
const executablePath = join(buildDir, `lingtu-server${extension}`)
const targetPath = join(projectRoot, 'src-tauri', 'binaries', `lingtu-server-${target}${extension}`)
const configPath = join(buildDir, 'sea-config.json')
const bundledEntry = join(buildDir, 'index.cjs')

mkdirSync(buildDir, { recursive: true })
mkdirSync(dirname(targetPath), { recursive: true })
if (!readFileSync(serverSource, 'utf8').includes('startServer')) {
  throw new Error(`Node 服务入口不存在: ${serverSource}`)
}

// SEA 需要单文件 CommonJS 入口；开发/测试仍使用 tsc 的类型检查产物。
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
  'esbuild', serverSource, '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundledEntry}`,
], { cwd: projectRoot, stdio: 'inherit' })

writeFileSync(configPath, JSON.stringify({
  main: bundledEntry,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
}, null, 2))

execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' })
if (process.platform === 'darwin') {
  const architecture = target.startsWith('aarch64-') ? 'arm64' : 'x86_64'
  // Universal Node 包含两个 SEA fuse；先裁成目标架构再注入，避免 postject 命中多个位置。
  execFileSync('lipo', ['-thin', architecture, process.execPath, '-output', executablePath], { stdio: 'inherit' })
} else {
  cpSync(process.execPath, executablePath, { force: true })
}

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', executablePath], { stdio: 'inherit' })
}

const postjectArgs = [
  'postject', executablePath, 'NODE_SEA_BLOB', blobPath,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA')
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', postjectArgs, { cwd: projectRoot, stdio: 'inherit' })

if (process.platform === 'darwin') {
  // 注入会移除原签名；先恢复 ad-hoc 签名，正式发布再由 CI 使用 Developer ID 重签并公证。
  execFileSync('codesign', ['--sign', '-', '--force', executablePath], { stdio: 'inherit' })
}

cpSync(executablePath, targetPath, { force: true })
rmSync(blobPath, { force: true })
rmSync(configPath, { force: true })
console.log(JSON.stringify({ sidecar: targetPath, target }))
