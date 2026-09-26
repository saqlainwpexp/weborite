/**
 * The Weborite "W" mark, drawn as lines (traced from the brand logo). Stroke it with currentColor at
 * W_STROKE and fill W_DOT: it reads white on the brand colour, like the logo file.
 */
export const W_VIEWBOX = "34 158 722 470";
export const W_RATIO = 470 / 722;
export const W_PATH = "M66.5 606.5V270.5L149 188l82.5 82.5v60M149 188v225M66.5 495.5l304-304M370.5 191.5h121v118h-121zM66.5 606.5h125l415-415M73.5 606.5l297-297M606.5 191.5h123v118h-123zM307.5 490.5v116h124l298-298M309.5 606.5l297-297";
export const W_STROKE = 14;
/** Thicker lines when the mark is drawn small, so it doesn't turn into hairlines. */
export const wStroke = (width: number) => (width < 60 ? 30 : width < 140 ? 22 : W_STROKE);
export const W_DOT = { x: 656, y: 542, width: 85, height: 72 };
