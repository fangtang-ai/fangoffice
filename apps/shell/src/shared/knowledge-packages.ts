export interface KnowledgeExpansionPack {
  id: string
  name: string
  priceFen: number
  storageMiB: number
}

/** Validate the public catalog; legacy wallet credits are not storage packs. */
export function readKnowledgeExpansionPacks(value: unknown): KnowledgeExpansionPack[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid knowledge catalog')
  const packs: KnowledgeExpansionPack[] = []
  const ids = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid knowledge package')
    const row = entry as Record<string, unknown>
    if (row.product !== 'knowledge_base') throw new Error('Invalid knowledge product')
    const terms = row.knowledgePlan
    if (!terms || typeof terms !== 'object' || Array.isArray(terms)) continue
    const plan = terms as Record<string, unknown>
    if (plan.permanent !== true) continue
    if (
      typeof row.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id) ||
      row.id.length > 80 ||
      ids.has(row.id) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > 80 ||
      typeof row.priceFen !== 'number' ||
      !Number.isSafeInteger(row.priceFen) ||
      row.priceFen <= 0 ||
      row.priceFen > 2147483647 ||
      typeof plan.storageMiB !== 'number' ||
      !Number.isInteger(plan.storageMiB) ||
      plan.storageMiB < 1 ||
      plan.storageMiB > 10240
    )
      throw new Error('Invalid knowledge package terms')
    ids.add(row.id)
    packs.push({ id: row.id, name: row.name, priceFen: row.priceFen, storageMiB: plan.storageMiB })
  }
  return packs
}
