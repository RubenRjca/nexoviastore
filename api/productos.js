'use strict';
// GET /api/productos -> catálogo público (sin IDs internos) + categorías + tasa Bs/USD y de DÓNDE viene la tasa.
//   tasa_fuente: 'manual' (variable TASA_BS) | 'dropanas' (deducida del precio sugerido en USD y Bs) |
//                'respaldo' (variable TASA_BS_RESPALDO: un número que TÚ pones; el sitio avisa que es aproximada) | null (solo USD)
const { publico, categorias, productoRef } = require('../lib/catalogo');
const { tasaBs } = require('../lib/dropanas');

module.exports = async (req, res) => {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ message: 'Método no permitido.' });
  let tasa = null, fuente = null;
  try { tasa = await tasaBs(productoRef()); if (tasa) fuente = Number(process.env.TASA_BS) > 0 ? 'manual' : 'dropanas'; } catch (e) { /* sin tasa en vivo */ }
  if (!tasa) { const r = Number(process.env.TASA_BS_RESPALDO); if (r > 0) { tasa = r; fuente = 'respaldo'; } }
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=120');
  return res.status(200).json({ tasa_bs: tasa, tasa_fuente: fuente, whatsapp: String(process.env.WHATSAPP_TIENDA || '').replace(/\D/g, '') || null, categorias: categorias(), productos: publico(tasa) });
};
