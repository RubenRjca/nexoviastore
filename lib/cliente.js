'use strict';
// Envoltura de lib/dropanas.js (que NO se modifica): nunca lanza excepciones y aplica un "circuito" de rate limit.
// Tras un 429 de DroPanas no se hace NINGUNA llamada más desde esta instancia hasta que pase Retry-After.
const { dp } = require('./dropanas');
let pausadoHasta = 0;

const pausaRestanteMs = () => Math.max(0, pausadoHasta - Date.now());
const pausar = (seg) => { pausadoHasta = Date.now() + Math.min(300, Math.max(1, Number(seg) || 30)) * 1000; };
const reiniciarPausa = () => { pausadoHasta = 0; };

async function llamar(path, opts) {
  const resto = pausaRestanteMs();
  if (resto > 0) return { ok: false, status: 429, j: { code: 'RATE_LIMIT_EXCEEDED' }, retryAfter: Math.ceil(resto / 1000), local: true };
  try {
    const r = await dp(path, opts);
    if (r.status === 429) pausar(r.retryAfter);
    return r;
  } catch (e) {
    // e.config = falta DROPANAS_API_KEY; si no, fue red/timeout (no sabemos si DroPanas llegó a procesar la petición)
    return { ok: false, status: e && e.config ? 500 : 0, j: { code: e && e.config ? 'CONFIG_SIN_LLAVE' : 'RED' }, retryAfter: null };
  }
}

module.exports = { llamar, pausaRestanteMs, pausar, reiniciarPausa };
