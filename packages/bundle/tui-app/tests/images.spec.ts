/**
 * Composer image markers: which markers a submission consumes and what text
 * reaches the model.
 */

import { describe, expect, it } from 'vitest'
import { imageMarker, parseImageMarkers } from '../src/images.ts'

describe('parseImageMarkers', () => {
  it('removes the markers of held images and reports them in content order', () => {
    const line = 'compare [Image #2] with [Image #1]'
    expect(parseImageMarkers(line, new Set([1, 2]))).toEqual({
      text: 'compare  with ',
      indices: [2, 1],
    })
  })

  it('keeps a marker whose image the draft no longer holds', () => {
    expect(parseImageMarkers('see [Image #3]', new Set([1]))).toEqual({
      text: 'see [Image #3]',
      indices: [],
    })
  })

  it('cites an image a repeated marker names only once', () => {
    expect(parseImageMarkers('[Image #1] and [Image #1]', new Set([1]))).toEqual({
      text: ' and ',
      indices: [1],
    })
  })

  it('reports nothing for a line without markers', () => {
    expect(parseImageMarkers('plain prompt', new Set([1]))).toEqual({ text: 'plain prompt', indices: [] })
  })
})

describe('imageMarker', () => {
  it('numbers the marker the composer shows', () => {
    expect(imageMarker(2)).toBe('[Image #2]')
  })
})
