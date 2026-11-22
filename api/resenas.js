'use strict';
// RESEÑAS REALES. Nunca hay reseñas inventadas: todo lo que se muestra lo escribió un cliente y lo aprobaste tú.
//   GET  /api/resenas?sku=cargador-65w  -> { ok, disponible, resumen:{total,promedio}, data:[{nombre,estrellas,texto,fecha}] }  (solo APROBADAS)
//   POST /api/resenas  { producto_sku, nombre, texto, estrellas }  -> queda "pendiente"; NO se publica hasta que la apruebes
//        (node scripts/resenas-moderar.js listar | aprobar <id> | rechazar <id> | quitar <id>)
// ALMACENAMIENTO: Upstash Redis / Vercel KV. Variables: KV_REST_API_URL + KV_REST_API_TOKEN (o UPSTASH_REDIS_REST_URL + _TOKEN).
//   Se crea en Vercel → Storage → Upstash Redis → conectar al proyecto → redesplegar. Sin eso: GET responde lista vacía y POST 503.
const crypto = require('crypto');
const { obtener } = require('../lib/catalogo');
const { configurado, pipeline } = require('../lib/almacen');
const { limitar } = require('../lib/cache');

const SKU_OK = /^[a-z0-9-]{3,40}$/;
const NOMBRE_OK = /^[\p{L}\p{M}][\p{L}\p{M}' .-]{1,29}$/u;
const MAX_PENDIENTES = 300, MAX_LEER = 100, VENCE_PENDIENTE_SEG = 90 * 24 * 3600;
const limpiar = (s) => s.replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(); // sin HTML ni caracteres de control
const hayEnlace = (s) => /(https?:\/\/|www\.|\.(com|net|org|ve|info)\b|@\w+\.\w+)/i.test(s);  // antispam: sin enlaces ni correos
const ipDe = (req) => String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
const vacio = { ok: true, disponible: false, resumen: { total: 0, promedio: null }, data: [] };

async function aprobadas(sku) {
  const [l] = await pipeline([['LRANGE', 'nx:resenas:ok:' + sku, 0, MAX_LEER - 1]]);
  const ids = l.result || []; if (!ids.length) return [];
  const [m] = await pipeline([['MGET', ...ids.map((i) => 'nx:resena:' + i)]]);
  return (m.result || []).filter(Boolean).map((s) => JSON.parse(s)).filter((r) => r.estado === 'aprobada');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) return res.status(403).json({ message: 'Origen no permitido.' }); }
  catch (e) { return res.status(403).json({ message: 'Origen no permitido.' }); }
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return res.status(403).json({ message: 'Origen no permitido.' });

  if (req.method === 'GET') {
    const sku = String(req.query.sku || '');
    if (!SKU_OK.test(sku) || !obtener(sku)) return res.status(404).json({ ok: false, message: 'Producto no encontrado.' });
    if (!configurado()) return res.status(200).json(vacio);
    try {
      const l = await aprobadas(sku);
      const prom = l.length ? Math.round((l.reduce((s, r) => s + r.estrellas, 0) / l.length) * 10) / 10 : null;
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json({ ok: true, disponible: true, resumen: { total: l.length, promedio: prom }, data: l.map((r) => ({ nombre: r.nombre, estrellas: r.estrellas, texto: r.texto, fecha: r.creada })) });
    } catch (e) { console.error(JSON.stringify({ nivel: 'ALERTA', code: 'RESENAS_ALMACEN', que_hacer: 'No se pudieron leer las reseñas del almacén (Upstash/KV).' })); return res.status(200).json(vacio); }
  }

  if (req.method !== 'POST') return res.status(405).json({ message: 'Método no permitido.' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (b.web) return res.status(202).json({ ok: true, estado: 'pendiente' }); // campo trampa anti-bots
  if (limitar('resena:' + ipDe(req), 3, 60 * 60 * 1000)) { res.setHeader('Retry-After', '3600'); return res.status(429).json({ message: 'Ya enviaste varias reseñas. Inténtalo más tarde.' }); }

  const sku = String(b.producto_sku || '');
  if (!SKU_OK.test(sku) || !obtener(sku)) return res.status(400).json({ message: 'Producto no encontrado.' });
  const nombre = typeof b.nombre === 'string' ? limpiar(b.nombre) : '';
  if (!NOMBRE_OK.test(nombre)) return res.status(400).json({ message: 'Escribe tu nombre (de 2 a 30 letras).' });
  const texto = typeof b.texto === 'string' ? limpiar(b.texto) : '';
  if (texto.length < 20 || texto.length > 600) return res.status(400).json({ message: 'Cuéntanos tu experiencia en 20 a 600 caracteres.' });
  if (hayEnlace(texto) || hayEnlace(nombre)) return res.status(400).json({ message: 'Por favor no incluyas enlaces ni correos.' });
  const estrellas = Number(b.estrellas);
  if (!Number.isInteger(estrellas) || estrellas < 1 || estrellas > 5) return res.status(400).json({ message: 'Elige de 1 a 5 estrellas.' });
  if (!configurado()) return res.status(503).json({ message: 'Las reseñas estarán disponibles muy pronto.' });

  try {
    const [n] = await pipeline([['LLEN', 'nx:resenas:pend']]);
    if (Number(n.result) >= MAX_PENDIENTES) return res.status(503).json({ message: 'Estamos recibiendo muchas reseñas. Inténtalo más tarde.' });
    const id = crypto.randomBytes(8).toString('hex');
    const rec = { id, sku, nombre, texto, estrellas, estado: 'pendiente', creada: new Date().toISOString() };
    await pipeline([['SET', 'nx:resena:' + id, JSON.stringify(rec), 'EX', VENCE_PENDIENTE_SEG], ['LPUSH', 'nx:resenas:pend', id]]);
    return res.status(202).json({ ok: true, estado: 'pendiente', message: '¡Gracias! Tu reseña se publicará cuando la revisemos.' });
  } catch (e) { return res.status(503).json({ message: 'No pudimos guardar tu reseña. Inténtalo más tarde.' }); }
};
