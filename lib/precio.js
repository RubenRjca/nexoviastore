'use strict';
// Opción A: el cliente paga producto + envío cotizado. El flete lo fija DroPanas (no se puede enviar transportation_price),
// así que se suma al precio unitario que se envía a la orden. Todo se calcula aquí, en el servidor.
const r2 = (n) => Math.round(n * 100) / 100;
const num = (x, d) => { const n = Number(x); return Number.isFinite(n) ? n : d; };
const MARGEN_MIN = () => num(process.env.MARGEN_MIN_USD, 5);
const COMISION = () => num(process.env.COMISION_USD, 0.5);

// precio: precio vigente del producto (USD). envio: flete cotizado (USD). Devuelve lo que ve y paga el cliente.
function calcular(precio, qty, envio) {
  const subtotal = r2(precio * qty), e = r2(envio);
  const unit = r2((subtotal + e) / qty);            // precio_venta_usd que se envía a DroPanas
  return { subtotal, envio: e, unit, total: r2(unit * qty) }; // total = lo que realmente se cobra (recaudo)
}
// Ganancia estimada del pedido: lo cobrado − costo del producto − flete − comisión de plataforma.
const margen = (c, costo, qty) => r2(c.total - num(costo, 0) * qty - c.envio - COMISION());

module.exports = { r2, calcular, margen, MARGEN_MIN, COMISION };
