// see docs/web-ui.md#fonts
export const FONT_KEY = 'slurp-font';
export const WORDMARK = 'SLURP';

export const FONT_STACKS = [
  { key: 'neo-grotesque', label: 'Neo-Grotesque', stack: "Inter, Roboto, 'Helvetica Neue', 'Arial Nova', 'Nimbus Sans', Arial, sans-serif" },
  { key: 'system-ui', label: 'System UI', stack: 'system-ui, sans-serif' },
  { key: 'industrial', label: 'Industrial', stack: "Bahnschrift, 'DIN Alternate', 'Franklin Gothic Medium', 'Nimbus Sans Narrow', sans-serif-condensed, sans-serif" },
  { key: 'humanist', label: 'Humanist', stack: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif" },
  { key: 'geometric-humanist', label: 'Geometric Humanist', stack: "Avenir, Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif" },
  { key: 'classical-humanist', label: 'Classical Humanist', stack: "Optima, Candara, 'Noto Sans', source-sans-pro, sans-serif" },
  { key: 'rounded-sans', label: 'Rounded Sans', stack: "ui-rounded, 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, Manjari, 'Arial Rounded MT', 'Arial Rounded MT Bold', Calibri, source-sans-pro, sans-serif" },
  { key: 'transitional', label: 'Transitional', stack: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, serif" },
  { key: 'old-style', label: 'Old Style', stack: "'Iowan Old Style', 'Palatino Linotype', 'URW Palladio L', P052, serif" },
  { key: 'slab-serif', label: 'Slab Serif', stack: "Rockwell, 'Rockwell Nova', 'Roboto Slab', 'DejaVu Serif', 'Sitka Small', serif" },
  { key: 'antique', label: 'Antique', stack: "Superclarendon, 'Bookman Old Style', 'URW Bookman', 'URW Bookman L', 'Georgia Pro', Georgia, serif" },
  { key: 'didone', label: 'Didone', stack: "Didot, 'Bodoni MT', 'Noto Serif Display', 'URW Palladio L', P052, Sylfaen, serif" },
  { key: 'monospace-code', label: 'Monospace Code', stack: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace" },
  { key: 'monospace-slab-serif', label: 'Monospace Slab Serif', stack: "'Nimbus Mono PS', 'Courier New', monospace" },
  { key: 'handwritten', label: 'Handwritten', stack: "'Segoe Print', 'Bradley Hand', Chilanka, TSCu_Comic, casual, cursive" },
] as const;

export const fontStack = (key: string | null) => (FONT_STACKS.find((f) => f.key === key) ?? FONT_STACKS[0]);

export function applyFont(key: string | null) {
  const font = fontStack(key);
  const root = document.documentElement;
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = `400 100px ${font.stack}`;
  root.dataset.font = font.key;
  root.style.setProperty('--font', font.stack);
  root.style.setProperty('--wordmark-glyphs', String(ctx.measureText(WORDMARK).width / 100));
}
