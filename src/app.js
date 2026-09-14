import { parse, serialize, row, endOf, visible, indentBlock, moveBlock, moveBefore } from './model.js';
const { invoke } = window.__TAURI__.core;
const win = window.__TAURI__.window.getCurrentWindow();
const $ = s => document.querySelector(s);
let doc = parse(''), path = null, saved = '', active = doc.rows[0].id;
let undo = [], redo = [], drag = null, saving = false, closing = false, foldTimer;
const snapshot = () => JSON.stringify({ doc, active });
function checkpoint() { undo.push(snapshot()); if (undo.length > 150) undo.shift(); redo = []; }
function history(from, to) {
  if (!from.length) return;
  to.push(snapshot()); ({ doc, active } = JSON.parse(from.pop())); render(); update();
}
function report(error) { $('#status').textContent = String(error); }
function update() {
  const dirty = serialize(doc) !== saved;
  const name = path?.split('/').pop() ?? '名称未設定';
  $('#name').textContent = (dirty ? '● ' : '') + name;
  win.setTitle((dirty ? '● ' : '') + name + ' — Pocket Outliner').catch(report);
  $('#format').textContent = `${doc.format === 'markdown' ? 'Markdown' : 'Text'} · ${doc.rows.length} 行`;
  $('#status').textContent = dirty ? '未保存' : '⌘ Enter 開閉 · Tab 階層 · ⌥ ↑↓ 移動';
}
async function persistFolds() {
  if (serialize(doc) !== saved) return;
  await invoke('save_folds', { text: serialize(doc), folds: doc.rows.flatMap((r, i) => r.folded ? [i] : []) });
}
function toggle(index) {
  doc.rows[index].folded = !doc.rows[index].folded; render();
  clearTimeout(foldTimer); foldTimer = setTimeout(() => persistFolds().catch(report), 300);
}
function resize(input) { input.style.height = '0'; input.style.height = input.scrollHeight + 'px'; }
function focus(id = active, position) {
  const input = document.getElementById(`row-${id}`);
  if (!input) return;
  active = id; input.focus();
  if (position !== undefined) input.setSelectionRange(position, position);
}
function render(position) {
  // Structural moves may place the selected row below a folded ancestor.
  const selected = doc.rows.findIndex(r => r.id === active);
  let depth = doc.rows[selected]?.depth ?? 0;
  for (let i = selected - 1; i >= 0 && depth > 0; i--) {
    if (doc.rows[i].depth < depth) { doc.rows[i].folded = false; depth = doc.rows[i].depth; }
  }
  const fragment = document.createDocumentFragment();
  for (const index of visible(doc.rows)) {
    const r = doc.rows[index], end = endOf(doc.rows, index), hasChildren = end > index + 1;
    const wrapper = document.createElement('div'); wrapper.className = 'row'; wrapper.style.setProperty('--depth', r.depth);
    const handle = document.createElement('button'); handle.className = 'handle'; handle.draggable = true;
    handle.textContent = hasChildren ? (r.folded ? '▸' : '▾') : '·';
    handle.setAttribute('aria-label', hasChildren ? (r.folded ? '展開' : '折りたたむ') : 'ブロックをドラッグ');
    if (hasChildren) handle.setAttribute('aria-expanded', String(!r.folded));
    handle.tabIndex = -1;
    handle.onclick = () => { active = r.id; if (hasChildren) toggle(index); else focus(); };
    handle.ondragstart = e => { drag = r.id; e.dataTransfer.setData('text/plain', r.text); e.dataTransfer.effectAllowed = 'move'; };
    handle.ondragend = () => { drag = null; document.querySelectorAll('.drop').forEach(el => el.classList.remove('drop')); };
    wrapper.ondragover = e => { if (drag !== null) { e.preventDefault(); wrapper.classList.add('drop'); } };
    wrapper.ondragleave = () => wrapper.classList.remove('drop');
    wrapper.ondrop = e => {
      e.preventDefault(); if (drag === null) return;
      checkpoint(); active = drag; moveBefore(doc.rows, doc.rows.findIndex(r => r.id === drag), index); drag = null; render(); update();
    };
    const input = document.createElement('textarea'); input.className = 'line'; input.id = `row-${r.id}`; input.rows = 1;
    input.value = r.text; input.spellcheck = false; input.setAttribute('aria-label', `${index + 1}行目、階層${r.depth + 1}`);
    input.onfocus = () => active = r.id;
    let composing = false;
    input.oncompositionstart = () => { checkpoint(); composing = true; };
    input.oncompositionend = () => { composing = false; r.text = input.value; resize(input); update(); };
    input.onbeforeinput = e => {
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault(); e.inputType === 'historyUndo' ? history(undo, redo) : history(redo, undo); return;
      }
      if (!composing && !e.isComposing) checkpoint();
    };
    input.oninput = () => { r.text = input.value; resize(input); update(); };
    input.onpaste = e => {
      const text = e.clipboardData.getData('text/plain');
      if (!/[\r\n]/.test(text)) return;
      e.preventDefault(); checkpoint();
      const chunks = text.replace(/\r\n?/g, '\n').split('\n');
      const tail = r.text.slice(input.selectionEnd);
      r.text = r.text.slice(0, input.selectionStart) + chunks.shift();
      const added = chunks.map(t => row(t, r.depth)); added.at(-1).text += tail;
      doc.rows.splice(endOf(doc.rows, index), 0, ...added); active = added.at(-1).id; render(added.at(-1).text.length - tail.length); update();
    };
    input.onkeydown = e => {
      if (composing || e.isComposing || e.keyCode === 229) return;
      const i = doc.rows.findIndex(x => x.id === r.id), pos = input.selectionStart;
      if (e.key === 'Tab') { e.preventDefault(); checkpoint(); indentBlock(doc.rows, i, e.shiftKey ? -1 : 1); render(pos); update(); }
      else if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); toggle(i); }
      else if (e.key === 'Enter') {
        e.preventDefault(); checkpoint(); const next = row(r.text.slice(input.selectionEnd), r.depth);
        r.text = r.text.slice(0, pos); doc.rows.splice(endOf(doc.rows, i), 0, next); active = next.id; render(0); update();
      } else if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault(); checkpoint(); moveBlock(doc.rows, i, e.key === 'ArrowUp' ? -1 : 1); render(pos); update();
      } else if (!e.metaKey && !e.altKey && !e.shiftKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault(); const indices = visible(doc.rows); const target = indices[indices.indexOf(i) + (e.key === 'ArrowUp' ? -1 : 1)];
        if (target !== undefined) focus(doc.rows[target].id, Math.min(pos, doc.rows[target].text.length));
      } else if (e.key === 'Backspace' && pos === 0 && input.selectionEnd === 0) {
        e.preventDefault();
        if (r.depth > 0) { checkpoint(); indentBlock(doc.rows, i, -1); render(0); update(); }
        else if (r.text === '' && doc.rows.length > 1 && endOf(doc.rows, i) === i + 1) {
          checkpoint(); const indices = visible(doc.rows); const at = indices.indexOf(i); active = doc.rows[indices[at - 1] ?? indices[at + 1]].id;
          doc.rows.splice(i, 1); render(); update();
        }
      }
    };
    wrapper.append(handle, input);
    if (hasChildren && r.folded) { const count = document.createElement('span'); count.className = 'count'; count.textContent = end - index - 1; wrapper.append(count); }
    fragment.append(wrapper);
  }
  $('#outline').replaceChildren(fragment);
  document.querySelectorAll('.line').forEach(resize); focus(active, position);
}
async function save(saveAs = false) {
  if (saving) return false;
  saving = true;
  const text = serialize(doc);
  try {
    const result = await invoke('save_document', { text, saveAs, markdown: doc.format === 'markdown' });
    if (!result) return false;
    path = result; saved = text; update(); await persistFolds().catch(report); return true;
  } catch (error) { report(error); return false; } finally { saving = false; }
}
$('#new').onclick = () => invoke('create_document').catch(report);
$('#open').onclick = () => invoke('open_documents').catch(report);
$('#save').onclick = () => save();
$('#help').onclick = () => $('#guide').showModal();
$('#dismiss-help').onclick = () => $('#guide').close();
document.addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229 || !e.metaKey || document.querySelector('dialog[open]')) return;
  const key = e.key.toLowerCase();
  if (['s', 'o', 'n', 'z', 'w'].includes(key)) e.preventDefault();
  if (key === 's') save(e.shiftKey);
  if (key === 'o') $('#open').click();
  if (key === 'n') $('#new').click();
  if (key === 'z') e.shiftKey ? history(redo, undo) : history(undo, redo);
  if (key === 'w') requestClose();
});
async function requestClose() {
  if (closing || saving) return;
  closing = true;
  try {
    if (serialize(doc) !== saved) {
      const dialog = $('#unsaved');
      const choice = await new Promise(resolve => {
        dialog.oncancel = e => { e.preventDefault(); dialog.close(); resolve('cancel'); };
        dialog.querySelectorAll('button').forEach(b => b.onclick = () => { dialog.close(); resolve(b.dataset.choice); });
        dialog.showModal();
      });
      if (choice === 'cancel' || (choice === 'save' && !(await save()))) return;
    }
    await persistFolds().catch(report); await win.destroy();
  } catch (error) { report(error); } finally { closing = false; }
}
await win.onCloseRequested(e => { e.preventDefault(); requestClose(); });
try {
  const loaded = await invoke('load_document'); path = loaded.path; doc = parse(loaded.text); saved = loaded.text;
  loaded.folds.forEach(i => { if (doc.rows[i]) doc.rows[i].folded = true; }); active = doc.rows[0].id; render(); update();
} catch (error) { render(); report(error); }
window.addEventListener('resize', () => document.querySelectorAll('.line').forEach(resize));
