/**
 * Composer image markers: the text token that stands for one held clipboard
 * image, and the fold that turns a submitted line back into its model-visible
 * text and its ordered images.
 *
 * The composer is a text editor, so an image it holds needs a text
 * representation that survives editing: a marker the user can delete like any
 * other character, and that a submission reads back to decide which images the
 * prompt still cites.
 * @module @deepseek-ai/dsh-tui-app/images
 */

/** Pattern matching one composer image marker. */
const MARKER_PATTERN = /\[Image #(\d+)\]/g

/**
 * The marker text the composer holds for the image numbered `index`.
 * @param index - the image's marker number, counted from one within the draft.
 * @returns the marker the composer inserts and a submission reads back.
 */
export function imageMarker(index: number): string {
  return `[Image #${String(index)}]`
}

/** One submitted composer line split into its text and the images it cites. */
export interface MarkedPrompt {
  /** The submitted line without the markers of images it still cites. */
  text: string
  /** Cited image numbers, in first-appearance order and without duplicates. */
  indices: number[]
}

/**
 * Read a submitted line's image markers.
 *
 * A marker whose image the composer no longer holds is literal user text and
 * stays in the prompt; a marker the composer still holds is removed, because the
 * image travels as its own content block exactly as it does on the other
 * surfaces.
 * @param line - the submitted composer text.
 * @param pending - image numbers the composer currently holds.
 * @returns the model-visible text and the cited images in content order.
 */
export function parseImageMarkers(line: string, pending: ReadonlySet<number>): MarkedPrompt {
  const indices: number[] = []
  const text = line.replace(MARKER_PATTERN, (match, digits: string) => {
    const index = Number(digits)
    if (!pending.has(index)) return match
    if (!indices.includes(index)) indices.push(index)
    return ''
  })
  return { text, indices }
}
