'use strict';
// POST /api/crear-orden
// Crea el pedido en DroPanas. Dos modalidades:
//  - contra_entrega: tipo_pago "con_recaudo" (el mensajero cobra al entregar).
//  - anticipado:     tipo_pago "sin_recaudo" + requiere_aprobacion:true. El pedido queda RETENIDO (sin guía, sin descontar
//                    stock y sin cobrar a tu wallet) hasta que verifiques el pago y lo apruebes en tu panel de DroPanas.
// Seguridad: la llave nunca sale de este archivo; precios e IDs salen de lib/catalogo.js, jamás del navegador.
// Duplicados: Idempotency-Key (UUID v4) + external_reference único. Un reintento devuelve el pedido original.
const { CATALOGO, configurado } = require('../lib/catalogo');
const { dp, cotizar, stockDisponible } = require('../lib/dropanas');

const SHIPPING_TYPE_ID = 1; // 1 = domicilio en 24 h (Pídelo y Punto). 2 = Pídelo Express (más rápido, flete mayor).
const METODOS_ANTICIPADO = { pagomovil: 'Pago Móvil', avilapay: 'Ávila Pay', zelle: 'Zelle', transferencia: 'Transferencia' };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REF_OK = /^[A-Za-z0-9._-]{1,100}$/;
const NOMBRE_OK = /^[\p{L}\p{M}' .-]{1,50}$/u;
const PAGO_REF_OK = /^[A-Za-z0-9 ._-]{4,40}$/;

const hits = new Map(); // límite por IP (mejor esfuerzo: en serverless cada instancia tiene su memoria)
const limitado = (ip) => {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 2000) hits.clear();
  return arr.length > 8;
};
const txt = (v, max) => (typeof v === 'string' && v.trim().length <= max ? v.trim() : '');
const fail = (res, status, message, code) => res.status(status).json({ ...(code ? { code } : {}), message });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return fail(res, 405, 'Método no permitido.');
  try { const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) return fail(res, 403, 'Origen no permitido.'); }
  catch (e) { return fail(res, 403, 'Origen no permitido.'); }

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (b.web) return res.status(200).json({ ok: true }); // campo trampa anti-bots
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (limitado(ip)) return fail(res, 429, 'Demasiados intentos. Espera unos minutos.');

  // ---- Validación de entrada ----
  const item = CATALOGO[b.sku];
  const idem = req.headers['idempotency-key'];
  const c = b.cliente || {}, d = b.direccion || {};
  const qty = Number(b.cantidad);
  const anticipado = b.metodo_pago === 'anticipado';
  if (!anticipado && b.metodo_pago !== 'contra_entrega') return fail(res, 400, 'Elige un método de pago.');
  if (!item) return fail(res, 400, 'Producto no disponible.');
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) return fail(res, 400, 'Cantidad inválida.');
  if (!idem || !UUID_V4.test(idem)) return fail(res, 400, 'Solicitud inválida. Recarga la página.');
  if (!REF_OK.test(b.external_reference || '')) return fail(res, 400, 'Solicitud inválida. Recarga la página.');
  if (!NOMBRE_OK.test(c.nombre || '') || !NOMBRE_OK.test(c.apellido || '')) return fail(res, 400, 'Revisa tu nombre y apellido.');
  const tel = String(c.telefono || '').replace(/\D/g, '');
  if (!/^[0-9+\s\-()]{10,18}$/.test(c.telefono || '') || tel.length < 10 || tel.length > 13) return fail(res, 400, 'Revisa tu número de teléfono.');
  if (!Number.isInteger(d.state_id) || !Number.isInteger(d.city_id)) return fail(res, 400, 'Elige tu estado y ciudad.');
  const direccion = txt(d.direccion, 250);
  if (direccion.length < 8) return fail(res, 400, 'Escribe tu dirección de entrega completa.');
  if (anticipado) {
    if (!METODOS_ANTICIPADO[b.pago_metodo]) return fail(res, 400, 'Elige con qué método pagarás.');
    if (!PAGO_REF_OK.test(String(b.pago_referencia || '').trim())) return fail(res, 400, 'Escribe el número de referencia de tu pago.');
  }
  if (!configurado(item)) return fail(res, 503, 'Este producto no está disponible por ahora.');

  const tipoPago = anticipado ? 'sin_recaudo' : 'con_recaudo';
  try {
    // ---- Cobertura: ¿hay entrega a domicilio a esa ciudad con este tipo de pago? ----
    const opciones = await cotizar({ bodega: item.bodega_origen_id, state: d.state_id, city: d.city_id, tipoPago });
    if (!opciones) return fail(res, 503, 'No pudimos verificar la cobertura. Inténtalo de nuevo en un momento.');
    const opcion = opciones.find((o) => o.shipping_type_id === SHIPPING_TYPE_ID && o.tipo_entrega === 'domicilio' && o.disponible !== false && (anticipado || o.soporta_recaudo !== false));
    if (!opcion) return fail(res, 422, anticipado
      ? 'Por ahora no tenemos entrega a domicilio en tu ciudad.'
      : 'En tu ciudad no está disponible el Pago Contra Entrega. Prueba con Pago Directo Anticipado.', 'SIN_COBERTURA');

    // ---- Stock (mejor esfuerzo): si DroPanas informa menos unidades de las pedidas, se frena aquí ----
    const stock = await stockDisponible(item.bodega_origen_id, item.producto_id).catch(() => null);
    if (stock !== null && stock < qty) return fail(res, 409, stock === 1 ? 'Solo queda 1 unidad de este producto.' : stock > 0 ? `Solo quedan ${stock} unidades de este producto.` : 'Este producto se agotó.', 'SIN_STOCK');

    // ---- Pedido con el formato de POST /api/v1/ordenes ----
    const notas = [];
    if (anticipado) notas.push(`PAGO ANTICIPADO ${METODOS_ANTICIPADO[b.pago_metodo]} ref ${String(b.pago_referencia).trim()}`);
    if (b.nota_cliente) notas.push(txt(b.nota_cliente, 150));
    const payload = {
      external_reference: b.external_reference,
      cliente: { nombre: c.nombre.trim(), apellido: c.apellido.trim(), telefono: String(c.telefono).trim() },
      direccion: { state_id: d.state_id, city_id: d.city_id, direccion, ...(txt(d.referencia, 120) ? { referencia: txt(d.referencia, 120) } : {}) },
      productos: [{ producto_id: item.producto_id, cantidad: qty, precio_venta_usd: item.precio_venta_usd /* + variante_id si el producto es variable */ }],
      bodega_origen_id: item.bodega_origen_id,
      tipo_entrega: 'domicilio',
      shipping_type_id: SHIPPING_TYPE_ID,
      tipo_pago: tipoPago,
      ...(anticipado ? { requiere_aprobacion: true } : {}),
      ...(notas.length ? { nota_cliente: notas.join(' | ').slice(0, 250) } : {}),
    };

    const r = await dp('/ordenes', { method: 'POST', body: payload, headers: { 'Idempotency-Key': idem } });
    const code = r.j && r.j.code;
    const modo = anticipado ? 'anticipado' : 'contra_entrega';
    if (r.ok) return res.status(200).json({ ok: true, referencia: b.external_reference, modo, en_cola: r.status === 202 });
    if (code === 'EXTERNAL_REFERENCE_DUPLICADO') return res.status(200).json({ ok: true, referencia: b.external_reference, modo, duplicado: true });
    console.error('DroPanas rechazó el pedido', r.status, code, r.j && r.j.message); // detalle solo en logs de Vercel
    if (code === 'SIN_STOCK_EN_BODEGA') return fail(res, 409, 'Este producto se agotó.', 'SIN_STOCK');
    if (code === 'IDEMPOTENCY_IN_FLIGHT') return fail(res, 409, 'Tu pedido se está procesando. Espera unos segundos.', code);
    if (code === 'IDEMPOTENCY_CONFLICT') return fail(res, 409, 'Revisa tus datos e inténtalo de nuevo.', code);
    if (r.status === 429) { if (r.retryAfter) res.setHeader('Retry-After', r.retryAfter); return fail(res, 429, 'Hay mucha demanda. Inténtalo en un minuto.'); }
    if (r.status === 503) return fail(res, 503, 'Estamos en mantenimiento. Inténtalo en unos minutos.');
    return fail(res, r.status >= 500 ? 502 : 422, 'No pudimos procesar tu pedido. Revisa tus datos e inténtalo de nuevo.');
  } catch (e) {
    console.error('crear-orden', e.message);
    return fail(res, e.config ? 500 : 502, 'No pudimos conectar con el servicio de pedidos. Inténtalo de nuevo.');
  }
};
