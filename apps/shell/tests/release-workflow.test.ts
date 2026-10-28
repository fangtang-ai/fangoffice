import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflows = join(__dirname, '../../../.github/workflows')

describe('release workflow contract', () => {
  it('runs CI for the actual Office trunk and exposes the same gate to releases', async () => {
    const ci = await readFile(join(workflows, 'ci.yml'), 'utf8')
    expect(ci).toMatch(/push:\s*\n\s+branches: \['release\/fangtang'/)
    expect(ci).toMatch(/pull_request:\s*\n\s+branches: \['release\/fangtang'\]/)
    expect(ci).toContain('workflow_call:')
    expect(ci).not.toMatch(/branches: \[main/)
    expect(ci).toContain('group: ci-${{ github.workflow }}-${{ github.ref }}')
  })

  it('checks the source and passes reusable CI before any packaging job', async () => {
    const release = await readFile(join(workflows, 'release.yml'), 'utf8')
    expect(release).toContain('run: node scripts/check-release-ref.cjs')
    expect(release).toContain('fetch-depth: 0')
    expect(release).toMatch(/verify:\s*\n\s+needs: check/)
    expect(release).toContain('uses: ./.github/workflows/ci.yml')
    expect(release).toMatch(/build:\s*\n\s+needs: verify/)
  })

  it('checks new English prose against the merge parent or push baseline without disabling audits', async () => {
    const ci = await readFile(join(workflows, 'ci.yml'), 'utf8')
    const step = ci
      .split('- name: Check comments/docs are English-only')[1]
      ?.split('\n      - name:')[0]
    expect(step).toContain("ENGLISH_COMMENT_BASE_REF: ${{ github.event.before || 'HEAD^' }}")
    expect(step).toContain('ENGLISH_COMMENT_BASE_REF=$(git rev-parse HEAD^1)')
    expect(step).toContain('[[ "$ENGLISH_COMMENT_BASE_REF" =~ ^0+$ ]]')
    expect(step).toContain('ENGLISH_COMMENT_BASE_REF=HEAD^')
    expect(step).toContain('npm run check:english-comments')
    expect(step).not.toContain('continue-on-error')
    expect(step).not.toContain('|| true')
  })

  it('serializes publishing by channel across refs without canceling a running upload', async () => {
    const release = await readFile(join(workflows, 'release.yml'), 'utf8')
    const publisher = release.slice(release.indexOf('\n  publish:'))
    expect(publisher).toContain("group: release-${{ github.event.inputs.channel || 'stable' }}")
    expect(publisher).toContain('cancel-in-progress: false')
    expect(release).not.toContain('group: release-${{ github.ref }}')
  })
})
