'use strict';
// GET /api/mis-pedidos → pedidos de la cuenta con sesión, con su estado y seguimiento en vivo (consulta a DroPanas por cada uno).
// La propiedad la da la sesión (no hace falta pedir los 4 dígitos). Sin Upstash responde disponible:false.
const sesion = require('../lib/sesion');
const usuarios = require('../lib/usuarios');
const { configurado } = require('../lib/almacen');
const { recordar, limitar } = require('../lib/cache');
const { cargar, armar, TEXTO, etapa } = require('../lib/seguimiento');

const PEDIDO_ESTADO = (o, e) => ({
  referencia: o.ref, creado: o.creado, sku: o.sku || null, variante_id: o.variante_id || null, titulo: o.titulo, variante: o.variante_nombre || null, cantidad: o.cantidad,
  total_usd: o.total_usd, modo: o.modo, contacto: o.contacto || null,
  estado: e.estado, mensaje: e.mensaje, estado_texto: e.estado_texto || null, numero_guia: e.numero_guia || null, fecha_entrega: e.fecha_entrega || null,
  historial: (e.historial || []).map((h) => ({ ...h, etapa: etapa(h.estado) })), // etapa → el termómetro del cliente ubica la fecha de cada paso
});
const PENDIENTE = { estado: 'pendiente_confirmacion', mensaje: TEXTO.pendiente_confirmacion, historial: [] };

async function estadoDe(o) {
  try {
    const r = await recordar('orden:' + o.ref, { ttlOk: 20 * 1000, ttlFail: 10 * 1000 }, () => cargar(o.ref));
    if (!r.ok || !r.v) return PENDIENTE;
    const a = await armar(o.ref, r.v);
    return a.ok ? a.body : PENDIENTE;
  } catch (e) { return PENDIENTE; } // si DroPanas no responde, el cliente igual ve su pedido y su código NX…
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ message: 'Método no permitido.' });
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return res.status(403).json({ message: 'Origen no permitido.' });
  const s = sesion.leer(req);
  if (!s) return res.status(401).json({ ok: false, code: 'LOGIN_REQUERIDO', message: 'Inicia sesión para ver tus pedidos.' });
  if (limitar('mp:' + s.sub, 20, 60 * 1000)) { res.setHeader('Retry-After', '30'); return res.status(429).json({ message: 'Demasiadas consultas. Espera un momento.' }); }
  if (!configurado()) return res.status(200).json({ ok: true, disponible: false, pedidos: [] });
  let lista;
  const n = req.query && req.query.activo === '1' ? 3 : 10; // ?activo=1: solo los últimos (consulta ligera para la tarjeta «Tu pedido actual»)
  try { lista = await usuarios.pedidosDeUsuario(s.sub, n); } catch (e) { return res.status(503).json({ ok: false, message: 'No pudimos cargar tus pedidos. Inténtalo de nuevo en un momento.' }); }
  const pedidos = await Promise.all(lista.map(async (o) => PEDIDO_ESTADO(o, await estadoDe(o))));
  return res.status(200).json({ ok: true, disponible: true, pedidos });
};
