import { parse, serialize, row, endOf, visible, parentOf, indentBlock, moveBlock, moveBefore } from './model.js';
const { invoke } = window.__TAURI__.core;
const win = window.__TAURI__.window.getCurrentWindow();
const $ = s => document.querySelector(s);
let doc = parse(''), path = null, saved = '', active = doc.rows[0].id;
let zoomRoot = null;
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
  win.setTitle((dirty ? '● ' : '') + name + ' — Pocket Outliner').catch(report);
  $('#status').textContent = '';
}
async function persistFolds() {
  if (serialize(doc) !== saved) return;
  await invoke('save_folds', { text: serialize(doc), folds: doc.rows.flatMap((r, i) => r.folded ? [i] : []) });
}
function setFolded(index, folded, position) {
  if (doc.rows[index].folded === folded) return;
  doc.rows[index].folded = folded; render(position);
  clearTimeout(foldTimer); foldTimer = setTimeout(() => persistFolds().catch(report), 300);
}
function resize(input) { input.style.height = '0'; input.style.height = input.scrollHeight + 'px'; }
function focus(id = active, position) {
  const input = document.getElementById(`row-${id}`);
  if (!input) return;
  active = id; input.focus();
  if (position !== undefined) input.setSelectionRange(position, position);
}
function zoomTo(id) {
  const position = document.getElementById(`row-${active}`)?.selectionStart;
  zoomRoot = id;
  const index = doc.rows.findIndex(r => r.id === id);
  if (doc.rows[index]?.folded) setFolded(index, false, position);
  else render(position);
}
function render(position) {
  const start = doc.rows.findIndex(r => r.id === zoomRoot);
  if (start < 0) zoomRoot = null;
  const zoomed = start >= 0;
  const end = zoomed ? endOf(doc.rows, start) : doc.rows.length;
  const baseDepth = zoomed ? doc.rows[start].depth : 0;
  const first = Math.max(0, start);
  if (zoomed && !doc.rows.slice(start, end).some(r => r.id === active)) active = zoomRoot;
  // Structural moves may place the selected row below a folded ancestor.
  const selected = doc.rows.findIndex(r => r.id === active);
  let depth = doc.rows[selected]?.depth ?? 0;
  for (let i = selected - 1; i >= first && depth > 0; i--) {
    if (doc.rows[i].depth < depth) { doc.rows[i].folded = false; depth = doc.rows[i].depth; }
  }
  const fragment = document.createDocumentFragment();
  const indices = visible(doc.rows, first, end);
  for (const index of indices) {
    const r = doc.rows[index], end = endOf(doc.rows, index), hasChildren = end > index + 1;
    const isZoomRoot = r.id === zoomRoot;
    const canOutdent = r.depth > 0 && (!zoomed || parentOf(doc.rows, index) > start);
    const insertionDepth = r.depth + Number(isZoomRoot);
    const insertRows = rows => {
      if (isZoomRoot) r.folded = false;
      doc.rows.splice(end, 0, ...rows);
    };
    const wrapper = document.createElement('div'); wrapper.className = 'row'; wrapper.style.setProperty('--depth', r.depth - baseDepth);
    const handle = document.createElement('button'); handle.className = 'handle'; handle.draggable = !isZoomRoot;
    handle.textContent = hasChildren ? (r.folded ? '▸' : '▾') : '·';
    handle.setAttribute('aria-label', hasChildren ? (r.folded ? '展開' : '折りたたむ') : isZoomRoot ? 'ズーム中の項目' : 'ブロックをドラッグ');
    if (hasChildren) handle.setAttribute('aria-expanded', String(!r.folded));
    handle.tabIndex = -1;
    handle.onclick = () => { active = r.id; if (hasChildren) setFolded(index, !r.folded); else focus(); };
    handle.ondragstart = e => { drag = r.id; e.dataTransfer.setData('text/plain', r.text); e.dataTransfer.effectAllowed = 'move'; };
    handle.ondragend = () => { drag = null; document.querySelectorAll('.drop').forEach(el => el.classList.remove('drop')); };
    wrapper.ondragover = e => { if (drag !== null && !isZoomRoot) { e.preventDefault(); wrapper.classList.add('drop'); } };
    wrapper.ondragleave = () => wrapper.classList.remove('drop');
    wrapper.ondrop = e => {
      e.preventDefault(); if (drag === null || isZoomRoot) return;
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
      const added = chunks.map(t => row(t, insertionDepth)); added.at(-1).text += tail;
      insertRows(added); active = added.at(-1).id; render(added.at(-1).text.length - tail.length); update();
    };
    input.onkeydown = e => {
      if (composing || e.isComposing || e.keyCode === 229) return;
      const i = doc.rows.findIndex(x => x.id === r.id), pos = input.selectionStart;
      if (e.key === 'Tab') { e.preventDefault(); if (isZoomRoot || (e.shiftKey && !canOutdent)) return; checkpoint(); indentBlock(doc.rows, i, e.shiftKey ? -1 : 1); render(pos); update(); }
      else if (e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        if (hasChildren) setFolded(i, e.key === 'ArrowUp', pos);
      }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.metaKey) return;
        checkpoint(); const next = row(r.text.slice(input.selectionEnd), insertionDepth);
        r.text = r.text.slice(0, pos); insertRows([next]); active = next.id; render(0); update();
      } else if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault(); if (isZoomRoot) return; checkpoint(); moveBlock(doc.rows, i, e.key === 'ArrowUp' ? -1 : 1); render(pos); update();
      } else if (!e.metaKey && !e.altKey && !e.shiftKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault(); const target = indices[indices.indexOf(i) + (e.key === 'ArrowUp' ? -1 : 1)];
        if (target !== undefined) focus(doc.rows[target].id, Math.min(pos, doc.rows[target].text.length));
      } else if (e.key === 'Backspace' && pos === 0 && input.selectionEnd === 0) {
        e.preventDefault();
        if (canOutdent) { checkpoint(); indentBlock(doc.rows, i, -1); render(0); update(); }
        else if (!isZoomRoot && r.text === '' && indices.length > 1 && endOf(doc.rows, i) === i + 1) {
          checkpoint(); const at = indices.indexOf(i); active = doc.rows[indices[at - 1] ?? indices[at + 1]].id;
          doc.rows.splice(i, 1); render(); update();
        }
      }
    };
    wrapper.append(handle, input);
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
$('#dismiss-help').onclick = () => $('#guide').close();
document.addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229 || !e.metaKey || document.querySelector('dialog[open]')) return;
  const key = e.key.toLowerCase();
  if (['z', 'w'].includes(key)) e.preventDefault();
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
const menuActions = {
  'new-document': () => invoke('create_document').catch(report),
  'open-document': () => invoke('open_documents').catch(report),
  'save-document': () => save(),
  'save-document-as': () => save(true),
  'zoom-row': () => zoomTo(active),
  'zoom-reset': () => { if (zoomRoot !== null) zoomTo(null); },
  'show-guide': () => $('#guide').showModal(),
};
await win.listen('menu-action', ({ payload }) => {
  if (!document.querySelector('dialog[open]')) menuActions[payload]();
});
await win.onCloseRequested(e => { e.preventDefault(); requestClose(); });
try {
  const loaded = await invoke('load_document'); path = loaded.path; doc = parse(loaded.text); saved = loaded.text;
  loaded.folds.forEach(i => { if (doc.rows[i]) doc.rows[i].folded = true; }); active = doc.rows[0].id; render(); update();
} catch (error) { render(); report(error); }
window.addEventListener('resize', () => document.querySelectorAll('.line').forEach(resize));
