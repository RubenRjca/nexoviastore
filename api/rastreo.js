'use strict';
// GET /api/rastreo?ref=NX1A2B3C4D5E6F&tel=4567
// Estado y tracking de un pedido, para que el cliente lo consulte con SU código de compra + los últimos 4 dígitos de su teléfono.
// Flujo: GET /ordenes/ext:{ref} -> GET /ordenes/{id}/tracking. Si el pedido quedó en cola (202 MAINTENANCE_QUEUED) se resuelve
// con el respaldo (lib/respaldo.js) y GET /ordenes/en-cola/{solicitud_id}. La llave DROPANAS_API_KEY solo vive en el servidor.
// Privacidad: la respuesta NUNCA incluye nombre, teléfono, dirección ni enlaces a la guía. Si el número o los 4 dígitos no
// coinciden, la respuesta es idéntica a "no existe" (no se puede averiguar qué pedidos existen).
const { recordar, limitar } = require('../lib/cache');
const { falloDe, alertar } = require('../lib/errores');
const { cargar, armar, ult4 } = require('../lib/seguimiento');
const usuarios = require('../lib/usuarios');

const REF_OK = /^NX[A-F0-9]{12}$/; // las referencias las fabrica crear-orden: 'NX' + 12 hex en mayúsculas
const NO_ENCONTRADO = { ok: false, estado: 'no_encontrado', message: 'No encontramos un pedido con esos datos. Revisa tu código de compra y los últimos 4 dígitos de tu teléfono.' };
const fallos = new Map(); // ref -> { n, hasta }: tras 5 intentos con 4 dígitos erróneos se bloquea la consulta 15 min

const bloqueada = (ref) => { const f = fallos.get(ref); return !!f && f.hasta > Date.now(); };
function falloTel(ref) {
  const f = fallos.get(ref) || { n: 0, hasta: 0 };
  if (++f.n >= 5) { f.hasta = Date.now() + 15 * 60 * 1000; f.n = 0; }
  fallos.set(ref, f); if (fallos.size > 3000) fallos.clear();
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ message: 'Método no permitido.' });
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return res.status(403).json({ message: 'Origen no permitido.' });
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (limitar('rastreo:' + ip, 20, 60 * 1000)) { res.setHeader('Retry-After', '30'); return res.status(429).json({ message: 'Demasiadas consultas. Espera un momento.' }); }

  const ref = String(req.query.ref || '').trim().toUpperCase(), cuatro = String(req.query.tel || '').replace(/\D/g, '').slice(-4);
  if (!REF_OK.test(ref) || cuatro.length !== 4) return res.status(400).json({ ok: false, message: 'Escribe tu código de compra y los últimos 4 dígitos de tu teléfono.' });
  if (bloqueada(ref)) { res.setHeader('Retry-After', '900'); return res.status(429).json({ message: 'Demasiados intentos con este pedido. Inténtalo más tarde.' }); }

  const r = await recordar('orden:' + ref, { ttlOk: 20 * 1000, ttlFail: 10 * 1000 }, () => cargar(ref));
  if (!r.ok) {
    alertar(r.clas, { ruta: 'rastreo', ref });
    if (r.clas.retryAfter) res.setHeader('Retry-After', String(r.clas.retryAfter));
    return res.status(r.clas.http === 404 ? 502 : r.clas.http).json({ ok: false, code: r.clas.code, message: r.clas.message });
  }
  const v = r.v;
  // Autorización: los 4 dígitos deben coincidir con el teléfono de DroPanas o con el que guardamos al crear el pedido.
  let ok = !!v && ult4(v.telefono) === cuatro;
  if (v && !ok) { const mio = await usuarios.pedidoPorRef(ref).catch(() => null); ok = !!mio && mio.tel4 === cuatro; }
  if (!ok) {
    // Diagnóstico SIN datos personales: ¿DroPanas no la encuentra o los 4 dígitos no coinciden?
    console.warn(JSON.stringify({ nivel: 'AVISO', code: 'RASTREO_NO_ENCONTRADO', causa: v ? 'telefono_no_coincide' : 'orden_no_encontrada', ref }));
    falloTel(ref); return res.status(404).json(NO_ENCONTRADO);
  }
  const a2 = await armar(ref, v);
  if (!a2.ok) {
    alertar(a2.clas, { ruta: 'rastreo', ref });
    if (a2.clas.retryAfter) res.setHeader('Retry-After', String(a2.clas.retryAfter));
    return res.status(a2.clas.http === 404 ? 502 : a2.clas.http).json({ ok: false, code: a2.clas.code, message: a2.clas.message });
  }
  return res.status(200).json(a2.body);
};
