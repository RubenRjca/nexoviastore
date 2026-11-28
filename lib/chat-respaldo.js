'use strict';
// Respuestas locales de respaldo del chat de ayuda: se usan cuando no hay GEMINI_API_KEY o Gemini falla (cuota, red, bloqueo).
// Solo afirman datos oficiales ya publicados en la tienda; lo que no está confirmado se deriva a WhatsApp.
const { lista, precioVigente } = require('./catalogo');

const WA = '+58 424-5474761';
const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const precioLampara = () => {
  const l = lista().find((i) => i.sku === 'lampara-atrapazancudos');
  return l ? precioVigente(l).toFixed(2).replace('.', ',') : '29,00';
};
const precioUps = () => {
  const u = lista().find((i) => i.sku === 'mini-ups-10400');
  return u ? precioVigente(u).toFixed(2).replace('.', ',') : '55,00';
};
const precioUro = () => {
  const p = lista().find((i) => i.sku === 'uro-probiotic-vaginal');
  return p ? precioVigente(p).toFixed(2).replace('.', ',') : '30,00';
};
const precioBt = () => {
  const b = lista().find((i) => i.sku === 'auricular-casco-bt57');
  return b ? precioVigente(b).toFixed(2).replace('.', ',') : '30,00';
};

const REGLAS = [
  [/(bt57|casco|moto|auricular|microfono)/, () => `El Auricular Bluetooth para Casco BT57 cuesta US$ ${precioBt()} (envío incluido). Incluye unidad exterior con LED azul y rojo, altavoces acolchados internos, micrófono flexible, cable USB-C, soporte de montaje y manual (caja 10 × 15 × 6 cm).`],
  [/(uro|probiotic|vaginal|flora|ph|capsula|olor)/, () => `URO Probiotic Vaginal cuesta US$ ${precioUro()} (envío incluido). Trae 60 cápsulas veganas (30 días, 2 cápsulas al día con agua) con 4 cepas Lactobacillus (5 mil millones UFC) y prebióticos XOS (400 mg) para apoyar pH, flora y olor íntimo. Suplemento dietético; consulta a tu médico si tienes dudas.`],
  [/(ups|router|modem|poe|10400|10\.400)/, () => `El Mini UPS de 10.400 mAh cuesta US$ ${precioUps()} (envío incluido). Tiene salidas 5V, 9V y 12V, puertos LAN y PoE (15V/24V) y salida USB. El fabricante no especifica horas exactas de duración; rinde más solo con el router/módem.`],
  [/(cepa|ingrediente|dosis)/, 'URO Probiotic Vaginal (OPositiv Health) combina 4 cepas Lactobacillus (L. acidophilus, L. rhamnosus, L. reuteri, L. fermentum; 5 mil millones UFC) y 400 mg de prebióticos XOS; el fabricante sugiere 2 cápsulas al día con agua (adultos 18+). Revisa siempre la etiqueta del envase o consulta a tu médico.'],
  [/(bateria|autonomia|horas|vatio|watt|peso|pesa|kilo|gramo|consumo)/, `Ese dato todavía no está confirmado, así que prefiero no inventarlo. Escríbenos por WhatsApp al ${WA} y lo confirmamos.`],
  [/(garantia|devol|cambio|defecto|reembolso|danad)/, 'Si tu producto llega con un defecto de fábrica, te ayudamos. Revisa «Garantía y devoluciones» en el pie de página o escríbenos por WhatsApp con tu código de compra.'],
  [/(rastre|seguimiento|codigo|historial|donde esta mi pedido|mi pedido)/, 'Puedes ver tu pedido en «Historial de compras» (con tu cuenta de Google) o en «Rastrear mi pedido» con tu código de compra (empieza por NX) y los últimos 4 dígitos de tu teléfono.'],
  [/(modelo|variante|enchufable|recargable|pila|usb)/, 'La lámpara tiene dos modelos: Modelo 1, enchufable por cable USB, y Modelo 2, recargable con pila y puerto USB-C en la tapa superior.'],
  [/(medida|tamano|alto|ancho|dimension|cm)/, 'La caja del auricular BT57 mide 10 × 15 × 6 cm, la de la lámpara 23,5 × 12,5 × 12,5 cm y el envase de URO Probiotic Vaginal 10 × 10 × 10 cm.'],
  [/(precio|cuanto|cuesta|costo|valor|dolar|bolivar)/, () => `Precios finales con envío incluido: Auricular casco BT57 US$ ${precioBt()}, Lámpara atrapazancudos US$ ${precioLampara()}, URO Probiotic Vaginal US$ ${precioUro()} y Mini UPS 10.400 mAh US$ ${precioUps()}. Los bolívares se muestran como equivalente.`],
  [/(pago|pagar|contra entrega|efectivo|zelle|pago movil|transferencia)/, 'Pagas al recibir tu pedido (Pago Contra Entrega). No pagas nada por adelantado.'],
  [/(envio|enviar|ciudad|cobertura|llegan|entrega|delivery|cuanto tarda|tiempo)/, `Hacemos envíos a domicilio en Venezuela según cobertura: al comprar eliges tu estado y ciudad. Para tiempos exactos de entrega escríbenos por WhatsApp al ${WA}.`],
  [/(comprar|compro|pedir|pedido|como se hace|registr|google|cuenta)/, 'Pulsa «Comprar ahora», completa tus datos de envío y conecta tu cuenta de Google en la misma ventana. Al terminar recibes tu código de compra (NX…).'],
  [/(luz|violeta|mosquito|zancudo|funciona|ventilador|silencio|noche|deposito|fisico|quimico)/, 'La lámpara usa luz violeta biomimética para atraer mosquitos y un ventilador motorizado de alta succión que los lleva a un depósito inferior transparente y desmontable. Es control 100 % físico, sin químicos, silenciosa para dormir y con función de luz nocturna suave.'],
];
const respaldo = (texto) => {
  const t = norm(texto);
  for (const [re, r] of REGLAS) if (re.test(t)) return typeof r === 'function' ? r() : r;
  return `Para esa consulta te atendemos mejor por WhatsApp al ${WA}. También puedes preguntarme por precio, modelos, envíos, pago contra entrega o rastreo.`;
};
module.exports = { respaldo, WA };
