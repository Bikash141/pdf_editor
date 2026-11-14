import io, os, re, shutil, subprocess, tempfile, time, uuid, threading, zipfile, json
import fitz  # PyMuPDF
import math
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.exceptions import HTTPException
from flask import Flask, request, send_file, send_from_directory, abort, render_template, session, redirect, url_for, Response, flash
from urllib.parse import urlencode
import db
import secrets, functools
from werkzeug.security import generate_password_hash, check_password_hash

HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)
app.wsgi_app = ProxyFix(
	app.wsgi_app,
	x_for=1,
	x_proto=1,
	x_host=1
)
@app.route('/')
def home():
	return render_template('index.html')
_KEY_FILE = os.path.join(HERE, '.secret_key')

if os.environ.get('SECRET_KEY'):
    app.secret_key = os.environ['SECRET_KEY']
else:  # persisted so admin logins survive restarts
    if not os.path.exists(_KEY_FILE):
        with open(_KEY_FILE, 'w') as fh:
            fh.write(secrets.token_hex(32))
    with open(_KEY_FILE) as fh:
        app.secret_key = fh.read().strip()
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax',
                  PERMANENT_SESSION_LIFETIME=8 * 3600)
word_lock = threading.Lock()

@app.after_request
def cors(resp):
    resp.headers['Access-Control-Allow-Origin'] = '*'
    return resp

TOOLS = {'/convert': 'word2pdf', '/merge': 'merge', '/split': 'split', '/compress': 'compress',
         '/protect': 'protect', '/unlock': 'unlock', '/rotate': 'rotate', '/watermark': 'watermark',
         '/pdf2word': 'pdf2word', '/editor/open': 'editor_open'}
SECRET_FIELDS = {'password', 'edits', 'keep'}

@app.before_request
def _start_timer():
    request.environ['t0'] = time.time()

@app.after_request
def log_operation(resp):
    tool = TOOLS.get(request.path)
    if tool and request.method == 'POST':
        try:
            files = [f for fs in request.files.listvalues() for f in fs]
            params = {k: v[:200] for k, v in request.form.items() if k not in SECRET_FIELDS}
            err = None
            out = None
            if resp.status_code >= 400:
                err = re.sub(r'<[^>]+>', ' ', resp.get_data(as_text=True))
                err = re.sub(r'\s+', ' ', err).strip()
            elif not resp.direct_passthrough:
                out = resp.content_length
            db.log_operation(tool, files[0].filename if files else '', request.content_length or 0, out,
                             params, resp.status_code, err,
                             int((time.time() - request.environ['t0']) * 1000), request.remote_addr or '')
        except Exception as e:  # logging must never break a request
            app.logger.warning('operation log failed: %s', e)
    return resp

@app.get('/')
def index():
    return render_template('index.html')

@app.get('/privacy')
def privacy_page():
    return render_template('privacy.html')

@app.get('/terms')
def terms_page():
    return render_template('terms.html')

@app.get('/about')
def about_page():
    return render_template('about.html')

@app.get('/style.css')
def style_css():
    return send_from_directory(HERE, 'style.css')

@app.get('/app.js')
def app_js():
    return send_from_directory(HERE, 'app.js')

def _compat(xml):
    # Word 2007 predates w:start/w:end (now left/right) and requires w:val on w:shd
    def margins(m):
        return re.sub(r'<w:end\b', '<w:right', re.sub(r'<w:start\b', '<w:left', m.group(0)))
    xml = re.sub(r'<w:(tcMar|tblCellMar)>.*?</w:\1>', margins, xml, flags=re.S)
    xml = re.sub(r'<w:ind\b[^>]*>',
                 lambda m: m.group(0).replace(' w:start=', ' w:left=').replace(' w:end=', ' w:right='), xml)
    return re.sub(r'<w:shd\b(?![^>]*\bw:val=)', '<w:shd w:val="clear"', xml)

W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

def _order(s):
    return s.split(',')

# Schema child order; Word rejects files whose children are out of order
CHILD_ORDER = {
    'pPr': _order('pStyle,keepNext,keepLines,pageBreakBefore,framePr,widowControl,numPr,suppressLineNumbers,pBdr,shd,tabs,suppressAutoHyphens,kinsoku,wordWrap,overflowPunct,topLinePunct,autoSpaceDE,autoSpaceDN,bidi,adjustRightInd,snapToGrid,spacing,ind,contextualSpacing,mirrorIndents,suppressOverlap,jc,textDirection,textAlignment,textboxTightWrap,outlineLvl,divId,cnfStyle,rPr,sectPr,pPrChange'),
    'rPr': _order('rStyle,rFonts,b,bCs,i,iCs,caps,smallCaps,strike,dstrike,outline,shadow,emboss,imprint,noProof,snapToGrid,vanish,webHidden,color,spacing,w,kern,position,sz,szCs,highlight,u,effect,bdr,shd,fitText,vertAlign,rtl,cs,em,lang,eastAsianLayout,specVanish,oMath'),
    'tcPr': _order('cnfStyle,tcW,gridSpan,hMerge,vMerge,tcBorders,shd,noWrap,tcMar,textDirection,tcFitText,vAlign,hideMark'),
    'tblPr': _order('tblStyle,tblpPr,tblOverlap,bidiVisual,tblStyleRowBandSize,tblStyleColBandSize,tblW,jc,tblCellSpacing,tblInd,tblBorders,shd,tblLayout,tblCellMar,tblLook'),
    'tcBorders': _order('top,left,bottom,right,insideH,insideV,tl2br,tr2bl'),
    'tblBorders': _order('top,left,bottom,right,insideH,insideV'),
    'tcMar': _order('top,left,bottom,right'),
    'tblCellMar': _order('top,left,bottom,right'),
    'pBdr': _order('top,left,bottom,right,between,bar'),
}

def _sanitize_xml(data):
    from lxml import etree
    root = etree.fromstring(data)
    q = lambda n: '{%s}%s' % (W_NS, n)
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        if el.tag == q('start'):
            el.tag = q('left')
        elif el.tag == q('end'):
            el.tag = q('right')
        for k, v in list(el.attrib.items()):
            if not k.startswith('{%s}' % W_NS):
                continue
            if re.fullmatch(r'-?\d+\.\d+', v):  # integer fields must not be decimals
                el.set(k, str(int(round(float(v)))))
            elif k.endswith(('}color', '}fill')) and v.startswith('#'):
                el.set(k, v[1:])
        for attr in ('start', 'end'):  # w:ind / w:tcMar-style attributes
            key = q(attr)
            if key in el.attrib:
                el.set(q('left' if attr == 'start' else 'right'), el.attrib.pop(key))
        if el.tag == q('shd') and q('val') not in el.attrib:
            el.set(q('val'), 'clear')
    for name, order in CHILD_ORDER.items():
        for parent in root.iter(q(name)):
            kids = list(parent)
            def rank(c):
                local = etree.QName(c).localname if isinstance(c.tag, str) else ''
                return order.index(local) if local in order else len(order)
            sorted_kids = sorted(kids, key=rank)  # stable
            if sorted_kids != kids:
                for c in kids:
                    parent.remove(c)
                for c in sorted_kids:
                    parent.append(c)
    return etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)

def make_word2007_safe(path):
    tmp = path + '.tmp'
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if re.match(r'word/(document|styles|header\d*|footer\d*)\.xml$', item.filename):
                data = _sanitize_xml(data)
            zout.writestr(item, data)
    os.replace(tmp, path)

def word_to_pdf(src, out):
    # requires the `libreoffice` (soffice) package on the host
    work = os.path.dirname(src)
    subprocess.run(
        ['soffice', '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', work, src],
        check=True, capture_output=True, timeout=120,
    )

@app.post('/convert')
def convert():
    f = request.files.get('file')
    if not f or not f.filename.lower().endswith(('.docx', '.doc')):
        abort(400, 'Upload a .doc or .docx file')
    work = tempfile.mkdtemp()
    src = os.path.join(work, uuid.uuid4().hex + os.path.splitext(f.filename)[1].lower())
    out = os.path.splitext(src)[0] + '.pdf'
    f.save(src)
    try:
        if src.endswith('.docx'):
            make_word2007_safe(src)
        with word_lock:
            word_to_pdf(src, out)
    except Exception as e:
        abort(500, f'Word conversion failed: {e}')
    if not os.path.exists(out):
        abort(500, 'Conversion failed')
    return send_file(out, mimetype='application/pdf')

@app.post('/merge')
def merge():
    files = request.files.getlist('file')
    if len(files) < 2:
        abort(400, 'Send at least two PDFs')
    writer = PdfWriter()
    for f in files:
        writer.append(PdfReader(f.stream))
    buf = io.BytesIO()
    writer.write(buf)
    buf.seek(0)
    return send_file(buf, mimetype='application/pdf')

def parse_pages(spec, total):
    pages = []
    for part in spec.replace(' ', '').split(','):
        if not part:
            continue
        m = re.fullmatch(r'(\d+)(?:-(\d+))?', part)
        if not m:
            abort(400, f'Invalid page range: {part}')
        a = int(m.group(1)); b = int(m.group(2) or a)
        if a < 1 or b < a or b > total:
            abort(400, f'Page range {part} is outside 1-{total}')
        pages.extend(range(a - 1, b))
    if not pages:
        abort(400, 'Enter pages to keep, e.g. 1-3,5')
    return pages

def read_pdf(password=None):
    f = request.files.get('file')
    if not f:
        abort(400, 'No file uploaded')
    try:
        reader = PdfReader(f.stream)
        if reader.is_encrypted:
            if password is None:
                abort(400, 'This PDF is password-protected. Use the Unlock PDF tool first')
            if not reader.decrypt(password):
                abort(400, 'Wrong password')
        len(reader.pages)
        return reader
    except HTTPException:
        raise
    except Exception:
        abort(400, 'This file is not a valid PDF')

def pdf_response(writer):
    buf = io.BytesIO()
    writer.write(buf)
    buf.seek(0)
    return send_file(buf, mimetype='application/pdf')

@app.post('/split')
def split():
    reader = read_pdf()
    writer = PdfWriter()
    for i in parse_pages(request.form.get('pages', ''), len(reader.pages)):
        writer.add_page(reader.pages[i])
    return pdf_response(writer)

@app.post('/compress')
def compress():
    reader = read_pdf()
    writer = PdfWriter(clone_from=reader)
    for page in writer.pages:
        page.compress_content_streams()
    writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    return pdf_response(writer)

@app.post('/protect')
def protect():
    pw = request.form.get('password', '')
    if len(pw) < 4:
        abort(400, 'Use a password of at least 4 characters')
    writer = PdfWriter(clone_from=read_pdf())
    writer.encrypt(user_password=pw, owner_password=None, algorithm='AES-256')
    return pdf_response(writer)

@app.post('/unlock')
def unlock():
    writer = PdfWriter(clone_from=read_pdf(request.form.get('password', '')))
    return pdf_response(writer)

@app.post('/rotate')
def rotate():
    angle = request.form.get('angle', '90')
    if angle not in ('90', '180', '270'):
        abort(400, 'Angle must be 90, 180 or 270')
    reader = read_pdf()
    spec = request.form.get('pages', '').strip()
    targets = set(parse_pages(spec, len(reader.pages))) if spec else set(range(len(reader.pages)))
    writer = PdfWriter(clone_from=reader)
    for i in targets:
        writer.pages[i].rotate(int(angle))
    return pdf_response(writer)

@app.post('/watermark')
def watermark():
    text = request.form.get('text', '').strip()
    if not text:
        abort(400, 'Enter the watermark text')
    try:
        text.encode('cp1252')
    except UnicodeEncodeError:
        abort(400, 'Watermark text supports Latin letters, numbers and common punctuation only')
    try:
        opacity = min(max(float(request.form.get('opacity', '0.2')), 0.05), 1.0)
    except ValueError:
        abort(400, 'Invalid opacity')
    position = request.form.get('position', 'diagonal')
    writer = PdfWriter(clone_from=read_pdf())
    for page in writer.pages:
        w, h = float(page.mediabox.width), float(page.mediabox.height)
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(w, h))
        c.setFillColorRGB(0.5, 0.5, 0.5)
        c.setFillAlpha(opacity)
        size = min(w, h) / 8
        while size > 8 and stringWidth(text, 'Helvetica-Bold', size) > (0.9 * (w if position != 'diagonal' else (w * w + h * h) ** .5 * .8)):
            size -= 2
        c.setFont('Helvetica-Bold', size)
        if position == 'diagonal':
            c.translate(w / 2, h / 2)
            c.rotate(math.degrees(math.atan2(h, w)))
            c.drawCentredString(0, -size / 3, text)
        else:
            c.drawCentredString(w / 2, h / 2 - size / 3 if position == 'center' else 24, text)
        c.save()
        buf.seek(0)
        page.merge_page(PdfReader(buf).pages[0])
    return pdf_response(writer)

DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

def pdf_file_to_docx(src, work):
    from pdf2docx import Converter
    out = os.path.join(work, 'out.docx')
    cv = Converter(src)
    try:
        cv.convert(out)
    finally:
        cv.close()
    make_word2007_safe(out)
    with open(out, 'rb') as fh:
        return io.BytesIO(fh.read())

@app.post('/pdf2word')
def pdf_to_word():
    f = request.files.get('file')
    if not f or not f.filename.lower().endswith('.pdf'):
        abort(400, 'Upload a .pdf file')
    reader = read_pdf()  # validates the PDF and rejects encrypted files
    if len(reader.pages) == 0:
        abort(400, 'This PDF has no pages')
    f.stream.seek(0)
    work = tempfile.mkdtemp()
    src = os.path.join(work, 'in.pdf')
    f.save(src)
    try:
        data = pdf_file_to_docx(src, work)
    except Exception as e:
        abort(500, f'PDF conversion failed: {e}')
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return send_file(data, mimetype=DOCX_MIME)

# ---------------------------------------------------------------- PDF editor
EDIT_DIR = os.path.join(tempfile.gettempdir(), 'pdf-editor-sessions')
os.makedirs(EDIT_DIR, exist_ok=True)

def _session_path(sid):
    if not re.fullmatch(r'[0-9a-f]{32}', sid):
        abort(404)
    p = os.path.join(EDIT_DIR, sid + '.pdf')
    if not os.path.exists(p) or not db.session_exists(sid):
        abort(404, 'This editing session has expired. Open the PDF again')
    return p

def _cleanup_sessions(max_age=6 * 3600):
    for sid in db.pop_expired(max_age):
        try:
            os.remove(os.path.join(EDIT_DIR, sid + '.pdf'))
        except OSError:
            pass
    now = time.time()
    for n in os.listdir(EDIT_DIR):  # orphaned files with no DB row
        p = os.path.join(EDIT_DIR, n)
        try:
            if now - os.path.getmtime(p) > max_age:
                os.remove(p)
        except OSError:
            pass

@app.post('/editor/open')
def editor_open():
    reader = read_pdf()  # validates, rejects encrypted
    if len(reader.pages) == 0:
        abort(400, 'This PDF has no pages')
    _cleanup_sessions()
    sid = uuid.uuid4().hex
    path = os.path.join(EDIT_DIR, sid + '.pdf')
    up = request.files['file']
    up.stream.seek(0)
    up.save(path)
    doc = fitz.open(path)
    pages = [{'w': p.rect.width, 'h': p.rect.height} for p in doc]
    doc.close()
    db.create_session(sid, up.filename or '', len(pages), os.path.getsize(path))
    return {'sid': sid, 'pages': pages}

@app.get('/editor/<sid>/page/<int:n>')
def editor_page(sid, n):
    doc = fitz.open(_session_path(sid))
    if not 0 <= n < len(doc):
        abort(404)
    png = doc[n].get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).tobytes('png')
    resp = send_file(io.BytesIO(png), mimetype='image/png')
    resp.headers['Cache-Control'] = 'no-store'
    return resp

@app.get('/editor/<sid>/lines/<int:n>')
def editor_lines(sid, n):
    from collections import Counter
    doc = fitz.open(_session_path(sid))
    if not 0 <= n < len(doc):
        abort(404)
    page = doc[n]
    if page.rotation:  # text editing is only offered on upright pages
        return {'lines': []}
    pix = page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)

    def px(x, y):
        x = min(max(int(x), 0), pix.width - 1)
        y = min(max(int(y), 0), pix.height - 1)
        return tuple(pix.pixel(x, y))

    out = []
    for b in page.get_text('dict')['blocks']:
        if b.get('type') != 0:
            continue
        for ln in b['lines']:
            spans = [s for s in ln['spans'] if s['text'].strip()]
            if not spans:
                continue
            main = max(spans, key=lambda s: len(s['text']))
            x0, y0, x1, y1 = ln['bbox']
            mid = (y0 + y1) / 2
            bg = Counter([px(x0 - 2, mid), px(x1 + 2, mid), px((x0 + x1) / 2, y0 - 1.5),
                          px((x0 + x1) / 2, y1 + 1.5)]).most_common(1)[0][0]
            fl = main['flags']
            fname = main['font'].lower()
            def _style(s):
                f, n = s['flags'], s['font'].lower()
                return {'t': s['text'], 'size': round(s['size'], 2), 'color': '#%06x' % s['color'],
                        'bold': bool(f & 16) or 'bold' in n,
                        'italic': bool(f & 2) or 'italic' in n or 'oblique' in n,
                        'serif': bool(f & 1), 'mono': bool(f & 8)}
            out.append({'bbox': [x0, y0, x1, y1], 'origin': list(main['origin']),
                        'spans': [_style(s) for s in ln['spans']],
                        'text': ''.join(s['text'] for s in ln['spans']).rstrip(),
                        'size': round(main['size'], 2), 'color': '#%06x' % main['color'],
                        'bold': bool(fl & 16) or 'bold' in fname,
                        'italic': bool(fl & 2) or 'italic' in fname or 'oblique' in fname,
                        'serif': bool(fl & 1), 'mono': bool(fl & 8), 'bg': list(bg)})
    return {'lines': out}

@app.get('/editor/<sid>/images/<int:n>')
def editor_images(sid, n):
    doc = fitz.open(_session_path(sid))
    if not 0 <= n < len(doc):
        abort(404)
    page = doc[n]
    if page.rotation:
        return {'images': []}
    out = []
    for info in page.get_image_info(xrefs=True):
        if info.get('xref') and not fitz.Rect(info['bbox']).is_empty:
            out.append({'xref': info['xref'], 'bbox': list(info['bbox'])})
    return {'images': out}

@app.post('/editor/<sid>/rotate/<int:n>')
def editor_rotate(sid, n):
    path = _session_path(sid)
    doc = fitz.open(path)
    if not 0 <= n < len(doc):
        abort(404)
    page = doc[n]
    page.set_rotation((page.rotation + 90) % 360)
    tmp = path + '.tmp'
    doc.save(tmp)
    doc.close()
    os.replace(tmp, path)
    db.touch_session(sid, os.path.getsize(path))
    doc = fitz.open(path)
    r = doc[n].rect
    return {'w': r.width, 'h': r.height}

def _hex(c, default=(0, 0, 0)):
    try:
        c = c.lstrip('#')
        return tuple(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except Exception:
        return default

WIN_FONTS = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')
BASE14 = {'he': ('helv', 'hebo', 'heit', 'hebi'), 'ti': ('tiro', 'tibo', 'tiit', 'tibi'),
          'co': ('cour', 'cobo', 'coit', 'cobi')}

def _font_for(op, text, page):
    bold, italic = bool(op.get('bold')), bool(op.get('italic'))
    try:
        text.encode('latin-1')
        fam = 'co' if op.get('mono') else 'ti' if op.get('serif') else 'he'
        return BASE14[fam][int(bold) + 2 * int(italic)]
    except UnicodeEncodeError:
        pass
    # characters outside Latin-1: embed a system font that covers them
    for fn in ('arialbd.ttf' if bold else 'arial.ttf', 'arial.ttf', 'segoeui.ttf'):
        p = os.path.join(WIN_FONTS, fn)
        if os.path.exists(p):
            name = 'u' + re.sub(r'\W', '', fn)
            page.insert_font(fontname=name, fontfile=p)
            return name
    return 'helv'

def _put_text(page, op, x, baseline, text, dm):
    size = float(op.get('size', 12))
    color = _hex(op.get('color', '#000000'))
    for i, line in enumerate(text.split('\n')):
        if not line:
            continue
        pt = fitz.Point(x, baseline + i * size * 1.2) * dm
        page.insert_text(pt, line, fontname=_font_for(op, line, page), fontsize=size,
                         color=color, rotate=page.rotation)

def _put_textbox(page, o, dm):
    """Text added by the user: font style, underline, alignment, opacity and optional background fill."""
    size = float(o.get('size', 12))
    lines = o['text'].split('\n')
    lh = size * 1.2
    widths = [_run_width(page, o, l) if l else 0 for l in lines]
    bw = max(widths) if widths else 0
    try:
        opacity = min(max(float(o.get('opacity', 1)), 0.05), 1.0)
    except (TypeError, ValueError):
        opacity = 1.0
    color = _hex(o.get('color', '#000000'))
    x0, y0 = float(o['x']), float(o['y'])
    if o.get('fill'):
        pad = 2
        r = fitz.Rect(x0 - pad, y0 - pad, x0 + bw + pad, y0 + len(lines) * lh + pad) * dm
        page.draw_rect(r, color=None, fill=_hex(o['fill'], (1, 1, 0)), fill_opacity=opacity, width=0)
    for i, (line, w) in enumerate(zip(lines, widths)):
        if not line:
            continue
        shift = {'center': (bw - w) / 2, 'right': bw - w}.get(o.get('align'), 0)
        lx, base = x0 + shift, y0 + size + i * lh
        page.insert_text(fitz.Point(lx, base) * dm, line, fontname=_font_for(o, line, page), fontsize=size,
                         color=color, rotate=page.rotation, fill_opacity=opacity)
        if o.get('underline'):
            uy = base + size * 0.12
            page.draw_line(fitz.Point(lx, uy) * dm, fitz.Point(lx + w, uy) * dm, color=color,
                           width=max(0.6, size / 16), stroke_opacity=opacity)


def _run_width(page, op, text):
    fn = _font_for(op, text, page)
    size = float(op.get('size', 12))
    try:
        return fitz.get_text_length(text, fontname=fn, fontsize=size)
    except Exception:
        return fitz.Font('helv').text_length(text, fontsize=size)

def _put_spans(page, o, dm):
    """Re-draw an edited line keeping each original span's own font style (e.g. bold label + regular value)."""
    spans = o.get('spans') or []
    orig, new = o.get('orig', ''), o['text']
    if not spans or not ''.join(s['t'] for s in spans).startswith(orig[:1] or ''):
        return _put_text(page, o, o['origin'][0], o['origin'][1], new, dm)
    owner = []   # original char index -> span
    for s in spans:
        owner += [s] * len(s['t'])
    if not owner:
        return _put_text(page, o, o['origin'][0], o['origin'][1], new, dm)
    p = 0
    while p < min(len(orig), len(new)) and orig[p] == new[p]:
        p += 1
    s_ = 0
    while s_ < min(len(orig), len(new)) - p and orig[len(orig) - 1 - s_] == new[len(new) - 1 - s_]:
        s_ += 1
    def style_at(i):
        if i < p:
            return owner[min(i, len(owner) - 1)]
        if i >= len(new) - s_:
            return owner[max(min(len(orig) - (len(new) - i), len(owner) - 1), 0)]
        return owner[min(max(p - 1, 0), len(owner) - 1)]
    runs = []
    for i, ch in enumerate(new):
        st = style_at(i)
        if runs and runs[-1][0] is st:
            runs[-1][1] += ch
        else:
            runs.append([st, ch])
    x, y = o['origin']
    for st, txt in runs:
        op = dict(st)
        pt = fitz.Point(x, y) * dm
        page.insert_text(pt, txt, fontname=_font_for(op, txt, page), fontsize=float(st['size']),
                         color=_hex(st.get('color', '#000000')), rotate=page.rotation)
        x += _run_width(page, op, txt)

def _remove_images(doc, page, xrefs):
    """Drop existing images from this page only (the image object itself may be shared with other pages)."""
    if not xrefs:
        return
    names = {im[0]: im[7] for im in page.get_images(full=True)}
    page.clean_contents()
    cont = page.get_contents()
    data = b''.join(doc.xref_stream(x) for x in cont)
    changed = False
    for x in set(xrefs):
        name = names.get(x)
        if not name:
            continue
        data, k = re.subn(rb'/' + re.escape(name.encode()) + rb'(?![\w.#-])\s+Do', b'', data)
        changed = changed or k > 0
        if not k:  # image sits inside a form XObject: blank it out instead
            try:
                page.delete_image(x)
            except Exception:
                pass
    if changed:
        doc.update_stream(cont[0], data)
        for x in cont[1:]:
            doc.update_stream(x, b'')

def _vec_png(w, h, draw):
    """Render a small vector shape to a transparent PNG (Word export keeps images but drops vector shapes)."""
    w, h = max(float(w), 1.0), max(float(h), 1.0)
    scale = min(4.0, 3000.0 / max(w, h))
    tmp = fitz.open()
    try:
        pg = tmp.new_page(width=w, height=h)
        draw(pg, fitz.Rect(0, 0, w, h))
        return pg.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=True).tobytes('png')
    finally:
        tmp.close()


def _shape_png(o, r):
    shape = o.get('shape', 'rect')
    kw = dict(color=None, fill=_hex(o.get('color', '#ffe600')), fill_opacity=float(o.get('opacity', 1)), width=0)

    def draw(pg, box):
        if shape == 'ellipse':
            pg.draw_oval(box, **kw)
        elif shape == 'round':
            pg.draw_rect(box, radius=min(.5, 12 / max(min(box.width, box.height), 1)), **kw)
        else:
            pg.draw_rect(box, **kw)
    return _vec_png(r.width, r.height, draw)


def _stroke_png(o):
    pts = [fitz.Point(x, y) for x, y in o['pts']]
    wd = float(o.get('width', 2))
    box = fitz.Rect(min(p.x for p in pts), min(p.y for p in pts), max(p.x for p in pts), max(p.y for p in pts))
    box = fitz.Rect(box.x0 - wd, box.y0 - wd, box.x1 + wd, box.y1 + wd)

    def draw(pg, _b):
        pg.draw_polyline([fitz.Point(p.x - box.x0, p.y - box.y0) for p in pts], color=_hex(o.get('color', '#e11d48')),
                         width=wd, lineCap=1, lineJoin=1, closePath=False)
    return box, _vec_png(box.width, box.height, draw)


def apply_edits(path, edits, keep, images=None, for_docx=False):
    doc = fitz.open(path)
    byp = {}
    for o in edits:
        byp.setdefault(int(o['page']), []).append(o)
    for pn, ops in byp.items():
        if not 0 <= pn < len(doc):
            continue
        page = doc[pn]
        dm = page.derotation_matrix
        _remove_images(doc, page, [int(o['xref']) for o in ops if o['t'] == 'delimg'])
        # Cover (solid, rectangular): really remove the text/image pixels underneath, otherwise the
        # covered content stays in the PDF and reappears when exported to Word or copied.
        covers = [o for o in ops if o['t'] == 'rect' and o.get('shape', 'rect') == 'rect'
                  and float(o.get('opacity', 1)) >= 0.99]
        for o in covers:
            r = fitz.Rect(o['x'], o['y'], o['x'] + o['w'], o['y'] + o['h']) * dm
            if not r.is_empty:
                page.add_redact_annot(r, fill=False)
        if covers:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS, graphics=0)
        reps = [o for o in ops if o['t'] == 'replace']
        for o in reps:
            r = fitz.Rect(o['bbox']) * dm
            pad = r.height * .15
            page.add_redact_annot(fitz.Rect(r.x0, r.y0 + pad, r.x1, r.y1 - pad))
        if reps:
            page.apply_redactions(images=0, graphics=0)
        for o in reps:
            r = fitz.Rect(o['bbox']) * dm
            bg = tuple(c / 255 for c in o.get('bg', [255, 255, 255]))
            page.draw_rect(r, color=None, fill=bg, width=0)
            if o['text'].strip():
                _put_spans(page, o, dm)
        for o in ops:
            t = o['t']
            if t == 'rect':
                r = fitz.Rect(o['x'], o['y'], o['x'] + o['w'], o['y'] + o['h']) * dm
                shape, kw = o.get('shape', 'rect'), dict(color=None, fill=_hex(o.get('color', '#ffe600')),
                                                         fill_opacity=float(o.get('opacity', 1)), width=0)
                if for_docx:  # Word export drops vector shapes, so place the box as an image instead
                    if not r.is_empty:
                        page.insert_image(r, stream=_shape_png(o, fitz.Rect(o['x'], o['y'], o['x'] + o['w'], o['y'] + o['h'])),
                                          keep_proportion=False, rotate=page.rotation, overlay=True)
                    continue
                if shape == 'ellipse':
                    page.draw_oval(r, **kw)
                elif shape == 'round':
                    page.draw_rect(r, radius=min(.5, 12 / max(min(r.width, r.height), 1)), **kw)
                else:
                    page.draw_rect(r, **kw)
            elif t == 'draw' and len(o.get('pts', [])) >= 2 and for_docx:
                box, png = _stroke_png(o)
                page.insert_image(box * dm, stream=png, keep_proportion=False, rotate=page.rotation, overlay=True)
            elif t == 'draw' and len(o.get('pts', [])) >= 2:
                pts = [fitz.Point(x, y) * dm for x, y in o['pts']]
                page.draw_polyline(pts, color=_hex(o.get('color', '#e11d48')),
                                   width=float(o.get('width', 2)), lineCap=1, lineJoin=1, closePath=False)
            elif t == 'text' and o.get('text', '').strip():
                _put_textbox(page, o, dm)
            elif t == 'image' and images and str(o.get('img')) in images:
                r = fitz.Rect(o['x'], o['y'], o['x'] + o['w'], o['y'] + o['h']) * dm
                if r.is_empty:
                    continue
                page.insert_image(r, stream=images[str(o['img'])], keep_proportion=False,
                                  rotate=page.rotation, overlay=True)
    if keep is not None:
        doc.select([i for i in keep if 0 <= i < len(doc)])
    # Do NOT subset fonts here: re-subsetting the PDF's existing Type0/CID fonts corrupts their
    # glyph widths, which spaces letters out and makes Cover boxes miss the text in real viewers.
    data = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return data

@app.post('/editor/<sid>/save')
def editor_save(sid):
    path = _session_path(sid)
    try:
        edits = json.loads(request.form.get('edits', '[]'))
        keep = json.loads(request.form.get('keep', 'null'))
    except ValueError:
        abort(400, 'Bad edit data')
    if keep is not None and not keep:
        abort(400, 'Keep at least one page')
    db.touch_session(sid)
    try:
        images = {k[4:]: f.read() for k, f in request.files.items() if k.startswith('img_')}
        data = apply_edits(path, edits, keep, images, for_docx=request.form.get('format') == 'docx')
    except Exception as e:
        abort(500, f'Saving failed: {e}')
    fmt = request.form.get('format') or 'pdf'
    try:
        db.log_editor_save(sid, fmt, len(edits), len(keep) if keep is not None else None, len(data))
    except Exception as e:
        app.logger.warning('editor save log failed: %s', e)
    if request.form.get('format') == 'docx':
        work = tempfile.mkdtemp()
        try:
            src = os.path.join(work, 'in.pdf')
            with open(src, 'wb') as fh:
                fh.write(data)
            return send_file(pdf_file_to_docx(src, work), mimetype=DOCX_MIME)
        except Exception as e:
            abort(500, f'Word conversion failed: {e}')
        finally:
            shutil.rmtree(work, ignore_errors=True)
    return send_file(io.BytesIO(data), mimetype='application/pdf')

# ---------------------------------------------------------------- superadmin
_fails = {}  # ip -> (count, first_fail_time); simple brute-force throttle

def admin_required(f):
    @functools.wraps(f)
    def wrapper(*a, **kw):
        if session.get('role') != 'superadmin':
            return redirect(url_for('admin_login'))
        return f(*a, **kw)
    return wrapper

def seed_admin():
    """Create the first superadmin from ADMIN_USER / ADMIN_PASSWORD (or a random password, printed once)."""
    if db.count_admins():
        return
    user = os.environ.get('ADMIN_USER', 'superadmin')
    pw = os.environ.get('ADMIN_PASSWORD')
    generated = not pw
    if generated:
        pw = secrets.token_urlsafe(12)
    db.upsert_admin(user, generate_password_hash(pw))
    print(f'Created superadmin "{user}"' + (f' with password: {pw}  (change it: python server.py set-admin-password)' if generated else ''))

@app.route('/admin', defaults={'rest': ''})
@app.route('/admin/<path:rest>')
def legacy_admin_url(rest):
    """Old /admin links keep working and land on the /superadmin URL."""
    qs = request.query_string.decode()
    return redirect('/superadmin' + ('/' + rest if rest else '') + ('?' + qs if qs else ''), code=301 if request.method == 'GET' else 308)

@app.route('/superadmin/login', methods=['GET', 'POST'])
def admin_login():
    err = None
    if request.method == 'POST':
        ip = request.remote_addr or ''
        n, t0 = _fails.get(ip, (0, time.time()))
        if time.time() - t0 > 900:
            n, t0 = 0, time.time()
        if n >= 5:
            err = 'Too many attempts. Try again in a few minutes.'
        else:
            a = db.get_admin(request.form.get('username', '').strip())
            if a and check_password_hash(a['password_hash'], request.form.get('password', '')):
                _fails.pop(ip, None)
                session.clear()
                session.permanent = True
                session.update(admin_id=a['id'], admin=a['username'], role=a['role'])
                db.touch_admin_login(a['id'])
                return redirect(url_for('admin_dashboard'))
            _fails[ip] = (n + 1, t0)
            err = 'Invalid username or password.'
    return render_template('admin_login.html', error=err), (429 if err and 'Too many' in err else 200)

@app.post('/superadmin/logout')
def admin_logout():
    session.clear()
    return redirect(url_for('admin_login'))

def _pager(page, per_page, total, endpoint_args):
    """Pagination model: page window with ellipses, plus a URL builder bound to the current filters."""
    pages = max(1, -(-total // per_page))
    page = min(max(1, page), pages)
    nums = sorted({1, pages, *range(max(1, page - 1), min(pages, page + 1) + 1)})
    items, prev = [], 0
    for n in nums:
        if n - prev > 1:
            items.append(None)
        items.append(n)
        prev = n
    return dict(page=page, pages=pages, total=total, per_page=per_page, items=items,
                first=(page - 1) * per_page + 1 if total else 0, last=min(page * per_page, total))

def _int(name, default, lo=1, hi=100000):
    try:
        return min(max(int(request.args.get(name, default)), lo), hi)
    except ValueError:
        return default

def _op_filters():
    status = request.args.get('status')
    if request.args.get('failed') == '1':  # legacy link
        status = 'failed'
    return (request.args.get('tool') or None, status if status in ('ok', 'failed') else None,
            (request.args.get('q') or '').strip()[:100] or None)

@app.get('/superadmin')
@admin_required
def admin_dashboard():
    from datetime import date, timedelta
    totals, by_tool, _sessions_n, saves = db.admin_stats()
    recent, _ = db.recent_operations(1, 6)
    # fill missing days for the activity chart
    got = {str(r['d']): r for r in db.ops_per_day(14)}
    days = []
    for i in range(13, -1, -1):
        d = date.today() - timedelta(days=i)
        r = got.get(str(d))
        days.append(dict(label=d.strftime('%d %b'), n=int(r['n']) if r else 0, failed=int(r['failed'] or 0) if r else 0))
    return render_template('admin.html', totals=totals, by_tool=by_tool, saves=saves, recent=recent, days=days)

@app.get('/superadmin/latest')
@admin_required
def admin_latest():
    rows, total = db.recent_operations(1, 25)
    return render_template('admin_latest.html', ops=rows, total=total)

@app.get('/superadmin/operations')
@admin_required
def admin_operations():
    _, by_tool, _s, _v = db.admin_stats()
    tool, status, q = _op_filters()
    per = _int('per', 10, 5, 100)
    if per not in (10, 25, 50, 100):
        per = 10
    _, total = db.recent_operations(1, 1, tool, status, q)  # clamp page against the real total
    ops_pg = _pager(_int('page', 1), per, total, None)
    ops, _ = db.recent_operations(ops_pg['page'], per, tool, status, q)

    def link(**kw):
        args = {k: v for k, v in request.args.items() if k != 'failed'}
        args.update(kw)
        return '/superadmin/operations?' + urlencode({k: v for k, v in args.items() if v not in (None, '')})

    return render_template('admin_operations.html', by_tool=by_tool, ops=ops, ops_pg=ops_pg,
                           tool=tool, status=status, q=q or '', per=per, link=link)

@app.get('/superadmin/export.csv')
@admin_required
def admin_export():
    import csv, io
    tool, status, q = _op_filters()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(['id', 'when', 'tool', 'filename', 'input_bytes', 'output_bytes', 'duration_ms', 'status', 'ip', 'error'])
    for o in db.all_operations(tool, status, q):
        w.writerow([o['id'], o['created_at'], o['tool'], o['filename'], o['input_bytes'], o['output_bytes'],
                    o['duration_ms'], o['status_code'], o['client_ip'], o['error'] or ''])
    return Response(buf.getvalue(), mimetype='text/csv',
                    headers={'Content-Disposition': 'attachment; filename=operations.csv'})

@app.context_processor
def _inject_csrf():
    if 'csrf' not in session:
        session['csrf'] = secrets.token_hex(16)
    return {'csrf_token': session['csrf']}

def _check_csrf():
    sent = request.form.get('csrf', '')
    if not sent or not secrets.compare_digest(sent, session.get('csrf', '')):
        abort(400, 'Invalid or expired form. Reload the page and try again.')

def _password_problem(current, new, confirm, admin):
    if not check_password_hash(admin['password_hash'], current):
        return 'current', 'Your current password is incorrect.'
    if len(new) < 8:
        return 'new', 'New password must be at least 8 characters.'
    if len(new) > 128:
        return 'new', 'New password is too long (max 128 characters).'
    if new == current:
        return 'new', 'New password must be different from the current one.'
    if new != confirm:
        return 'confirm', 'The two new passwords do not match.'
    return None, None

@app.route('/superadmin/password', methods=['GET', 'POST'])
@admin_required
def admin_password():
    err = field = None
    if request.method == 'POST':
        _check_csrf()
        key = 'pw:%s' % session.get('admin_id')
        n, t0 = _fails.get(key, (0, time.time()))
        if time.time() - t0 > 900:
            n, t0 = 0, time.time()
        admin = db.get_admin(session.get('admin', ''))
        if n >= 5:
            err = 'Too many attempts. Try again in a few minutes.'
        elif not admin:
            session.clear()
            return redirect(url_for('admin_login'))
        else:
            field, err = _password_problem(request.form.get('current', ''), request.form.get('new', ''),
                                           request.form.get('confirm', ''), admin)
            if err is None:
                _fails.pop(key, None)
                db.update_admin_password(admin['id'], generate_password_hash(request.form['new']))
                session.clear()  # rotate the session after a credential change
                session.permanent = True
                session.update(admin_id=admin['id'], admin=admin['username'], role=admin['role'], csrf=secrets.token_hex(16))
                flash('Your password was changed successfully.')
                return redirect(url_for('admin_password'))
            if field == 'current':
                _fails[key] = (n + 1, t0)
    return render_template('admin_password.html', error=err, field=field), (429 if err and 'Too many' in err else 200)

@app.get('/admin.css')
def admin_css():
    return send_from_directory(HERE, 'admin.css')

@app.template_filter('size')
def _size(n):
    n = n or 0
    return f'{n} B' if n < 1024 else f'{n/1024:.0f} KB' if n < 1048576 else f'{n/1048576:.1f} MB'


if __name__ == '__main__':
    import sys

    db.init_db()

    if sys.argv[1:2] == ['set-admin-password']:
        import getpass

        u = input('Admin username [superadmin]: ').strip() or 'superadmin'
        pw = getpass.getpass('New password (min 8 chars): ')

        if len(pw) < 8:
            sys.exit('Password too short')

        db.upsert_admin(u, generate_password_hash(pw))
        sys.exit(f'Password set for {u}')

    seed_admin()

    # Local development server with automatic reload
    app.run(
        host='127.0.0.1',
        port=5000,
        debug=True,
        use_reloader=True
    )

