#!/usr/bin/env node
'use strict';
// Moderación de reseñas (se corre en TU computador; no hay panel público de administración).
//   KV_REST_API_URL=... KV_REST_API_TOKEN=... node scripts/resenas-moderar.js listar            reseñas pendientes
//   ...                                          aprobar <id>     la publica en la tienda
//   ...                                          rechazar <id>    la descarta
//   ...                                          publicadas <sku> reseñas visibles de un producto
//   ...                                          quitar <id>      despublica una ya aprobada
const { configurado, pipeline } = require('../lib/almacen');
const K = (id) => 'nx:resena:' + id;
const get = async (id) => { const [x] = await pipeline([['GET', K(id)]]); return x.result ? JSON.parse(x.result) : null; };
const fila = (r) => `#${r.id}  ${'★'.repeat(r.estrellas)}${'☆'.repeat(5 - r.estrellas)}  ${r.sku}  ${r.nombre}\n     ${r.texto}\n`;

async function listar() {
  const [l] = await pipeline([['LRANGE', 'nx:resenas:pend', 0, 99]]); const ids = l.result || [];
  if (!ids.length) return console.log('No hay reseñas pendientes.');
  const [m] = await pipeline([['MGET', ...ids.map(K)]]);
  (m.result || []).filter(Boolean).map(JSON.parse).forEach((r) => console.log(fila(r)));
  console.log(`${ids.length} pendiente(s). Aprueba con: node scripts/resenas-moderar.js aprobar <id>`);
}
async function aprobar(id) {
  const r = await get(id); if (!r) throw new Error('No existe esa reseña (o ya venció).'); if (r.estado !== 'pendiente') throw new Error('Esa reseña ya está ' + r.estado + '.');
  r.estado = 'aprobada'; r.aprobada = new Date().toISOString();
  await pipeline([['SET', K(id), JSON.stringify(r)], ['LREM', 'nx:resenas:pend', 0, id], ['LPUSH', 'nx:resenas:ok:' + r.sku, id]]);
  console.log('✔ Publicada en', r.sku);
}
async function rechazar(id) {
  const r = await get(id); if (!r) throw new Error('No existe esa reseña.'); r.estado = 'rechazada';
  await pipeline([['SET', K(id), JSON.stringify(r), 'EX', 30 * 24 * 3600], ['LREM', 'nx:resenas:pend', 0, id]]); console.log('✔ Rechazada.');
}
async function quitar(id) {
  const r = await get(id); if (!r) throw new Error('No existe esa reseña.'); r.estado = 'retirada';
  await pipeline([['SET', K(id), JSON.stringify(r), 'EX', 30 * 24 * 3600], ['LREM', 'nx:resenas:ok:' + r.sku, 0, id]]); console.log('✔ Retirada de la tienda.');
}
async function publicadas(sku) {
  const [l] = await pipeline([['LRANGE', 'nx:resenas:ok:' + sku, 0, 99]]); const ids = l.result || [];
  if (!ids.length) return console.log('Sin reseñas publicadas para ' + sku);
  const [m] = await pipeline([['MGET', ...ids.map(K)]]); (m.result || []).filter(Boolean).map(JSON.parse).forEach((r) => console.log(fila(r)));
}

module.exports = { listar, aprobar, rechazar, quitar, publicadas };
if (require.main === module) {
  const [, , cmd, arg] = process.argv, acciones = { listar, aprobar, rechazar, quitar, publicadas };
  if (!configurado()) { console.error('✖ Falta KV_REST_API_URL y KV_REST_API_TOKEN (Upstash Redis / Vercel KV).'); process.exit(1); }
  if (!acciones[cmd] || (cmd !== 'listar' && !arg)) { console.error('Uso: listar | aprobar <id> | rechazar <id> | quitar <id> | publicadas <sku>'); process.exit(1); }
  acciones[cmd](arg).catch((e) => { console.error('✖ ' + e.message); process.exit(1); });
}
