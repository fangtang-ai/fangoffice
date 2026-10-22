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
 *   node scripts/stage-release.cjs --channel test --publish --initial-release
 *   node scripts/stage-release.cjs --artifacts dist --channel test --check-env
 *
 * Without --publish it only stages (renames + rewrites + verifies) — handy
 * for a local dry run after dist:win.
 * --check-env validates the required build marker without staging or uploading.
 * --initial-release permits confirmed HTTP 404 feeds only, never unknown state.
 *
 * channel=test stages/uploads with a Test infix (FangTangOffice-Test-Setup-…)
 * so the test-site release line can never be confused with the stable one.
 *
 * OSS layout (bucket: fangtang-office-updates, region cn-hangzhou):
 *   <channel>/latest.yml  <channel>/latest-mac.yml  <channel>/latest-linux.yml
 *   <channel>/FangTangOffice-Setup-<v>.exe (+ .exe.blockmap)
 *   <channel=test>/FangTangOffice-Test-Setup-<v>.exe (+ .exe.blockmap)
 *   <channel>/FangTangOffice-<v>-arm64.dmg / .zip (+ .zip.blockmap)
 *   <channel>/fangtang-office_<v>_amd64.deb / .x86_64.rpm / *.AppImage
 *
 * The script writes ONLY into this bucket (same guard as publish-update.ps1
 * — every other bucket on the account is off-limits). Missing aliyun CLI or
 * credentials is a hard failure with --publish: auto-updaters and the
 * download page read the OSS feeds, so a GitHub-only release would be
 * invisible to every installed client.
 */

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs')
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

async function publishedVersion(url, initialRelease) {
  // Unknown remote state must never become permission to overwrite a channel.
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
  })
  if (response.status === 404 && initialRelease) return null
  if (!response.ok) throw new Error(`remote feed HTTP ${response.status}: ${url}`)
  if (initialRelease) throw new Error(`remote feed already exists: ${url}`)
  const version = ymlVersion(await response.text())
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`remote feed has no valid published version: ${url}`)
  }
  return version
}

async function main() {
  const artifacts = arg('artifacts', 'dist')
  const dir = isAbsolute(artifacts) ? artifacts : join(process.cwd(), artifacts)
  const channel = arg('channel', 'stable')
  const publish = hasFlag('publish')
  const force = hasFlag('force')
  const initialRelease = hasFlag('initial-release')
  if (!['stable', 'beta', 'test'].includes(channel)) throw new Error(`bad channel: ${channel}`)
  if (!existsSync(dir)) throw new Error(`artifacts dir not found: ${dir}`)

  // deployment-line guard: refuse to publish a test-env build to a production
  // channel (or the reverse) — see the marker written by electron-builder.cjs
  const markerPath = join(dir, 'fangtang-build-env.txt')
  if (!existsSync(markerPath)) {
    throw new Error(`missing build environment marker in ${dir} — rebuild before publishing`)
  }
  const built = readFileSync(markerPath, 'utf8').trim()
  const need = channel === 'test' ? 'test' : 'production'
  if (built !== need) {
    throw new Error(
      `artifacts in ${dir} were built for the "${built}" line but --channel ${channel} ` +
        `publishes the "${need}" line — rebuild with matching FANGTANG_BUILD_ENV`,
    )
  }
  if (hasFlag('check-env')) {
    console.log(`[stage] build environment verified: ${built}`)
    return
  }

  // --- 1. rename Chinese-named artifacts to ASCII and rewrite feeds --------
  // electron-builder default names embed the Chinese productName; OSS/URLs
  // and the download page stay encoding-safe when everything is ASCII. The
  // FangTangOffice-Setup name matches the already-published stable feed.
  // test-channel artifacts carry a Test infix so the two release lines are
  // never confusable in the bucket or on a download page
  const ascii = channel === 'test' ? 'FangTangOffice-Test' : 'FangTangOffice'
  const renames = [
    [/^方塘Office(?:-Test)? Setup (.+)\.exe(\.blockmap)?$/, `${ascii}-Setup-$1.exe$2`],
    [/^方塘Office(?:-Test)?-(.+)\.(dmg|zip|AppImage)(\.blockmap)?$/, `${ascii}-$1.$2$3`],
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

  // build byproducts that must never ship: electron-builder debug ymls and
  // *-unpacked/ app directories (the release = installers + blockmaps + feeds)
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (/^builder-(debug\.yml|effective-config\.yaml)$/.test(name)) {
      rmSync(p)
      console.log(`removed: ${name}`)
    } else if (statSync(p).isDirectory()) {
      rmSync(p, { recursive: true })
      console.log(`removed dir: ${name}/`)
    }
  }

  // --- 2. verify every feed entry against the staged bytes -----------------
  // sha512 in the yml is base64 of the raw file bytes; a mismatch here would
  // brick auto-updates, so fail before anything is uploaded.
  // Keep provenance for retries, but never publish the local build marker.
  const files = readdirSync(dir).filter((name) => name !== 'fangtang-build-env.txt')
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
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`${feed}: no valid version line`)
    }
    if (feedVersion && feedVersion !== version) {
      throw new Error(`platform feeds have different versions: ${feedVersion} != ${version}`)
    }
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
    // download-only artifacts the updater feeds intentionally omit:
    // .dmg = mac manual install, .deb/.rpm = system package managers,
    // .blockmap = electron-updater derives its URL from the artifact name
    if (!referenced.has(file) && !/\.(dmg|deb|rpm|blockmap)$/.test(file)) {
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
  // hard failure, not a degrade: a GitHub-only release is invisible to
  // auto-updaters and the download page (they read the OSS feeds)
  if (!aliyunOnPath()) throw new Error('aliyun CLI not on PATH — install it to publish to OSS')
  if (!process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || !process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET) {
    throw new Error('ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET not set — cannot publish to OSS')
  }

  // forward-only guard: never overwrite or roll back the published channel.
  // Checked per-platform feed — a republish could otherwise roll back one
  // platform (e.g. latest-mac.yml) while latest.yml stays ahead.
  for (const feed of feeds) {
    const current = await publishedVersion(`${HTTP_BASE}/${channel}/${feed}`, initialRelease)
    const decision = releaseUploadDecision(feedVersion, current, { force })
    if (decision.action === 'reject') throw new Error(decision.reason)
  }

  // region is fixed for this bucket (see header); newer aliyun CLI builds
  // refuse to infer it from credentials env alone ("region can't be empty")
  const oss = (...a) =>
    execFileSync('aliyun', ['oss', ...a, '--region', 'cn-hangzhou'], { stdio: 'inherit' })
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
