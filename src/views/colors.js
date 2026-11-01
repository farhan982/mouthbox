/* Pad colours.
 *
 * Ordered dark-to-bright to match the pad sort order (kick first), so the
 * colour of a lane roughly tells you how bright the sound is.
 */

export const PAD_COLORS = [
  '#f0567a',
  '#f08a4b',
  '#f2c14e',
  '#7bc96f',
  '#4bb3c4',
  '#6b8af2',
  '#a97bf2',
  '#f27bc4',
];

export function padColor(index) {
  return PAD_COLORS[index % PAD_COLORS.length];
}
