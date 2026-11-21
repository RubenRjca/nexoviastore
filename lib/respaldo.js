'use strict';
// Respaldo de pedidos: nada se pierde en silencio cuando DroPanas rechaza, se cae la red o el pedido queda en cola.
//  - Los LOGS de Vercel llevan solo datos enmascarados (teléfono ***1234, sin dirección).
//  - El detalle completo (para recuperar la venta a mano) va a un almacén PRIVADO con vencimiento de 30 días:
//    Upstash Redis / Vercel KV por su API REST (variables KV_REST_API_URL + KV_REST_API_TOKEN, o UPSTASH_REDIS_REST_URL + _TOKEN).
//  - Nunca se guardan llaves, cabeceras ni Idempotency-Key. Nunca se devuelve nada de esto a un endpoint público.
//  - Si no hay almacén configurado, registrar() NO falla: deja el log enmascarado y avisa { guardado:false }.
const TTL_SEG = 30 * 24 * 3600;
const url = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const enmascarar = (t) => (t ? '***' + String(t).replace(/\D/g, '').slice(-4) : null);

async function pipeline(cmds) {
  const r = await fetch(url().replace(/\/$/, '') + '/pipeline', {
    method: 'POST', signal: AbortSignal.timeout(4000),
    headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' }, body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('almacen ' + r.status);
  return r.json();
}

// ev: { tipo: rechazo|en_cola|error_red, ref, sku, cantidad, metodo_pago, variante_id, http, code, solicitud_id, motivo, cliente, direccion, pago, nota }
async function registrar(ev) {
  const reg = {
    v: 1, ts: new Date().toISOString(), tipo: ev.tipo, ref: ev.ref, sku: ev.sku, cantidad: ev.cantidad, metodo_pago: ev.metodo_pago,
    variante_id: ev.variante_id == null ? null : ev.variante_id, http: ev.http == null ? null : ev.http, code: ev.code || null,
    solicitud_id: ev.solicitud_id == null ? null : ev.solicitud_id, motivo: ev.motivo || null,
    cliente: ev.cliente ? { nombre: ev.cliente.nombre, apellido: ev.cliente.apellido, telefono: ev.cliente.telefono } : null,
    direccion: ev.direccion ? { state_id: ev.direccion.state_id, city_id: ev.direccion.city_id, direccion: ev.direccion.direccion, referencia: ev.direccion.referencia || null } : null,
    pago: ev.pago || null, nota: ev.nota || null,
  };
  console.error(JSON.stringify({ evento: 'pedido_' + reg.tipo, ref: reg.ref, sku: reg.sku, cantidad: reg.cantidad, metodo_pago: reg.metodo_pago, http: reg.http, code: reg.code, solicitud_id: reg.solicitud_id, tel: enmascarar(reg.cliente && reg.cliente.telefono) }));
  if (!url() || !token()) return { guardado: false, motivo: 'sin_almacen' };
  try {
    await pipeline([['SET', 'nx:pedido:' + reg.ref, JSON.stringify(reg), 'EX', TTL_SEG], ['LPUSH', 'nx:pedidos:recientes', reg.ref], ['LTRIM', 'nx:pedidos:recientes', 0, 499]]);
    return { guardado: true };
  } catch (e) {
    console.error(JSON.stringify({ nivel: 'ALERTA', code: 'RESPALDO_FALLO', que_hacer: 'No se pudo guardar el respaldo del pedido ' + reg.ref + '. Revisa el almacén (Upstash/KV).' }));
    return { guardado: false, motivo: 'error_almacen' };
  }
}

async function obtener(ref) {
  if (!url() || !token()) return null;
  try { const [x] = await pipeline([['GET', 'nx:pedido:' + ref]]); return x && x.result ? JSON.parse(x.result) : null; } catch (e) { return null; }
}

async function recientes(n = 50) {
  if (!url() || !token()) return [];
  try {
    const [l] = await pipeline([['LRANGE', 'nx:pedidos:recientes', 0, Math.min(n, 500) - 1]]);
    const refs = [...new Set(l.result || [])];
    if (!refs.length) return [];
    const [m] = await pipeline([['MGET', ...refs.map((r) => 'nx:pedido:' + r)]]);
    return (m.result || []).filter(Boolean).map((s) => JSON.parse(s));
  } catch (e) { return []; }
}

module.exports = { registrar, obtener, recientes, enmascarar };
