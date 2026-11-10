const $ = id => document.getElementById(id);
const drop = $('drop'), input = $('input'), filesEl = $('files'), actions = $('actions'), results = $('results');
const convertBtn = $('convert'), progress = $('progress'), toolbar = $('toolbar');
const API = location.protocol === 'file:' ? 'http://localhost:5000' : '';
let items = [], busy = false, mode = 'word';
const MODES = {
  editor: { title: 'Edit <em>PDF</em> files', lead: 'Change text, add text, highlight, cover or draw on a PDF, then save it as a PDF or a Word document.',
          accept: '.pdf', re: /\.pdf$/i, pick: '', hint: '', go: '', tag: 'PDF', url: '', suffix: '' },
  word: { title: 'Convert WORD to <em>PDF</em>', lead: 'Turn DOC and DOCX files into PDFs using Microsoft Word installed on this computer. Nothing is ever uploaded to the internet.',
          accept: '.doc,.docx', re: /\.docx?$/i, pick: 'Select WORD files', hint: 'or drop DOC / DOCX files here', go: 'Convert to PDF', tag: 'DOCX', url: '/convert' },
  pdf2word: { title: 'Convert PDF to <em>WORD</em>', lead: 'Turn PDF files into editable DOCX documents. Conversion runs on this computer, nothing is uploaded to the internet.',
          accept: '.pdf', re: /\.pdf$/i, pick: 'Select PDF files', hint: 'or drop PDF files here', go: 'Convert to Word', tag: 'PDF', url: '/pdf2word', ext: '.docx', outTag: 'DOCX' },
  merge: { title: 'Merge <em>PDF</em> files', lead: 'Combine several PDFs into one document. Use the arrows to put them in the order you want.',
          accept: '.pdf', re: /\.pdf$/i, pick: 'Select PDF files', hint: 'or drop PDF files here', go: 'Merge PDF', tag: 'PDF', url: '/merge' },
  split: { title: 'Split <em>PDF</em> by pages', lead: 'Keep only the pages you need. Enter page numbers and ranges, like 1-3, 5, 8-10.',
          accept: '.pdf', re: /\.pdf$/i, pick: 'Select PDF files', hint: 'or drop PDF files here', go: 'Extract pages', tag: 'PDF', url: '/split' },
  compress: { title: 'Compress <em>PDF</em> files', lead: 'Reduce the file size of your PDFs while keeping them readable.',
          accept: '.pdf', re: /\.pdf$/i, pick: 'Select PDF files', hint: 'or drop PDF files here', go: 'Compress PDF', tag: 'PDF', url: '/compress' },
  protect: { title: 'Protect <em>PDF</em> with a password', lead: 'Encrypt your PDFs with AES-256 so only people with the password can open them.',
          accept: '.pdf', re: /\.pdf$/i, pick: 'Select PDF files', hint: 'or drop PDF files here', go: 'Protect PDF', tag: 'PDF', url: '/protect', suffix: '-protected',
          fields: [{ name: 'password', label: 'Password', type: 'password', ph: 'At least 4 characters', req: 'Enter a password of at least 4 characters' }] },
  unlock: { title: 'Unlock <em>PDF</em> files', lead: 'Remove the password from a PDF you own, so it opens without one.',
          accept: '.pdf', re: /\.pdf$/i, pick: 'Select PDF files', hint: 'or drop PDF files here', go: 'Unlock PDF', tag: 'PDF', url: '/unlock', suffix: '-unlocked',
          fields: [{ name: 'password', label: 'Current password', type: 'password', ph: 'Password of the PDF', req: 'Enter the PDF’s current password' }] },
  rotate: { title: 'Rotate <em>PDF</em> pages', lead: 'Turn every page, or only the pages you choose, to the right orientation.',
          accept: '.pdf', re: /\.pdf$/i, pick: 'Select PDF files', hint: 'or drop PDF files here', go: 'Rotate PDF', tag: 'PDF', url: '/rotate', suffix: '-rotated',
          fields: [{ name: 'angle', label: 'Rotate', type: 'select', options: [['90', '90° right'], ['180', '180°'], ['270', '90° left']] },
                   { name: 'pages', label: 'Pages', ph: 'All pages, or e.g. 1-3, 5' }] },
  watermark: { title: 'Add a watermark to <em>PDF</em>', lead: 'Stamp text such as CONFIDENTIAL or DRAFT across every page.',
          accept: '.pdf', re: /\.pdf$/i, pick: 'Select PDF files', hint: 'or drop PDF files here', go: 'Add watermark', tag: 'PDF', url: '/watermark', suffix: '-watermarked',
          fields: [{ name: 'text', label: 'Text', ph: 'CONFIDENTIAL', req: 'Enter the watermark text' },
                   { name: 'position', label: 'Position', type: 'select', options: [['diagonal', 'Diagonal'], ['center', 'Center'], ['bottom', 'Bottom']] },
                   { name: 'opacity', label: 'Strength', type: 'select', options: [['0.1', 'Light'], ['0.2', 'Medium'], ['0.4', 'Strong']], val: '0.2' }] },
};
MODES.split.fields = [{ name: 'pages', label: 'Pages to keep', ph: 'e.g. 1-3, 5, 8-10', req: 'Enter the pages to keep, e.g. 1-3, 5' }];
MODES.split.suffix = '-pages'; MODES.compress.suffix = '-compressed'; MODES.word.suffix = ''; MODES.merge.suffix = ''; MODES.pdf2word.suffix = '';

function renderFields(m) {
  const box = $('opts'); box.innerHTML = '';
  (MODES[m].fields || []).forEach(f => {
    const w = document.createElement('div'); w.className = 'fld';
    const l = document.createElement('label'); l.htmlFor = 'f_' + f.name; l.textContent = f.label; w.appendChild(l);
    let el;
    if (f.type === 'select') {
      el = document.createElement('select');
      f.options.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; el.appendChild(o); });
      if (f.val) el.value = f.val;
    } else {
      el = document.createElement('input'); el.type = f.type || 'text'; el.placeholder = f.ph || ''; el.autocomplete = 'off';
      el.addEventListener('keydown', e => { if (e.key === 'Enter' && !convertBtn.disabled) convertAll(); });
    }
    el.id = 'f_' + f.name; w.appendChild(el); box.appendChild(w);
  });
}

// returns FormData extras, or null (after warning) when a required field is empty
function readFields() {
  const out = [];
  for (const f of MODES[mode].fields || []) {
    const el = $('f_' + f.name), v = el.value.trim();
    if (f.req && !v) { el.focus(); toast(f.req); return null; }
    out.push([f.name, f.type === 'password' ? el.value : v]);
  }
  return out;
}

const icon = id => `<svg><use href="#${id}"/></svg>`;
const COMMON_FAQ =['Are my files uploaded anywhere?', 'No. The page talks only to the converter running on this computer. Files are processed in a temporary folder and are never sent over the internet.'];
const CONTENT = {
  editor: {
    sub: 'Make quick changes to a PDF without leaving your computer.',
    steps: [['Open a PDF', 'Select a text-based PDF or drop it onto the page.'],
            ['Edit it', 'Click any text to retype it, or use Add text, Highlight, Cover and Draw. Undo anything.'],
            ['Save', 'Download the result as a PDF, or as an editable Word document.']],
    faq: [COMMON_FAQ,
          ['Can I change any text?', 'Yes, any real text. You edit one line at a time and the line keeps its first font, size and color. Scanned pages are images, so there is no text to change (use Add text or Cover on those).'],
          ['What happens to the original text?', 'It is removed from the PDF and replaced with your new text, not just hidden under it.'],
          ['Why does the Word version look different?', 'Word files are rebuilt from the PDF layout. Simple documents come out close; complex layouts may need touch-ups.'],
          ['Are password-protected PDFs supported?', 'Not directly. Use the Unlock PDF tool first.']] },
  pdf2word: {
    sub: 'Get an editable Word document from any text-based PDF.',
    steps: [['Add your PDFs', 'Drag and drop PDF files, or browse to select as many as you like.'],
            ['Convert', 'Text, tables, images and layout are rebuilt as an editable DOCX on this PC.'],
            ['Download', 'Save the Word files one by one, or grab everything as a ZIP.']],
    faq: [COMMON_FAQ,
          ['Will the layout match exactly?', 'Simple documents convert very closely. Complex layouts may need small touch-ups in Word.'],
          ['Does it work on scanned PDFs?', 'No. Scanned pages are images, and this tool does not do OCR, so there is no text to edit.'],
          ['Can I convert a password-protected PDF?', 'Not directly. Use the Unlock PDF tool first, then convert.']] },
  word: {
    sub: 'No installs, no accounts. Drop your documents and get PDFs back.',
    steps: [['Add your files', 'Drag and drop Word documents, or browse to select as many as you like.'],
            ['Convert', 'Microsoft Word on this PC renders each document, so the PDF looks like the original.'],
            ['Download', 'Save PDFs one by one, grab everything as a ZIP, or merge them into a single file.']],
    faq: [COMMON_FAQ,
          ['Which file types are supported?', 'Both legacy .doc and modern .docx files. Other formats such as .odt or .rtf are not supported.'],
          ['Why did a conversion fail?', 'The error is shown on the file’s row. Common causes are a password-protected or corrupted document. Fix the file and press Retry.'],
          ['Is there a size or page limit?', 'No built-in limit. Very large documents simply take longer because Word has to render every page.']] },
  merge: {
    sub: 'Combine PDFs in a few clicks, in exactly the order you choose.',
    steps: [['Add PDFs', 'Select two or more PDF files, or drop them onto the page.'],
            ['Set the order', 'Use the ▲ ▼ buttons so the files are listed the way you want them merged.'],
            ['Merge', 'Click Merge PDF and your combined document downloads as merged.pdf.']],
    faq: [COMMON_FAQ,
          ['How many files can I merge?', 'Two or more, with no built-in limit. Page order follows the order of the list.'],
          ['Can I merge password-protected PDFs?', 'Not directly. Remove the password first, then merge.']] },
  split: {
    sub: 'Extract just the pages you need into a new PDF.',
    steps: [['Add a PDF', 'Select one or more PDF files, or drop them onto the page.'],
            ['Choose pages', 'Type page numbers and ranges, like 1-3, 5, 8-10. Pages keep the order you type them in.'],
            ['Extract', 'Click Extract pages and download the new, shorter PDF.']],
    faq: [COMMON_FAQ,
          ['What page format is accepted?', 'Single pages and ranges separated by commas, for example 1-3, 5, 8-10. Numbers start at 1.'],
          ['What happens with an out-of-range page?', 'You get a clear error such as “Page range 9 is outside 1-3” and nothing is changed.']] },
  compress: {
    sub: 'Make PDFs smaller for sharing, with no quality settings to fiddle with.',
    steps: [['Add PDFs', 'Select one or more PDF files, or drop them onto the page.'],
            ['Compress', 'Each file is repacked locally, removing duplicate data and compressing page content.'],
            ['Compare and download', 'See the before and after size on each row, then download the results or a ZIP.']],
    faq: [COMMON_FAQ,
          ['How much smaller will my PDF get?', 'It depends on the file. PDFs made by Word are already compact, so savings can be small; files with duplicated or uncompressed content shrink more.'],
          ['Does compression reduce image quality?', 'No. Images are left untouched, which is why it is lossless but not as aggressive as dedicated image compressors.']] },
};

Object.assign(CONTENT, {
  protect: {
    sub: 'Lock a PDF in seconds. The password never leaves this computer.',
    steps: [['Add PDFs', 'Select one or more PDF files, or drop them onto the page.'],
            ['Set a password', 'Choose a password of at least 4 characters. Use a longer one for sensitive files.'],
            ['Protect', 'Each file is encrypted with AES-256 and offered as a download or a ZIP.']],
    faq: [COMMON_FAQ,
          ['Can you recover a forgotten password?', 'No. The password is not stored anywhere, so keep it safe. Without it the file cannot be opened.'],
          ['Which encryption is used?', 'AES-256, the same standard used by modern PDF readers for password protection.']] },
  unlock: {
    sub: 'Remove the password from a PDF you have the password for.',
    steps: [['Add PDFs', 'Select the password-protected PDF files, or drop them onto the page.'],
            ['Enter the password', 'Type the current password. If several files share it, they unlock together.'],
            ['Unlock', 'You get a copy that opens without a password. The original is not changed.']],
    faq: [COMMON_FAQ,
          ['Can this crack a password I forgot?', 'No. You must know the current password. This tool only removes protection you can already open.'],
          ['What does “Wrong password” mean?', 'The password did not match this PDF. Check the capitalization and try again.']] },
  rotate: {
    sub: 'Fix sideways scans and landscape pages without opening an editor.',
    steps: [['Add PDFs', 'Select one or more PDF files, or drop them onto the page.'],
            ['Pick the angle', 'Choose 90° right, 180° or 90° left. Leave Pages empty to rotate every page.'],
            ['Rotate', 'Download the corrected PDF, or enter pages like 1-3, 5 to rotate only those.']],
    faq: [COMMON_FAQ,
          ['Can I rotate only some pages?', 'Yes. Type the page numbers or ranges, for example 2, 4-6. Other pages stay as they are.'],
          ['Is the content re-rendered?', 'No. Only the page rotation flag changes, so text and images keep full quality.']] },
  watermark: {
    sub: 'Mark documents as confidential, draft or approved before you share them.',
    steps: [['Add PDFs', 'Select one or more PDF files, or drop them onto the page.'],
            ['Design the mark', 'Type the text, then choose its position and how strong it should look.'],
            ['Stamp', 'The watermark is added to every page and the result is ready to download.']],
    faq: [COMMON_FAQ,
          ['Can the watermark be removed later?', 'It is merged into the page content, so it is not a separate layer, but it is not a security feature. Use Protect PDF for that.'],
          ['Does it support images or other languages?', 'Currently plain Latin text only (letters, numbers, common punctuation).']] },
});

const TRUST = {
  editor: ['Edit existing text', 'Save as PDF or Word'],
  protect: ['AES-256 encryption', 'Password never stored'],
  unlock: ['Original file untouched', 'Needs the current password'],
  rotate: ['No quality loss', 'Whole file or chosen pages'],
  watermark: ['Diagonal, center or bottom', 'Adjustable strength'],
  pdf2word: ['Editable .docx output', 'Text, tables & images'],
  word: ['Supports .doc & .docx', 'Fonts & layout preserved'],
  merge: ['Any number of PDFs', 'You choose the order'],
  split: ['Ranges like 1-3, 5, 8-10', 'Original quality kept'],
  compress: ['Lossless, images untouched', 'See size before & after'],
};

function renderContent(m) {
  const c = CONTENT[m];
  $('trust').innerHTML = [...TRUST[m], 'No sign-up, no limits'].map(t => `<span>${icon('i-check')} ${t.replace(/&/g, '&amp;')}</span>`).join('');
  $('howSub').textContent = c.sub;
  $('steps').innerHTML = '';
  c.steps.forEach(([h, p], i) => {
    const d = document.createElement('div'); d.className = 'card step';
    d.innerHTML = `<div class="num">${i + 1}</div><h3></h3><p></p>`;
    d.querySelector('h3').textContent = h; d.querySelector('p').textContent = p; $('steps').appendChild(d);
  });
  $('faqList').innerHTML = '';
  c.faq.forEach(([q, a]) => {
    const d = document.createElement('details'); d.innerHTML = '<summary></summary><p></p>';
    d.querySelector('summary').textContent = q; d.querySelector('p').textContent = a; $('faqList').appendChild(d);
  });
}

function setMode(m) {
  if (busy || m === mode) return;
  items.forEach(i => i.url && URL.revokeObjectURL(i.url)); items = [];
  mode = m; const c = MODES[m];
  document.querySelectorAll('#tools button[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  $('moreBtn').classList.toggle('active', !!$('menu').querySelector('.active'));
  closeMenu(); renderFields(m);
  document.querySelector('.tool').hidden = m === 'editor'; $('editorApp').hidden = m !== 'editor';
  $('title').innerHTML = c.title; $('lead').textContent = c.lead;
  input.accept = c.accept; $('pickLabel').textContent = c.pick; $('dropHint').textContent = c.hint; $('convertLabel').textContent = c.go;
  document.title = c.title.replace(/<\/?em>/g, '') + ' – BP';
  renderContent(m);
  draw();
}
$('title').innerHTML = MODES.word.title; $('lead').textContent = MODES.word.lead; renderContent('word');
setMode('editor'); // Edit PDF only
function closeMenu() { $('menu').classList.remove('open'); $('moreBtn').setAttribute('aria-expanded', 'false'); }
$('moreBtn').onclick = e => { e.stopPropagation(); const open = $('menu').classList.toggle('open'); $('moreBtn').setAttribute('aria-expanded', open); };
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
document.querySelectorAll('#tools button[data-mode]').forEach(b => b.onclick = () => { setMode(b.dataset.mode); history.replaceState(null, '', '#' + b.dataset.mode); });
$('year').textContent = new Date().getFullYear();

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

// theme
const root = document.documentElement;
if (localStorage.theme) root.dataset.theme = localStorage.theme;
$('theme').onclick = () => {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = localStorage.theme = dark ? 'light' : 'dark';
};

$('pick').onclick = () => input.click();
input.onchange = () => { addFiles(input.files); input.value = ''; };
['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
// Accept files dropped anywhere on the page (the drop zone shrinks once files are listed)
const hasFiles = ev => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
window.addEventListener('dragover', ev => { if (hasFiles(ev)) ev.preventDefault(); });
window.addEventListener('drop', ev => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  drop.classList.remove('over');
  if (mode === 'editor') {
    const fs = Array.from(ev.dataTransfer.files);
    if (fs.length && fs.every(f => f.type.startsWith('image/')) && window.editorAddImages) editorAddImages(fs);   // images dropped outside a page
    else if (fs[0] && window.openEditor) openEditor(fs[0]);
    return;
  }
  if (!busy && ev.dataTransfer.files.length) addFiles(ev.dataTransfer.files);
});
$('clear').onclick = () => { if (!busy) { items.forEach(i => i.url && URL.revokeObjectURL(i.url)); items = []; draw(); } };

const size = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const pdfName = it => {
  return it.file.name.replace(/\.(docx?|pdf)$/i, '') + MODES[mode].suffix + (MODES[mode].ext || '.pdf');
};

function addFiles(list) {
  const bad = [];
  for (const f of list) {
    if (!MODES[mode].re.test(f.name)) { bad.push(f.name); continue; }
    items.push({ file: f, state: 'ready' });
  }
  if (bad.length) toast(`Skipped (not ${mode === 'word' ? 'Word' : 'PDF'} files): ` + bad.join(', '));
  draw();
}

function move(i, d) { [items[i], items[i + d]] = [items[i + d], items[i]]; draw(); }

function draw() {
  filesEl.innerHTML = '';
  items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'file ' + it.state;
    row.innerHTML = `<div class="ficon">${it.state === 'done' ? (MODES[mode].outTag || 'PDF') : MODES[mode].tag}</div>
      <div class="info"><div class="name"></div><div class="meta"></div></div><div class="end"></div>`;
    row.querySelector('.name').textContent = it.file.name;
    row.querySelector('.name').title = it.file.name;
    if (!busy && items.length > 1) {
      row.draggable = true;
      row.addEventListener('dragstart', ev => { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(i)); row.classList.add('dragging'); });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', ev => { ev.preventDefault(); row.classList.add('dropat'); });
      row.addEventListener('dragleave', () => row.classList.remove('dropat'));
      row.addEventListener('drop', ev => {
        if (hasFiles(ev)) return; // external files: handled by the page-level drop
        ev.preventDefault();
        const from = Number(ev.dataTransfer.getData('text/plain'));
        if (Number.isInteger(from) && from !== i) { items.splice(i, 0, items.splice(from, 1)[0]); }
        draw();
      });
    }
    const meta = row.querySelector('.meta'), end = row.querySelector('.end');
    const btn = (svg, title, fn, dis, cls = 'ic') => {
      const b = document.createElement('button'); b.className = cls; b.innerHTML = svg; b.title = title; b.setAttribute('aria-label', title);
      b.onclick = fn; b.disabled = !!dis; end.appendChild(b); return b;
    };
    if (it.state === 'working') {
      meta.textContent = 'Converting…';
      end.innerHTML = '<div class="spin"></div>';
    } else {
      if (it.state === 'ready') meta.textContent = size(it.file.size);
      if (it.state === 'error') {
        meta.textContent = it.error;
        btn('Retry', 'Retry this file', () => { it.state = 'ready'; convertAll(); }, busy, 'retry');
      }
      if (it.state === 'done') {
        meta.textContent = `${size(it.file.size)} → ${size(it.blob.size)}`;
        const a = document.createElement('a'); a.className = 'dl'; a.href = it.url; a.download = pdfName(it);
        a.innerHTML = icon('i-download') + 'Download'; end.appendChild(a);
      }
      btn(icon('i-up'), 'Move up', () => move(i, -1), busy || i === 0);
      btn(icon('i-down'), 'Move down', () => move(i, 1), busy || i === items.length - 1);
      btn(icon('i-x'), 'Remove', () => { if (it.url) URL.revokeObjectURL(it.url); items.splice(i, 1); draw(); }, busy, 'ic keep');
    }
    filesEl.appendChild(row);
  });
  const done = items.filter(i => i.state === 'done').length;
  const pending = items.some(it => it.state === 'ready' || it.state === 'error');
  drop.classList.toggle('compact', items.length > 0);
  toolbar.style.display = items.length ? 'flex' : 'none';
  $('count').textContent = `${items.length} file${items.length === 1 ? '' : 's'}` + (done ? ` · ${done} converted` : '');
  actions.style.display = items.length && pending ? 'flex' : 'none';
  convertBtn.disabled = busy || (mode === 'merge' && items.length < 2);
  $('opts').style.display = (MODES[mode].fields || []).length && items.length ? 'flex' : 'none';
  results.style.display = done && mode !== 'merge' ? 'flex' : 'none';
  $('merge').style.display = done > 1 && mode === 'word' ? '' : 'none';
}

async function post(url, fd) {
  let res;
  try { res = await fetch(API + url, { method: 'POST', body: fd }); }
  catch { throw new Error('Cannot reach the converter. Is server.py running?'); }
  if (!res.ok) {
    const t = await res.text();
    const m = t.match(/<p>([\s\S]*?)<\/p>/);
    throw new Error((m ? m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&') : t).slice(0, 300));
  }
  return res.blob();
}

async function mergeAll() {
  busy = true; draw();
  const fd = new FormData();
  items.forEach(i => fd.append('file', i.file, i.file.name));
  try { save(await post('/merge', fd), 'merged.pdf'); toast(`Merged ${items.length} PDFs`); }
  catch (e) { toast('Merge failed: ' + e.message); }
  busy = false; draw();
}

async function convertAll() {
  if (mode === 'merge') return mergeAll();
  const extra = readFields();
  if (!extra) return;
  busy = true;
  const todo = items.filter(i => i.state === 'ready' || i.state === 'error');
  let n = 0;
  progress.style.display = 'block'; progress.firstElementChild.style.width = '0';
  for (const it of todo) {
    it.state = 'working'; draw();
    try {
      const fd = new FormData(); fd.append('file', it.file);
      extra.forEach(([k, v]) => fd.append(k, v));
      it.blob = await post(MODES[mode].url, fd);
      it.url = URL.createObjectURL(it.blob);
      it.state = 'done';
    } catch (e) { console.error(e); it.error = e.message; it.state = 'error'; }
    progress.firstElementChild.style.width = (++n / todo.length * 100) + '%';
  }
  busy = false; draw();
  const failed = todo.filter(i => i.state === 'error').length;
  toast(failed ? `${todo.length - failed} done, ${failed} failed` : `Done — ${todo.length} file${todo.length === 1 ? '' : 's'} processed`);
  setTimeout(() => progress.style.display = 'none', 800);
}
convertBtn.onclick = convertAll;

function save(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('merge').onclick = async () => {
  const fd = new FormData();
  items.filter(i => i.state === 'done').forEach(i => fd.append('file', i.blob, pdfName(i)));
  try { save(await post('/merge', fd), 'merged.pdf'); } catch (e) { toast('Merge failed: ' + e.message); }
};

// minimal store-only ZIP writer
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xEDB88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc32 = b => { let c = ~0; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };
async function makeZip(entries) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  for (const { name, blob } of entries) {
    const data = new Uint8Array(await blob.arrayBuffer()), nm = enc.encode(name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    parts.push(h, nm, data); central.push(c, nm); off += 30 + nm.length + data.length;
  }
  const csize = central.reduce((s, p) => s + p.byteLength, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

$('zip').onclick = async () => {
  const used = new Set();
  const entries = items.filter(i => i.state === 'done').map(i => {
    let name = pdfName(i), k = 1;
    while (used.has(name)) name = pdfName(i).replace(/(\.\w+)$/, ` (${k++})$1`);
    used.add(name); return { name, blob: i.blob };
  });
  save(await makeZip(entries), mode === 'pdf2word' ? 'converted-docs.zip' : 'converted-pdfs.zip');
};

// ---------------------------------------------------------------- PDF editor
(() => {
const el = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const clone = o => JSON.parse(JSON.stringify(o));
const ed = { sid: null, name: '', pages: [], ops: [], undo: [], redo: [], tool: 'select', zoom: 1.4, sel: null,
             deleted: new Set(), lines: {}, ver: {}, nid: 1, editNode: null, imgs: {}, imgN: 1, hover: null, images: {}, selImg: null };
const colors = { select: '#000000', text: '#000000', highlight: '#ffe600', whiteout: '#ffffff', draw: '#e11d48' };
const sizes = { select: 12, text: 12, highlight: 12, whiteout: 12, draw: 2 };
const errText = t => { const m = t.match(/<p>([\s\S]*?)<\/p>/); return (m ? m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&') : t).slice(0, 300); };
const fam = o => o.mono ? '"Courier New",Courier,monospace' : o.serif ? '"Times New Roman",Times,serif' : 'Arial,Helvetica,sans-serif';
const pageEl = i => el('edPages').children[i];
const stageOf = i => pageEl(i).querySelector('.stage');
const opById = id => ed.ops.find(o => o.id === id);
const isEditable = n => n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));

// ---- history
function commit(before) {
  if (JSON.stringify(before) !== JSON.stringify(ed.ops)) {
    ed.undo.push(before); if (ed.undo.length > 100) ed.undo.shift(); ed.redo = [];
  }
  syncBtns();
}
function mutate(fn) { const before = clone(ed.ops); fn(); commit(before); }
function syncBtns() { el('edUndo').disabled = !ed.undo.length; el('edRedo').disabled = !ed.redo.length; }
function stepHistory(from, to) {
  if (document.activeElement && isEditable(document.activeElement)) document.activeElement.blur();
  if (!from.length) return;
  to.push(clone(ed.ops)); ed.ops = from.pop(); ed.sel = null; renderAll(); syncBtns(); updateControls();
}

// ---- selection / controls
function applySel() {
  document.querySelectorAll('#edPages [data-id]').forEach(n => n.classList.toggle('sel', Number(n.dataset.id) === ed.sel));
  document.querySelectorAll('#edPages .imgex').forEach(n => n.classList.toggle('sel', !!ed.selImg && ed.selImg.page === Number(n.dataset.pg) && ed.selImg.ix === Number(n.dataset.ix)));
}
function select(id) { ed.sel = id; ed.selImg = null; applySel(); updateControls(); }
// remove an image that is already part of the PDF: recorded as an edit so it can be undone
function removeExisting(pg, ix) {
  const im = (ed.images[pg] || [])[ix]; if (!im) return;
  mutate(() => ed.ops.push({ id: ed.nid++, t: 'delimg', page: pg, xref: im.xref, bbox: im.bbox }));
  ed.selImg = null; ed.sel = null; renderPage(pg); updateControls();
}
const textDef = { serif: false, mono: false, bold: false, italic: false, underline: false, align: 'left', opacity: 1, fill: null };
function syncTextOpts() {
  const o = ed.sel && opById(ed.sel), isT = !!o && o.t === 'text';
  el('edTextOpts').hidden = !(isT || (!o && ed.tool === 'text'));
  const v = isT ? o : textDef;
  el('edFont').value = v.mono ? 'mono' : v.serif ? 'serif' : 'sans';
  el('edB').classList.toggle('active', !!v.bold); el('edI').classList.toggle('active', !!v.italic); el('edU').classList.toggle('active', !!v.underline);
  el('edAlign').value = v.align || 'left';
  el('edOpacity').value = Math.round((v.opacity == null ? 1 : v.opacity) * 100);
  el('edBgOn').checked = !!v.fill; if (v.fill) el('edBg').value = v.fill;
}
function updateControls() {
  syncTextOpts();
  const o = ed.sel && opById(ed.sel);
  if (o) {
    el('edColor').value = o.t === 'rect' || o.t === 'draw' || o.t === 'text' || o.t === 'replace' ? (o.color || '#000000') : '#000000';
    el('edSize').value = o.t === 'draw' ? o.width : o.t === 'rect' || o.t === 'image' || o.t === 'delimg' ? '' : o.size;
  } else {
    el('edColor').value = colors[ed.tool]; el('edSize').value = sizes[ed.tool];
  }
}
function setTool(t) {
  ed.tool = t; ed.sel = null;
  document.querySelectorAll('#edTools button[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  document.querySelectorAll('#edPages .stage').forEach(s => s.className = 'stage t-' + t);
  applySel(); updateControls();
}

// ---- rendering
function layout() {
  ed.pages.forEach((p, i) => { const s = stageOf(i); s.style.width = p.w * ed.zoom + 'px'; s.style.height = p.h * ed.zoom + 'px'; });
  el('edZoomLbl').textContent = Math.round(ed.zoom * 100) + '%';
}
function renderAll() { ed.pages.forEach((_, i) => renderPage(i)); }

function styleText(n, o) {
  n.style.fontFamily = fam(o); n.style.fontWeight = o.bold ? 700 : 400; n.style.fontStyle = o.italic ? 'italic' : 'normal';
  n.style.fontSize = o.size * ed.zoom + 'px'; n.style.color = o.color;
  if (o.t === 'text') {   // extra options only exist on text added by the user
    n.style.textDecoration = o.underline ? 'underline' : 'none';
    n.style.textAlign = o.align || 'left';
    n.style.opacity = o.opacity == null ? 1 : o.opacity;
    n.style.background = o.fill || 'transparent';
    n.style.boxShadow = o.fill ? `0 0 0 ${2 * ed.zoom}px ${o.fill}` : 'none';
  }
}

const area = b => (b[2] - b[0]) * (b[3] - b[1]);
function renderPage(i) {
  const ov = stageOf(i).querySelector('.ov'), z = ed.zoom;
  ov.innerHTML = '';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'draws'); ov.appendChild(svg);
  const edited = new Set(ed.ops.filter(o => o.t === 'replace' && o.page === i).map(o => o.line));
  const gone = ed.ops.filter(o => o.t === 'delimg' && o.page === i);
  (ed.images[i] || []).map((im, ix) => ({ im, ix })).filter(({ im }) => !gone.some(g => g.xref === im.xref && g.bbox[0] === im.bbox[0] && g.bbox[1] === im.bbox[1]))
    .sort((a, b) => area(b.im.bbox) - area(a.im.bbox)).forEach(({ im, ix }) => {   // big images underneath, small on top
      const d = document.createElement('div'); d.className = 'imgex'; d.dataset.pg = i; d.dataset.ix = ix; d.title = area(im.bbox) < ed.pages[i].w * ed.pages[i].h * .9 ? 'Click to remove this image (Undo brings it back)' : 'Click to select this large image, then press Delete to remove it';
      d.style.cssText = `left:${im.bbox[0] * z}px;top:${im.bbox[1] * z}px;width:${(im.bbox[2] - im.bbox[0]) * z}px;height:${(im.bbox[3] - im.bbox[1]) * z}px`;
      const rm = document.createElement('div'); rm.className = 'rm'; rm.textContent = '✕'; rm.title = 'Remove this image from the PDF';
      rm.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); removeExisting(i, ix); });
      d.appendChild(rm);
      d.addEventListener('pointerdown', ev => { if (ev.button !== 0 || ev.target === rm) return; ev.preventDefault(); ev.stopPropagation();
        const pg = ed.pages[i];   // one click removes normal images; page-sized backgrounds are only selected, so a stray click can't wipe them
        if (area(im.bbox) < pg.w * pg.h * .9) removeExisting(i, ix);
        else { ed.sel = null; ed.selImg = { page: i, ix }; applySel(); updateControls(); } });
      ov.appendChild(d);
    });
  (ed.lines[i] || []).forEach((ln, k) => {
    if (edited.has(k)) return;
    const h = document.createElement('div'); h.className = 'hit';
    h.style.cssText = `left:${ln.bbox[0] * z - 1}px;top:${ln.bbox[1] * z - 1}px;width:${(ln.bbox[2] - ln.bbox[0]) * z + 2}px;height:${(ln.bbox[3] - ln.bbox[1]) * z + 2}px`;
    h.title = 'Click to edit this text';
    h.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      ev.preventDefault(); ev.stopPropagation();
      const before = clone(ed.ops);
      const o = { id: ed.nid++, t: 'replace', page: i, line: k, bbox: ln.bbox, origin: ln.origin, spans: ln.spans, orig: ln.text, text: ln.text,
                  size: ln.size, color: ln.color, bold: ln.bold, italic: ln.italic, serif: ln.serif, mono: ln.mono, bg: ln.bg };
      ed.ops.push(o);
      const n = drawOp(o, ov, svg); h.remove(); beginRepEdit(n, o, before, i);
    });
    ov.appendChild(h);
  });
  ed.ops.filter(o => o.page === i).forEach(o => drawOp(o, ov, svg));
  applySel();
}

const shapeRadius = s => s === 'ellipse' ? '50%' : s === 'round' ? '12px' : '0';
function drawOp(o, ov, svg) {
  const z = ed.zoom;
  if (o.t === 'replace') {
    const n = document.createElement('div'); n.className = 'rep'; n.dataset.id = o.id; n.textContent = o.text;
    const [x0, y0, x1, y1] = o.bbox;
    n.style.cssText += `left:${x0 * z - 1}px;top:${y0 * z}px;height:${(y1 - y0) * z}px;min-width:${(x1 - x0) * z + 2}px;padding-left:1px;background:rgb(${o.bg.join(',')})`;
    styleText(n, o);
    n.addEventListener('mousedown', ev => {
      if (ev.button !== 0 || n.classList.contains('editing')) return;
      ev.preventDefault(); ev.stopPropagation();
      beginRepEdit(n, o, clone(ed.ops), o.page);
    });
    ov.appendChild(n); return n;
  }
  if (o.t === 'text') {
    const n = document.createElement('div'); n.className = 'tbox'; n.dataset.id = o.id;
    n.style.left = o.x * z + 'px'; n.style.top = o.y * z + 'px';
    const tx = document.createElement('span'); tx.className = 'tx'; tx.contentEditable = 'plaintext-only'; tx.textContent = o.text;
    tx.style.cssText = 'display:block;outline:none;min-width:8px;user-select:text;cursor:text';
    styleText(tx, o); n.style.lineHeight = '1.2';
    const mv = document.createElement('div'); mv.className = 'mv'; mv.textContent = '✥'; mv.title = 'Drag to move'; mv.contentEditable = 'false';
    const rm = document.createElement('div'); rm.className = 'rm'; rm.textContent = '✕'; rm.title = 'Delete'; rm.contentEditable = 'false';
    mv.style.display = rm.style.display = 'none';
    n.append(tx, mv, rm);
    let before = null;
    tx.addEventListener('focus', () => { if (!before) before = clone(ed.ops); select(o.id); mv.style.display = rm.style.display = ''; });
    tx.addEventListener('input', () => { o.text = tx.innerText.replace(/\n$/, ''); });
    tx.addEventListener('blur', () => {
      o.text = tx.innerText.replace(/\n$/, '');
      if (!o.text.trim()) { ed.ops = ed.ops.filter(x => x !== o); n.remove(); }
      commit(before || clone(ed.ops)); before = null;
      if (ed.sel !== o.id) mv.style.display = rm.style.display = 'none';
    });
    n.addEventListener('pointerdown', ev => { ev.stopPropagation(); if (ed.sel !== o.id) select(o.id); });
    n.__start = b => { before = b; };
    rm.addEventListener('mousedown', ev => { ev.preventDefault(); ev.stopPropagation(); mutate(() => { ed.ops = ed.ops.filter(x => x !== o); }); n.remove(); ed.sel = null; });
    mv.addEventListener('pointerdown', ev => {
      ev.preventDefault(); ev.stopPropagation(); mv.setPointerCapture(ev.pointerId);
      const b = clone(ed.ops), sx = ev.clientX, sy = ev.clientY, ox = o.x, oy = o.y;
      const move = e => { o.x = ox + (e.clientX - sx) / ed.zoom; o.y = oy + (e.clientY - sy) / ed.zoom; n.style.left = o.x * ed.zoom + 'px'; n.style.top = o.y * ed.zoom + 'px'; };
      const up = () => { mv.removeEventListener('pointermove', move); mv.removeEventListener('pointerup', up); commit(b); };
      mv.addEventListener('pointermove', move); mv.addEventListener('pointerup', up);
    });
    ov.appendChild(n); return n;
  }
  if (o.t === 'delimg') {
    const n = document.createElement('div'); n.className = 'shape ghost'; n.dataset.id = o.id;
    const gp = ed.pages[o.page], gx0 = Math.max(o.bbox[0], 0), gy0 = Math.max(o.bbox[1], 0), gx1 = Math.min(o.bbox[2], gp.w), gy1 = Math.min(o.bbox[3], gp.h);   // clamp to the page
    n.style.cssText = `left:${gx0 * z}px;top:${gy0 * z}px;width:${Math.max(gx1 - gx0, 0) * z}px;height:${Math.max(gy1 - gy0, 0) * z}px;cursor:pointer`;
    const l = document.createElement('div'); l.className = 'lbl'; l.textContent = 'Image removed'; n.appendChild(l);
    const rm = document.createElement('div'); rm.className = 'rm'; rm.textContent = '↶'; rm.title = 'Restore this image'; rm.style.background = '#2563eb';
    rm.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); mutate(() => { ed.ops = ed.ops.filter(x => x !== o); }); ed.sel = null; renderPage(o.page); updateControls(); });
    n.appendChild(rm);
    n.addEventListener('pointerdown', ev => { if (ev.target !== rm) { ev.stopPropagation(); select(o.id); } });
    ov.appendChild(n); return n;
  }
  if (o.t === 'image') {
    const im = ed.imgs[o.img]; if (!im) return null;
    const n = document.createElement('div'); n.className = 'imgop'; n.dataset.id = o.id;
    const place = () => { n.style.left = o.x * ed.zoom + 'px'; n.style.top = o.y * ed.zoom + 'px'; n.style.width = o.w * ed.zoom + 'px'; n.style.height = o.h * ed.zoom + 'px'; };
    place();
    const img = document.createElement('img'); img.src = im.url; img.alt = ''; img.draggable = false; n.appendChild(img);
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(h => { const d = document.createElement('div'); d.className = 'rh'; d.dataset.h = h; n.appendChild(d); });
    const rm = document.createElement('div'); rm.className = 'rm'; rm.textContent = '✕'; rm.title = 'Delete'; n.appendChild(rm);
    rm.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); mutate(() => { ed.ops = ed.ops.filter(x => x !== o); }); n.remove(); ed.sel = null; updateControls(); });
    n.addEventListener('pointerdown', ev => {
      if (ev.button !== 0 || ev.target === rm) return;
      ev.preventDefault(); ev.stopPropagation();
      if (ed.sel !== o.id) select(o.id);
      const h = ev.target.dataset && ev.target.dataset.h;   // resize handle, or undefined = move
      const b = clone(ed.ops), sx = ev.clientX, sy = ev.clientY, ox = o.x, oy = o.y, ow = o.w, oh = o.h, ar = ow / oh;
      n.setPointerCapture(ev.pointerId);
      const move = e => {
        const dx = (e.clientX - sx) / ed.zoom, dy = (e.clientY - sy) / ed.zoom, MIN = 8;
        const pg = ed.pages[o.page], PW = pg.w, PH = pg.h;   // keep the image inside the page
        if (!h) { o.x = Math.min(Math.max(ox + dx, 0), Math.max(PW - ow, 0)); o.y = Math.min(Math.max(oy + dy, 0), Math.max(PH - oh, 0)); }
        else {
          let x0 = ox, y0 = oy, x1 = ox + ow, y1 = oy + oh;
          if (h.includes('w')) x0 = Math.max(Math.min(ox + dx, x1 - MIN), 0); if (h.includes('e')) x1 = Math.min(Math.max(x1 + dx, x0 + MIN), PW);
          if (h.includes('n')) y0 = Math.max(Math.min(oy + dy, y1 - MIN), 0); if (h.includes('s')) y1 = Math.min(Math.max(y1 + dy, y0 + MIN), PH);
          if (h.length === 2 && !e.shiftKey) {   // corners keep the aspect ratio (hold Shift to stretch freely)
            let w = x1 - x0, hh = y1 - y0;
            if (w / hh > ar) w = hh * ar; else hh = w / ar;
            if (h.includes('w')) x0 = x1 - w; else x1 = x0 + w;
            if (h.includes('n')) y0 = y1 - hh; else y1 = y0 + hh;
          }
          o.x = x0; o.y = y0; o.w = x1 - x0; o.h = y1 - y0;
        }
        place();
      };
      const up = () => { n.removeEventListener('pointermove', move); n.removeEventListener('pointerup', up); n.removeEventListener('pointercancel', up); commit(b); };
      n.addEventListener('pointermove', move); n.addEventListener('pointerup', up); n.addEventListener('pointercancel', up);
    });
    ov.appendChild(n); return n;
  }
  if (o.t === 'rect') {
    const n = document.createElement('div'); n.className = 'shape'; n.dataset.id = o.id;
    n.style.cssText = `left:${o.x * z}px;top:${o.y * z}px;width:${o.w * z}px;height:${o.h * z}px;background:${o.color};opacity:${o.opacity};cursor:pointer;border-radius:${shapeRadius(o.shape)}`;
    n.addEventListener('pointerdown', ev => { ev.stopPropagation(); select(o.id); });
    ov.appendChild(n); return n;
  }
  if (o.t === 'draw') {
    const p = document.createElementNS(NS, 'polyline'); p.dataset.id = o.id;
    p.setAttribute('points', o.pts.map(([x, y]) => `${x * z},${y * z}`).join(' '));
    p.setAttribute('stroke', o.color); p.setAttribute('stroke-width', o.width * z);
    p.addEventListener('pointerdown', ev => { ev.stopPropagation(); select(o.id); });
    svg.appendChild(p); return p;
  }
}

function beginRepEdit(n, o, before, pageIdx) {
  n.contentEditable = 'plaintext-only'; n.classList.add('editing'); n.style.userSelect = 'text'; n.style.cursor = 'text';
  ed.editNode = n; select(o.id);
  let cancelled = false;
  n.addEventListener('input', () => { o.text = n.innerText.replace(/\n/g, ' '); });
  n.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); n.blur(); }
    else if (ev.key === 'Escape') { cancelled = true; ed.ops = before; n.blur(); }
  });
  n.addEventListener('blur', () => {
    if (!cancelled) {
      o.text = n.innerText.replace(/\n/g, ' ');
      if (o.text === o.orig) ed.ops = ed.ops.filter(x => x !== o);
      commit(before);
    }
    n.contentEditable = 'false'; n.classList.remove('editing');
    if (ed.editNode === n) ed.editNode = null;
    // rebuild once nothing else is being edited (restores the hover box when the edit was reverted/cancelled)
    setTimeout(() => { if (!ed.editNode && !isEditable(document.activeElement) && ed.sid) renderPage(pageIdx); }, 0);
  }, { once: true });
  n.focus();
  const r = document.createRange(); r.selectNodeContents(n); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

// ---- creating items on the page
const pt = (ev, stage) => { const r = stage.getBoundingClientRect(); return [(ev.clientX - r.left) / ed.zoom, (ev.clientY - r.top) / ed.zoom]; };

// ---- images: upload button, paste, drag & drop (all land on the page under the pointer, else the page in view)
const MAX_IMG_PX = 2400;
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  const im = new Image(); im.src = url;
  try { await im.decode(); } catch { URL.revokeObjectURL(url); throw new Error(`“${file.name || 'pasted image'}” is not a supported image`); }
  let { naturalWidth: nw, naturalHeight: nh } = im, blob = file, outUrl = url;
  const scale = Math.min(1, MAX_IMG_PX / Math.max(nw, nh));
  if (scale < 1 || !/^image\/(png|jpeg)$/.test(file.type)) {   // downscale huge images; convert gif/webp/etc. to PNG for the PDF
    const c = document.createElement('canvas'); c.width = Math.round(nw * scale); c.height = Math.round(nh * scale);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    blob = await new Promise(r => c.toBlob(r, type, .92));
    URL.revokeObjectURL(url); outUrl = URL.createObjectURL(blob); nw = c.width; nh = c.height;
  }
  return { blob, url: outUrl, nw, nh };
}
function visiblePlace() {   // centre of whichever page fills most of the viewport
  let best = null, bestV = -1;
  ed.pages.forEach((p, i) => {
    if (ed.deleted.has(i)) return;
    const r = stageOf(i).getBoundingClientRect(), v = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    if (v > bestV) { bestV = v; best = { i, r }; }
  });
  if (!best) return null;
  const cy = Math.min(Math.max(innerHeight / 2, best.r.top), best.r.bottom);
  return { page: best.i, x: ed.pages[best.i].w / 2, y: (cy - best.r.top) / ed.zoom };
}
async function addImages(files, at) {
  if (!ed.sid) return toast('Open a PDF first');
  const imgs = files.filter(f => /^image\//.test(f.type));
  if (!imgs.length) return toast('Please choose an image file');
  at = at || ed.hover || visiblePlace(); if (!at) return;
  const before = clone(ed.ops); let added = 0, k = 0;
  for (const f of imgs) {
    let m; try { m = await prepareImage(f); } catch (e) { toast(e.message); continue; }
    const key = ed.imgN++; ed.imgs[key] = m;
    const pg = ed.pages[at.page];
    let w = Math.min(m.nw * .75, pg.w * .5, 400), h = w * m.nh / m.nw;   // 96dpi px → pt, capped to half a page
    if (h > pg.h * .6) { h = pg.h * .6; w = h * m.nw / m.nh; }
    let cy = at.y - h / 2 + k * 16;
    if (at.fit) {   // clicked between two sections: shrink to the empty band there and centre in it
      const ls = ed.lines[at.page] || [];
      const top = Math.max(0, ...ls.filter(l => l.bbox[3] <= at.y).map(l => l.bbox[3]));
      const bot = Math.min(pg.h, ...ls.filter(l => l.bbox[1] >= at.y).map(l => l.bbox[1]));
      const gap = bot - top - 8;
      if (gap >= 24) {
        if (h > gap) { h = gap; w = h * m.nw / m.nh; }
        const maxW = pg.w - 40; if (w > maxW) { w = maxW; h = w * m.nh / m.nw; }
        cy = top + 4 + (gap - h) / 2;
      } else toast('Not enough empty space between those lines — the image will overlap; resize it or click a bigger gap');
    }
    const x = Math.min(Math.max(at.x - w / 2 + k * 16, 0), pg.w - w), y = Math.min(Math.max(cy, 0), pg.h - h);
    ed.ops.push({ id: ed.nid++, t: 'image', page: at.page, x, y, w, h, img: key }); added++; k++;
  }
  if (!added) return;
  commit(before); renderPage(at.page);
  setTool('select'); select(ed.ops[ed.ops.length - 1].id);
  toast(added > 1 ? `Added ${added} images` : 'Image added — drag to move, drag the handles to resize');
}
window.editorAddImages = files => addImages(files);

function wireStage(stage, i) {
  const ov = stage.querySelector('.ov');
  stage.addEventListener('pointermove', ev => { const [x, y] = pt(ev, stage); ed.hover = { page: i, x, y }; });
  stage.addEventListener('pointerleave', () => { ed.hover = null; });
  const hasImg = ev => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
  stage.addEventListener('dragover', ev => { if (hasImg(ev)) { ev.preventDefault(); stage.classList.add('dropimg'); } });
  stage.addEventListener('dragleave', () => stage.classList.remove('dropimg'));
  stage.addEventListener('drop', ev => {
    if (!hasImg(ev)) return;
    ev.preventDefault(); ev.stopPropagation(); stage.classList.remove('dropimg');
    const [x, y] = pt(ev, stage); addImages(Array.from(ev.dataTransfer.files), { page: i, x, y });
  });
  stage.addEventListener('pointerdown', ev => {   // an image is waiting: drop it exactly where the user clicks
    if (!ed.pendingImgs || ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const files = ed.pendingImgs; setPendingImgs(null);
    const [x, y] = pt(ev, stage); addImages(files, { page: i, x, y, fit: true });
  }, true);
  stage.addEventListener('mousedown', ev => { if (ed.tool !== 'select') ev.preventDefault(); });
  stage.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    const t = ed.tool;
    if (t === 'select') { if (ev.target === stage || ev.target === ov || ev.target.tagName === 'svg') select(null); return; }
    ev.preventDefault();
    const [x, y] = pt(ev, stage);
    if (t === 'text') {
      const before = clone(ed.ops), size = sizes.text;
      const o = { id: ed.nid++, t: 'text', page: i, x: x, y: y - size * .6, text: '', size, color: colors.text, ...textDef };
      ed.ops.push(o);
      const n = drawOp(o, ov, ov.querySelector('svg.draws')); n.__start(before);
      n.querySelector('.tx').focus();
      return;
    }
    stage.setPointerCapture(ev.pointerId);
    const svg = ov.querySelector('svg.draws');
    if (t === 'draw') {
      const pts = [[x, y]], p = document.createElementNS(NS, 'polyline');
      p.setAttribute('stroke', colors.draw); p.setAttribute('stroke-width', sizes.draw * ed.zoom); svg.appendChild(p);
      const move = e => { pts.push(pt(e, stage).map(v => Math.round(v * 10) / 10)); p.setAttribute('points', pts.map(([a, b]) => `${a * ed.zoom},${b * ed.zoom}`).join(' ')); };
      const up = () => {
        stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerup', up); p.remove();
        if (pts.length < 2) return;
        mutate(() => ed.ops.push({ id: ed.nid++, t: 'draw', page: i, pts, color: colors.draw, width: sizes.draw }));
        renderPage(i);
      };
      stage.addEventListener('pointermove', move); stage.addEventListener('pointerup', up);
    } else { // highlight / whiteout
      const box = document.createElement('div'); box.className = 'shape';
      box.style.cssText = `left:${x * ed.zoom}px;top:${y * ed.zoom}px;width:0;height:0;background:${colors[t]};opacity:${t === 'highlight' ? .4 : 1};outline:1px dashed #2563eb;border-radius:${shapeRadius(el('edShape').value)}`;
      ov.appendChild(box);
      let cur = [x, y];
      const move = e => {
        cur = pt(e, stage);
        box.style.left = Math.min(x, cur[0]) * ed.zoom + 'px'; box.style.top = Math.min(y, cur[1]) * ed.zoom + 'px';
        box.style.width = Math.abs(cur[0] - x) * ed.zoom + 'px'; box.style.height = Math.abs(cur[1] - y) * ed.zoom + 'px';
      };
      const up = () => {
        stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerup', up); box.remove();
        const w = Math.abs(cur[0] - x), h = Math.abs(cur[1] - y);
        if (w * ed.zoom < 4 || h * ed.zoom < 4) return;
        mutate(() => ed.ops.push({ id: ed.nid++, t: 'rect', page: i, x: Math.min(x, cur[0]), y: Math.min(y, cur[1]), w, h, color: colors[t], opacity: t === 'highlight' ? .4 : 1, shape: el('edShape').value }));
        renderPage(i);
      };
      stage.addEventListener('pointermove', move); stage.addEventListener('pointerup', up);
    }
  });
}

// ---- opening a file
function build() {
  const box = el('edPages'); box.innerHTML = '';
  ed.pages.forEach((p, i) => {
    const w = document.createElement('div'); w.className = 'edpage';
    w.innerHTML = `<div class="ph"><span>Page ${i + 1}</span><span class="grow"></span><button data-a="rot">Rotate</button><button data-a="del">Delete page</button></div>
      <div class="stage t-${ed.tool}"><img alt="Page ${i + 1}"><div class="ov"></div></div>`;
    w.querySelector('img').src = `${API}/editor/${ed.sid}/page/${i}?v=${ed.ver[i] = 0}`;
    wireStage(w.querySelector('.stage'), i);
    w.querySelector('[data-a=del]').onclick = e => {
      if (ed.deleted.has(i)) ed.deleted.delete(i);
      else if (ed.deleted.size + 1 >= ed.pages.length) return toast('A PDF needs at least one page');
      else ed.deleted.add(i);
      w.classList.toggle('deleted', ed.deleted.has(i));
      e.target.textContent = ed.deleted.has(i) ? 'Restore page' : 'Delete page';
    };
    w.querySelector('[data-a=rot]').onclick = async () => {
      if (ed.ops.some(o => o.page === i)) return toast('Undo or finish the edits on this page before rotating it');
      try {
        const r = await fetch(`${API}/editor/${ed.sid}/rotate/${i}`, { method: 'POST' });
        if (!r.ok) throw new Error(errText(await r.text()));
        ed.pages[i] = await r.json(); ed.lines[i] = []; ed.images[i] = [];
        w.querySelector('img').src = `${API}/editor/${ed.sid}/page/${i}?v=${++ed.ver[i]}`;
        layout(); renderPage(i);
      } catch (e) { toast('Rotate failed: ' + e.message); }
    };
    box.appendChild(w);
  });
  layout(); renderAll();
}

async function loadLines(sid) {
  for (let i = 0; i < ed.pages.length; i++) {
    try {
      const r = await fetch(`${API}/editor/${sid}/lines/${i}`);
      if (!r.ok || ed.sid !== sid) continue;
      ed.lines[i] = (await r.json()).lines;
      if (!ed.editNode) renderPage(i);
    } catch { /* page just stays non-editable */ }
    try {
      const r = await fetch(`${API}/editor/${sid}/images/${i}`);
      if (!r.ok || ed.sid !== sid) continue;
      ed.images[i] = (await r.json()).images;
      if (!ed.editNode) renderPage(i);
    } catch { /* images on this page just can't be selected */ }
  }
}

window.openEditor = async file => {
  if (!file || !/\.pdf$/i.test(file.name)) return toast('Please choose a PDF file');
  if (ed.ops.length && !confirm('Open a new file? Your unsaved edits will be lost.')) return;
  const fd = new FormData(); fd.append('file', file);
  let j;
  try {
    let r;
    try { r = await fetch(API + '/editor/open', { method: 'POST', body: fd }); }
    catch { throw new Error('Cannot reach the converter. Is server.py running?'); }
    if (!r.ok) throw new Error(errText(await r.text()));
    j = await r.json();
  } catch (e) { return toast(e.message); }
  Object.assign(ed, { sid: j.sid, name: file.name, pages: j.pages, ops: [], undo: [], redo: [], sel: null, deleted: new Set(), lines: {}, ver: {}, editNode: null, imgs: {}, imgN: 1, hover: null, images: {}, selImg: null });
  el('edOpen').hidden = true; el('edMain').hidden = false;
  el('edName').textContent = `${file.name} · ${j.pages.length} page${j.pages.length === 1 ? '' : 's'}`;
  setTool('select'); build(); syncBtns(); loadLines(j.sid);
};

function closeFile() {
  if (ed.ops.length && !confirm('Close this file? Your unsaved edits will be lost.')) return;
  Object.values(ed.imgs).forEach(m => URL.revokeObjectURL(m.url)); ed.imgs = {}; ed.hover = null;
  ed.sid = null; ed.ops = []; el('edPages').innerHTML = ''; el('edMain').hidden = true; el('edOpen').hidden = false;
}

// ---- saving
async function saveAs(fmt) {
  if (document.activeElement && isEditable(document.activeElement)) document.activeElement.blur();
  const keep = ed.pages.map((_, i) => i).filter(i => !ed.deleted.has(i));
  const edits = ed.ops.filter(o => !(o.t === 'text' && !o.text.trim()));
  const fd = new FormData();
  fd.append('edits', JSON.stringify(edits)); fd.append('keep', JSON.stringify(keep)); fd.append('format', fmt);
  new Set(edits.filter(o => o.t === 'image').map(o => o.img)).forEach(k => ed.imgs[k] && fd.append('img_' + k, ed.imgs[k].blob, 'image'));
  const btns = [el('edSavePdf'), el('edSaveDocx')], labels = btns.map(b => b.textContent);
  btns.forEach(b => b.disabled = true);
  (fmt === 'docx' ? btns[1] : btns[0]).textContent = 'Saving…';
  try {
    const blob = await post(`/editor/${ed.sid}/save`, fd);
    save(blob, ed.name.replace(/\.pdf$/i, '') + '-edited' + (fmt === 'docx' ? '.docx' : '.pdf'));
    toast(fmt === 'docx' ? 'Saved as Word document' : 'Saved as PDF');
  } catch (e) { toast('Save failed: ' + e.message); }
  btns.forEach((b, k) => { b.disabled = false; b.textContent = labels[k]; });
}

// ---- wiring
el('edImg').onclick = () => el('edImgInput').click();
function setPendingImgs(files) {
  ed.pendingImgs = files;
  document.body.classList.toggle('placing', !!files);
  if (files) toast('Now click on the page where you want the image (Esc to cancel)');
}
el('edImgInput').onchange = e => {
  const files = Array.from(e.target.files).filter(f => /^image\//.test(f.type)); e.target.value = '';
  if (!files.length) return toast('Please choose an image file');
  setPendingImgs(files);   // wait for a click on the section where it should go
};
document.addEventListener('keydown', e => { if (e.key === 'Escape' && ed.pendingImgs) setPendingImgs(null); });
document.addEventListener('paste', ev => {   // Ctrl+V of a copied image / screenshot, from anywhere on the page
  if (el('editorApp').hidden || !ed.sid) return;
  const files = Array.from(ev.clipboardData ? ev.clipboardData.items : []).filter(it => it.kind === 'file' && /^image\//.test(it.type)).map(it => it.getAsFile()).filter(Boolean);
  if (!files.length) return;   // plain text paste keeps working normally
  ev.preventDefault(); addImages(files);
});
el('edPick').onclick = () => el('edInput').click();
el('edInput').onchange = e => { openEditor(e.target.files[0]); e.target.value = ''; };
['dragenter', 'dragover'].forEach(t => el('edDrop').addEventListener(t, ev => { ev.preventDefault(); el('edDrop').classList.add('over'); }));
['dragleave', 'drop'].forEach(t => el('edDrop').addEventListener(t, () => el('edDrop').classList.remove('over')));
document.querySelectorAll('#edTools button[data-tool]').forEach(b => b.onclick =() => setTool(b.dataset.tool));
el('edUndo').onclick = () => stepHistory(ed.undo, ed.redo);
el('edRedo').onclick = () => stepHistory(ed.redo, ed.undo);
const zoomBy = d => { ed.zoom = Math.min(2.6, Math.max(.6, Math.round((ed.zoom + d) * 10) / 10)); layout(); renderAll(); };
el('edZoomIn').onclick = () => zoomBy(.2); el('edZoomOut').onclick = () => zoomBy(-.2);
el('edSavePdf').onclick = () => saveAs('pdf'); el('edSaveDocx').onclick = () => saveAs('docx');
el('edClose').onclick = closeFile;
el('edColor').oninput = e => {
  const o = ed.sel && opById(ed.sel);
  if (!o) { colors[ed.tool] = e.target.value; return; }
  if (o.t === 'image' || o.t === 'delimg') return;
  o.color = e.target.value;
  const n = document.querySelector(`#edPages [data-id="${o.id}"]`);
  if (n) { if (o.t === 'rect') n.style.background = o.color; else if (o.t === 'draw') n.setAttribute('stroke', o.color); else (n.querySelector('.tx') || n).style.color = o.color; }
};
el('edColor').onchange = () => { /* history entry for the whole color change */
  const o = ed.sel && opById(ed.sel); if (o && o.t !== 'image' && o.t !== 'delimg') { const b = clone(ed.ops); b.find(x => x.id === o.id).color = colorBefore; commit(b); }
};
let colorBefore = '#000000';
el('edColor').addEventListener('focus', () => { const o = ed.sel && opById(ed.sel); if (o) colorBefore = o.color; });
el('edColor').addEventListener('click', () => { const o = ed.sel && opById(ed.sel); if (o) colorBefore = o.color; });
el('edSize').oninput = e => {
  const v = Math.min(200, Math.max(1, Number(e.target.value) || 0)); if (!v) return;
  const o = ed.sel && opById(ed.sel);
  if (!o) { sizes[ed.tool] = v; return; }
  if (o.t === 'rect' || o.t === 'image' || o.t === 'delimg') return;
  mutate(() => { if (o.t === 'draw') o.width = v; else o.size = v; });
  const n = document.querySelector(`#edPages [data-id="${o.id}"]`);
  if (o.t === 'draw') n && n.setAttribute('stroke-width', v * ed.zoom);
  else if (n) { const t = n.querySelector('.tx') || n; t.style.fontSize = v * ed.zoom + 'px'; }
};
// ---- Add-text options (apply to the selected text box, or become the defaults for the next one)
function textTarget() { const o = ed.sel && opById(ed.sel); return o && o.t === 'text' ? o : null; }
function setTextProp(patch, record = true) {
  const o = textTarget();
  if (!o) { Object.assign(textDef, patch); syncTextOpts(); return; }
  const apply = () => Object.assign(o, patch);
  record ? mutate(apply) : apply();
  const n = document.querySelector(`#edPages [data-id="${o.id}"] .tx`); if (n) styleText(n, o);
  syncTextOpts();
}
['edB', 'edI', 'edU'].forEach(id => {
  const key = { edB: 'bold', edI: 'italic', edU: 'underline' }[id];
  el(id).addEventListener('mousedown', ev => ev.preventDefault());   // keep the caret in the text box
  el(id).onclick = () => { const o = textTarget(); setTextProp({ [key]: !(o ? o[key] : textDef[key]) }); };
});
el('edFont').onchange = e => setTextProp({ serif: e.target.value === 'serif', mono: e.target.value === 'mono' });
el('edAlign').onchange = e => setTextProp({ align: e.target.value });
let opBefore = null;
el('edOpacity').addEventListener('pointerdown', () => { opBefore = clone(ed.ops); });
el('edOpacity').oninput = e => setTextProp({ opacity: Number(e.target.value) / 100 }, false);
el('edOpacity').onchange = () => { if (opBefore && textTarget()) commit(opBefore); opBefore = null; };
const bgChange = () => setTextProp({ fill: el('edBgOn').checked ? el('edBg').value : null });
el('edBgOn').onchange = bgChange; el('edBg').oninput = () => { el('edBgOn').checked = true; bgChange(); };
document.addEventListener('keydown', ev => {
  if (el('editorApp').hidden || !ed.sid) return;
  const typing = isEditable(document.activeElement);
  if ((ev.ctrlKey || ev.metaKey) && !typing && (ev.key === 'z' || ev.key === 'y')) {
    ev.preventDefault(); ev.key === 'z' && !ev.shiftKey ? stepHistory(ed.undo, ed.redo) : stepHistory(ed.redo, ed.undo);
  } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && !typing && ed.selImg) {
    ev.preventDefault(); removeExisting(ed.selImg.page, ed.selImg.ix);
  } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && !typing && ed.sel) {
    ev.preventDefault();
    const id = ed.sel, o = opById(id); if (!o) return;
    mutate(() => { ed.ops = ed.ops.filter(x => x.id !== id); }); ed.sel = null; renderPage(o.page); updateControls();
  }
});
window.addEventListener('beforeunload', ev => { if (ed.ops.length) { ev.preventDefault(); ev.returnValue = ''; } });
})();
