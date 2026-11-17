'use strict';
// FUENTE ÚNICA DE VERDAD del catálogo (precios, IDs y datos públicos). El navegador solo envía el "sku".
// TODO (Fase 7): reemplaza los productos de ejemplo y completa producto_id y bodega_origen_id reales
// (GET /api/v1/productos y GET /api/v1/bodegas). Mientras estén en null, el pedido se rechaza a propósito.
// Productos con talla/color: agrega variante_id a la línea del pedido (ver api/crear-orden.js).
const CATALOGO = {
  'cargador-65w':    { titulo: 'Cargador Rápido 65W, 4 Puertos USB-C y USB-A', icono: 'charger', etiqueta: 'Más vendido', precio_venta_usd: 24.9, producto_id: null, bodega_origen_id: null },
  'smartwatch-fit':  { titulo: 'Smartwatch Deportivo con Llamadas Bluetooth',   icono: 'watch',   precio_venta_usd: 29.9, producto_id: null, bodega_origen_id: null },
  'audifonos-tws':   { titulo: 'Audífonos Inalámbricos con Estuche de Carga',   icono: 'buds',    etiqueta: 'Nuevo', precio_venta_usd: 19.9, producto_id: null, bodega_origen_id: null },
  'power-bank-20k':  { titulo: 'Power Bank 20.000 mAh con Carga Rápida',        icono: 'bank',    precio_venta_usd: 27.9, producto_id: null, bodega_origen_id: null },
  'cable-usbc-100w': { titulo: 'Cable USB-C a USB-C 100W, 1,5 m',               icono: 'cable',   precio_venta_usd: 6.9,  producto_id: null, bodega_origen_id: null },
  'parlante-bt':     { titulo: 'Parlante Bluetooth Portátil',                   icono: 'speaker', precio_venta_usd: 22.9, producto_id: null, bodega_origen_id: null },
};

const configurado = (i) => Number.isInteger(i.producto_id) && Number.isInteger(i.bodega_origen_id);
const productoRef = () => (Object.values(CATALOGO).find(configurado) || {}).producto_id || null;
const publico = (tasa) => Object.entries(CATALOGO).map(([sku, i]) => ({
  sku, titulo: i.titulo, icono: i.icono, etiqueta: i.etiqueta || null, usd: i.precio_venta_usd,
  ves: tasa ? Math.round(i.precio_venta_usd * tasa * 100) / 100 : null,
}));

module.exports = { CATALOGO, configurado, productoRef, publico };
