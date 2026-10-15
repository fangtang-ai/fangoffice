import { describe, expect, expectTypeOf, it } from 'vitest'
import { KnowledgeContractError, parseKnowledgeLocator } from '../src'
import { locatorContext, pdfLocator } from './locator-fixtures'

const context = locatorContext('pdf')

describe('physical PDF locators and source identity', () => {
  it('preserves physical page/block/span and explicit reliable geometry', () => {
    const result = parseKnowledgeLocator(pdfLocator, context)
    expect(result).toEqual(pdfLocator)
    if (result.format === 'pdf' && result.geometry !== null) {
      expectTypeOf(result.geometry.rotation).toEqualTypeOf<0 | 90 | 180 | 270>()
      expectTypeOf(result.schemaVersion).toEqualTypeOf<1>()
    }
    expect(parseKnowledgeLocator({ ...pdfLocator, geometry: null }, context).format).toBe('pdf')
    expect(
      parseKnowledgeLocator(
        { ...pdfLocator, geometry: { ...pdfLocator.geometry, bbox: null } },
        context,
      ),
    ).toEqual({ ...pdfLocator, geometry: { ...pdfLocator.geometry, bbox: null } })
  })

  it.each([
    { ...pdfLocator, physicalPage: 0 },
    { ...pdfLocator, physicalPage: '一' },
    { ...pdfLocator, blockIndex: -1 },
    { ...pdfLocator, spanIndex: 0.5 },
    { ...pdfLocator, schemaVersion: 2 },
    { ...pdfLocator, sourceHash: 'c'.repeat(64) },
    { ...pdfLocator, textHash: 'c'.repeat(64) },
    { ...pdfLocator, span: { ...pdfLocator.span, end: 6 } },
    { ...pdfLocator, span: { ...pdfLocator.span, start: 2, end: 2 } },
    { ...pdfLocator, page: 1 },
    { ...pdfLocator, owner: 'forged' },
  ])('rejects ambiguous page numbering, invalid spans or different sources: %j', (value) => {
    expect(() => parseKnowledgeLocator(value, context)).toThrow(KnowledgeContractError)
  })

  it.each([
    { ...pdfLocator.geometry, pageWidth: 0 },
    { ...pdfLocator.geometry, pageHeight: Infinity },
    { ...pdfLocator.geometry, rotation: 45 },
    { ...pdfLocator.geometry, origin: 'bottom-left' },
    { ...pdfLocator.geometry, unit: 'px' },
    { ...pdfLocator.geometry, bbox: { x0: -1, y0: 20, x1: 200, y1: 50 } },
    { ...pdfLocator.geometry, bbox: { x0: 10, y0: 20, x1: 613, y1: 50 } },
    { ...pdfLocator.geometry, bbox: { x0: 10, y0: 20, x1: 10, y1: 50 } },
    { ...pdfLocator.geometry, bbox: { x0: 10, y0: 20, x1: 200, y1: NaN } },
  ])('rejects misleading or out-of-page geometry: %j', (geometry) => {
    expect(() => parseKnowledgeLocator({ ...pdfLocator, geometry }, context)).toThrow(
      KnowledgeContractError,
    )
  })

  it('rejects an invalid or different caller source context', () => {
    expect(() => parseKnowledgeLocator(pdfLocator, locatorContext('docx'))).toThrow(
      KnowledgeContractError,
    )
    expect(() =>
      parseKnowledgeLocator(pdfLocator, { ...context, textCodePointLength: -1 }),
    ).toThrow(KnowledgeContractError)
    expect(() => parseKnowledgeLocator(pdfLocator, { ...context, ownerId: 'forged' })).toThrow(
      KnowledgeContractError,
    )
  })
})
