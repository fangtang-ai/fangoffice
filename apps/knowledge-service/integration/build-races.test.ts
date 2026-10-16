import { expect, it } from 'vitest'
import { changeBuild, closedBuildStates, prepareContentInsert } from './build-fixtures'
import { expectBlocked, withBuildRace } from './build-race-fixtures'

for (const [state, assignment] of Object.entries(closedBuildStates)) {
  it(`makes a non-key ${state} UPDATE wait for the content writer's SHARE lock`, async () => {
    await withBuildRace(async ({ fixture, writer, closer, observer, writerPid, closerPid }) => {
      const insert = await prepareContentInsert(writer, fixture, 'kb_source_units')
      expect((await writer.query(insert.text, insert.values)).rowCount).toBe(1)
      const closing = changeBuild(closer, fixture, assignment).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      await expectBlocked(observer, closerPid, writerPid)
      await writer.query('COMMIT')
      await expect(closing).resolves.toMatchObject({ result: { rowCount: 1 } })
      await closer.query('COMMIT')
      const count = await observer.query(
        `SELECT count(*)::int AS count FROM knowledge.kb_source_units
        WHERE owner_id = $1 AND build_id = $2`,
        [fixture.owners[0], fixture.id],
      )
      expect(count.rows).toEqual([{ count: 2 }])
    })
  })

  it(`rechecks the current ${state} state after the writer waits for a closing transaction`, async () => {
    await withBuildRace(async ({ fixture, writer, closer, observer, writerPid, closerPid }) => {
      const insert = await prepareContentInsert(writer, fixture, 'kb_source_units')
      await closer.query(
        'SELECT id FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2 FOR UPDATE',
        [fixture.owners[0], fixture.id],
      )
      await changeBuild(closer, fixture, assignment)
      const writing = writer.query(insert.text, insert.values).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      await expectBlocked(observer, writerPid, closerPid)
      await closer.query('COMMIT')
      await expect(writing).resolves.toMatchObject({
        error: { code: '23514', constraint: 'kb_build_writable' },
      })
      await writer.query('ROLLBACK')
      const count = await observer.query(
        `SELECT count(*)::int AS count FROM knowledge.kb_source_units
        WHERE owner_id = $1 AND build_id = $2`,
        [fixture.owners[0], fixture.id],
      )
      expect(count.rows).toEqual([{ count: 1 }])
    })
  })

  it(`lets a waiting writer proceed when the ${state} transition rolls back`, async () => {
    await withBuildRace(async ({ fixture, writer, closer, observer, writerPid, closerPid }) => {
      const insert = await prepareContentInsert(writer, fixture, 'kb_source_units')
      await changeBuild(closer, fixture, assignment)
      const writing = writer.query(insert.text, insert.values).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      await expectBlocked(observer, writerPid, closerPid)
      await closer.query('ROLLBACK')
      await expect(writing).resolves.toMatchObject({ result: { rowCount: 1 } })
      await writer.query('COMMIT')
      const result = await observer.query(
        `SELECT status, gc_state FROM knowledge.kb_builds
        WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], fixture.id],
      )
      expect(result.rows).toEqual([{ status: 'building', gc_state: 'live' }])
    })
  })
}

it('allows independent content writers to share one building parent without serializing them', async () => {
  await withBuildRace(async ({ fixture, writer, closer }) => {
    const first = await prepareContentInsert(writer, fixture, 'kb_source_units', 1)
    const second = await prepareContentInsert(closer, fixture, 'kb_source_units', 2)
    expect((await writer.query(first.text, first.values)).rowCount).toBe(1)
    expect((await closer.query(second.text, second.values)).rowCount).toBe(1)
  })
})

it('leaves no inserted row after a real parent-lock timeout', async () => {
  await withBuildRace(async ({ fixture, writer, closer, observer }) => {
    const insert = await prepareContentInsert(writer, fixture, 'kb_source_units')
    await changeBuild(closer, fixture, closedBuildStates.sealed)
    await writer.query("SET LOCAL lock_timeout = '100ms'")
    await expect(writer.query(insert.text, insert.values)).rejects.toMatchObject({ code: '55P03' })
    await writer.query('ROLLBACK')
    expect(
      (
        await observer.query(
          `SELECT count(*)::int AS count FROM knowledge.kb_source_units
      WHERE owner_id = $1 AND build_id = $2`,
          [fixture.owners[0], fixture.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }])
  })
})
