'use strict';
// POST /api/webhook  ← DroPanas (Integraciones → Webhooks → URL https://TU-DOMINIO/api/webhook)
// Recibe order.* e incident.created. Verifica la firma HMAC-SHA256 (X-DroPanas-Signature = hex del cuerpo CRUDO con el secreto del webhook),
// descarta entregas repetidas (X-DroPanas-Delivery) y guarda el último estado del pedido por su referencia NX… en el almacén privado.
// Responde 2xx rápido (DroPanas reintenta hasta 5 veces si no). Sin DROPANAS_WEBHOOK_SECRET responde 503: jamás acepta eventos sin firma.
// Los incidentes (novedades) salen como ALERTA en los logs de Vercel. /api/rastreo sigue consultando DroPanas directamente (este receptor no lo reemplaza).
const crypto = require('crypto');
const { configurado, pipeline } = require('../lib/almacen');
const { limitar } = require('../lib/cache');

const REF_OK = /^NX[A-F0-9]{12}$/;
const crudo = (req) => new Promise((ok, no) => {
  if (Buffer.isBuffer(req.rawBody)) return ok(req.rawBody);
  const parts = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { no(new Error('grande')); req.destroy(); } else parts.push(c); });
  req.on('end', () => ok(Buffer.concat(parts))); req.on('error', no);
});
const firmaOk = (raw, secreto, cab) => {
  const esperada = crypto.createHmac('sha256', secreto).update(raw).digest('hex');
  const dada = String(cab || '').trim().replace(/^sha256=/i, '').toLowerCase();
  const a = Buffer.from(esperada), b = Buffer.from(dada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ message: 'Método no permitido.' });
  const secreto = process.env.DROPANAS_WEBHOOK_SECRET;
  if (!secreto) return res.status(503).json({ message: 'Webhook no configurado.' });
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (limitar('wh:' + ip, 300, 60 * 1000)) { res.setHeader('Retry-After', '30'); return res.status(429).json({ message: 'Demasiadas solicitudes.' }); } // holgado para DroPanas; frena fuerza bruta de firmas
  let raw; try { raw = await crudo(req); } catch (e) { return res.status(413).json({ message: 'Cuerpo demasiado grande.' }); }
  if (!firmaOk(raw, secreto, req.headers['x-dropanas-signature'])) return res.status(401).json({ message: 'Firma no válida.' });
  let ev; try { ev = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ message: 'JSON inválido.' }); }
  const d = (ev && ev.datos) || {}, ped = d.pedido || {};
  // Marca de entrega: la del encabezado o, si no llega, la huella del cuerpo. Se libera si el guardado falla, para que el reintento de DroPanas sí se procese.
  const del = String(req.headers['x-dropanas-delivery'] || '');
  const marca = 'nx:wh:d:' + (/^[\w-]{6,80}$/.test(del) ? del : 'h' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40));
  let marcada = false;
  try {
    if (configurado()) {
      const [r] = await pipeline([['SET', marca, '1', 'EX', 86400, 'NX']]);
      if (r.result !== 'OK') return res.status(200).json({ ok: true, duplicado: true });
      marcada = true;
      const rawRef = String(ped.numero_externo || d.external_reference || '').trim().toUpperCase();
      const ref = REF_OK.test(rawRef) ? rawRef : null;
      if (ref && String(ev.evento || '').startsWith('order.')) {
        const rec = { evento: ev.evento, estado: ped.estado || d.status_nuevo || null, transportadora: ped.transportadora || null, guia: ped.numero_guia || null, at: ev.timestamp || new Date().toISOString(), sandbox: !!ev.sandbox };
        const [previo] = await pipeline([['GET', 'nx:wh:' + ref]]); let viejo = null; try { viejo = previo && previo.result ? JSON.parse(previo.result) : null; } catch (e) { /* registro dañado: se reemplaza */ }
        const tNuevo = Date.parse(rec.at), tViejo = viejo ? Date.parse(viejo.at) : NaN;
        if (!viejo || !Number.isFinite(tViejo) || (Number.isFinite(tNuevo) && tNuevo >= tViejo)) await pipeline([['SET', 'nx:wh:' + ref, JSON.stringify(rec), 'EX', 30 * 86400]]); // un evento atrasado nunca pisa uno más reciente
      }
    }
  } catch (e) {
    if (marcada) { try { await pipeline([['DEL', marca]]); } catch (e2) { /* sin almacén: no hay marca que liberar */ } }
    console.error(JSON.stringify({ nivel: 'ALERTA', code: 'WEBHOOK_ALMACEN', que_hacer: 'No se pudo guardar el evento de DroPanas en el almacén; DroPanas reintentará.' }));
    return res.status(500).json({ message: 'No se pudo procesar. Reintenta.' });
  }
  if (ev.evento === 'incident.created') console.error(JSON.stringify({ nivel: 'ALERTA', code: 'NOVEDAD_DROPANAS', orden_id: d.orden_id, novedad_id: d.novedad_id, tipo: d.tipo, que_hacer: 'Responde la novedad en el panel de DroPanas (Novedades).' }));
  return res.status(200).json({ ok: true });
};
module.exports.config = { api: { bodyParser: false } };
