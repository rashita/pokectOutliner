import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize, endOf, visible, moveBlock, indentBlock, moveBefore } from '../src/model.js';
test('unchanged files round trip including BOM, mixed indent, blanks and CRLF', () => {
  for (const text of ['', 'hoge\n child\n　孫\n\tタブ\n', '\uFEFF- 親\r\n  - 子\r\n\r\n', '- a\n - b', 'a\n\n']) assert.equal(serialize(parse(text)), text);
});
test('one whitespace character is one level', () => { assert.deepEqual(parse('a\n b\n　c\n\td\n  e').rows.map(r => r.depth), [0,1,1,1,2]); });
test('markdown detection depends on first line', () => { assert.equal(parse('- a').format, 'markdown'); assert.equal(parse('a\n- b').format, 'text'); });
test('edit keeps original indentation and line endings', () => { const d = parse('- a\r\n\t - b\r\n'); d.rows[1].text = 'new'; assert.equal(serialize(d), '- a\r\n\t - new\r\n'); });
test('fold hides descendants, not next sibling', () => { const d = parse('a\n b\n  c\nd'); d.rows[0].folded = true; assert.equal(endOf(d.rows, 0),3); assert.deepEqual(visible(d.rows),[0,3]); });
test('block move carries descendants both ways', () => { const d = parse('a\n b\nc\n d'); assert.ok(moveBlock(d.rows,0,1)); assert.equal(serialize(d),'c\n d\na\n b'); assert.ok(moveBlock(d.rows,2,-1)); assert.equal(serialize(d),'a\n b\nc\n d'); });
test('indent and outdent apply to a whole subtree', () => { const d = parse('a\nb\n c'); assert.ok(indentBlock(d.rows,1,1)); assert.equal(serialize(d),'a\n b\n  c'); assert.ok(indentBlock(d.rows,1,-1)); assert.equal(serialize(d),'a\nb\n c'); assert.equal(indentBlock(d.rows,0,1),false); });
test('drag cannot put a block inside itself', () => { const d = parse('a\n b\nc'); assert.equal(moveBefore(d.rows,0,1),false); assert.equal(serialize(d),'a\n b\nc'); });
test('drag adopts destination depth with descendants intact', () => { const d = parse('a\n b\nc\n d'); assert.ok(moveBefore(d.rows,2,1)); assert.equal(serialize(d),'a\n c\n  d\n b'); });
