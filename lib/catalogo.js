'use strict';
// Lee data/catalogo.json (la ÚNICA fuente de verdad de productos, precios e IDs). El navegador solo envía el "sku".
// Solo se muestran y se pueden comprar los productos con "estado": "publicado". Los "borrador" no salen en la tienda.
const data = require('../data/catalogo.json');

const publicados = data.productos.filter((p) => p.estado === 'publicado');
const porSku = new Map(publicados.map((p) => [p.sku, p])); // Map: un sku como "__proto__" o "constructor" no puede colarse

const obtener = (sku) => (typeof sku === 'string' ? porSku.get(sku) : undefined);
const lista = () => publicados;
const configurado = (i) => Number.isInteger(i.producto_id) && Number.isInteger(i.bodega_origen_id);
const productoRef = () => (publicados.find(configurado) || {}).producto_id || null;
const enOferta = (p) => Number.isFinite(p.precio_oferta_usd) && p.precio_oferta_usd > 0 && p.precio_oferta_usd < p.precio_venta_usd;
const precioVigente = (p) => (enOferta(p) ? p.precio_oferta_usd : p.precio_venta_usd); // lo que realmente se cobra
const r2 = (n) => Math.round(n * 100) / 100;

const categorias = () => data.categorias.filter((c) => publicados.some((p) => p.categoria === c.id));
const publico = (tasa) => publicados.map((p) => ({
  sku: p.sku, titulo: p.titulo, descripcion: p.descripcion, por_que: p.por_que, beneficios: p.beneficios, specs: p.specs,
  categoria: p.categoria, icono: p.icono, etiqueta: p.etiqueta || null, imagen: p.imagen || null, semana: !!p.semana,
  nuevo: !!p.nuevo, resenas: [], // resenas: SIEMPRE vacío (nunca se siembran); las reales vienen de /api/resenas
  ...(Array.isArray(p.desventajas) && p.desventajas.length ? { desventajas: p.desventajas } : {}),
  ...(p.por_que_conviene ? { por_que_conviene: p.por_que_conviene } : {}), ...(p.beneficio_practico ? { beneficio_practico: p.beneficio_practico } : {}),
  usd: precioVigente(p), usd_antes: enOferta(p) ? p.precio_venta_usd : null,
  ves: tasa ? r2(precioVigente(p) * tasa) : null,
}));

module.exports = { obtener, lista, configurado, productoRef, precioVigente, categorias, publico };
