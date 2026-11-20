'use strict';
// GET  /api/resenas?sku=xxx  ->  { data: [{ id, producto_sku, nombre, texto, estrellas, created_at }] }
// POST /api/resenas  { producto_sku, nombre, texto, estrellas }  ->  { data: { … } }
// Reseñas de clientes. Se guardan en Supabase (tabla `resenas`). El navegador nunca habla con Supabase
// directamente: pasa por aquí (mismo origen) para respetar el CSP (connect-src 'self').
const { obtener } = require('../lib/catalogo');

const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const mismoOrigen = (req) => {
  try { const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) return false; } catch (e) { return false; }
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin') return false;
  return true;
};

const limpiar = (s, max) => String(s || '').trim().slice(0, max);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!mismoOrigen(req)) return res.status(403).json({ message: 'Origen no permitido.' });
  if (!SB_URL || !SB_KEY) return res.status(503).json({ message: 'Reseñas no configuradas.' });

  if (req.method === 'GET') {
    const sku = limpiar(req.query && req.query.sku, 80);
    if (!sku || !obtener(sku)) return res.status(200).json({ data: [] });
    try {
      const r = await fetch(SB_URL + '/rest/v1/resenas?producto_sku=eq.' + encodeURIComponent(sku) + '&order=created_at.desc&limit=50', {
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY },
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      if (!r.ok) return res.status(502).json({ message: 'No se pudieron cargar las reseñas.' });
      return res.status(200).json({ data: j || [] });
    } catch (e) {
      return res.status(502).json({ message: 'No se pudieron cargar las reseñas.' });
    }
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const sku = limpiar(b.producto_sku, 80);
    const nombre = limpiar(b.nombre, 60);
    const texto = limpiar(b.texto, 500);
    const estrellas = Math.round(Number(b.estrellas));
    if (!sku || !obtener(sku)) return res.status(400).json({ message: 'Producto no válido.' });
    if (!nombre || nombre.length < 2) return res.status(400).json({ message: 'Escribe tu nombre.' });
    if (!texto || texto.length < 5) return res.status(400).json({ message: 'Escribe tu reseña.' });
    if (!estrellas || estrellas < 1 || estrellas > 5) return res.status(400).json({ message: 'Elige una calificación.' });
    try {
      const r = await fetch(SB_URL + '/rest/v1/resenas', {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ producto_sku: sku, nombre, texto, estrellas }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      if (!r.ok) return res.status(502).json({ message: 'No se pudo guardar tu reseña.' });
      return res.status(200).json({ data: (j && j[0]) || null });
    } catch (e) {
      return res.status(502).json({ message: 'No se pudo guardar tu reseña.' });
    }
  }

  return res.status(405).json({ message: 'Método no permitido.' });
};
