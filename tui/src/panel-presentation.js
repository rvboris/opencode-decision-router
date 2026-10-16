// Terminal-cell-aware presentation; no routing or aggregation logic here.
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const clean = (value) => String(value ?? 'не указан').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
const cells = (s) => {
  const cp = s.codePointAt(0);
  if (/^\p{Mark}+$/u.test(s)) return 0;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s) ||
    (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x20000)) ? 2 : 1;
};
export const cellWidth = (text) => [...segments.segment(text)].reduce((n, x) => n + cells(x.segment), 0);
export function fitLabel(value, width) {
  const text = clean(value).slice(0, 384);
  if (cellWidth(text) <= width) return text;
  let result = '', used = 0;
  for (const { segment } of segments.segment(text)) {
    const size = cells(segment);
    if (used + size > width - 1) break;
    result += segment; used += size;
  }
  return width > 0 ? result + '…' : '';
}
const pad = (text, width) => text + ' '.repeat(Math.max(0, width - cellWidth(text)));
export function tableRows(items, width, { bars = false, indent = '', countWidth = Math.max(1, ...items.map(x => String(x.count).length)) } = {}) {
  const graph = bars && width >= 48;
  const nameWidth = width - countWidth - 10 - (graph ? 9 : 0) - indent.length;
  return items.map(item => {
    const percent = Number.isFinite(item.percent) ? item.percent : 0;
    const numbers = `${String(item.count).padStart(countWidth)}  ${percent.toFixed(1).padStart(5)}%`;
    const tone = /^light(?:\s*\/|$)/.test(item.name) ? 'light' : /^heavy(?:\s*\/|$)/.test(item.name) ? 'heavy' : 'base';
    if (nameWidth < 6) return { text: `${fitLabel(indent + item.name, width)}\n${fitLabel(numbers.trimStart(), width)}`, tone };
    const filled = Math.round(Math.max(0, Math.min(100, percent)) / 100 * 8);
    return { text: `${indent}${pad(fitLabel(item.name, nameWidth), nameWidth)}  ${numbers}${graph ? ' ' + '━'.repeat(filled) + '·'.repeat(8 - filled) : ''}`, tone };
  });
}
export function scopeTabs(scope, width) {
  const labels = width >= 28 ? ['Сессия', 'Весь журнал'] : ['Сессия', 'Журнал'];
  return labels.map((label, i) => ({ text: (scope === (i ? 'all' : 'session') ? '▸ ' : '  ') + label, active: scope === (i ? 'all' : 'session') }));
}
