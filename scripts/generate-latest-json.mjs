import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// latest.json 是客户端检查更新的唯一事实来源，必须和 Release 里的安装包严格对应。
// 安装包名由 Tauri 从中文 productName 剥离而来（例如 `_1.0.5_aarch64.dmg`），
// 不能凭约定拼接，只能列出 Release 资产按后缀匹配。
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const MIN_SUPPORTED_VERSION = '1.0.5' // 首个带检查更新能力的版本；低于它的客户端只能手动重装。

function readVersion() {
  const match = readFileSync(join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8').match(/"version"\s*:\s*"([^"]+)"/)
  if (!match) throw new Error('无法从 tauri.conf.json 读取应用版本')
  return match[1]
}

/** 按资产名后缀判定平台；两个平台的安装包后缀没有交集，不需要额外元数据。 */
function platformForAsset(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.dmg')) return 'darwin-arm64'
  if (lower.endsWith('.exe')) return 'windows-x64'
  return undefined
}

function listReleaseAssets(repository, tag) {
  const output = execFileSync('gh', ['release', 'view', tag, '--repo', repository, '--json', 'assets'], { encoding: 'utf8' })
  const assets = JSON.parse(output).assets
  if (!Array.isArray(assets) || assets.length === 0) throw new Error(`Release ${tag} 没有资产`)
  return assets
}

function buildDocument({ version, notes, assets, baseUrl }) {
  const platforms = {}
  for (const asset of assets) {
    const platform = platformForAsset(asset.name)
    if (!platform) continue
    if (platforms[platform]) throw new Error(`平台 ${platform} 匹配到多个安装包：${platforms[platform].name}、${asset.name}`)
    platforms[platform] = { url: `${baseUrl}/${encodeURIComponent(asset.name)}`, size: asset.size, name: asset.name }
  }
  const missing = ['darwin-arm64', 'windows-x64'].filter((platform) => !platforms[platform])
  if (missing.length > 0) throw new Error(`Release 缺少以下平台的安装包：${missing.join('、')}`)
  return {
    version,
    min_supported_version: MIN_SUPPORTED_VERSION,
    notes,
    pub_date: new Date().toISOString(),
    platforms,
  }
}

const [, , tagArgument, repositoryArgument, releaseNotesPath, outputArgument] = process.argv
try {
  const tag = tagArgument || process.env.GITHUB_REF_NAME
  const repository = repositoryArgument || process.env.GITHUB_REPOSITORY
  const outputPath = outputArgument || 'latest.json'
  if (!tag || !repository) throw new Error('用法：node scripts/generate-latest-json.mjs <tag> <owner/repo> [release-notes文件] [输出路径]')

  const version = readVersion()
  if (tag.replace(/^v/, '') !== version) throw new Error(`标签 ${tag} 与应用版本 ${version} 不一致`)
  const assets = listReleaseAssets(repository, tag)
  if (!assets.some((asset) => platformForAsset(asset.name))) throw new Error('Release 里没有可识别的安装包')
  // Release 说明里是自动生成的 changelog，只取前几行作为更新摘要。
  const notes = releaseNotesPath
    ? readFileSync(releaseNotesPath, 'utf8').trim().split('\n').slice(0, 3).join('\n')
    : ''
  const document = buildDocument({ version, notes, assets, baseUrl: `https://github.com/${repository}/releases/download/${tag}` })
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`)
  console.log(JSON.stringify({ outputPath, version, platforms: Object.keys(document.platforms) }))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
