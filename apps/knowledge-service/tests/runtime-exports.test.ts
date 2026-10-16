import { expect, it } from 'vitest'
import * as runtime from '../src/runtime'

it('exports controlled build publication through the public runtime entry', () => {
  expect(runtime).toHaveProperty('publishBuild', expect.any(Function))
})
