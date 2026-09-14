let sequence = 0;
export const row = (text = '', depth = 0) => ({ id: ++sequence, text, depth, folded: false });
export function parse(source) {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  source = source.slice(bom.length);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailing = source.endsWith('\n');
  const lines = source.split(/\r?\n/);
  if (trailing) lines.pop();
  const format = lines[0]?.startsWith('-') ? 'markdown' : 'text';
  let indent = ' ';
  const rows = lines.map(raw => {
    const prefix = raw.match(/^[ \t\u3000]*/u)[0];
    if (prefix) indent = prefix[0];
    let text = raw.slice(prefix.length);
    if (format === 'markdown') text = text.replace(/^-(?: |$)/, '');
    return { ...row(text, prefix.length), raw, originalText: text, originalDepth: prefix.length, prefix };
  });
  return { rows, format, newline, trailing, bom, indent };
}
export function serialize(doc) {
  return doc.bom + doc.rows.map(r => {
    if (r.raw !== undefined && r.text === r.originalText && r.depth === r.originalDepth) return r.raw;
    const prefix = r.depth === r.originalDepth ? r.prefix : doc.indent.repeat(r.depth);
    return (prefix ?? doc.indent.repeat(r.depth)) + (doc.format === 'markdown' ? '- ' : '') + r.text;
  }).join(doc.newline) + (doc.trailing ? doc.newline : '');
}
export function endOf(rows, index) {
  let end = index + 1;
  while (end < rows.length && rows[end].depth > rows[index].depth) end++;
  return end;
}
export function visible(rows) {
  const result = [];
  for (let i = 0; i < rows.length;) { result.push(i); i = rows[i].folded ? endOf(rows, i) : i + 1; }
  return result;
}
export function indentBlock(rows, index, delta) {
  const end = endOf(rows, index);
  if (rows[index].depth + delta < 0) return false;
  if (delta > 0 && (index === 0 || rows[index].depth >= rows[index - 1].depth + 1)) return false;
  for (let i = index; i < end; i++) rows[i].depth += delta;
  return true;
}
export function moveBefore(rows, index, target) {
  const end = endOf(rows, index);
  if (target >= index && target <= end) return false;
  const depth = rows[target]?.depth ?? 0;
  const block = rows.splice(index, end - index);
  const delta = depth - block[0].depth;
  block.forEach(r => r.depth += delta);
  rows.splice(target > index ? target - block.length : target, 0, ...block);
  return true;
}
export function moveBlock(rows, index, direction) {
  const depth = rows[index].depth;
  if (direction < 0) {
    let target = index - 1;
    while (target >= 0 && rows[target].depth > depth) target--;
    if (target < 0 || rows[target].depth !== depth) return false;
    return moveBefore(rows, index, target);
  }
  const end = endOf(rows, index);
  if (end >= rows.length || rows[end].depth !== depth) return false;
  const nextEnd = endOf(rows, end);
  const block = rows.splice(index, end - index);
  rows.splice(nextEnd - block.length, 0, ...block);
  return true;
}
