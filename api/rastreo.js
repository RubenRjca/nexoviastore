'use strict';
// GET /api/rastreo?ref=NX1A2B3C4D5E6F&tel=4567
// Estado y tracking de un pedido, para que el cliente lo consulte con SU número de pedido + los últimos 4 dígitos de su teléfono.
// Flujo: GET /ordenes/ext:{ref} -> GET /ordenes/{id}/tracking. Si el pedido quedó en cola (202 MAINTENANCE_QUEUED) se resuelve
// con el respaldo (lib/respaldo.js) y GET /ordenes/en-cola/{solicitud_id}. La llave DROPANAS_API_KEY solo vive en el servidor.
// Privacidad: la respuesta NUNCA incluye nombre, teléfono, dirección ni enlaces a la guía. Si el número o los 4 dígitos no
// coinciden, la respuesta es idéntica a "no existe" (no se puede averiguar qué pedidos existen).
const { llamar } = require('../lib/cliente');
const { recordar, limitar } = require('../lib/cache');
const { falloDe, alertar } = require('../lib/errores');
const respaldo = require('../lib/respaldo');

const REF_OK = /^NX[A-F0-9]{12}$/; // las referencias las fabrica crear-orden: 'NX' + 12 hex en mayúsculas
const NO_ENCONTRADO = { ok: false, estado: 'no_encontrado', message: 'No encontramos un pedido con esos datos. Revisa tu número de pedido y los últimos 4 dígitos de tu teléfono.' };
const fallos = new Map(); // ref -> { n, hasta }: tras 5 intentos con 4 dígitos erróneos se bloquea la consulta 15 min

const ult4 = (t) => String(t || '').replace(/\D/g, '').slice(-4);
const bloqueada = (ref) => { const f = fallos.get(ref); return !!f && f.hasta > Date.now(); };
function falloTel(ref) {
  const f = fallos.get(ref) || { n: 0, hasta: 0 };
  if (++f.n >= 5) { f.hasta = Date.now() + 15 * 60 * 1000; f.n = 0; }
  fallos.set(ref, f); if (fallos.size > 3000) fallos.clear();
}
const etapa = (txt) => {
  const s = String(txt || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return s.includes('entregad') ? 'entregado' : s.includes('novedad') ? 'novedad' : s.includes('reparto') ? 'en_reparto' : s.includes('camino') ? 'en_camino' : s.includes('preparaci') ? 'preparando' : 'recibido';
};
const TEXTO = {
  recibido: 'Recibimos tu pedido y lo estamos organizando.', preparando: 'Tu pedido está en preparación.', en_camino: 'Tu pedido va en camino.',
  en_reparto: 'Tu pedido salió a reparto: pronto llegará a tu dirección.', entregado: '¡Tu pedido fue entregado!', novedad: 'Hubo una novedad con tu entrega. Revisa el detalle abajo.',
  en_revision: 'Estamos verificando tu pedido (y tu pago, si pagaste por adelantado). Te avisaremos cuando salga.', en_cola: 'Tu pedido quedó en cola por mantenimiento de la plataforma y se procesará automáticamente.',
  no_procesado: 'No pudimos procesar tu pedido. Te contactaremos para ayudarte.',
};

async function cargar(ref) {
  const o = await llamar('/ordenes/ext:' + ref);
  if (o.ok && o.j && o.j.data) { const d = o.j.data; return { ok: true, v: { id: d.id, telefono: (d.cliente || {}).telefono, aprobacion: d.estado_aprobacion || null } }; }
  if (o.status !== 404) return falloDe(o);
  const rec = await respaldo.obtener(ref); // ¿quedó en cola o fue rechazado?
  if (!rec) return { ok: true, v: null };
  const tel = rec.cliente && rec.cliente.telefono;
  if (rec.tipo === 'en_cola' && rec.solicitud_id) {
    const q = await llamar('/ordenes/en-cola/' + encodeURIComponent(rec.solicitud_id));
    if (!q.ok) return falloDe(q);
    const s = (q.j && q.j.data) || {};
    if (s.estado === 'procesado' && s.orden_id) {
      const o2 = await llamar('/ordenes/' + encodeURIComponent(s.orden_id));
      if (o2.ok && o2.j && o2.j.data) return { ok: true, v: { id: s.orden_id, telefono: tel, aprobacion: o2.j.data.estado_aprobacion || null } };
    }
    return { ok: true, v: { id: null, telefono: tel, estado: s.estado === 'fallido' || s.estado === 'descartado' ? 'no_procesado' : 'en_cola' } };
  }
  return { ok: true, v: { id: null, telefono: tel, estado: 'no_procesado' } };
}

const tracking = (id) => recordar('trk:' + id, { ttlOk: 20 * 1000, ttlFail: 15 * 1000 }, async () => {
  const x = await llamar(`/ordenes/${encodeURIComponent(id)}/tracking`);
  if (x.ok) return { ok: true, v: (x.j && x.j.data) || {} };
  if (x.j && x.j.code === 'TRACKING_NOT_AVAILABLE') return { ok: true, v: { sin_guia: true } }; // aún sin guía (p. ej. pendiente de aprobación)
  return falloDe(x);
});

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ message: 'Método no permitido.' });
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return res.status(403).json({ message: 'Origen no permitido.' });
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (limitar('rastreo:' + ip, 20, 60 * 1000)) { res.setHeader('Retry-After', '30'); return res.status(429).json({ message: 'Demasiadas consultas. Espera un momento.' }); }

  const ref = String(req.query.ref || '').trim().toUpperCase(), cuatro = String(req.query.tel || '').replace(/\D/g, '').slice(-4);
  if (!REF_OK.test(ref) || cuatro.length !== 4) return res.status(400).json({ ok: false, message: 'Escribe tu número de pedido y los últimos 4 dígitos de tu teléfono.' });
  if (bloqueada(ref)) { res.setHeader('Retry-After', '900'); return res.status(429).json({ message: 'Demasiados intentos con este pedido. Inténtalo más tarde.' }); }

  const r = await recordar('orden:' + ref, { ttlOk: 20 * 1000, ttlFail: 10 * 1000 }, () => cargar(ref));
  if (!r.ok) {
    alertar(r.clas, { ruta: 'rastreo', ref });
    if (r.clas.retryAfter) res.setHeader('Retry-After', String(r.clas.retryAfter));
    return res.status(r.clas.http === 404 ? 502 : r.clas.http).json({ ok: false, code: r.clas.code, message: r.clas.message });
  }
  const v = r.v;
  if (!v || ult4(v.telefono) !== cuatro) { falloTel(ref); return res.status(404).json(NO_ENCONTRADO); }

  const base = { ok: true, referencia: ref, actualizado: new Date().toISOString() };
  if (!v.id) return res.status(200).json({ ...base, estado: v.estado, mensaje: TEXTO[v.estado], historial: [] });

  const t = await tracking(v.id);
  if (!t.ok) {
    alertar(t.clas, { ruta: 'rastreo', ref });
    if (t.clas.retryAfter) res.setHeader('Retry-After', String(t.clas.retryAfter));
    return res.status(t.clas.http === 404 ? 502 : t.clas.http).json({ ok: false, code: t.clas.code, message: t.clas.message });
  }
  const d = t.v || {};
  const pendiente = /pendiente/i.test(v.aprobacion || ''), rechazada = /rechaz|cancel/i.test(v.aprobacion || '');
  const estado = rechazada ? 'no_procesado' : (pendiente && (d.sin_guia || !d.status_actual)) ? 'en_revision' : etapa(d.status_actual);
  return res.status(200).json({
    ...base, estado, mensaje: TEXTO[estado], estado_texto: d.status_actual || null, numero_guia: d.numero_guia || null, fecha_entrega: d.fecha_entrega || null,
    historial: (Array.isArray(d.historial) ? d.historial : []).slice(-20).map((h) => ({ estado: h.status, detalle: h.descripcion || null, fecha: h.created_at || null })),
  });
};
