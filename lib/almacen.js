'use strict';
// Almacén clave-valor PRIVADO (Upstash Redis / Vercel KV) por su API REST, sin dependencias.
// Variables: KV_REST_API_URL + KV_REST_API_TOKEN  (o UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). Las mismas que usa lib/respaldo.js.
const url = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const configurado = () => !!(url() && token());

async function pipeline(cmds) {
  const r = await fetch(url().replace(/\/$/, '') + '/pipeline', {
    method: 'POST', signal: AbortSignal.timeout(4000),
    headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' }, body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('almacen ' + r.status);
  return r.json();
}

module.exports = { configurado, pipeline };
