'use strict';
// Existencias REALES por producto y variante, sin agotar el rate limit y sin "fallar hacia adentro":
//  - Fuentes: GET /bodegas/{id}/inventario (existencias de la bodega de despacho) + GET /productos/{id} (tipo y variantes[]).
//  - Un inventario por bodega se comparte entre todos los productos (1 llamada/min por bodega, no por producto).
//  - "No sé" nunca se convierte en "hay": si no se pudo verificar, estado = 'desconocido' (verificado:false). La palabra final
//    la tiene DroPanas al crear la orden (SIN_STOCK_EN_BODEGA / STOCK_INSUFICIENTE).
const { llamar } = require('./cliente');
const { recordar } = require('./cache');
const { falloDe } = require('./errores');

const TTL = { inventario: 60 * 1000, producto: 5 * 60 * 1000, fallo: 20 * 1000 };
const num = (x) => { const n = Number(x); return x === null || x === undefined || x === '' || !Number.isFinite(n) ? null : Math.max(0, Math.floor(n)); };
const limpio = (x) => { const t = String(x === null || x === undefined ? '' : x).trim(); return /^(no detallado|n\/a|ninguno|-|—)$/i.test(t) ? '' : t; }; // DroPanas rellena "No detallado" cuando no hay color/talla
const idVariante = (v) => { if (v && typeof v === 'object') v = v.id !== undefined ? v.id : v.variante_id; const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const configurado = (i) => !!i && Number.isInteger(i.producto_id) && Number.isInteger(i.bodega_origen_id);

function inventario(bodega) {
  return recordar(`inv:${bodega}`, { ttlOk: TTL.inventario, ttlFail: TTL.fallo }, async () => {
    const filas = [];
    for (let pag = 1; pag <= 5; pag++) { // por si la API pagina; si no hay "meta", sale en la primera vuelta
      const r = await llamar(`/bodegas/${bodega}/inventario${pag > 1 ? '?page=' + pag : ''}`);
      if (!r.ok) return falloDe(r);
      filas.push(...(Array.isArray(r.j.data) ? r.j.data : []));
      const ultima = r.j.meta && Number(r.j.meta.last_page);
      if (!ultima || pag >= ultima) break;
    }
    return { ok: true, v: filas };
  });
}
const producto = (id) => recordar(`prod:${id}`, { ttlOk: TTL.producto, ttlFail: TTL.fallo }, async () => {
  const r = await llamar(`/productos/${id}`);
  return r.ok ? { ok: true, v: (r.j && r.j.data) || null } : falloDe(r);
});

async function disponibilidad(item) {
  if (!configurado(item)) return { estado: 'no_configurado', tipo: 'desconocido', total: null, variantes: [], verificado: true, obsoleto: false, degradado: false, retryAfter: null };
  const [inv, det] = await Promise.all([inventario(item.bodega_origen_id), producto(item.producto_id)]);
  const d = det.ok ? det.v : null;
  const filas = inv.ok ? inv.v.filter((f) => f.producto && Number(f.producto.id) === item.producto_id) : [];
  const porVar = new Map();
  for (const f of filas) { const vid = idVariante(f.variante); if (vid) porVar.set(vid, (porVar.get(vid) || 0) + (num(f.cantidad) || 0)); }

  const tipo = d ? (d.tipo_producto === 'variable' ? 'variable' : 'simple') : (porVar.size ? 'variable' : 'desconocido');
  const base = { tipo, verificado: true, obsoleto: !!(inv.obsoleto || det.obsoleto), degradado: !inv.ok || !det.ok, retryAfter: (!inv.ok && inv.retryAfter) || (!det.ok && det.retryAfter) || null };

  if (tipo === 'variable') {
    const lista = d && Array.isArray(d.variantes) ? d.variantes : [];
    const variantes = lista.map((v) => {
      const id = idVariante(v); let disp = porVar.has(id) ? porVar.get(id) : null, fuente = disp === null ? null : 'bodega';
      if (disp === null) { const g = num(v.cantidad !== undefined ? v.cantidad : v.stock); if (g !== null) { disp = g; fuente = 'producto'; } }
      return { id, nombre: limpio(v.nombre) || [v.color, v.size].map(limpio).filter(Boolean).join(' / ') || null, disponible: disp, fuente, estado: disp === null ? 'desconocido' : disp > 0 ? 'disponible' : 'agotado' };
    });
    if (!lista.length) for (const [id, n] of porVar) variantes.push({ id, nombre: null, disponible: n, fuente: 'bodega', estado: n > 0 ? 'disponible' : 'agotado' });
    const estado = variantes.some((v) => v.estado === 'disponible') ? 'disponible' : variantes.length && variantes.every((v) => v.estado === 'agotado') ? 'agotado' : 'desconocido';
    return { ...base, estado, total: null, variantes, verificado: estado !== 'desconocido' };
  }

  let total = null, fuente = null;
  if (filas.length) { total = filas.reduce((s, f) => s + (num(f.cantidad) || 0), 0); fuente = 'bodega'; }
  else if (d) { const g = num(d.stock !== undefined ? d.stock : d.cantidad !== undefined ? d.cantidad : d.stock_total); if (g !== null) { total = g; fuente = 'producto'; } }
  const estado = total === null ? 'desconocido' : total > 0 ? 'disponible' : 'agotado';
  return { ...base, estado, total, fuente, variantes: [], verificado: estado !== 'desconocido' };
}

const sinStock = (n) => ({ ok: false, http: 409, code: 'SIN_STOCK', message: n === 0 ? 'Este producto se agotó.' : n === 1 ? 'Solo queda 1 unidad de este producto.' : `Solo quedan ${n} unidades de este producto.` });

// Validación previa a crear la orden. Solo BLOQUEA con evidencia (producto sin configurar, variante faltante/ajena, stock insuficiente conocido).
async function puedeComprar(item, qty, varianteId) {
  const d = await disponibilidad(item);
  if (d.estado === 'no_configurado') return { ok: false, http: 503, code: 'NO_CONFIGURADO', message: 'Este producto no está disponible por ahora.' };
  if (d.tipo === 'variable') {
    if (!varianteId) return { ok: false, http: 422, code: 'VARIANTE_REQUERIDA', message: 'Elige la talla o el color antes de continuar.' };
    if (d.variantes.length) {
      const v = d.variantes.find((x) => x.id === varianteId);
      if (!v) return { ok: false, http: 422, code: 'VARIANTE_NO_PERTENECE', message: 'Esa opción ya no está disponible. Elige otra talla o color.' };
      if (v.disponible !== null && v.disponible < qty) return sinStock(v.disponible);
    }
    return { ok: true, verificado: d.verificado };
  }
  if (d.total !== null && d.total < qty) return sinStock(d.total);
  return { ok: true, verificado: d.verificado };
}

module.exports = { disponibilidad, puedeComprar, idVariante };
