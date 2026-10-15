import { parseKnowledgePagination, type KnowledgePagination } from './requests'
import { invalid, list, nullable, object, unique, uuid } from './validation'

export function parseKnowledgePage<Item extends { id: string }>(
  input: unknown,
  parseItem: (input: unknown) => Item,
  request: KnowledgePagination,
) {
  const expected = parseKnowledgePagination(request)
  const result = object({
    items: list((value) => parseItem(value), 0, expected.limit),
    nextCursor: nullable(uuid),
  })(input, 'page')
  unique(result.items, (item) => item.id, 'page.items')
  if (result.nextCursor !== null && result.nextCursor !== result.items.at(-1)?.id) {
    invalid('page.nextCursor')
  }
  if (expected.cursor !== null && result.items.some((item) => item.id === expected.cursor)) {
    invalid('page.items')
  }
  return result
}

export type KnowledgePage<Item extends { id: string }> = ReturnType<typeof parseKnowledgePage<Item>>
