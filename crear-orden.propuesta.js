'use strict';
// POST /api/crear-orden
// Crea el pedido en DroPanas. Dos modalidades:
//  - contra_entrega: tipo_pago "con_recaudo" (el mensajero cobra al entregar).
//  - anticipado:     tipo_pago "sin_recaudo" + requiere_aprobacion:true. El pedido queda RETENIDO (sin guía, sin descontar
//                    stock y sin cobrar a tu wallet) hasta que verifiques el pago y lo apruebes en tu panel de DroPanas.
// Seguridad: la llave nunca sale de este archivo; precios e IDs salen de lib/catalogo.js, jamás del navegador.
// PROPUESTA v2 (NO aplicada): manejo explícito de 403 CROSS_MODE, 202 MAINTENANCE_QUEUED, 422 de stock/variante/bodega, 503 y 429,
// variante_id y respaldo de pedidos fallidos. Idempotencia y tipo_pago: sin cambios.
// Duplicados: Idempotency-Key (UUID v4) + external_reference derivado en servidor de un orden_id aleatorio. Un reintento devuelve el pedido original.
const crypto = require('crypto');
const { obtener, configurado, precioVigente } = require('../lib/catalogo');
const { llamar } = require('../lib/cliente');
const { cotizarRuta } = require('../lib/cotizacion');
const { clasificar, alertar } = require('../lib/errores');
const { puedeComprar } = require('../lib/stock');
const respaldo = require('../lib/respaldo');

const SHIPPING_TYPE_ID = 1; // 1 = domicilio en 24 h (Pídelo y Punto). 2 = Pídelo Express (más rápido, flete mayor).
const METODOS_ANTICIPADO = { pagomovil: 'Pago Móvil', avilapay: 'Ávila Pay', zelle: 'Zelle', transferencia: 'Transferencia' };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
// Texto libre: se eliminan < > y caracteres de control (evita inyección de HTML/scripts en tu panel de DroPanas).
const limpiar = (s) => s.replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const txt = (v, max) => (typeof v === 'string' && v.trim().length <= max ? limpiar(v) : '');
const fail = (res, status, message, code) => res.status(status).json({ ...(code ? { code } : {}), message });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return fail(res, 405, 'Método no permitido.');
  try { const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) return fail(res, 403, 'Origen no permitido.'); }
  catch (e) { return fail(res, 403, 'Origen no permitido.'); }
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin') return fail(res, 403, 'Origen no permitido.'); // un navegador desde otro sitio no puede llamar esta ruta

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (b.web) return res.status(200).json({ ok: true }); // campo trampa anti-bots
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (limitado(ip)) return fail(res, 429, 'Demasiados intentos. Espera unos minutos.');

  // ---- Validación de entrada ----
  const item = obtener(b.sku);
  const idem = req.headers['idempotency-key'];
  const c = b.cliente || {}, d = b.direccion || {};
  const qty = Number(b.cantidad);
  const anticipado = b.metodo_pago === 'anticipado';
  if (!anticipado && b.metodo_pago !== 'contra_entrega') return fail(res, 400, 'Elige un método de pago.');
  if (!item) return fail(res, 400, 'Producto no disponible.');
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) return fail(res, 400, 'Cantidad inválida.');
  if (!idem || !UUID_V4.test(idem)) return fail(res, 400, 'Solicitud inválida. Recarga la página.');
  if (!UUID_V4.test(b.orden_id || '')) return fail(res, 400, 'Solicitud inválida. Recarga la página.');
  // La referencia la fabrica el SERVIDOR a partir de un UUID aleatorio: nadie puede adivinar ni "reservar" la referencia de otro cliente.
  const ref = 'NX' + crypto.createHash('sha256').update(String(b.orden_id).toLowerCase()).digest('hex').slice(0, 12).toUpperCase();
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
  const varianteId = b.variante_id === undefined || b.variante_id === null ? null : Number(b.variante_id);
  if (varianteId !== null && (!Number.isInteger(varianteId) || varianteId < 1)) return fail(res, 400, 'Opción inválida.');

  const tipoPago = anticipado ? 'sin_recaudo' : 'con_recaudo';
  const modo = anticipado ? 'anticipado' : 'contra_entrega';
  // Datos para el respaldo (el detalle completo va a un almacén privado; en los logs solo sale enmascarado).
  const ctx = {
    ref, sku: b.sku, cantidad: qty, metodo_pago: b.metodo_pago, variante_id: varianteId,
    cliente: { nombre: c.nombre.trim(), apellido: c.apellido.trim(), telefono: String(c.telefono).trim() },
    direccion: { state_id: d.state_id, city_id: d.city_id, direccion, referencia: txt(d.referencia, 120) },
    pago: anticipado ? { metodo: b.pago_metodo, referencia: String(b.pago_referencia).trim() } : null, nota: txt(b.nota_cliente, 150),
  };
  // Todo fallo al CREAR el pedido se clasifica, se respalda (salvo reintentos de idempotencia) y se responde con un texto seguro.
  const rechazar = async (clas, tipo) => {
    alertar(clas, { ref, sku: b.sku });
    if (!String(clas.code).startsWith('IDEMPOTENCY')) await respaldo.registrar({ ...ctx, tipo: tipo || 'rechazo', http: clas.http, code: clas.code });
    if (clas.retryAfter) res.setHeader('Retry-After', String(clas.retryAfter));
    return fail(res, clas.http, clas.message, clas.code);
  };

  try {
    // ---- Cobertura: ¿hay entrega a domicilio a esa ciudad con este tipo de pago? ----
    const cot = await cotizarRuta({ bodega: item.bodega_origen_id, state: d.state_id, city: d.city_id, tipoPago });
    if (!cot.ok) {
      alertar(cot.clas, { ref, ruta: 'cotizar-envio' });
      if (cot.clas.retryAfter) res.setHeader('Retry-After', String(cot.clas.retryAfter));
      return fail(res, cot.clas.http === 404 ? 503 : cot.clas.http, cot.clas.message, cot.clas.code);
    }
    const opcion = cot.v.find((o) => o.shipping_type_id === SHIPPING_TYPE_ID && o.tipo_entrega === 'domicilio' && o.disponible !== false && (anticipado || o.soporta_recaudo !== false));
    if (!opcion) return fail(res, 422, anticipado
      ? 'Por ahora no tenemos entrega a domicilio en tu ciudad.'
      : 'En tu ciudad no está disponible el Pago Contra Entrega. Prueba con Pago Directo Anticipado.', 'SIN_COBERTURA');

    // ---- Variante y stock reales (lib/stock.js). Solo bloquea con evidencia; la palabra final la tiene DroPanas ----
    const pc = await puedeComprar(item, qty, varianteId);
    if (!pc.ok) return fail(res, pc.http, pc.message, pc.code);

    // ---- Pedido con el formato de POST /api/v1/ordenes ----
    const notas = [];
    if (anticipado) notas.push(`PAGO ANTICIPADO ${METODOS_ANTICIPADO[b.pago_metodo]} ref ${String(b.pago_referencia).trim()}`);
    if (b.nota_cliente) notas.push(txt(b.nota_cliente, 150));
    const payload = {
      external_reference: ref,
      cliente: { nombre: c.nombre.trim(), apellido: c.apellido.trim(), telefono: String(c.telefono).trim() },
      direccion: { state_id: d.state_id, city_id: d.city_id, direccion, ...(txt(d.referencia, 120) ? { referencia: txt(d.referencia, 120) } : {}) },
      productos: [{ producto_id: item.producto_id, cantidad: qty, precio_venta_usd: precioVigente(item), ...(varianteId ? { variante_id: varianteId } : {}) }],
      bodega_origen_id: item.bodega_origen_id,
      tipo_entrega: 'domicilio',
      shipping_type_id: SHIPPING_TYPE_ID,
      tipo_pago: tipoPago,
      // Anticipado: siempre retenido hasta verificar el pago. Contra entrega: COD_REQUIERE_APROBACION=1 retiene también esos pedidos
      // para que los confirmes (p. ej. por WhatsApp) antes de enviar: es la mejor defensa contra pedidos falsos.
      ...(anticipado || process.env.COD_REQUIERE_APROBACION === '1' ? { requiere_aprobacion: true } : {}),
      ...(notas.length ? { nota_cliente: notas.join(' | ').slice(0, 250) } : {}),
    };

    const r = await llamar('/ordenes', { method: 'POST', body: payload, headers: { 'Idempotency-Key': idem } });
    const clas = clasificar(r);
    if (clas.tipo === 'ok') return res.status(200).json({ ok: true, estado: 'creado', referencia: ref, modo });
    if (clas.tipo === 'duplicado') return res.status(200).json({ ok: true, estado: 'creado', referencia: ref, modo, duplicado: true });
    if (clas.tipo === 'en_cola') {
      // 202: aceptado, NO se reenvía. Se guarda el solicitud_id para poder consultarlo en /api/rastreo.
      const sid = r.j && r.j.data && r.j.data.solicitud_id;
      await respaldo.registrar({ ...ctx, tipo: 'en_cola', http: 202, code: clas.code, solicitud_id: sid });
      return res.status(202).json({ ok: true, estado: 'en_cola', referencia: ref, modo, message: clas.message });
    }
    // Error de red / timeout: el pedido pudo haberse creado. El reintento con la MISMA Idempotency-Key lo resuelve sin duplicar.
    return rechazar(clas, clas.tipo === 'red' ? 'error_red' : 'rechazo');
  } catch (e) {
    console.error('crear-orden', e.message);
    return rechazar({ http: 502, code: 'EXCEPCION', message: 'No pudimos procesar tu pedido. Inténtalo de nuevo.' }, 'error_red');
  }
};
