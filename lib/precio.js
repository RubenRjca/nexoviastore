'use strict';
// Precio final único: el cliente ve y paga solo el precio de venta del catálogo (envío incluido). El flete que cotiza DroPanas
// NO se suma ni se muestra: solo se usa aquí, en el servidor, para estimar la ganancia y alertar si es baja.
const r2 = (n) => Math.round(n * 100) / 100;
const num = (x, d) => { const n = Number(x); return Number.isFinite(n) ? n : d; };
const MARGEN_MIN = () => num(process.env.MARGEN_MIN_USD, 5);
const COMISION = () => num(process.env.COMISION_USD, 0.5);

// precio: precio final vigente (USD, todo incluido). envio: flete cotizado (USD), solo para el margen interno.
function calcular(precio, qty, envio) {
  const unit = r2(precio), total = r2(unit * qty), e = r2(envio);
  return { subtotal: total, envio: e, unit, total }; // unit = precio_venta_usd enviado a DroPanas; total = lo que se cobra
}
// Ganancia estimada del pedido: lo cobrado − costo del producto − flete − comisión de plataforma.
const margen = (c, costo, qty) => r2(c.total - num(costo, 0) * qty - c.envio - COMISION());

module.exports = { r2, calcular, margen, MARGEN_MIN, COMISION };
