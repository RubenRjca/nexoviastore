'use strict';
// Lógica de seguimiento compartida por /api/rastreo (referencia + 4 dígitos) y /api/mis-pedidos (cuenta con sesión).
const { llamar } = require('./cliente');
const { recordar } = require('./cache');
const { falloDe } = require('./errores');
const respaldo = require('./respaldo');
const usuarios = require('./usuarios');

const etapa = (txt) => {
  const s = String(txt || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return s.includes('entregad') ? 'entregado' : s.includes('novedad') ? 'novedad' : s.includes('reparto') ? 'en_reparto' : s.includes('camino') ? 'en_camino' : s.includes('preparaci') ? 'preparando' : 'recibido';
};
const TEXTO = {
  recibido: 'Recibimos tu pedido y lo estamos organizando.', preparando: 'Tu pedido está en preparación.', en_camino: 'Tu pedido va en camino.',
  en_reparto: 'Tu pedido salió a reparto: pronto llegará a tu dirección.', entregado: '¡Tu pedido fue entregado!', novedad: 'Hubo una novedad con tu entrega. Revisa el detalle abajo.',
  en_revision: 'Estamos verificando tu pedido (y tu pago, si pagaste por adelantado). Te avisaremos cuando salga.', en_cola: 'Tu pedido quedó en cola por mantenimiento de la plataforma y se procesará automáticamente.',
  no_procesado: 'No pudimos procesar tu pedido. Te contactaremos para ayudarte.',
  pendiente_confirmacion: 'Recibimos tu pedido. Está pendiente de confirmación; en cuanto lo confirmemos verás aquí su avance.',
};

async function cargar(ref) {
  const o = await llamar('/ordenes/ext:' + ref);
  if (o.ok && o.j && o.j.data) { const d = o.j.data; return { ok: true, v: { id: d.id, telefono: (d.cliente || {}).telefono, aprobacion: d.estado_aprobacion || null } }; }
  if (o.status !== 404) return falloDe(o);
  const rec = await respaldo.obtener(ref); // ¿quedó en cola o fue rechazado?
  if (!rec) { // DroPanas no la encuentra (¿aún pendiente?): si nosotros la creamos, lo decimos en vez de "no existe"
    const mio = await usuarios.pedidoPorRef(ref).catch(() => null);
    return { ok: true, v: mio ? { id: null, telefono: mio.tel4, estado: 'pendiente_confirmacion' } : null };
  }
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


// Arma la respuesta de estado para un pedido ya localizado (v = resultado de cargar()). { ok:true, body } o { ok:false, clas }.
async function armar(ref, v) {
  const base = { ok: true, referencia: ref, actualizado: new Date().toISOString() };
  if (!v.id) return { ok: true, body: { ...base, estado: v.estado, mensaje: TEXTO[v.estado], historial: [] } };
  const t = await tracking(v.id);
  if (!t.ok) return { ok: false, clas: t.clas };
  const d = t.v || {};
  const pendiente = /pendiente/i.test(v.aprobacion || ''), rechazada = /rechaz|cancel/i.test(v.aprobacion || '');
  const estado = rechazada ? 'no_procesado' : (pendiente && (d.sin_guia || !d.status_actual)) ? 'en_revision' : etapa(d.status_actual);
  return { ok: true, body: {
    ...base, estado, mensaje: TEXTO[estado], estado_texto: d.status_actual || null, numero_guia: d.numero_guia || null, fecha_entrega: d.fecha_entrega || null,
    historial: (Array.isArray(d.historial) ? d.historial : []).slice(-20).map((h) => ({ estado: h.status, detalle: h.descripcion || null, fecha: h.created_at || null })),
  } };
}
const ult4 = (t) => String(t || '').replace(/\D/g, '').slice(-4);

module.exports = { etapa, TEXTO, cargar, tracking, armar, ult4 };
