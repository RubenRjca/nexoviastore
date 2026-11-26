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

const REGLAS = [
  [/(bateria|autonomia|horas|vatio|watt|peso|pesa|kilo|gramo|consumo)/, `Ese dato todavía no está confirmado, así que prefiero no inventarlo. Escríbenos por WhatsApp al ${WA} y lo confirmamos.`],
  [/(garantia|devol|cambio|defecto|reembolso|danad)/, 'Si tu producto llega con un defecto de fábrica, te ayudamos. Revisa «Garantía y devoluciones» en el pie de página o escríbenos por WhatsApp con tu código de compra.'],
  [/(rastre|seguimiento|codigo|historial|donde esta mi pedido|mi pedido)/, 'Puedes ver tu pedido en «Historial de compras» (con tu cuenta de Google) o en «Rastrear mi pedido» con tu código de compra (empieza por NX) y los últimos 4 dígitos de tu teléfono.'],
  [/(modelo|variante|enchufable|recargable|pila|usb)/, 'Hay dos modelos: Modelo 1, enchufable por cable USB, y Modelo 2, recargable con pila y puerto USB-C en la tapa superior. Eliges cuál quieres al comprar.'],
  [/(medida|tamano|alto|ancho|dimension|cm)/, 'La caja mide 23,5 cm de alto × 12,5 cm de ancho × 12,5 cm de largo.'],
  [/(precio|cuanto|cuesta|costo|valor|dolar|bolivar)/, () => `La lámpara atrapazancudos cuesta US$ ${precioLampara()}, precio final con envío incluido y sin cargos ocultos. Los bolívares se muestran como equivalente.`],
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
