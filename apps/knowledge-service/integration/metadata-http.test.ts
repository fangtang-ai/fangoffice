import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { publishBuild } from '../src/runtime'
import { changeCapacityFixture } from './capacity-fixtures'
import { preparePublication, publicationTransaction } from './publication-fixtures'
import { uploadMetadata } from './upload-fixtures'
import { withUploadHttpFixture } from './upload-http-fixtures'

it('lists and reads created metadata and reflects a prepared upload through the account client', async () => {
  await withUploadHttpFixture(async (_fixture, { client }) => {
    const target = { spaceId: randomUUID(), documentId: randomUUID() }
    const space = await client.createSpace({ spaceId: target.spaceId }, { title: 'Readable space' })
    const document = await client.createDocument(target, uploadMetadata)
    const spaces = await client.listSpaces()
    expect(spaces.items).toContainEqual(space)
    expect(await client.listDocuments({ spaceId: target.spaceId })).toEqual({
      items: [document],
      nextCursor: null,
    })
    expect(await client.getDocument(target)).toEqual(document)

    const operationId = randomUUID()
    await client.prepareUpload(target, {
      operationId,
      idempotencyKey: randomUUID(),
      expectedGeneration: '0',
      declaredBytes: '4',
      format: 'txt',
    })
    expect(await client.getDocument(target)).toMatchObject({
      active: null,
      desired: { operationId, versionId: null },
    })
  })
})

it('paginates owner spaces and documents by stable UUID cursors without duplicate or skipped items', async () => {
  await withUploadHttpFixture(async (fixture, { client }) => {
    const spaceIds = [randomUUID(), randomUUID()]
    for (const spaceId of spaceIds) await client.createSpace({ spaceId }, { title: 'Paged space' })
    const expectedSpaces = [fixture.id, ...spaceIds].sort()
    const spaces = await client.listSpaces({ limit: 2 })
    expect(spaces.items.map((space) => space.id)).toEqual(expectedSpaces.slice(0, 2))
    expect(spaces.nextCursor).toBe(expectedSpaces[1])
    const remainingSpaces = await client.listSpaces({ limit: 2, cursor: spaces.nextCursor })
    expect(remainingSpaces.items.map((space) => space.id)).toEqual(expectedSpaces.slice(2))
    expect(remainingSpaces.nextCursor).toBeNull()

    const spaceId = spaceIds[0]
    const documentIds = [randomUUID(), randomUUID(), randomUUID()].sort()
    for (const documentId of documentIds)
      await client.createDocument({ spaceId, documentId }, uploadMetadata)
    const documents = await client.listDocuments({ spaceId }, { limit: 2 })
    expect(documents.items.map((document) => document.id)).toEqual(documentIds.slice(0, 2))
    expect(documents.nextCursor).toBe(documentIds[1])
    expect(
      await client.listDocuments({ spaceId }, { limit: 2, cursor: documents.nextCursor }),
    ).toMatchObject({
      items: [{ id: documentIds[2] }],
      nextCursor: null,
    })
    expect(await client.listDocuments({ spaceId }, { limit: 2, cursor: documentIds[2] })).toEqual({
      items: [],
      nextCursor: null,
    })
  })
})

it('keeps frozen metadata readable and hides documents and spaces after HTTP deletion', async () => {
  await withUploadHttpFixture(async (fixture, { client, service, headers }) => {
    const published = await preparePublication(fixture)
    await publicationTransaction(fixture, (transaction) =>
      publishBuild(transaction, published.context),
    )
    expect(await client.getDocument({ spaceId: fixture.id, documentId: fixture.id })).toMatchObject(
      {
        generation: '1',
        active: { versionId: fixture.id, buildId: fixture.id, treeBuildId: null },
        desired: null,
      },
    )
    const target = { spaceId: randomUUID(), documentId: randomUUID() }
    await client.createSpace({ spaceId: target.spaceId }, { title: 'Frozen space' })
    const document = await client.createDocument(target, uploadMetadata)
    await changeCapacityFixture(
      fixture,
      "UPDATE knowledge.kb_spaces SET state='frozen' WHERE owner_id=$1 AND id=$2",
      [target.spaceId],
    )
    expect((await client.listSpaces()).items).toContainEqual({
      id: target.spaceId,
      title: 'Frozen space',
      state: 'frozen',
    })
    expect(await client.getDocument(target)).toEqual(document)
    for (const scope of [
      { kind: 'document', ...target },
      { kind: 'space', spaceId: target.spaceId },
    ]) {
      const intentId = randomUUID()
      const response = await fetch(`${service.origin}/api/knowledge/deletions`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ id: intentId, scope }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ phase: 'deleted' })
      await expect(client.getDocument(target)).rejects.toMatchObject({
        problem: { code: 'NOT_FOUND' },
      })
      if (scope.kind === 'document')
        expect(await client.listDocuments({ spaceId: target.spaceId })).toEqual({
          items: [],
          nextCursor: null,
        })
    }
    expect((await client.listSpaces()).items.map((space) => space.id)).not.toContain(target.spaceId)
    await expect(client.listDocuments({ spaceId: target.spaceId })).rejects.toMatchObject({
      problem: { code: 'NOT_FOUND' },
    })
  })
})

it('hides children when their parent space is already deleting', async () => {
  await withUploadHttpFixture(async (fixture, { client }) => {
    const target = { spaceId: randomUUID(), documentId: randomUUID() }
    await client.createSpace({ spaceId: target.spaceId }, { title: 'Deleting space' })
    await client.createDocument(target, uploadMetadata)
    await changeCapacityFixture(
      fixture,
      "UPDATE knowledge.kb_spaces SET state='deleting' WHERE owner_id=$1 AND id=$2",
      [target.spaceId],
    )
    expect((await client.listSpaces()).items.map((space) => space.id)).not.toContain(target.spaceId)
    await expect(client.getDocument(target)).rejects.toMatchObject({
      problem: { code: 'NOT_FOUND' },
    })
    await expect(client.listDocuments({ spaceId: target.spaceId })).rejects.toMatchObject({
      problem: { code: 'NOT_FOUND' },
    })
  })
})

it.each(['active', 'frozen'] as const)(
  'deletes an empty %s space and replays its HTTP intent',
  async (state) => {
    await withUploadHttpFixture(async (fixture, { client, service, headers }) => {
      const spaceId = randomUUID()
      await client.createSpace({ spaceId }, { title: 'Empty space' })
      if (state === 'frozen')
        await changeCapacityFixture(
          fixture,
          "UPDATE knowledge.kb_spaces SET state='frozen' WHERE owner_id=$1 AND id=$2",
          [spaceId],
        )
      expect(await client.listDocuments({ spaceId })).toEqual({ items: [], nextCursor: null })
      const request = { id: randomUUID(), scope: { kind: 'space', spaceId } }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`${service.origin}/api/knowledge/deletions`, {
          method: 'DELETE',
          headers,
          body: JSON.stringify(request),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ intentId: request.id, phase: 'deleted' })
      }
      expect((await client.listSpaces()).items.map((space) => space.id)).not.toContain(spaceId)
      await expect(client.listDocuments({ spaceId })).rejects.toMatchObject({
        problem: { code: 'NOT_FOUND' },
      })
    })
  },
)

it('hides all owner metadata after HTTP account-scope deletion, including empty spaces', async () => {
  await withUploadHttpFixture(async (fixture, { client, service, headers }) => {
    const published = await preparePublication(fixture)
    await publicationTransaction(fixture, (transaction) =>
      publishBuild(transaction, published.context),
    )
    const spaceId = '00000000-0000-4000-8000-000000000001'
    await client.createSpace({ spaceId }, { title: 'First empty space' })
    const response = await fetch(`${service.origin}/api/knowledge/deletions`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ id: randomUUID(), scope: { kind: 'owner' } }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ phase: 'deleted' })
    expect(await client.listSpaces()).toEqual({ items: [], nextCursor: null })
    for (const deletedSpaceId of [spaceId, fixture.id])
      await expect(client.listDocuments({ spaceId: deletedSpaceId })).rejects.toMatchObject({
        problem: { code: 'NOT_FOUND' },
      })
    await expect(
      client.getDocument({ spaceId: fixture.id, documentId: fixture.id }),
    ).rejects.toMatchObject({ problem: { code: 'NOT_FOUND' } })
  })
})
