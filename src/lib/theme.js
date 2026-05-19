// Mushy design tokens — JS export.
// Dùng khi cần tham chiếu màu/font trong JSX inline style hoặc logic
// (vd: animated chart, conditional color). Mọi class CSS đã được lib/theme.css
// import sẵn — chỉ dùng file này khi cần value động.

export const colors = {
  brand: '#E63946',
  brandPressed: '#C92A39',
  brandSoft: '#FFE4E7',
  pink: '#FF6B81',
  pinkSoft: '#FFB3C1',

  ink: '#0F0F12',
  text: '#1A1A1F',
  muted: '#6B6770',
  hairline: 'rgba(15, 15, 18, 0.08)',

  bg: '#FFF7F8',
  surface: '#FFFFFF',
  surfaceMuted: '#FBEEF0',

  success: '#10B981',
  warn: '#F59E0B',
  danger: '#E63946',
};

// Giảm bo góc (sếp Huy 2026-05-19): card 28→20, list/tile → 14, pill 999.
export const radii = {
  card: 20,
  button: 999,  // pill
  input: 999,
  tile: 14,
  list: 14,     // list item / info row
};

export const fonts = {
  body: "'Be Vietnam Pro', system-ui, -apple-system, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
};
