#!/usr/bin/env node
'use strict';
// Herramienta LOCAL del catálogo (se corre en tu computador o en GitHub Actions; nunca en el navegador).
//   node scripts/catalogo.js sugerir [--top 30]                 Ranking de productos de DroPanas por margen (guarda data/sugerencias.json)
//   node scripts/catalogo.js agregar <producto_id> --bodega <id> [--sku slug] [--categoria carga]
//                                                               Agrega el producto como "borrador" (no sale en la tienda)
//   node scripts/catalogo.js validar [--estricto]               Revisa data/catalogo.json antes de subirlo
// "sugerir" y "agregar" necesitan la variable DROPANAS_API_KEY (tu llave; no se guarda en ningún archivo).
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'data', 'catalogo.json');
const OUT = path.join(__dirname, '..', 'data', 'sugerencias.json');
const BASE = 'https://app.dropanas.com/api/v1';
const [, , cmd, ...args] = process.argv;
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const salir = (m) => { console.error('✖ ' + m); process.exit(1); };
const leer = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const guardar = (d) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n');
const r2 = (n) => Math.round(n * 100) / 100;

async function api(p) {
  const key = process.env.DROPANAS_API_KEY;
  if (!key) salir('Falta DROPANAS_API_KEY. Ejemplo (Mac/Linux): DROPANAS_API_KEY=test_sk_xxx node scripts/catalogo.js sugerir');
  const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) salir(`DroPanas respondió ${r.status}: ${j.message || j.code || ''}`);
  return j;
}

// Puntaje 0-100 con lo que la API SÍ expone: margen, precio de impulso, peso (proxy del flete) y tipo simple.
// OJO: la API no publica ventas ni rotación. La demanda debes validarla aparte (ver README) y aprobar tú cada producto.
function puntuar(p) {
  const costo = Number(p.precio_costo_usd), sug = Number(p.precio_sugerido_usd);
  if (!(costo > 0 && sug > costo)) return null;
  const margen = sug - costo, pct = margen / sug, peso = Number(p.peso) || 0;
  const impulso = sug >= 8 && sug <= 60 ? 15 : sug < 8 ? 15 * (sug / 8) : Math.max(0, 15 - (sug - 60) / 6);
  const score = Math.min(pct, 0.6) / 0.6 * 45 + Math.min(margen, 15) / 15 * 25 + impulso + (peso <= 0.5 ? 10 : peso <= 1 ? 7 : peso <= 2 ? 3 : 0) + (p.tipo_producto === 'variable' ? 0 : 5);
  return { id: p.id, sku: p.sku, nombre: p.nombre, tipo: p.tipo_producto, peso, imagen: p.imagen || null, costo_usd: r2(costo), sugerido_usd: r2(sug), margen_usd: r2(margen), margen_pct: Math.round(pct * 100), score: Math.round(score) };
}

async function sugerir() {
  const top = Number(flag('top', 30)), ya = new Set(leer().productos.map((p) => p.producto_id).filter(Boolean)), todos = [];
  for (let page = 1, ultima = 1; page <= ultima && page <= 30; page++) {
    const j = await api(`/productos?per_page=100&page=${page}`);
    ultima = (j.meta && j.meta.last_page) || 1; todos.push(...(j.data || []));
    if (page < ultima) await new Promise((r) => setTimeout(r, 700)); // respeta el límite de 100 peticiones por minuto
  }
  const r = todos.map(puntuar).filter((x) => x && !ya.has(x.id)).sort((a, b) => b.score - a.score).slice(0, top);
  fs.writeFileSync(OUT, JSON.stringify({ generado: new Date().toISOString(), total_catalogo: todos.length, sugerencias: r }, null, 2) + '\n');
  console.log(`\nCatálogo leído: ${todos.length} productos. Top ${r.length} por margen y facilidad de envío:\n`);
  r.forEach((x, i) => console.log(`${String(i + 1).padStart(2)}. [${x.score}] #${x.id} ${x.nombre.slice(0, 48).padEnd(48)} costo $${x.costo_usd}  venta $${x.sugerido_usd}  margen ${x.margen_pct}% ($${x.margen_usd})  ${x.peso} kg ${x.tipo === 'variable' ? '(variable: no soportado aún)' : ''}`));
  console.log(`\nGuardado en data/sugerencias.json. Siguiente paso: valida la DEMANDA de los que te interesen y agrégalos con:\n  node scripts/catalogo.js agregar <id> --bodega <bodega_origen_id>\n`);
}

async function agregar() {
  const id = Number(args[0]), bodega = Number(flag('bodega'));
  if (!Number.isInteger(id) || !Number.isInteger(bodega)) salir('Uso: node scripts/catalogo.js agregar <producto_id> --bodega <bodega_origen_id>  (la bodega sale de GET /api/v1/bodegas)');
  const d = leer(), j = (await api(`/productos/${id}`)).data;
  if (!j) salir('Producto no encontrado.');
  if (d.productos.some((p) => p.producto_id === id)) salir('Ese producto ya está en data/catalogo.json.');
  const sku = flag('sku', String(j.nombre).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40));
  if (d.productos.some((p) => p.sku === sku)) salir(`El sku "${sku}" ya existe; usa --sku otro-nombre.`);
  const cat = d.categorias.find((c) => c.id === flag('categoria')) || d.categorias[0];
  d.productos.push({ sku, estado: 'borrador', semana: false, categoria: cat.id, icono: cat.icono, etiqueta: '', imagen: '',
    titulo: j.nombre, descripcion: j.descripcion_corta || '', por_que: '', beneficios: [], specs: {},
    precio_venta_usd: Number(j.precio_sugerido_usd), precio_oferta_usd: null, costo_usd: Number(j.precio_costo_usd),
    tipo_producto: j.tipo_producto, producto_id: id, bodega_origen_id: bodega });
  guardar(d);
  console.log(`✔ Agregado "${sku}" como BORRADOR (precio sugerido US$ ${j.precio_sugerido_usd}, costo US$ ${j.precio_costo_usd}).`);
  console.log('  Falta: título comercial, descripcion, por_que, beneficios (3+), specs, imagen en assets/productos/ y precio final. Luego cambia "estado" a "publicado".');
  if (j.tipo_producto === 'variable') console.log('  ⚠ Es un producto variable (talla/color): la tienda aún no envía variante_id; no lo publiques todavía.');
}

function validar() {
  const estricto = args.includes('--estricto'), d = leer(), err = [], av = [], skus = new Set(), cats = new Set(d.categorias.map((c) => c.id));
  d.productos.forEach((p, i) => {
    const n = `${p.sku || '#' + i}`, pub = p.estado === 'publicado';
    if (!/^[a-z0-9-]{3,40}$/.test(p.sku || '')) err.push(`${n}: sku inválido (solo minúsculas, números y guiones).`);
    if (skus.has(p.sku)) err.push(`${n}: sku repetido.`); skus.add(p.sku);
    if (!['publicado', 'borrador'].includes(p.estado)) err.push(`${n}: estado debe ser "publicado" o "borrador".`);
    if (!cats.has(p.categoria)) err.push(`${n}: categoría "${p.categoria}" no existe.`);
    if (!(p.precio_venta_usd > 0)) err.push(`${n}: precio_venta_usd inválido.`);
    if (p.precio_oferta_usd != null && !(p.precio_oferta_usd > 0 && p.precio_oferta_usd < p.precio_venta_usd)) err.push(`${n}: precio_oferta_usd debe ser menor que el precio normal.`);
    const venta = p.precio_oferta_usd || p.precio_venta_usd;
    if (p.costo_usd != null && venta < p.costo_usd * 1.15) (pub ? err : av).push(`${n}: el precio (US$ ${venta}) deja menos de 15 % sobre el costo (US$ ${p.costo_usd}); revisa tu margen y el flete.`);
    if (p.imagen && !/^(assets\/|https:\/\/)/.test(p.imagen)) err.push(`${n}: imagen debe empezar por assets/ o https://.`);
    if (p.imagen && p.imagen.startsWith('assets/') && !fs.existsSync(path.join(__dirname, '..', p.imagen))) err.push(`${n}: no existe el archivo ${p.imagen}.`);
    if (Array.isArray(p.imagenes)) {
      p.imagenes.forEach((im, idx) => {
        if (!/^(assets\/|https:\/\/)/.test(im || '')) err.push(`${n} imagenes[${idx}]: debe empezar por assets/ o https://.`);
        else if (im.startsWith('assets/') && !fs.existsSync(path.join(__dirname, '..', im))) err.push(`${n} imagenes[${idx}]: no existe el archivo ${im}.`);
      });
    }
    if (p.variantes && typeof p.variantes === 'object') {
      Object.entries(p.variantes).forEach(([vid, v]) => {
        if (!v || !v.nombre) err.push(`${n} variante ${vid}: falta nombre.`);
        if (v && v.imagen) {
          if (!/^(assets\/|https:\/\/)/.test(v.imagen)) err.push(`${n} variante ${vid}: imagen debe empezar por assets/ o https://.`);
          else if (v.imagen.startsWith('assets/') && !fs.existsSync(path.join(__dirname, '..', v.imagen))) err.push(`${n} variante ${vid}: no existe el archivo ${v.imagen}.`);
        }
      });
    }
    if (!pub) return;
    if (p.tipo_producto === 'variable') err.push(`${n}: producto variable (talla/color) no soportado todavía.`);
    if (!p.titulo || !p.descripcion || !p.por_que) err.push(`${n}: falta título, descripcion o por_que.`);
    if (!Array.isArray(p.beneficios) || p.beneficios.length < 3) err.push(`${n}: necesita al menos 3 beneficios.`);
    if (!p.specs || Object.keys(p.specs).length < 2) av.push(`${n}: pocas specs para el comparador.`);
    if (!Number.isInteger(p.producto_id) || !Number.isInteger(p.bodega_origen_id)) (estricto ? err : av).push(`${n}: falta producto_id o bodega_origen_id (no se podrá comprar).`);
  });
  if (d.productos.filter((p) => p.estado === 'publicado' && p.semana).length > 1) av.push('Hay más de un "Producto de la semana"; se mostrará el primero.');
  av.forEach((m) => console.log('⚠ ' + m)); err.forEach((m) => console.error('✖ ' + m));
  console.log(`\n${d.productos.length} productos revisados: ${err.length} errores, ${av.length} avisos.`);
  process.exit(err.length ? 1 : 0);
}

({ sugerir, agregar, validar }[cmd] || (() => salir('Comandos: sugerir | agregar | validar')))();
