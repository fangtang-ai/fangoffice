#!/usr/bin/env node
/**
 * scripts/stage-release.cjs — stage cross-platform release artifacts for
 * publishing: rename Chinese-named artifacts to ASCII, rewrite the electron
 * updater feed ymls to match, verify feed↔artifact integrity locally, then
 * (with --publish) upload installers first and feeds last to the OSS update
 * bucket and verify both anonymously.
 *
 * Usage:
 *   node scripts/stage-release.cjs [--artifacts dist] [--channel stable] [--publish] [--force]
 *
 * Without --publish it only stages (renames + rewrites + verifies) — handy
 * for a local dry run after dist:win.
 *
 * OSS layout (bucket: fangtang-office-updates, region cn-hangzhou):
 *   <channel>/latest.yml  <channel>/latest-mac.yml  <channel>/latest-linux.yml
 *   <channel>/FangTangOffice-Setup-<v>.exe (+ .exe.blockmap)
 *   <channel>/FangTangOffice-<v>-arm64.dmg / .zip (+ .zip.blockmap)
 *   <channel>/fangtang-office_<v>_amd64.deb / .x86_64.rpm / *.AppImage
 *
 * The script writes ONLY into this bucket (same guard as publish-update.ps1
 * — every other bucket on the account is off-limits). Uploads are skipped
 * with a warning when the aliyun CLI or credentials are missing, so a
 * release can still go out via GitHub while OSS upload is being fixed.
 */

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } = require('node:fs')
const { join, isAbsolute } = require('node:path')
const { ymlVersion, releaseUploadDecision } = require('./update-feed-utils.cjs')

// fixed targets — deliberately not parameters (see publish-update.ps1)
const BUCKET = 'fangtang-office-updates'
const HTTP_BASE = `https://${BUCKET}.oss-cn-hangzhou.aliyuncs.com`

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const hasFlag = (name) => args.includes(`--${name}`)

async function main() {
  const artifacts = arg('artifacts', 'dist')
  const dir = isAbsolute(artifacts) ? artifacts : join(process.cwd(), artifacts)
  const channel = arg('channel', 'stable')
  const publish = hasFlag('publish')
  const force = hasFlag('force')
  if (!['stable', 'beta'].includes(channel)) throw new Error(`bad channel: ${channel}`)
  if (!existsSync(dir)) throw new Error(`artifacts dir not found: ${dir}`)

  // --- 1. rename Chinese-named artifacts to ASCII and rewrite feeds --------
  // electron-builder default names embed the Chinese productName; OSS/URLs
  // and the download page stay encoding-safe when everything is ASCII. The
  // FangTangOffice-Setup name matches the already-published stable feed.
  const renames = [
    [/^方塘Office Setup (.+)\.exe(\.blockmap)?$/, 'FangTangOffice-Setup-$1.exe$2'],
    [/^方塘Office-(.+)\.(dmg|zip|AppImage)(\.blockmap)?$/, 'FangTangOffice-$1.$2$3'],
  ]
  const staged = readdirSync(dir)
  const nameMap = []
  for (const name of staged) {
    for (const [re, to] of renames) {
      if (re.test(name)) {
        nameMap.push([name, name.replace(re, to)])
        break
      }
    }
  }
  for (const [from, to] of nameMap) {
    renameSync(join(dir, from), join(dir, to))
    for (const yml of staged.filter((f) => f.endsWith('.yml'))) {
      const p = join(dir, yml)
      const text = readFileSync(p, 'utf8')
      if (text.includes(from)) writeFileSync(p, text.split(from).join(to))
    }
  }
  for (const [from, to] of nameMap) console.log(`renamed: ${from} -> ${to}`)

  // --- 2. verify every feed entry against the staged bytes -----------------
  // sha512 in the yml is base64 of the raw file bytes; a mismatch here would
  // brick auto-updates, so fail before anything is uploaded.
  const files = readdirSync(dir)
  const feeds = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'].filter((f) =>
    files.includes(f),
  )
  if (feeds.length === 0) throw new Error(`no feed yml found in ${dir}`)

  const sha512Base64 = (file) =>
    createHash('sha512')
      .update(readFileSync(join(dir, file)))
      .digest('base64')
  let feedVersion = null
  for (const feed of feeds) {
    const text = readFileSync(join(dir, feed), 'utf8')
    const version = ymlVersion(text)
    if (!version) throw new Error(`${feed}: no version line`)
    // top-level path/sha512 (latest.yml) plus the files: list entries
    const entries = []
    const topPath = text.match(/^path:\s*(\S+)/m)?.[1]
    const topSha = text.match(/^sha512:\s*(\S+)/m)?.[1]
    if (topPath && topSha) entries.push([topPath, topSha])
    for (const m of text.matchAll(/- url:\s*(\S+)\n[\s\S]*?sha512:\s*(\S+)/g)) {
      entries.push([m[1], m[2]])
    }
    if (entries.length === 0) throw new Error(`${feed}: no entries to verify`)
    for (const [file, sha] of entries) {
      if (!existsSync(join(dir, file))) throw new Error(`${feed}: missing artifact ${file}`)
      if (sha512Base64(file) !== sha) throw new Error(`${feed}: sha512 mismatch for ${file}`)
    }
    console.log(`verified: ${feed} (v${version}, ${entries.length} entries)`)
    feedVersion ??= version
  }

  // every non-feed file must be referenced by a feed, except the dmg (a
  // download-only artifact the updater feed intentionally does not list)
  const referenced = new Set()
  for (const feed of feeds) {
    const text = readFileSync(join(dir, feed), 'utf8')
    for (const m of text.matchAll(/(?:^path:|- url:)\s*(\S+)/gm)) referenced.add(m[1])
  }
  for (const file of files.filter((f) => !feeds.includes(f))) {
    // .dmg: updater feed intentionally omits it; .blockmap: electron-updater
    // derives its URL from the artifact name, feeds need not reference it
    if (!referenced.has(file) && !file.endsWith('.dmg') && !file.endsWith('.blockmap')) {
      throw new Error(`stray artifact not referenced by any feed: ${file}`)
    }
  }

  // --- 3. upload (installers first, feeds last — a feed must never dangle) -
  const aliyunOnPath = () => {
    try {
      execFileSync('aliyun', ['version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  const ossBase = `oss://${BUCKET}/${channel}`
  if (!publish) {
    console.log(
      `[stage] dry run — staged ${files.length} files in ${dir} (pass --publish to upload)`,
    )
    return
  }
  if (!aliyunOnPath()) {
    console.warn('[stage] aliyun CLI not on PATH — skipping OSS upload (staged only)')
    return
  }
  if (!process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || !process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET) {
    console.warn('[stage] no ALIBABA_CLOUD_* credentials — skipping OSS upload (staged only)')
    return
  }

  // forward-only guard: never overwrite or roll back the published channel
  try {
    const res = await fetch(`${HTTP_BASE}/${channel}/latest.yml`)
    if (res.ok) {
      const current = ymlVersion(await res.text())
      const decision = releaseUploadDecision(feedVersion, current, { force })
      if (decision.action === 'reject') throw new Error(decision.reason)
    }
  } catch (err) {
    // network/absence of a current feed is fine (first publish); an explicit
    // reject from the guard must still stop the release
    if (String(err.message).includes('not newer than')) throw err
    console.warn(
      `[stage] could not read current ${channel} feed (${err.message}) — uploading anyway`,
    )
  }

  const oss = (...a) => execFileSync('aliyun', ['oss', ...a], { stdio: 'inherit' })
  for (const file of files.filter((f) => !feeds.includes(f))) {
    oss('cp', join(dir, file), `${ossBase}/${file}`, '--acl', 'public-read', '--force')
  }
  for (const feed of feeds) {
    oss('cp', join(dir, feed), `${ossBase}/${feed}`, '--acl', 'public-read', '--force')
  }

  // --- 4. anonymous verification (proves public-read actually works) ------
  for (const feed of feeds) {
    const res = await fetch(`${HTTP_BASE}/${channel}/${feed}`)
    if (!res.ok) throw new Error(`${feed}: anonymous fetch failed (${res.status})`)
    const text = await res.text()
    if (ymlVersion(text) !== feedVersion) {
      throw new Error(
        `${feed}: published version != staged (${ymlVersion(text)} != ${feedVersion})`,
      )
    }
    console.log(`published: ${HTTP_BASE}/${channel}/${feed} (v${feedVersion})`)
  }
  for (const file of files.filter((f) => !feeds.includes(f))) {
    const res = await fetch(`${HTTP_BASE}/${channel}/${file}`, { method: 'HEAD' })
    if (!res.ok) throw new Error(`${file}: HEAD failed (${res.status})`)
  }
  console.log(`published: ${HTTP_BASE}/${channel}/ (v${feedVersion})`)
}

main().catch((err) => {
  console.error(`[stage] ERROR: ${err.message}`)
  process.exit(1)
})
