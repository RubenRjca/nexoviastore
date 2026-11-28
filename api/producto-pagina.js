'use strict';
// Sirve el HTML de portada con metadatos Open Graph / Twitter específicos del producto cuando se comparte un enlace
// (/p/<sku> o /?p=<sku>), manteniendo intacta la portada general (og-image.jpg) cuando se comparte /.
const fs = require('fs');
const path = require('path');
const { obtener } = require('../lib/catalogo');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SKU_OK = /^[a-z0-9-]{3,40}$/;

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const recorta = (s, n = 200) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};

function imagenDe(p) {
  if (Array.isArray(p.imagenes) && p.imagenes[0]) return p.imagenes[0];
  if (p.variantes && typeof p.variantes === 'object') {
    const v = Object.values(p.variantes).find((x) => x && x.imagen);
    if (v) return v.imagen;
  }
  return p.imagen || 'og-image.jpg';
}

function origenDe(req) {
  const h = (req && req.headers) || {};
  const proto = String(h['x-forwarded-proto'] || 'https').split(',')[0].trim().toLowerCase() === 'http' ? 'http' : 'https';
  const host = String(h['x-forwarded-host'] || h.host || 'nexoviastore.vercel.app').split(',')[0].trim().replace(/[^a-z0-9.:-]/gi, '') || 'nexoviastore.vercel.app';
  return `${proto}://${host}`;
}

function setMeta(html, attr, key, val) {
  const re = new RegExp(`(<meta\\s+${attr}="${key}"\\s+content=")([^"]*)("[^>]*>)`, 'i');
  return re.test(html) ? html.replace(re, `$1${esc(val)}$3`) : html;
}

function renderProducto(p, base) {
  const rel = imagenDe(p);
  const imgUrl = /^https:\/\//.test(rel) ? rel : `${base}/${rel.replace(/^\/+/, '')}`;
  const url = `${base}/p/${encodeURIComponent(p.sku)}`;
  const titulo = `${p.titulo} | Nexovia Store`;
  const desc = recorta(`${p.descripcion} Pago Contra Entrega en Venezuela.`, 210);
  const imgType = /\.png(\?|$)/i.test(imgUrl) ? 'image/png' : 'image/jpeg';

  let out = HTML.replace(/(<meta\s+name="viewport"[^>]*>)/i, '$1\n<base href="/">');
  out = out.replace(/<title>[^<]*<\/title>/i, `<title>${esc(titulo)}</title>`);
  out = setMeta(out, 'name', 'description', desc);
  out = out.replace(/(<link\s+rel="canonical"\s+href=")([^"]*)("[^>]*>)/i, `$1${esc(url)}$3`);
  out = setMeta(out, 'property', 'og:type', 'product');
  out = setMeta(out, 'property', 'og:url', url);
  out = setMeta(out, 'property', 'og:title', p.titulo);
  out = setMeta(out, 'property', 'og:description', desc);
  out = setMeta(out, 'property', 'og:image', imgUrl);
  out = setMeta(out, 'property', 'og:image:url', imgUrl);
  out = setMeta(out, 'property', 'og:image:secure_url', imgUrl);
  out = setMeta(out, 'property', 'og:image:type', imgType);
  out = out.replace(/<meta\s+property="og:image:(width|height)"[^>]*>\n?/gi, '');
  out = setMeta(out, 'property', 'og:image:alt', p.titulo);
  out = setMeta(out, 'name', 'twitter:title', titulo);
  out = setMeta(out, 'name', 'twitter:description', desc);
  out = setMeta(out, 'name', 'twitter:image', imgUrl);
  out = setMeta(out, 'name', 'twitter:image:alt', p.titulo);
  return out;
}

function renderInicio(base) {
  const ogImg = `${base}/og-image.jpg?v=2`;
  const url = `${base}/`;
  let out = HTML.replace(/(<meta\s+name="viewport"[^>]*>)/i, '$1\n<base href="/">');
  out = out.replace(/(<link\s+rel="canonical"\s+href=")([^"]*)("[^>]*>)/i, `$1${esc(url)}$3`);
  out = setMeta(out, 'property', 'og:url', url);
  out = setMeta(out, 'property', 'og:image', ogImg);
  out = setMeta(out, 'property', 'og:image:url', ogImg);
  out = setMeta(out, 'property', 'og:image:secure_url', ogImg);
  out = setMeta(out, 'name', 'twitter:image', ogImg);
  return out;
}

module.exports = async (req, res) => {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ message: 'Método no permitido.' });
  }
  const qry = req.query || {};
  const raw = Array.isArray(qry.p) ? qry.p[0] : qry.p;
  const sku = typeof raw === 'string' ? raw.trim() : '';
  const p = SKU_OK.test(sku) ? obtener(sku) : null;
  const base = origenDe(req);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
  if (req.method === 'HEAD') { const r = res.status(200); return typeof r.end === 'function' ? r.end() : r.send(''); }
  if (!p) return res.status(200).send(renderInicio(base));
  return res.status(200).send(renderProducto(p, base));
};
