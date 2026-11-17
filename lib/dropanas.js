'use strict';
// Cliente mínimo de la API de DroPanas. La llave vive SOLO en process.env.DROPANAS_API_KEY (test_sk_… / live_sk_…).
const BASE = 'https://app.dropanas.com/api/v1';
const memo = new Map();

async function remember(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = await fn();
  if (v !== null && v !== undefined) {           // no guardamos fallos en caché
    if (memo.size > 500) memo.clear();
    memo.set(key, { v, exp: Date.now() + ttlMs });
  }
  return v;
}

async function dp(path, { method = 'GET', body, headers } = {}) {
  const key = process.env.DROPANAS_API_KEY;
  if (!key) throw Object.assign(new Error('Falta DROPANAS_API_KEY'), { config: true });
  const r = await fetch(BASE + path, {
    method,
    signal: AbortSignal.timeout(9000),
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j, retryAfter: r.headers.get('retry-after') };
}

// Opciones de envío reales para la ruta (cobertura, si soporta recaudo, precio). null = no se pudo consultar.
const cotizar = ({ bodega, state, city, tipoPago }) =>
  remember(`q:${bodega}:${state}:${city}:${tipoPago}`, 10 * 60 * 1000, async () => {
    const q = new URLSearchParams({ bodega_origen_id: bodega, state_id: state, city_id: city, tipo_pago: tipoPago });
    const r = await dp('/cotizar-envio?' + q);
    return r.ok && Array.isArray(r.j.data) ? r.j.data : null;
  });

// Existencias del producto en la bodega. null = desconocido (la validación definitiva la hace DroPanas con SIN_STOCK_EN_BODEGA).
async function stockDisponible(bodega, productoId) {
  const rows = await remember(`inv:${bodega}`, 60 * 1000, async () => {
    const r = await dp(`/bodegas/${bodega}/inventario`);
    return r.ok && Array.isArray(r.j.data) ? r.j.data : null;
  });
  if (!rows) return null;
  const mine = rows.filter((x) => x.producto && Number(x.producto.id) === productoId);
  return mine.length ? mine.reduce((s, x) => s + (Number(x.cantidad) || 0), 0) : null;
}

// Tasa Bs/USD: variable TASA_BS si la defines; si no, se deduce del precio sugerido de un producto (USD vs Bs) en DroPanas.
async function tasaBs(productoRef) {
  const env = Number(process.env.TASA_BS);
  if (env > 0) return env;
  if (!productoRef) return null;
  return remember('tasa', 30 * 60 * 1000, async () => {
    const r = await dp(`/productos/${productoRef}`);
    const d = r.ok && r.j.data;
    return d && d.precio_sugerido_usd > 0 && d.precio_sugerido_ves > 0 ? d.precio_sugerido_ves / d.precio_sugerido_usd : null;
  });
}

module.exports = { dp, cotizar, stockDisponible, tasaBs };
