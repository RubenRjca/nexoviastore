'use strict';
// Traduce una respuesta de DroPanas { ok, status, j, retryAfter } a:
//   tipo     ok | en_cola | duplicado | stock | validacion | config | limite | mantenimiento | no_encontrado | red | servidor
//   http     código HTTP que devolvemos al navegador
//   code     código estable para el frontend / los logs
//   message  texto SEGURO para el cliente (nunca el mensaje crudo de DroPanas: puede traer saldos u otros datos)
//   alerta   si existe, es un problema de CONFIGURACIÓN tuyo (no del cliente): se registra como ALERTA en los logs
const T = (tipo, http, code, message, extra = {}) => ({ tipo, http, code, message, ...extra });
const MSG_CONFIG = 'La tienda se está configurando. Inténtalo más tarde.';

function clasificar(r) {
  const s = r.status, c = r.j && r.j.code;
  if (s === 202 || c === 'MAINTENANCE_QUEUED') return T('en_cola', 202, 'MAINTENANCE_QUEUED', 'Recibimos tu pedido. La plataforma está en mantenimiento y se procesará automáticamente.', { ok: true });
  if (r.ok) return T('ok', 200, 'OK', '', { ok: true });

  if (c === 'EXTERNAL_REFERENCE_DUPLICADO') return T('duplicado', 200, c, 'Tu pedido ya estaba registrado.', { ok: true });
  if (c === 'IDEMPOTENCY_IN_FLIGHT') return T('validacion', 409, c, 'Tu pedido se está procesando. Espera unos segundos.');
  if (c === 'IDEMPOTENCY_CONFLICT') return T('validacion', 409, c, 'Revisa tus datos e inténtalo de nuevo.');

  if (s === 403 && c === 'CROSS_MODE_OPERATION_FORBIDDEN')
    return T('config', 503, 'CONFIG_ENTORNO', MSG_CONFIG, { alerta: 'Llave y IDs de entornos distintos: con test_sk_ usa IDs de sandbox y con live_sk_ IDs reales (producto_id, bodega_origen_id, state_id, city_id).' });
  if (s === 401 || c === 'AUTH_LLAVE_BLOQUEADA' || c === 'AUTH_IP_BLOQUEADA' || c === 'CONFIG_SIN_LLAVE' || (s === 403 && !c))
    return T('config', 503, 'CONFIG_LLAVE', MSG_CONFIG, { alerta: 'La llave DROPANAS_API_KEY falta, es inválida, está revocada o bloqueada. Revísala en Vercel y en DroPanas.' });

  if (s === 429 || c === 'RATE_LIMIT_EXCEEDED')
    return T('limite', 429, 'RATE_LIMIT_EXCEEDED', 'Hay mucha demanda. Inténtalo en un minuto.', { retryAfter: Number(r.retryAfter) || 30 });
  if (c === 'MAINTENANCE_ACTIVE') return T('mantenimiento', 503, c, 'Estamos en mantenimiento. Inténtalo en unos minutos.', { retryAfter: Number(r.retryAfter) || 60 });
  if (c === 'APROBACION_ORDENES_DISABLED')
    return T('config', 503, c, MSG_CONFIG, { alerta: 'Se envió requiere_aprobacion pero el módulo de aprobación está deshabilitado en DroPanas: el pago anticipado no se puede retener.' });

  if (c === 'SIN_STOCK_EN_BODEGA' || c === 'STOCK_INSUFICIENTE') return T('stock', 409, 'SIN_STOCK', 'Este producto se agotó. Prueba con otro.');
  if (c === 'VARIANTE_REQUERIDA') return T('validacion', 422, c, 'Elige la talla o el color antes de continuar.', { alerta: 'El producto es variable y se envió sin variante_id: el frontend debe mostrar el selector de variantes (GET /api/stock).' });
  if (c === 'VARIANTE_NO_PERTENECE') return T('validacion', 422, c, 'Esa opción ya no está disponible. Elige otra talla o color.', { alerta: 'variante_id no pertenece al producto: el catálogo o el selector están desactualizados.' });
  if (c === 'BODEGA_ORIGEN_REQUERIDA') return T('config', 503, c, MSG_CONFIG, { alerta: 'Falta bodega_origen_id en el catálogo (data/catalogo.json) para este producto.' });
  if (c === 'SANDBOX_TRANSPORTADORA_NO_PERMITIDA') return T('config', 503, c, MSG_CONFIG, { alerta: 'Con test_sk_ solo funciona Pídelo y Punto (domicilio). Usa tipo_entrega domicilio o la llave live.' });
  if (c === 'VALIDATION_ERROR') return T('validacion', 422, c, 'Revisa tus datos e inténtalo de nuevo.', { campos: r.j && r.j.errors ? Object.keys(r.j.errors).slice(0, 10) : [] });
  if (c === 'PRODUCTO_NO_ENCONTRADO') return T('config', 503, c, 'Este producto no está disponible por ahora.', { alerta: 'El producto_id del catálogo no existe en este entorno (¿IDs de otro modo?).' });
  if (c === 'ORDER_NOT_FOUND' || s === 404) return T('no_encontrado', 404, c || 'NO_ENCONTRADO', 'No encontramos ese pedido.');
  if (c === 'TRACKING_NOT_AVAILABLE') return T('no_encontrado', 422, c, 'Tu pedido aún no tiene guía de envío.');
  if (s === 0) return T('red', 502, 'RED', 'No pudimos conectar con el servicio de pedidos. Inténtalo de nuevo.', { reintentable: true });
  if (s >= 500) return T('servidor', 502, 'SERVICIO_NO_DISPONIBLE', 'El servicio no está disponible. Inténtalo de nuevo en un momento.', { reintentable: true });
  return T('validacion', 422, c || 'RECHAZADO', 'No pudimos procesar tu pedido. Revisa tus datos e inténtalo de nuevo.');
}

// Los problemas de configuración quedan como ALERTA en los logs de Vercel (nunca llegan al cliente).
function alertar(clas, ctx = {}) {
  if (!clas.alerta) return;
  console.error(JSON.stringify({ nivel: 'ALERTA', code: clas.code, que_hacer: clas.alerta, ...ctx }));
}

// Para guardar un FALLO en lib/cache.js: dura lo que diga Retry-After si fue un 429; si no, el TTL corto por defecto.
function falloDe(r) {
  const clas = clasificar(r);
  return { ok: false, error: clas.code, status: r.status, ttlMs: r.status === 429 ? (Number(r.retryAfter) || 30) * 1000 : undefined, clas, retryAfter: clas.retryAfter || null };
}

module.exports = { clasificar, alertar, falloDe };
