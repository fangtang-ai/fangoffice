import { expect, it } from 'vitest'
import { prepareHttpCompletion, withCompletionHttpFixture } from './upload-completion-http-fixtures'

it('completes verified real HTTP object bytes into an owner-scoped Version and desired pointer through the account client', async () => {
  await withCompletionHttpFixture(async (fixture, api, storage) => {
    const input = await prepareHttpCompletion(fixture, api, storage)
    const result = await api.client.completeUpload(input.target, input.request)
    expect(result.operation).toMatchObject({ id: input.request.operationId, ...input.target, phase: 'queued', expectedGeneration: '0' })
    expect(result.operation.targetVersionId).not.toBeNull()
    expect(await api.client.getDocument(input.target)).toMatchObject({ active: null, desired: { operationId: input.request.operationId, versionId: result.operation.targetVersionId } })
    expect(storage.requests.map((request) => request.method)).toEqual(['GET', 'PUT', 'GET'])
  })
})
