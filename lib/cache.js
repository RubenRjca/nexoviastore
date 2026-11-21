'use strict';
// Caché en memoria para no agotar el rate limit de DroPanas (100 req/min en producción).
//  - Éxitos con TTL corto; FALLOS también se guardan (TTL propio) para no repetir la llamada en bucle.
//  - "Una llamada a la vez" por clave: 50 visitantes a la vez = 1 sola petición a DroPanas.
//  - Si falla pero hubo un dato bueno hace poco, se sirve ese dato marcado como obsoleto en vez de fallar.
const store = new Map();   // clave -> { exp, r }
const buenas = new Map();  // clave -> { t, r } (último éxito)
const vuelo = new Map();   // clave -> Promise en curso
const MAX = 500, OBSOLETO_MAX_MS = 10 * 60 * 1000;

function barrer() {
  const now = Date.now();
  for (const [k, v] of store) if (v.exp <= now) store.delete(k);
  if (store.size >= MAX) store.clear();
  if (buenas.size >= MAX) buenas.clear();
}

// fn() devuelve { ok:true, v } o { ok:false, error, ttlMs? } (ttlMs = cuánto recordar ESE fallo, p. ej. Retry-After)
function recordar(clave, { ttlOk = 60000, ttlFail = 20000 } = {}, fn) {
  const hit = store.get(clave);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.r);
  if (vuelo.has(clave)) return vuelo.get(clave);
  const p = (async () => {
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, error: 'EXCEPCION' }; }
    if (r.ok) buenas.set(clave, { t: Date.now(), r });
    else {
      const previo = buenas.get(clave);
      if (previo && Date.now() - previo.t < OBSOLETO_MAX_MS) r = { ...previo.r, obsoleto: true };
    }
    if (store.size >= MAX) barrer();
    store.set(clave, { exp: Date.now() + (r.ok && !r.obsoleto ? ttlOk : Math.max(1000, r.ttlMs || ttlFail)), r });
    return r;
  })().finally(() => vuelo.delete(clave));
  vuelo.set(clave, p);
  return p;
}

// Límite simple por clave (mejor esfuerzo: cada instancia serverless tiene su propia memoria).
const ventanas = new Map();
function limitar(clave, max, ventanaMs) {
  const now = Date.now(), a = (ventanas.get(clave) || []).filter((t) => now - t < ventanaMs);
  a.push(now); ventanas.set(clave, a);
  if (ventanas.size > 3000) ventanas.clear();
  return a.length > max; // true = se pasó del límite
}
const reiniciar = () => { store.clear(); buenas.clear(); vuelo.clear(); ventanas.clear(); };

module.exports = { recordar, limitar, reiniciar };
