'use strict';
// GET /api/cotizar?sku=…&estado=ID&ciudad=ID&cantidad=1&metodo=contra_entrega|anticipado
// Comprueba cobertura de entrega y devuelve el precio final único (envío incluido). El flete cotizado NO se expone al navegador.
const { obtener, configurado, precioVigente } = require('../lib/catalogo');
const { cotizarRuta, elegirOpcion } = require('../lib/cotizacion');
const { alertar } = require('../lib/errores');
const { limitar } = require('../lib/cache');
const precio = require('../lib/precio');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ message: 'Método no permitido.' });
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return res.status(403).json({ message: 'Origen no permitido.' });
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (limitar('cotizar:' + ip, 40, 60 * 1000)) { res.setHeader('Retry-After', '30'); return res.status(429).json({ message: 'Demasiadas consultas. Espera un momento.' }); }
  const q = req.query || {}, item = obtener(q.sku), qty = Number(q.cantidad || 1), state = Number(q.estado), city = Number(q.ciudad);
  const anticipado = q.metodo === 'anticipado';
  if (!item) return res.status(400).json({ message: 'Producto no disponible.' });
  if (!Number.isInteger(qty) || qty < 1 || qty > 20 || !Number.isInteger(state) || !Number.isInteger(city)) return res.status(400).json({ message: 'Elige tu estado y ciudad.' });
  if (!configurado(item)) return res.status(503).json({ message: 'Este producto no está disponible por ahora.' });
  const cot = await cotizarRuta({ bodega: item.bodega_origen_id, state, city, tipoPago: anticipado ? 'sin_recaudo' : 'con_recaudo' });
  if (!cot.ok) { alertar(cot.clas, { ruta: 'cotizar' }); if (cot.clas.retryAfter) res.setHeader('Retry-After', String(cot.clas.retryAfter)); return res.status(cot.clas.http === 404 ? 503 : cot.clas.http).json({ code: cot.clas.code, message: cot.clas.message }); }
  const op = elegirOpcion(cot.v, anticipado);
  if (!op) return res.status(422).json({ code: 'SIN_COBERTURA', message: anticipado ? 'Por ahora no tenemos entrega a domicilio en tu ciudad.' : 'En tu ciudad no está disponible el Pago Contra Entrega.' });
  const envio = Number(op.precio_usd);
  if (!Number.isFinite(envio) || envio < 0) return res.status(503).json({ code: 'ENVIO_NO_DISPONIBLE', message: 'No pudimos calcular el envío. Inténtalo de nuevo en un momento.' });
  const c = precio.calcular(precioVigente(item), qty, envio);
  return res.status(200).json({ ok: true, total_usd: c.total, tiempo: op.tiempo_estimado || null });
};
