'use strict';
// Cobertura de envío por ruta (GET /cotizar-envio) con caché de éxitos (10 min) y de fallos (20 s / Retry-After).
// A diferencia de lib/dropanas.js#cotizar, aquí un fallo conserva el MOTIVO (429, CROSS_MODE, red…) para poder tratarlo bien.
const { llamar } = require('./cliente');
const { recordar } = require('./cache');
const { falloDe } = require('./errores');

const cotizarRuta = ({ bodega, state, city, tipoPago }) =>
  recordar(`q:${bodega}:${state}:${city}:${tipoPago}`, { ttlOk: 10 * 60 * 1000, ttlFail: 20 * 1000 }, async () => {
    const q = new URLSearchParams({ bodega_origen_id: bodega, state_id: state, city_id: city, tipo_pago: tipoPago });
    const r = await llamar('/cotizar-envio?' + q);
    return r.ok ? { ok: true, v: Array.isArray(r.j.data) ? r.j.data : [] } : falloDe(r);
  });

// Opción de domicilio de Pídelo y Punto (shipping_type_id 1) que aplica a la ruta; con recaudo exige soporta_recaudo.
const elegirOpcion = (lista, anticipado, tipoId = 1) => (lista || []).find((o) => o.shipping_type_id === tipoId && o.tipo_entrega === 'domicilio' && o.disponible !== false && (anticipado || o.soporta_recaudo !== false)) || null;

module.exports = { cotizarRuta, elegirOpcion };
