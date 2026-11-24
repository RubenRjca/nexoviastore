'use strict';
// Perfil y pedidos por usuario en el almacén privado (Upstash/KV). Sin almacén configurado, todo responde vacío (nunca rompe la compra).
//  nx:u:{sub}   perfil JSON            nx:uo:{sub}  ZSET de referencias NX… (score = fecha)            nx:o:{ref}  pedido JSON
const { configurado, pipeline } = require('./almacen');

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
const SIN_TTL = 400 * 86400; // los pedidos se conservan ~13 meses

async function obtenerUsuario(sub) {
  if (!configurado()) return null;
  const [r] = await pipeline([['GET', 'nx:u:' + sub]]); return parse(r.result);
}
async function guardarUsuario(u) { // u: { sub, email, nombre, nombres, apellidos, foto }; conserva el "perfil" guardado antes
  if (!configurado()) return;
  const previo = (await obtenerUsuario(u.sub)) || {};
  await pipeline([['SET', 'nx:u:' + u.sub, JSON.stringify({ ...previo, ...u, perfil: previo.perfil || null, visto: new Date().toISOString() })]]);
}
async function guardarPerfil(sub, perfil) {
  if (!configurado() || !sub) return;
  const u = (await obtenerUsuario(sub)) || { sub };
  await pipeline([['SET', 'nx:u:' + sub, JSON.stringify({ ...u, perfil })]]);
}
// Foto de perfil propia: JPEG en base64 en su propia clave (para no inflar el perfil); `foto_v` en el usuario sirve de versión para el caché.
async function obtenerFoto(sub) { if (!configurado() || !sub) return null; const [r] = await pipeline([['GET', 'nx:uf:' + sub]]); return r.result || null; }
async function guardarFoto(sub, b64) { // b64 = null → quitar
  if (!configurado() || !sub) return false;
  const u = (await obtenerUsuario(sub)) || { sub };
  const cmds = [['SET', 'nx:u:' + sub, JSON.stringify({ ...u, foto_v: b64 ? Date.now() : null })]];
  cmds.push(b64 ? ['SET', 'nx:uf:' + sub, b64] : ['DEL', 'nx:uf:' + sub]);
  await pipeline(cmds); return true;
}
async function guardarPedido(rec) { // rec.sub puede ser null (compra sin cuenta): igual se guarda por referencia
  if (!configurado()) return false;
  const cmds = [['SET', 'nx:o:' + rec.ref, JSON.stringify(rec), 'EX', SIN_TTL]];
  if (rec.sub) cmds.push(['ZADD', 'nx:uo:' + rec.sub, Date.parse(rec.creado) || Date.now(), rec.ref]);
  await pipeline(cmds); return true;
}
async function pedidoPorRef(ref) {
  if (!configurado()) return null;
  const [r] = await pipeline([['GET', 'nx:o:' + ref]]); return parse(r.result);
}
async function pedidosDeUsuario(sub, n = 20) {
  if (!configurado()) return [];
  const [z] = await pipeline([['ZREVRANGE', 'nx:uo:' + sub, 0, n - 1]]);
  const refs = Array.isArray(z.result) ? z.result : []; if (!refs.length) return [];
  const rs = await pipeline(refs.map((r) => ['GET', 'nx:o:' + r]));
  return rs.map((x) => parse(x.result)).filter(Boolean).filter((o) => o.sub === sub);
}
module.exports = { obtenerUsuario, guardarUsuario, guardarPerfil, obtenerFoto, guardarFoto, guardarPedido, pedidoPorRef, pedidosDeUsuario };
