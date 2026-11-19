'use strict';
// GET /api/productos -> catálogo público (sin IDs internos) + categorías + tasa Bs/USD.
const { publico, categorias, productoRef } = require('../lib/catalogo');
const { tasaBs } = require('../lib/dropanas');

module.exports = async (req, res) => {
  let tasa = null;
  try { tasa = await tasaBs(productoRef()); } catch (e) { /* sin tasa: la tienda muestra solo USD */ }
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  return res.status(200).json({ tasa_bs: tasa, categorias: categorias(), productos: publico(tasa) });
};
