'use strict';
// GET /api/stock?skus=cargador-65w,parlante-bt   (hasta 12; sin parámetro = todo el catálogo publicado, máx. 12)
// Disponibilidad pública y SEGURA: sin IDs internos y con cantidades topadas en 10 ("10 o más") para no regalar tu inventario.
// estado: disponible | agotado | desconocido (no se pudo verificar: NO significa que haya) | no_configurado | no_encontrado
// La llave DROPANAS_API_KEY solo se usa en el servidor (lib/dropanas.js). La caché vive en lib/cache.js.
const { obtener, lista } = require('../lib/catalogo');
const { disponibilidad } = require('../lib/stock');
const { limitar } = require('../lib/cache');
const { pausaRestanteMs } = require('../lib/cliente');

const SKU_OK = /^[a-z0-9-]{3,40}$/;
const CAP = 10;
const cap = (n) => (n === null ? null : Math.min(n, CAP));

function publicar(d) {
  const vendible = d.estado !== 'agotado' && d.estado !== 'no_configurado';
  return {
    estado: d.estado, tipo: d.tipo, vendible, verificado: !!d.verificado,
    disponible: d.tipo === 'variable' ? null : cap(d.total), bajo: d.total !== null && d.total > 0 && d.total <= 5,
    variantes: d.variantes.map((v) => ({ id: v.id, nombre: v.nombre, estado: v.estado, disponible: cap(v.disponible) })),
    obsoleto: !!d.obsoleto, degradado: !!d.degradado,
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ message: 'Método no permitido.' });
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return res.status(403).json({ message: 'Origen no permitido.' });
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (limitar('stock:' + ip, 60, 60 * 1000)) { res.setHeader('Retry-After', '30'); return res.status(429).json({ message: 'Demasiadas consultas. Espera un momento.' }); }

  const q = req.query.skus !== undefined ? req.query.skus : req.query.sku;
  const pedidos = q === undefined ? lista().slice(0, 12).map((p) => p.sku) : [...new Set(String(q).split(',').map((s) => s.trim()).filter(Boolean))];
  if (!pedidos.length || pedidos.length > 12) return res.status(400).json({ message: 'Pide entre 1 y 12 productos.' });
  if (pedidos.some((s) => !SKU_OK.test(s))) return res.status(400).json({ message: 'Producto inválido.' });

  const items = {};
  await Promise.all(pedidos.map(async (sku) => {
    const it = obtener(sku);
    items[sku] = it ? publicar(await disponibilidad(it)) : { estado: 'no_encontrado', vendible: false, verificado: true, disponible: null, variantes: [] };
  }));

  const resto = pausaRestanteMs();
  if (resto > 0) res.setHeader('Retry-After', String(Math.ceil(resto / 1000)));
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60'); // el CDN de Vercel absorbe el tráfico repetido
  return res.status(200).json({ ok: true, items, actualizado: new Date().toISOString() });
};
