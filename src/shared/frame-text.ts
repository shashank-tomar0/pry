/** Conservative OCR gate: only skip spatially uniform tiles.
 * Inspect every pixel so small binary glyphs cannot fall between samples.
 */
export function tileLooksReadable(image: { data: Uint8ClampedArray }): boolean {
  const { data } = image;
  if (data.length < 4) return false;
  const r = data[0];
  const g = data[1];
  const b = data[2];
  for (let i = 4; i + 3 < data.length; i += 4) {
    if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b) return true;
  }
  return false;
}
