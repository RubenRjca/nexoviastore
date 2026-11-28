'use strict';
// Pruebas del backend (Node 18+): node tests/backend.test.js   — usa un DroPanas y un almacén SIMULADOS; no llama a nada real.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');
process.env.DROPANAS_API_KEY = 'test_sk_simulada';
// Las pruebas usan 2 productos de ejemplo que en producción están en borrador: aquí se publican solo en memoria.
require(path.join(root, 'data/catalogo.json')).productos.forEach((p) => { if (['cargador-65w', 'smartwatch-fit'].includes(p.sku)) p.estado = 'publicado'; });
const catalogo = require(path.join(root, 'lib/catalogo'));
const cache = require(path.join(root, 'lib/cache'));
const cliente = require(path.join(root, 'lib/cliente'));
const { clasificar } = require(path.join(root, 'lib/errores'));
const stockLib = require(path.join(root, 'lib/stock'));
const respaldo = require(path.join(root, 'lib/respaldo'));
const hStock = require(path.join(root, 'api/stock.js')), hRastreo = require(path.join(root, 'api/rastreo.js'));

// ---------- mini runner ----------
let ok = 0, mal = 0; const logs = [];
const origErr = console.error, origWarn = console.warn, origLog = console.log; console.error = (...a) => logs.push(a.join(' ')); console.warn = console.error; console.log = (...a) => { if (!/ORDEN_CREADA/.test(a.join(' '))) origLog(...a); };
const out = (m) => process.stdout.write(m + '\n');
async function t(nombre, fn) { try { await fn(); ok++; out('  ✔ ' + nombre); } catch (e) { mal++; out('  ✖ ' + nombre + '\n      ' + (e && e.message)); } }
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'no coincide') + ': ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); };
const si = (c, m) => { if (!c) throw new Error(m || 'se esperaba verdadero'); };

// ---------- DroPanas y almacén simulados ----------
let rutas = [], llamadas = [];
const kv = new Map(), listas = new Map(), zsets = new Map(); const L = (k) => { if (!listas.has(k)) listas.set(k, []); return listas.get(k); }; let kvFalla = false;
const mk = (s, j, h = {}) => ({ ok: s >= 200 && s < 300, status: s, headers: { get: (k) => h[k.toLowerCase()] || null }, json: async () => j });
global.fetch = async (url, opt = {}) => {
  const u = new URL(url), clave = (opt.method || 'GET') + ' ' + u.pathname + u.search;
  if (u.host === 'kv.test') { // Upstash simulado
    if (kvFalla) return mk(500, {});
    const res = JSON.parse(opt.body).map(([c, ...a]) => {
      if (c === 'SET') { if (a.includes('NX') && kv.has(a[0])) return { result: null }; kv.set(a[0], a[1]); return { result: 'OK' }; }
      if (c === 'GET') return { result: kv.get(a[0]) || null };
      if (c === 'DEL') { kv.delete(a[0]); return { result: 1 }; }
      if (c === 'MGET') return { result: a.map((k) => kv.get(k) || null) };
      if (c === 'LPUSH') { L(a[0]).unshift(a[1]); return { result: L(a[0]).length }; }
      if (c === 'LTRIM') return { result: 'OK' };
      if (c === 'LLEN') return { result: L(a[0]).length };
      if (c === 'LREM') { listas.set(a[0], L(a[0]).filter((x) => x !== a[2])); return { result: 1 }; }
      if (c === 'LRANGE') return { result: L(a[0]).slice(a[1], a[2] + 1) };
      if (c === 'ZADD') { const z = (zsets.get(a[0]) || new Map()); z.set(a[2], Number(a[1])); zsets.set(a[0], z); return { result: 1 }; }
      if (c === 'ZREVRANGE') { const z = [...(zsets.get(a[0]) || new Map()).entries()].sort((x, y) => y[1] - x[1]).map((e) => e[0]); return { result: z.slice(a[1], a[2] + 1) }; }
      return { result: null };
    });
    return mk(200, res);
  }
  llamadas.push({ clave, opt });
  for (const r of rutas) if (r.re.test(clave)) { const x = typeof r.r === 'function' ? r.r(opt, u) : r.r; if (x instanceof Error) throw x; return mk(x.s, x.j, x.h); }
  return mk(404, { code: 'ORDER_NOT_FOUND' });
};
const ruta = (re, r) => rutas.unshift({ re, r });
const reset = () => { rutas = []; llamadas = []; cache.reiniciar(); cliente.reiniciarPausa(); logs.length = 0; kv.clear(); listas.clear(); zsets.clear(); kvFalla = false; };
const n = (re) => llamadas.filter((c) => re.test(c.clave)).length;
const call = async (h, { method = 'GET', query = {}, body, headers = {} } = {}) => {
  const o = { h: {} }; const res = { setHeader(k, v) { o.h[k.toLowerCase()] = v; }, status(s) { o.s = s; return this; }, json(j) { o.j = j; return this; }, send(b) { o.b = b; return this; } };
  await h({ method, query, body, headers: { 'x-vercel-forwarded-for': '7.7.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250), host: 'tienda.test', ...headers } }, res); return o;
};
const conAlmacen = () => { process.env.KV_REST_API_URL = 'https://kv.test'; process.env.KV_REST_API_TOKEN = 'tok'; };
const sinAlmacen = () => { delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; };

// Catálogo de prueba: un simple (101) y uno variable (202)
const A = catalogo.obtener('cargador-65w'), V = catalogo.obtener('smartwatch-fit');
A.producto_id = 101; A.bodega_origen_id = 1; V.producto_id = 202; V.bodega_origen_id = 1;
const inv = (filas) => ({ s: 200, j: { data: filas } });
const fila = (id, cantidad, variante = null) => ({ producto: { id }, cantidad, variante });
const detSimple = { s: 200, j: { data: { id: 101, tipo_producto: 'simple' } } };
const detVar = { s: 200, j: { data: { id: 202, tipo_producto: 'variable', variantes: [{ id: 42, nombre: 'Azul / M', cantidad: 12 }, { id: 43, nombre: 'Azul / L', cantidad: 0 }] } } };

(async () => {
  out('\n== Caché (éxitos, fallos, una llamada a la vez, obsoleto) ==');
  await t('50 consultas simultáneas = 1 sola llamada', async () => { reset(); let c = 0; await Promise.all(Array.from({ length: 50 }, () => cache.recordar('k', {}, async () => { c++; return { ok: true, v: 1 }; }))); eq(c, 1); });
  await t('un fallo se recuerda: no se repite en bucle', async () => { reset(); let c = 0; const f = async () => { c++; return { ok: false, error: 'X' }; }; await cache.recordar('f', { ttlFail: 5000 }, f); await cache.recordar('f', { ttlFail: 5000 }, f); eq(c, 1); });
  await t('si falla tras un éxito reciente, sirve el dato obsoleto', async () => { reset(); await cache.recordar('o', { ttlOk: 1 }, async () => ({ ok: true, v: 'bueno' })); await new Promise((r) => setTimeout(r, 5)); const r = await cache.recordar('o', {}, async () => ({ ok: false, error: 'X' })); eq([r.ok, r.v, r.obsoleto], [true, 'bueno', true]); });

  out('\n== Cliente: 429 y Retry-After ==');
  await t('tras un 429 no se llama a DroPanas hasta que pase Retry-After', async () => {
    reset(); ruta(/GET \/api\/v1\/productos\/1$/, { s: 429, j: { code: 'RATE_LIMIT_EXCEEDED' }, h: { 'retry-after': '35' } });
    const a = await cliente.llamar('/productos/1'); const antes = llamadas.length; const b = await cliente.llamar('/productos/2');
    eq(a.status, 429); eq(b.local, true); eq(llamadas.length, antes, 'no debió llamar'); si(b.retryAfter >= 34 && b.retryAfter <= 35, 'retryAfter ' + b.retryAfter);
  });
  await t('un error de red no lanza excepción', async () => { reset(); ruta(/./, new Error('timeout')); const r = await cliente.llamar('/x'); eq([r.ok, r.status, r.j.code], [false, 0, 'RED']); });

  out('\n== Clasificador de códigos de DroPanas ==');
  const casos = [
    [{ ok: false, status: 403, j: { code: 'CROSS_MODE_OPERATION_FORBIDDEN' } }, 'CONFIG_ENTORNO', 503, true],
    [{ ok: true, status: 202, j: { code: 'MAINTENANCE_QUEUED' } }, 'MAINTENANCE_QUEUED', 202, false],
    [{ ok: false, status: 422, j: { code: 'SIN_STOCK_EN_BODEGA' } }, 'SIN_STOCK', 409, false],
    [{ ok: false, status: 422, j: { code: 'STOCK_INSUFICIENTE' } }, 'SIN_STOCK', 409, false],
    [{ ok: false, status: 422, j: { code: 'VARIANTE_REQUERIDA' } }, 'VARIANTE_REQUERIDA', 422, true],
    [{ ok: false, status: 422, j: { code: 'VARIANTE_NO_PERTENECE' } }, 'VARIANTE_NO_PERTENECE', 422, true],
    [{ ok: false, status: 422, j: { code: 'BODEGA_ORIGEN_REQUERIDA' } }, 'BODEGA_ORIGEN_REQUERIDA', 503, true],
    [{ ok: false, status: 503, j: { code: 'MAINTENANCE_ACTIVE' } }, 'MAINTENANCE_ACTIVE', 503, false],
    [{ ok: false, status: 429, j: { code: 'RATE_LIMIT_EXCEEDED' }, retryAfter: '12' }, 'RATE_LIMIT_EXCEEDED', 429, false],
    [{ ok: false, status: 401, j: {} }, 'CONFIG_LLAVE', 503, true],
    [{ ok: false, status: 422, j: { code: 'SANDBOX_TRANSPORTADORA_NO_PERMITIDA' } }, 'SANDBOX_TRANSPORTADORA_NO_PERMITIDA', 503, true],
    [{ ok: false, status: 422, j: { code: 'VALIDATION_ERROR', errors: { telefono: ['x'] } } }, 'VALIDATION_ERROR', 422, false],
    [{ ok: false, status: 0, j: { code: 'RED' } }, 'RED', 502, false],
  ];
  for (const [r, code, http, alerta] of casos) await t(`${r.status || 'red'} ${(r.j && r.j.code) || ''} → ${code}/${http}${alerta ? ' + ALERTA' : ''}`, async () => { const c = clasificar(r); eq([c.code, c.http, !!c.alerta], [code, http, alerta]); });
  await t('el mensaje al cliente nunca trae el texto crudo de DroPanas', async () => { const c = clasificar({ ok: false, status: 422, j: { code: 'WALLET_SALDO_INSUFICIENTE', message: 'Saldo 123,45 USD' } }); si(!/123/.test(c.message)); });

  out('\n== Stock real (productos/{id} + bodegas/{id}/inventario) ==');
  await t('producto simple: existencias reales de la bodega', async () => { reset(); ruta(/inventario/, inv([fila(101, 7)])); ruta(/productos\/101$/, detSimple); const d = await stockLib.disponibilidad(A); eq([d.estado, d.total, d.fuente, d.verificado], ['disponible', 7, 'bodega', true]); });
  await t('dos productos de la misma bodega comparten UNA llamada de inventario', async () => { reset(); ruta(/inventario/, inv([fila(101, 7), fila(202, 3, { id: 42 })])); ruta(/productos\/101$/, detSimple); ruta(/productos\/202$/, detVar); await Promise.all([stockLib.disponibilidad(A), stockLib.disponibilidad(V)]); eq(n(/inventario/), 1); });
  await t('segunda consulta dentro del TTL no vuelve a llamar', async () => { reset(); ruta(/inventario/, inv([fila(101, 7)])); ruta(/productos\/101$/, detSimple); await stockLib.disponibilidad(A); const antes = llamadas.length; await stockLib.disponibilidad(A); eq(llamadas.length, antes); });
  await t('"no sé" no se convierte en "hay": producto ausente del inventario = desconocido', async () => { reset(); ruta(/inventario/, inv([fila(999, 5)])); ruta(/productos\/101$/, detSimple); const d = await stockLib.disponibilidad(A); eq([d.estado, d.verificado], ['desconocido', false]); });
  await t('si el inventario no lo trae, usa el stock del detalle del producto', async () => { reset(); ruta(/inventario/, inv([])); ruta(/productos\/101$/, { s: 200, j: { data: { id: 101, tipo_producto: 'simple', stock: 4 } } }); const d = await stockLib.disponibilidad(A); eq([d.estado, d.total, d.fuente], ['disponible', 4, 'producto']); });
  await t('stock 0 en la bodega = agotado', async () => { reset(); ruta(/inventario/, inv([fila(101, 0)])); ruta(/productos\/101$/, detSimple); eq((await stockLib.disponibilidad(A)).estado, 'agotado'); });
  await t('producto con variantes: stock por variante (bodega primero, luego producto)', async () => { reset(); ruta(/inventario/, inv([fila(202, 3, { id: 42 })])); ruta(/productos\/202$/, detVar); const d = await stockLib.disponibilidad(V); eq(d.tipo, 'variable'); eq(d.variantes.map((v) => [v.id, v.disponible, v.estado, v.fuente]), [[42, 3, 'disponible', 'bodega'], [43, 0, 'agotado', 'producto']]); });
  await t('inventario con 429: desconocido + degradado + Retry-After, sin repetir llamadas', async () => {
    reset(); ruta(/inventario/, { s: 429, j: { code: 'RATE_LIMIT_EXCEEDED' }, h: { 'retry-after': '7' } }); ruta(/productos\/101$/, detSimple);
    const d = await stockLib.disponibilidad(A); eq([d.estado, d.degradado, d.retryAfter], ['desconocido', true, 7]); const antes = llamadas.length; await stockLib.disponibilidad(A); eq(llamadas.length, antes);
  });
  await t('puedeComprar: bloquea solo con evidencia', async () => {
    reset(); ruta(/inventario/, inv([fila(101, 7), fila(202, 3, { id: 42 })])); ruta(/productos\/101$/, detSimple); ruta(/productos\/202$/, detVar);
    eq((await stockLib.puedeComprar(A, 8)).code, 'SIN_STOCK'); eq((await stockLib.puedeComprar(A, 7)).ok, true);
    eq((await stockLib.puedeComprar(V, 1)).code, 'VARIANTE_REQUERIDA'); eq((await stockLib.puedeComprar(V, 1, 99)).code, 'VARIANTE_NO_PERTENECE');
    eq((await stockLib.puedeComprar(V, 4, 42)).code, 'SIN_STOCK'); eq((await stockLib.puedeComprar(V, 3, 42)).ok, true);
  });
  await t('puedeComprar con DroPanas caído NO bloquea (DroPanas decide al crear la orden)', async () => { reset(); ruta(/./, { s: 500, j: {} }); eq((await stockLib.puedeComprar(A, 1)).ok, true); });
  await t('producto sin IDs reales = no configurado', async () => { eq((await stockLib.puedeComprar({ producto_id: null, bodega_origen_id: null }, 1)).code, 'NO_CONFIGURADO'); });

  out('\n== GET /api/stock ==');
  await t('devuelve estado público, topa cantidades en 10 y marca "bajo"', async () => {
    reset(); ruta(/inventario/, inv([fila(101, 25)])); ruta(/productos\/101$/, detSimple);
    const r = await call(hStock, { query: { skus: 'cargador-65w' } }); const i = r.j.items['cargador-65w'];
    eq([r.s, i.estado, i.disponible, i.bajo, i.vendible], [200, 'disponible', 10, false, true]); si(!JSON.stringify(r.j).includes('101') && !('producto_id' in i), 'no debe exponer IDs'); si(/s-maxage/.test(r.h['cache-control']));
  });
  await t('productos con variantes devuelven id/nombre/estado de cada una', async () => { reset(); ruta(/inventario/, inv([fila(202, 3, { id: 42 })])); ruta(/productos\/202$/, detVar); const i = (await call(hStock, { query: { skus: 'smartwatch-fit' } })).j.items['smartwatch-fit']; eq(i.variantes.map((v) => [v.id, v.nombre, v.estado]), [[42, 'Azul / M', 'disponible'], [43, 'Azul / L', 'agotado']]); });
  await t('con 429 responde "desconocido" (no "disponible") y Retry-After', async () => { reset(); ruta(/inventario/, { s: 429, j: {}, h: { 'retry-after': '20' } }); ruta(/productos\/101$/, detSimple); const r = await call(hStock, { query: { skus: 'cargador-65w' } }); eq([r.j.items['cargador-65w'].estado, r.j.items['cargador-65w'].degradado], ['desconocido', true]); si(Number(r.h['retry-after']) > 0); });
  await t('sku desconocido, inválido, de más de 12, POST y origen ajeno', async () => {
    reset(); eq((await call(hStock, { query: { skus: 'no-existe' } })).j.items['no-existe'].estado, 'no_encontrado');
    eq((await call(hStock, { query: { skus: '../etc/passwd' } })).s, 400); eq((await call(hStock, { query: { skus: Array.from({ length: 13 }, (_, i) => 'prod-' + i).join(',') } })).s, 400);
    eq((await call(hStock, { method: 'POST' })).s, 405); eq((await call(hStock, { headers: { 'sec-fetch-site': 'cross-site' } })).s, 403);
  });

  out('\n== Respaldo de pedidos ==');
  const ev = { tipo: 'rechazo', ref: 'NXAAAAAAAAAAAA', sku: 'cargador-65w', cantidad: 1, metodo_pago: 'contra_entrega', http: 409, code: 'SIN_STOCK', cliente: { nombre: 'Ana', apellido: 'Pérez', telefono: '04141234567' }, direccion: { state_id: 24, city_id: 149, direccion: 'Av. Principal casa 4' } };
  await t('guarda el detalle en el almacén privado y los logs salen enmascarados', async () => {
    reset(); conAlmacen(); const r = await respaldo.registrar(ev); eq(r.guardado, true); const g = await respaldo.obtener('NXAAAAAAAAAAAA'); eq(g.cliente.telefono, '04141234567');
    const l = logs.join('\n'); si(l.includes('***4567') && !l.includes('04141234567') && !l.includes('Av. Principal'), 'el log no debe llevar teléfono completo ni dirección'); si(!/test_sk|Bearer|tok/.test(l + JSON.stringify([...kv.values()])), 'sin llaves');
  });
  await t('sin almacén configurado no falla: avisa guardado:false y deja el log', async () => { reset(); sinAlmacen(); const r = await respaldo.registrar(ev); eq([r.guardado, r.motivo], [false, 'sin_almacen']); si(logs.some((x) => x.includes('pedido_rechazo'))); });
  await t('si el almacén falla, no rompe el pedido y deja ALERTA', async () => { reset(); conAlmacen(); kvFalla = true; const r = await respaldo.registrar(ev); eq(r.motivo, 'error_almacen'); si(logs.some((x) => x.includes('RESPALDO_FALLO'))); });
  await t('recientes() lista lo guardado', async () => { reset(); conAlmacen(); await respaldo.registrar(ev); eq((await respaldo.recientes(10)).length, 1); });

  out('\n== GET /api/rastreo ==');
  const REF = (c) => 'NX' + c.repeat(12);
  const ordenOk = (id = 777, aprob = 'no_aplica') => ({ s: 200, j: { data: { id, estado_aprobacion: aprob, cliente: { nombre: 'Ana', telefono: '04141234567' }, direccion: { direccion: 'Av. Secreta 1' } } } });
  const trk = { s: 200, j: { data: { id: 777, numero_guia: 'DP777', status_actual: 'En reparto', fecha_entrega: null, historial: [{ status: 'Generada', descripcion: 'El despacho ha sido generado', created_at: '2026-08-17T10:30:00-04:00' }, { status: 'En reparto', descripcion: 'Salió a reparto', created_at: '2026-08-17T15:00:00-04:00' }] } } };
  await t('consulta por referencia + 4 dígitos: estado y línea de tiempo SIN datos personales', async () => {
    reset(); ruta(/ordenes\/ext:/, ordenOk()); ruta(/ordenes\/777\/tracking/, trk);
    const r = await call(hRastreo, { query: { ref: REF('A'), tel: '4567' } }); eq([r.s, r.j.estado, r.j.numero_guia, r.j.historial.length], [200, 'en_reparto', 'DP777', 2]);
    const s = JSON.stringify(r.j); si(!/0414|Ana|Secreta|pdf/.test(s), 'filtró datos personales'); eq(r.h['cache-control'], 'no-store');
  });
  await t('4 dígitos incorrectos o pedido inexistente: respuesta idéntica (no se puede averiguar qué existe)', async () => {
    reset(); ruta(/ordenes\/ext:NXBBBB/, ordenOk()); ruta(/ordenes\/777\/tracking/, trk);
    const mal = await call(hRastreo, { query: { ref: REF('B'), tel: '0000' } }); const no = await call(hRastreo, { query: { ref: REF('C'), tel: '0000' } }); eq([mal.s, mal.j], [no.s, no.j]); eq(mal.s, 404);
  });
  await t('tras 5 intentos fallidos con un pedido se bloquea 15 min (anti fuerza bruta)', async () => { reset(); ruta(/ordenes\/ext:NXDDDD/, ordenOk()); let u; for (let i = 0; i < 6; i++) u = await call(hRastreo, { query: { ref: REF('D'), tel: '10' + String(i).padStart(2, '0') } }); eq(u.s, 429); eq((await call(hRastreo, { query: { ref: REF('D'), tel: '4567' } })).s, 429); });
  await t('parámetros inválidos → 400; POST → 405; origen ajeno → 403', async () => { reset(); eq((await call(hRastreo, { query: { ref: '123', tel: '4567' } })).s, 400); eq((await call(hRastreo, { query: { ref: REF('E') } })).s, 400); eq((await call(hRastreo, { method: 'POST' })).s, 405); eq((await call(hRastreo, { query: { ref: REF('E'), tel: '4567' }, headers: { 'sec-fetch-site': 'cross-site' } })).s, 403); });
  await t('pedido pendiente de aprobación sin guía → "en_revision"', async () => { reset(); ruta(/ordenes\/ext:NXFFFF/, ordenOk(778, 'pendiente_aprobacion')); ruta(/ordenes\/778\/tracking/, { s: 422, j: { code: 'TRACKING_NOT_AVAILABLE' } }); const r = await call(hRastreo, { query: { ref: REF('F'), tel: '4567' } }); eq([r.s, r.j.estado], [200, 'en_revision']); });
  await t('pedido EN COLA (202): se resuelve con el respaldo y /ordenes/en-cola/{id}', async () => {
    reset(); conAlmacen(); await respaldo.registrar({ ...ev, tipo: 'en_cola', ref: REF('1'), solicitud_id: 184, http: 202, code: 'MAINTENANCE_QUEUED' });
    ruta(/ordenes\/en-cola\/184/, { s: 200, j: { data: { estado: 'pendiente', orden_id: null } } });
    let r = await call(hRastreo, { query: { ref: REF('1'), tel: '4567' } }); eq([r.s, r.j.estado], [200, 'en_cola']);
    cache.reiniciar(); rutas = []; ruta(/ordenes\/en-cola\/184/, { s: 200, j: { data: { estado: 'procesado', orden_id: 779 } } }); ruta(/ordenes\/779$/, ordenOk(779)); ruta(/ordenes\/779\/tracking/, trk);
    r = await call(hRastreo, { query: { ref: REF('1'), tel: '4567' } }); eq([r.s, r.j.estado], [200, 'en_reparto']);
  });
  await t('pedido rechazado y respaldado: el cliente ve "no_procesado"', async () => { reset(); conAlmacen(); await respaldo.registrar({ ...ev, ref: REF('2') }); const r = await call(hRastreo, { query: { ref: REF('2'), tel: '4567' } }); eq([r.s, r.j.estado], [200, 'no_procesado']); });
  await t('403 CROSS_MODE → 503 con mensaje seguro + ALERTA', async () => { reset(); ruta(/ordenes\/ext:/, { s: 403, j: { code: 'CROSS_MODE_OPERATION_FORBIDDEN' } }); const r = await call(hRastreo, { query: { ref: REF('3'), tel: '4567' } }); eq([r.s, r.j.code], [503, 'CONFIG_ENTORNO']); si(logs.some((x) => x.includes('ALERTA'))); });
  await t('429 de DroPanas → 429 con Retry-After', async () => { reset(); ruta(/ordenes\/ext:/, { s: 429, j: { code: 'RATE_LIMIT_EXCEEDED' }, h: { 'retry-after': '12' } }); const r = await call(hRastreo, { query: { ref: REF('4'), tel: '4567' } }); eq([r.s, r.h['retry-after']], [429, '12']); });

  // ---------- Propuesta de crear-orden (solo si el archivo está en el repo) ----------
  const prop = path.join(root, 'api/crear-orden.js');
  if (fs.existsSync(prop)) {
    out('\n== api/crear-orden (v2: códigos de DroPanas, cola, variantes y respaldo) ==');
    const hOrden = require(prop); let ipN = 0;
    const cuerpo = (x = {}) => ({ sku: 'cargador-65w', cantidad: 1, metodo_pago: 'contra_entrega', orden_id: crypto.randomUUID(), cliente: { nombre: 'Ana', apellido: 'Pérez', telefono: '0414-1234567' }, direccion: { state_id: 24, city_id: 149, direccion: 'Av. Principal, casa 4' }, ...x });
    const pedir = (body, headers = {}) => call(hOrden, { method: 'POST', body, headers: { 'idempotency-key': crypto.randomUUID(), 'x-vercel-forwarded-for': '8.8.8.' + (ipN++ % 250) + '.' + Math.floor(ipN / 250), ...headers } });
    const base = () => { reset(); conAlmacen(); ruta(/cotizar-envio/, { s: 200, j: { data: [{ tipo_entrega: 'domicilio', shipping_type_id: 1, disponible: true, soporta_recaudo: true, precio_usd: 5 }] } }); ruta(/inventario/, inv([fila(101, 50), fila(202, 9, { id: 42 })])); ruta(/productos\/101$/, detSimple); ruta(/productos\/202$/, detVar); };
    const post = (r) => ruta(/POST \/api\/v1\/ordenes$/, r);
    const body = () => JSON.parse(llamadas.filter((c) => /POST .*ordenes$/.test(c.clave)).pop().opt.body);
    await t('201 → creado (con_recaudo, Idempotency-Key reenviada)', async () => { base(); post({ s: 201, j: { data: { id: 1 } } }); const k = crypto.randomUUID(); const r = await pedir(cuerpo(), { 'idempotency-key': k }); eq([r.s, r.j.estado], [200, 'creado']); const p = llamadas.filter((c) => /POST .*ordenes$/.test(c.clave))[0]; eq([JSON.parse(p.opt.body).tipo_pago, p.opt.headers['Idempotency-Key']], ['con_recaudo', k]); });
    await t('202 MAINTENANCE_QUEUED → estado "en_cola", NO se reenvía y se respalda el solicitud_id', async () => { base(); post({ s: 202, j: { code: 'MAINTENANCE_QUEUED', data: { solicitud_id: 184, estado: 'pendiente', orden_id: null } } }); const r = await pedir(cuerpo()); eq([r.s, r.j.estado], [202, 'en_cola']); eq(n(/POST .*ordenes$/), 1); const g = await respaldo.obtener(r.j.referencia); eq([g.tipo, g.solicitud_id], ['en_cola', 184]); });
    await t('403 CROSS_MODE → 503 genérico, ALERTA y pedido respaldado', async () => { base(); post({ s: 403, j: { code: 'CROSS_MODE_OPERATION_FORBIDDEN', message: 'detalle interno' } }); const r = await pedir(cuerpo()); eq([r.s, r.j.code], [503, 'CONFIG_ENTORNO']); si(!JSON.stringify(r.j).includes('interno')); si(logs.some((x) => x.includes('ALERTA') && x.includes('CONFIG_ENTORNO'))); eq((await respaldo.recientes(5)).length, 1); });
    for (const [s, code, http, esperado] of [[422, 'SIN_STOCK_EN_BODEGA', 409, 'SIN_STOCK'], [422, 'STOCK_INSUFICIENTE', 409, 'SIN_STOCK'], [422, 'VARIANTE_REQUERIDA', 422, 'VARIANTE_REQUERIDA'], [422, 'BODEGA_ORIGEN_REQUERIDA', 503, 'BODEGA_ORIGEN_REQUERIDA'], [422, 'VALIDATION_ERROR', 422, 'VALIDATION_ERROR'], [503, 'MAINTENANCE_ACTIVE', 503, 'MAINTENANCE_ACTIVE']])
      await t(`${s} ${code} → ${http} ${esperado} (respaldado)`, async () => { base(); post({ s, j: { code, message: 'Saldo 99,99 USD' } }); const r = await pedir(cuerpo()); eq([r.s, r.j.code], [http, esperado]); si(!JSON.stringify(r.j).includes('99,99'), 'filtró mensaje crudo'); eq((await respaldo.recientes(5)).length, 1); });
    await t('503 MAINTENANCE_ACTIVE trae Retry-After', async () => { base(); post({ s: 503, j: { code: 'MAINTENANCE_ACTIVE' } }); const r = await pedir(cuerpo()); si(Number(r.h['retry-after']) > 0); });
    await t('429 RATE_LIMIT_EXCEEDED respeta Retry-After y activa el circuito (la siguiente no llama a DroPanas)', async () => { base(); post({ s: 429, j: { code: 'RATE_LIMIT_EXCEEDED' }, h: { 'retry-after': '12' } }); const r = await pedir(cuerpo()); eq([r.s, r.h['retry-after']], [429, '12']); const antes = llamadas.length; await pedir(cuerpo()); eq(llamadas.length, antes, 'no debió llamar a DroPanas'); });
    await t('fallo de red al crear: 502, se respalda como error_red y se puede reintentar con la misma llave', async () => { base(); post(new Error('timeout')); const r = await pedir(cuerpo()); eq([r.s, r.j.code], [502, 'RED']); eq((await respaldo.recientes(5))[0].tipo, 'error_red'); });
    await t('IDEMPOTENCY_IN_FLIGHT → 409 y NO se respalda (es un reintento)', async () => { base(); post({ s: 409, j: { code: 'IDEMPOTENCY_IN_FLIGHT' } }); const r = await pedir(cuerpo()); eq(r.s, 409); eq((await respaldo.recientes(5)).length, 0); });
    await t('EXTERNAL_REFERENCE_DUPLICADO → creado (no se duplica)', async () => { base(); post({ s: 422, j: { code: 'EXTERNAL_REFERENCE_DUPLICADO' } }); const r = await pedir(cuerpo()); eq([r.s, r.j.duplicado], [200, true]); });
    await t('pago anticipado: sin_recaudo + requiere_aprobacion', async () => { base(); post({ s: 201, j: { data: {} } }); await pedir(cuerpo({ metodo_pago: 'anticipado', pago_metodo: 'zelle', pago_referencia: 'ZL998877' })); const b = body(); eq([b.tipo_pago, b.requiere_aprobacion], ['sin_recaudo', true]); });
    await t('producto con variantes: sin variante → 422 antes de llamar; con variante → viaja variante_id', async () => { base(); post({ s: 201, j: { data: {} } }); const r1 = await pedir(cuerpo({ sku: 'smartwatch-fit' })); eq([r1.s, r1.j.code], [422, 'VARIANTE_REQUERIDA']); eq(n(/POST .*ordenes$/), 0); const r2 = await pedir(cuerpo({ sku: 'smartwatch-fit', variante_id: 42 })); eq(r2.s, 200); eq(body().productos[0].variante_id, 42); });
    await t('el precio y los IDs siguen saliendo del servidor (no del navegador)', async () => { base(); post({ s: 201, j: { data: {} } }); await pedir(cuerpo({ precio_venta_usd: 0.01, producto_id: 1 })); eq([body().productos[0].precio_venta_usd, body().productos[0].producto_id], [21.9, 101]); }); // precio final único del catálogo (el envío cotizado no se suma)
    await t('cobertura: CROSS_MODE al cotizar → 503 con ALERTA (sin crear pedido)', async () => { base(); ruta(/cotizar-envio/, { s: 403, j: { code: 'CROSS_MODE_OPERATION_FORBIDDEN' } }); const r = await pedir(cuerpo()); eq([r.s, r.j.code], [503, 'CONFIG_ENTORNO']); eq(n(/POST .*ordenes$/), 0); });
    out('\n== Cuentas, precio final único (envío incluido), margen y variantes estrictas ==');
    const SES = 'x'.repeat(40); process.env.SESSION_SECRET = SES;
    const sesionLib = require(path.join(root, 'lib/sesion.js'));
    const cookie = (sub = 'g-1') => 'nx_sesion=' + sesionLib.firmar({ sub, email: 'a@b.c', nombre: 'Ana' });
    await t('precio final único: el cliente paga solo el precio del catálogo y la respuesta NO revela el envío', async () => { base(); post({ s: 201, j: { data: { id: 5 } } }); const r = await pedir(cuerpo()); eq([r.s, r.j.envio_usd, r.j.subtotal_usd, r.j.total_usd], [200, undefined, undefined, 21.9]); eq(body().productos[0].precio_venta_usd, 21.9); });
    await t('total_esperado distinto al calculado → 409 PRECIO_CAMBIO y NO se crea el pedido', async () => { base(); post({ s: 201, j: { data: {} } }); const r = await pedir(cuerpo({ total_esperado_usd: 26.9 })); eq([r.s, r.j.code, r.j.total_usd, r.j.envio_usd], [409, 'PRECIO_CAMBIO', 21.9, undefined]); si(!llamadas.some((c) => /POST .*ordenes$/.test(c.clave)), 'no debe crear'); });
    await t('margen de la lámpara a US$ 29 con envío 4,50 / 6,90 y comisión 0,50 (cálculo interno)', async () => {
      const P = require('../lib/precio'); const c1 = P.calcular(29, 1, 6.9), c2 = P.calcular(29, 1, 4.5);
      eq([c1.total, c1.unit, P.margen(c1, 14.99, 1), P.margen(c2, 14.99, 1)], [29, 29, 6.61, 9.01]);
    });
    await t('total_esperado correcto → se crea', async () => { base(); post({ s: 201, j: { data: {} } }); eq((await pedir(cuerpo({ total_esperado_usd: 21.9 }))).s, 200); });
    await t('margen bajo el mínimo → ALERTA MARGEN_BAJO en logs (no bloquea la venta)', async () => { base(); post({ s: 201, j: { data: {} } }); process.env.MARGEN_MIN_USD = '1000'; const r = await pedir(cuerpo()); delete process.env.MARGEN_MIN_USD; eq(r.s, 200); si(logs.some((l) => /MARGEN_BAJO/.test(l)), 'falta la alerta'); });
    await t('margen sano → sin alerta', async () => { base(); post({ s: 201, j: { data: {} } }); process.env.MARGEN_MIN_USD = '0'; await pedir(cuerpo()); delete process.env.MARGEN_MIN_USD; si(!logs.some((l) => /MARGEN_BAJO/.test(l)), 'no debía alertar'); });
    await t('REQUIERE_CUENTA=1 sin sesión → 401 LOGIN_REQUERIDO; apagado → compra libre', async () => {
      base(); post({ s: 201, j: { data: {} } }); process.env.REQUIERE_CUENTA = '1'; const r = await pedir(cuerpo()); eq([r.s, r.j.code], [401, 'LOGIN_REQUERIDO']); delete process.env.REQUIERE_CUENTA; eq((await pedir(cuerpo())).s, 200); });
    await t('con sesión: el pedido se guarda por usuario (Mis pedidos) con tel4 y variante, y el perfil queda para autollenar', async () => {
      base(); post({ s: 201, j: { data: { id: 55 } } }); process.env.REQUIERE_CUENTA = '1'; const r = await pedir(cuerpo(), { cookie: cookie('g-9') }); delete process.env.REQUIERE_CUENTA; eq(r.s, 200);
      const rec = JSON.parse(kv.get('nx:o:' + r.j.referencia)); eq([rec.sub, rec.tel4, rec.total_usd, rec.orden_id], ['g-9', '4567', 21.9, 55]); si(zsets.get('nx:uo:g-9').has(r.j.referencia), 'falta en la lista del usuario'); si(JSON.parse(kv.get('nx:u:g-9')).perfil.telefono, 'falta el perfil'); });
    await t('WhatsApp: el pedido guarda los datos de contacto y entrega para reenviar la confirmación desde Mis pedidos', async () => {
      base(); post({ s: 201, j: { data: { id: 56 } } }); const r = await pedir(cuerpo({ entrega: { estado: 'Distrito Capital', ciudad: 'Caracas' } }), { cookie: cookie('g-9') }); eq(r.s, 200);
      const rec = JSON.parse(kv.get('nx:o:' + r.j.referencia)); eq([rec.contacto.estado, rec.contacto.ciudad], ['Distrito Capital', 'Caracas']); si(rec.contacto.nombre && rec.contacto.telefono && rec.contacto.direccion, 'falta contacto');
      si(!JSON.stringify(r.j).includes(rec.contacto.telefono), 'la respuesta no debe devolver el teléfono'); });
    await t('compra sin cuenta (modo libre) igual deja registro por referencia, sin usuario', async () => { base(); post({ s: 201, j: { data: {} } }); const r = await pedir(cuerpo()); const rec = JSON.parse(kv.get('nx:o:' + r.j.referencia)); eq(rec.sub, null); });
    await t('si el almacén falla, el pedido igual se crea y queda ALERTA PEDIDO_NO_GUARDADO', async () => { base(); post({ s: 201, j: { data: {} } }); kvFalla = true; const r = await pedir(cuerpo()); eq(r.s, 200); si(logs.some((l) => /PEDIDO_NO_GUARDADO/.test(l)), 'falta alerta'); });
    await t('variantes estrictas: lámpara sin variante → 400; modelo ajeno → 400; 1950/1951 pasan esa validación', async () => {
      base(); post({ s: 201, j: { data: {} } });
      const r1 = await pedir(cuerpo({ sku: 'lampara-atrapazancudos' })); eq([r1.s, r1.j.code], [400, 'VARIANTE_REQUERIDA']);
      const r2 = await pedir(cuerpo({ sku: 'lampara-atrapazancudos', variante_id: 999 })); eq([r2.s, r2.j.code], [400, 'VARIANTE_INVALIDA']);
      for (const id of [1950, 1951]) { const r3 = await pedir(cuerpo({ sku: 'lampara-atrapazancudos', variante_id: id })); si(!/VARIANTE_(REQUERIDA|INVALIDA)/.test(r3.j.code || ''), 'rechazó ' + id); } });
    await t('GET /api/cotizar: devuelve solo el precio final (sin envío); sin cobertura → 422', async () => {
      base(); const hCot = require(path.join(root, 'api/cotizar.js'));
      const r = await call(hCot, { query: { sku: 'cargador-65w', estado: '24', ciudad: '149', cantidad: '2' } }); eq([r.s, r.j.subtotal_usd, r.j.envio_usd, r.j.total_usd], [200, undefined, undefined, 43.8]);
      ruta(/cotizar-envio/, { s: 200, j: { data: [] } }); cache.reiniciar(); const r2 = await call(hCot, { query: { sku: 'cargador-65w', estado: '24', ciudad: '150' } }); eq([r2.s, r2.j.code], [422, 'SIN_COBERTURA']); });
    delete process.env.SESSION_SECRET;
  }

  out('\n== /api/productos: tasa en vivo, manual o de respaldo ==');
  const hProd = require(path.join(root, 'api/productos.js'));
  const limpiarEnv = () => { delete process.env.TASA_BS; delete process.env.TASA_BS_RESPALDO; };
  const refProdRe = new RegExp('productos\\/' + catalogo.productoRef() + '$');
  await t('sin ninguna tasa: solo USD (tasa y fuente nulas) y NINGUNA reseña sembrada en el catálogo', async () => { reset(); limpiarEnv(); ruta(refProdRe, detSimple); const r = await call(hProd); eq([r.j.tasa_bs, r.j.tasa_fuente], [null, null]); si(r.j.productos.every((p) => Array.isArray(p.resenas) && p.resenas.length === 0), 'resenas debe ir vacío'); });
  await t('WHATSAPP_TIENDA: /api/productos lo expone solo con dígitos; sin variable → null (el front usa su número por defecto)', async () => {
    reset(); limpiarEnv(); ruta(refProdRe, detSimple); eq((await call(hProd, {})).j.whatsapp, null);
    reset(); limpiarEnv(); process.env.WHATSAPP_TIENDA = '+58 424-5474761'; ruta(refProdRe, detSimple); const r = await call(hProd, {}); delete process.env.WHATSAPP_TIENDA; eq(r.j.whatsapp, '584245474761'); });
  await t('ficha de la lámpara: medidas de la caja, características confirmadas e imágenes de ambos modelos (sin inventar peso ni autonomía)', async () => {
    const fs = require('fs'), cat = JSON.parse(fs.readFileSync(path.join(root, 'data/catalogo.json'), 'utf8')), l = cat.productos.find((x) => x.sku === 'lampara-atrapazancudos');
    eq(l.specs['Medidas de la caja'], '23,5 cm de alto × 12,5 cm de ancho × 12,5 cm de largo');
    si((l.caracteristicas || []).length === 7 && l.caracteristicas.some((c) => /luz nocturna/i.test(c.t)), 'faltan características'); si(!/peso|autonom|horas/i.test(Object.keys(l.specs).join(' ')), 'no debe inventar peso ni autonomía');
    for (const id of ['1950', '1951']) si(l.variantes[id].imagen && fs.existsSync(path.join(root, l.variantes[id].imagen)), 'falta la imagen del modelo ' + id);
    const pub = require(path.join(root, 'lib/catalogo.js')).publico(null).find((x) => x.sku === 'lampara-atrapazancudos'); si(pub.caracteristicas && pub.caracteristicas.length === 7, 'publico no expone caracteristicas'); });
  await t('páginas legales propias: existen, se enlazan entre sí y no copian ni nombran a DroPanas', async () => {
    const fs = require('fs');
    for (const n of ['terminos', 'privacidad', 'garantia']) { const h = fs.readFileSync(path.join(root, 'legal', n + '.html'), 'utf8'); si(/Nexovia Store/.test(h) && /terminos\.html/.test(h) && /privacidad\.html/.test(h) && /garantia\.html/.test(h), n + ': falta navegación'); si(!/dropanas/i.test(h), n + ': no debe nombrar a DroPanas'); }
    const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8'); si(/legal\/terminos\.html/.test(idx) && /legal\/privacidad\.html/.test(idx) && /legal\/garantia\.html/.test(idx), 'el pie de página debe enlazar las tres páginas'); });
  await t('ayuda: botón «Habla con nuestra IA de Nexovia» abre LucidBot en pestaña nueva, sin iframe; sin selector de moneda', async () => {
    const fs = require('fs'), idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const m = idx.match(/<a[^>]*id="ai-ia"[^>]*>([^<]*)<\/a>/); si(m && /href="https:\/\/panel\.lucidbot\.co\/webchat\/\?p=1695810"/.test(m[0]) && /target="_blank"/.test(m[0]) && /rel="noopener noreferrer"/.test(m[0]) && m[1] === 'Habla con nuestra IA de Nexovia', 'falta el botón de la IA con su enlace');
    si(!/<iframe[^>]*lucidbot|id="ai-fr"/.test(idx), 'no debe quedar el iframe de LucidBot'); si(!/data-cur="VES"/.test(idx) && !/class="cur"/.test(idx), 'no debe quedar el selector USD/Bs'); });
  const hChat = require(path.join(root, 'api/chat.js')), GEM = /generateContent$/, M = (c) => ({ mensajes: [{ role: 'user', content: c }] });
  const gOk = (txt) => ({ s: 200, j: { candidates: [{ content: { parts: [{ text: txt }] } }] } });
  await t('chat: con GEMINI_API_KEY responde con IA (temp. 0,3, llave en cabecera, sistema con precio y reglas) y no expone la llave', async () => {
    reset(); process.env.GEMINI_API_KEY = 'gk-secreta'; ruta(GEM, gOk('Cuesta US$ 29,00 con envío incluido.'));
    const r = await call(hChat, { method: 'POST', body: M('¿cuánto cuesta?') }); delete process.env.GEMINI_API_KEY;
    eq([r.s, r.j.fuente, r.j.respuesta], [200, 'ia', 'Cuesta US$ 29,00 con envío incluido.']); si(!JSON.stringify(r.j).includes('gk-secreta'), 'no debe devolver la llave');
    const c = llamadas.find((x) => GEM.test(x.clave)), b = JSON.parse(c.opt.body), sis = b.systemInstruction.parts[0].text;
    eq([c.opt.headers['x-goog-api-key'], b.generationConfig.temperature, c.clave.includes('gemini-2.5-flash')], ['gk-secreta', 0.3, true]);
    si(/US\$ 29,00/.test(sis) && /584245474761|424-5474761/.test(sis) && /NUNCA inventes/.test(sis) && /23,5 cm/.test(sis) && !/dropanas/i.test(sis), 'el sistema no trae los datos oficiales o nombra al proveedor'); });
  await t('chat: sin GEMINI_API_KEY → respuestas locales de respaldo (200, sin llamar a Gemini)', async () => {
    reset(); delete process.env.GEMINI_API_KEY;
    const r = await call(hChat, { method: 'POST', body: M('¿Cuál es la autonomía de la batería?') }); eq([r.s, r.j.fuente], [200, 'respaldo']); si(/WhatsApp/.test(r.j.respuesta) && /confirmado/.test(r.j.respuesta), 'no debe inventar la autonomía'); eq(n(GEM), 0);
    eq((await call(hChat, { method: 'POST', body: M('precio?') })).j.respuesta.includes('US$ 29,00'), true); });
  await t('chat: error de cuota / red / respuesta vacía de Gemini → respaldo sin romper el chat', async () => {
    for (const x of [{ s: 429, j: { error: { status: 'RESOURCE_EXHAUSTED' } } }, new Error('red'), { s: 200, j: { candidates: [], promptFeedback: { blockReason: 'SAFETY' } } }]) {
      reset(); process.env.GEMINI_API_KEY = 'k'; ruta(GEM, x); const r = await call(hChat, { method: 'POST', body: M('¿cómo compro?') }); delete process.env.GEMINI_API_KEY;
      eq([r.s, r.j.fuente], [200, 'respaldo']); si(/Comprar ahora/.test(r.j.respuesta), 'respaldo incorrecto'); si(!JSON.stringify(logs).includes('cómo compro'), 'no debe registrar el mensaje del cliente'); } });
  const urlsGem = () => llamadas.filter((x) => GEM.test(x.clave)).map((x) => x.clave);
  await t('chat: payload válido para la API REST de Gemini (roles solo user/model, systemInstruction.parts[].text, sin «assistant»/«system» en contents)', async () => {
    reset(); process.env.GEMINI_API_KEY = 'k'; ruta(GEM, gOk('ok'));
    await call(hChat, { method: 'POST', body: { mensajes: [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'Hola, ¿en qué te ayudo?' }, { role: 'user', content: '¿precio?' }] } }); delete process.env.GEMINI_API_KEY;
    const b = JSON.parse(llamadas.find((x) => GEM.test(x.clave)).opt.body);
    eq(b.contents.map((c) => c.role), ['user', 'model', 'user']); si(b.contents.every((c) => Array.isArray(c.parts) && typeof c.parts[0].text === 'string' && Object.keys(c).sort().join() === 'parts,role'), 'contents mal formado');
    si(Array.isArray(b.systemInstruction.parts) && typeof b.systemInstruction.parts[0].text === 'string' && !('role' in b.systemInstruction), 'systemInstruction mal formado'); si(!('system' in b) && !JSON.stringify(b.contents).includes('"assistant"'), 'no debe haber system/assistant en contents'); });
  await t('chat: GEMINI_MODEL con espacios, comillas y prefijo «models/» se limpia (sin models/models/); valor inválido → modelo estable por defecto', async () => {
    reset(); process.env.GEMINI_API_KEY = 'k'; ruta(GEM, gOk('ok')); process.env.GEMINI_MODEL = '  "models/gemini-2.5-flash-lite " ';
    await call(hChat, { method: 'POST', body: M('hola') }); eq(urlsGem(), ['POST /v1beta/models/gemini-2.5-flash-lite:generateContent']);
    reset(); ruta(GEM, gOk('ok')); process.env.GEMINI_MODEL = '¡¡ no vale !!'; await call(hChat, { method: 'POST', body: M('hola') }); eq(urlsGem(), ['POST /v1beta/models/gemini-2.5-flash:generateContent']);
    reset(); ruta(GEM, gOk('ok')); process.env.GEMINI_MODEL = '   '; await call(hChat, { method: 'POST', body: M('hola') }); eq(urlsGem(), ['POST /v1beta/models/gemini-2.5-flash:generateContent']);
    delete process.env.GEMINI_MODEL; delete process.env.GEMINI_API_KEY; });
  await t('chat: modelo obsoleto (404 NOT_FOUND) → prueba el alias estable antes de caer al respaldo', async () => {
    reset(); process.env.GEMINI_API_KEY = 'k'; process.env.GEMINI_MODEL = 'gemini-1.5-flash-viejo';
    ruta(GEM, (o, u) => (u.pathname.includes('gemini-1.5-flash-viejo') ? { s: 404, j: { error: { status: 'NOT_FOUND', message: 'models/gemini-1.5-flash-viejo is not found' } } } : gOk('Respuesta con el modelo estable.')));
    const r = await call(hChat, { method: 'POST', body: M('hola') }); delete process.env.GEMINI_MODEL; delete process.env.GEMINI_API_KEY;
    eq([r.j.fuente, r.j.respuesta], ['ia', 'Respuesta con el modelo estable.']); eq(urlsGem().map((x) => x.split('/').pop()), ['gemini-1.5-flash-viejo:generateContent', 'gemini-2.5-flash:generateContent']); });
  await t('chat: 400 por thinkingConfig → reintenta el mismo modelo sin esa opción', async () => {
    reset(); process.env.GEMINI_API_KEY = 'k';
    ruta(GEM, (o) => (JSON.parse(o.body).generationConfig.thinkingConfig ? { s: 400, j: { error: { status: 'INVALID_ARGUMENT', message: 'Thinking budget is not supported for this model' } } } : gOk('ok sin thinking')));
    const r = await call(hChat, { method: 'POST', body: M('hola') }); delete process.env.GEMINI_API_KEY; eq([r.j.fuente, r.j.respuesta, n(GEM)], ['ia', 'ok sin thinking', 2]); });
  await t('chat: llave inválida (400 API_KEY_INVALID) → una sola llamada, respaldo y causa legible en el log (sin la llave)', async () => {
    reset(); process.env.GEMINI_API_KEY = 'llave-mala'; ruta(GEM, { s: 400, j: { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } } });
    const r = await call(hChat, { method: 'POST', body: M('hola') }); delete process.env.GEMINI_API_KEY;
    eq([r.j.fuente, n(GEM)], ['respaldo', 1]); const lg = JSON.stringify(logs); si(/API_KEY_INVALID/.test(lg) && /CHAT_GEMINI_FALLO/.test(lg) && !lg.includes('llave-mala'), 'el log debe indicar la causa sin exponer la llave'); });
  await t('chat: la llave se limpia (espacios, saltos de línea, comillas) antes de enviarla', async () => {
    reset(); process.env.GEMINI_API_KEY = ' "gk-abc"\n'; ruta(GEM, gOk('ok')); await call(hChat, { method: 'POST', body: M('hola') }); delete process.env.GEMINI_API_KEY;
    eq(llamadas.find((x) => GEM.test(x.clave)).opt.headers['x-goog-api-key'], 'gk-abc'); });
  await t('chat: límites (mensaje 500, historial 6), origen y método', async () => {
    reset(); process.env.GEMINI_API_KEY = 'k'; ruta(GEM, gOk('ok'));
    const hist = []; for (let i = 0; i < 12; i++) hist.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(900) }); hist.push({ role: 'user', content: 'y'.repeat(900) });
    await call(hChat, { method: 'POST', body: { mensajes: hist } }); const b = JSON.parse(llamadas.find((x) => GEM.test(x.clave)).opt.body); delete process.env.GEMINI_API_KEY;
    si(b.contents.length <= 6 && b.contents.every((c) => c.parts[0].text.length <= 500) && b.contents[0].role === 'user' && b.contents[b.contents.length - 1].role === 'user', 'límites no aplicados');
    eq((await call(hChat, { method: 'POST', body: { mensajes: [] } })).s, 400); eq((await call(hChat, { method: 'GET' })).s, 405);
    eq((await call(hChat, { method: 'POST', body: M('hola'), headers: { origin: 'https://otro.com' } })).s, 403); });
  await t('tasa de respaldo (TASA_BS_RESPALDO): se usa y se marca como "respaldo"', async () => { reset(); limpiarEnv(); process.env.TASA_BS_RESPALDO = '140'; ruta(refProdRe, detSimple); const r = await call(hProd); eq([r.j.tasa_bs, r.j.tasa_fuente], [140, 'respaldo']); eq(r.j.productos[0].ves, Math.round(r.j.productos[0].usd * 140 * 100) / 100); limpiarEnv(); });
  await t('tasa en vivo deducida de DroPanas (precio sugerido USD y Bs) → "dropanas"', async () => { reset(); limpiarEnv(); process.env.TASA_BS_RESPALDO = '140'; ruta(refProdRe, { s: 200, j: { data: { id: catalogo.productoRef(), tipo_producto: 'simple', precio_sugerido_usd: 10, precio_sugerido_ves: 1500 } } }); const r = await call(hProd); eq([r.j.tasa_bs, r.j.tasa_fuente], [150, 'dropanas']); limpiarEnv(); });
  await t('TASA_BS manual → "manual"', async () => { reset(); limpiarEnv(); process.env.TASA_BS = '152.5'; ruta(refProdRe, detSimple); const r = await call(hProd); eq([r.j.tasa_bs, r.j.tasa_fuente], [152.5, 'manual']); limpiarEnv(); });

  out('\n== /api/resenas: solo reseñas reales, con moderación ==');
  const hRes = require(path.join(root, 'api/resenas.js')), moderar = require(path.join(root, 'scripts/resenas-moderar.js'));
  const rv = (x = {}) => ({ producto_sku: 'cargador-65w', nombre: 'María', texto: 'Lo recibí en tres días y carga mi laptop y mi celular a la vez. Muy buen producto.', estrellas: 5, ...x });
  const silencio = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
  const idPendiente = () => [...kv.keys()].find((k) => k.startsWith('nx:resena:')).split(':')[2];
  await t('sin almacén: GET responde lista vacía (disponible:false) y POST 503, sin inventar nada', async () => { reset(); sinAlmacen(); const g = await call(hRes, { query: { sku: 'cargador-65w' } }); eq([g.s, g.j.disponible, g.j.data.length], [200, false, 0]); eq((await call(hRes, { method: 'POST', body: rv() })).s, 503); });
  await t('una reseña nueva queda PENDIENTE y no se ve hasta que la apruebes', async () => {
    reset(); conAlmacen(); const p = await call(hRes, { method: 'POST', body: rv() }); eq([p.s, p.j.estado], [202, 'pendiente']);
    eq((await call(hRes, { query: { sku: 'cargador-65w' } })).j.data.length, 0, 'no debe publicarse sola');
    await silencio(() => moderar.aprobar(idPendiente()));
    const g = await call(hRes, { query: { sku: 'cargador-65w' } }); eq([g.j.disponible, g.j.data.length, g.j.resumen.promedio, g.j.data[0].nombre], [true, 1, 5, 'María']); si(/s-maxage/.test(g.h['cache-control']));
  });
  await t('rechazar y quitar: la reseña deja de verse', async () => {
    reset(); conAlmacen(); await call(hRes, { method: 'POST', body: rv(), headers: { 'x-vercel-forwarded-for': '1.1.1.1' } }); const id = idPendiente();
    await silencio(() => moderar.aprobar(id)); eq((await call(hRes, { query: { sku: 'cargador-65w' } })).j.data.length, 1);
    await silencio(() => moderar.quitar(id)); eq((await call(hRes, { query: { sku: 'cargador-65w' } })).j.data.length, 0);
  });
  await t('promedio con varias reseñas', async () => { reset(); conAlmacen(); for (const [i, e] of [5, 4, 4].entries()) { await call(hRes, { method: 'POST', body: rv({ estrellas: e }), headers: { 'x-vercel-forwarded-for': '2.2.2.' + i } }); } for (const k of [...kv.keys()].filter((x) => x.startsWith('nx:resena:'))) await silencio(() => moderar.aprobar(k.split(':')[2])); eq((await call(hRes, { query: { sku: 'cargador-65w' } })).j.resumen, { total: 3, promedio: 4.3 }); });
  await t('validaciones: enlaces, estrellas, nombre, texto corto, producto inexistente', async () => {
    reset(); conAlmacen(); const p = (x) => call(hRes, { method: 'POST', body: rv(x) });
    eq((await p({ texto: 'Compren en www.tiendafalsa.com que es mejor y más barato que aquí.' })).s, 400); eq((await p({ estrellas: 6 })).s, 400); eq((await p({ estrellas: 0 })).s, 400); eq((await p({ estrellas: 4.5 })).s, 400);
    eq((await p({ nombre: 'M' })).s, 400); eq((await p({ nombre: '123' })).s, 400); eq((await p({ texto: 'Bueno' })).s, 400); eq((await p({ producto_sku: 'no-existe' })).s, 400); eq((await p({ producto_sku: '__proto__' })).s, 400);
    eq(kv.size, 0, 'no debe guardar nada inválido');
  });
  await t('HTML/scripts en el texto se eliminan antes de guardar y nunca salen en la respuesta', async () => {
    reset(); conAlmacen(); await call(hRes, { method: 'POST', body: rv({ texto: 'Excelente <script>alert(1)</script> producto, me llegó rápido a la casa y funciona.' }) });
    const guardado = [...kv.values()].join(''); si(!/[<>]/.test(guardado.replace(/\{|\}/g, '')), 'quedó HTML en el almacén'); await silencio(() => moderar.aprobar(idPendiente()));
    si(!/[<>]/.test(JSON.stringify((await call(hRes, { query: { sku: 'cargador-65w' } })).j)));
  });
  await t('campo trampa anti-bots, límite de 3 por hora, origen ajeno, GET con sku inválido y método no permitido', async () => {
    reset(); conAlmacen(); const bot = await call(hRes, { method: 'POST', body: rv({ web: 'http://spam' }) }); eq(bot.s, 202); eq(kv.size, 0);
    const ip = { 'x-vercel-forwarded-for': '9.9.9.9' }; const r = []; for (let i = 0; i < 4; i++) r.push((await call(hRes, { method: 'POST', body: rv(), headers: ip })).s); eq(r, [202, 202, 202, 429]);
    eq((await call(hRes, { method: 'POST', body: rv(), headers: { origin: 'https://evil.com' } })).s, 403); eq((await call(hRes, { query: { sku: '../x' } })).s, 404); eq((await call(hRes, { method: 'DELETE' })).s, 405);
  });

  out('\n== /api/webhook: firma HMAC, duplicados y estado del pedido ==');
  const hWh = require(path.join(root, 'api/webhook.js'));
  const SEC = 'whsec_prueba';
  const evt = (o = {}) => ({ evento: 'order.status_changed', timestamp: '2026-11-22T10:00:00-04:00', sandbox: false, cuenta: { id: 1 }, datos: { orden_id: 5, pedido: { numero_externo: 'NX1A2B3C4D5E6F', estado: 'En reparto', transportadora: 'Tealca', numero_guia: '123' } }, ...o });
  const llamarWh = async (body, { secreto = SEC, firma, delivery = 'del-0001', method = 'POST' } = {}) => {
    const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); const o = { h: {} };
    const res = { setHeader(k, v) { o.h[k.toLowerCase()] = v; }, status(s) { o.s = s; return this; }, json(j) { o.j = j; return this; } };
    await hWh({ method, rawBody: raw, headers: { host: 'tienda.test', 'x-dropanas-signature': firma !== undefined ? firma : crypto.createHmac('sha256', secreto).update(raw).digest('hex'), 'x-dropanas-delivery': delivery } }, res); return o;
  };
  await t('sin DROPANAS_WEBHOOK_SECRET: 503 (nunca acepta sin firma)', async () => { reset(); conAlmacen(); delete process.env.DROPANAS_WEBHOOK_SECRET; eq((await llamarWh(evt())).s, 503); });
  process.env.DROPANAS_WEBHOOK_SECRET = SEC;
  await t('firma inválida o ausente: 401 y no se guarda nada', async () => { reset(); conAlmacen(); eq((await llamarWh(evt(), { firma: 'abc' })).s, 401); eq((await llamarWh(evt(), { secreto: 'otro' })).s, 401); eq([...kv.keys()].filter((k) => k.startsWith('nx:wh:')).length, 0); });
  await t('firma válida: guarda el último estado por referencia NX…', async () => { reset(); conAlmacen(); const r = await llamarWh(evt()); eq(r.s, 200); const rec = JSON.parse(kv.get('nx:wh:NX1A2B3C4D5E6F')); eq([rec.estado, rec.transportadora, rec.guia], ['En reparto', 'Tealca', '123']); });
  await t('entrega repetida (mismo X-DroPanas-Delivery): duplicado, no reprocesa', async () => { reset(); conAlmacen(); await llamarWh(evt()); const r = await llamarWh(evt()); eq([r.s, r.j.duplicado], [200, true]); });
  await t('referencia ajena (no NX…) no se guarda; incidente deja ALERTA; método GET 405', async () => { reset(); conAlmacen(); await llamarWh(evt({ datos: { pedido: { numero_externo: 'LUCID-1', estado: 'X' } } }), { delivery: 'del-0002' }); eq([...kv.keys()].filter((k) => k.startsWith('nx:wh:NX')).length, 0); const n = logs.length; await llamarWh({ evento: 'incident.created', datos: { orden_id: 9, novedad_id: 3, tipo: 'no_entregado' } }, { delivery: 'del-0003' }); si(logs.length > n, 'debe alertar la novedad'); eq((await llamarWh(evt(), { method: 'GET' })).s, 405); });
  await t('webhook: si el almacén falla responde 500 y el reintento SÍ se procesa (no queda como duplicado)', async () => { reset(); conAlmacen(); kvFalla = true; const r1 = await llamarWh(evt(), { delivery: 'del-0003' }); eq(r1.s, 500); kvFalla = false; const r2 = await llamarWh(evt(), { delivery: 'del-0003' }); eq([r2.s, r2.j.duplicado], [200, undefined]); si(kv.has('nx:wh:NX1A2B3C4D5E6F'), 'no se guardó tras el reintento'); });
  await t('webhook: sin encabezado de entrega, el mismo cuerpo se trata como duplicado', async () => { reset(); conAlmacen(); await llamarWh(evt(), { delivery: '' }); const r = await llamarWh(evt(), { delivery: '' }); eq(r.j.duplicado, true); });
  await t('webhook: un evento atrasado no pisa el estado más reciente', async () => { reset(); conAlmacen(); await llamarWh(evt({ timestamp: '2026-11-22T12:00:00-04:00', datos: { pedido: { numero_externo: 'NX1A2B3C4D5E6F', estado: 'Entregado' } } }), { delivery: 'del-0010' }); await llamarWh(evt({ timestamp: '2026-11-22T09:00:00-04:00', datos: { pedido: { numero_externo: 'NX1A2B3C4D5E6F', estado: 'En reparto' } } }), { delivery: 'del-0011' }); eq(JSON.parse(kv.get('nx:wh:NX1A2B3C4D5E6F')).estado, 'Entregado'); });
  await t('webhook: límite de tasa por IP (429) sin guardar nada', async () => { reset(); conAlmacen(); let u; for (let i = 0; i < 305; i++) u = await llamarWh(evt(), { firma: 'x', delivery: 'd-' + i + 'xxxxxx' }); eq(u.s, 429); });
  delete process.env.DROPANAS_WEBHOOK_SECRET;

  out('\n== Privacidad del costo, variantes y cobertura ==');
  await t('la API pública no expone costo_usd ni IDs de DroPanas', async () => { const txt = JSON.stringify(catalogo.publico(100)); si(!/costo_usd|producto_id|bodega_origen_id/.test(txt), 'campo interno expuesto'); });
  await t('vercel.json bloquea /data, /lib y archivos internos (el costo no se sirve como estático)', async () => { const v = require(path.join(root, 'vercel.json')); const re = (v.redirects || []).map((r) => r.source); si(re.some((x) => x.includes('data') && x.includes('lib')), 'falta redirect de /data y /lib'); });
  await t('variantes: "No detallado" nunca llega como nombre', async () => { reset(); ruta(/inventario/, inv([fila(202, 3, { id: 42 })])); ruta(/productos\/202$/, { s: 200, j: { data: { tipo_producto: 'variable', variantes: [{ id: 42, color: 'No detallado', size: 'No detallado', cantidad: 3 }, { id: 43, nombre: 'Echufable' }] } } }); const i = (await call(hStock, { query: { skus: 'smartwatch-fit' } })).j.items['smartwatch-fit']; eq(i.variantes.map((v) => v.nombre), [null, 'Echufable']); });
  await t('la lámpara trae etiquetas para las variantes 1950 y 1951', async () => { const l = catalogo.publico(100).find((p) => p.sku === 'lampara-atrapazancudos'); si(l && l.variantes && l.variantes['1950'] && l.variantes['1951'] && l.variantes['1950'].nombre !== l.variantes['1951'].nombre, 'faltan variantes'); });

  out('\n== Sesión firmada y Google ==');
  process.env.SESSION_SECRET = 'y'.repeat(40);
  const ses = require(path.join(root, 'lib/sesion.js')), goo = require(path.join(root, 'lib/google.js')), hAuth = require(path.join(root, 'api/auth.js')), hMp = require(path.join(root, 'api/mis-pedidos.js')), usr = require(path.join(root, 'lib/usuarios.js'));
  await t('sesión: firma válida pasa; manipulada, vencida o sin secreto NO', async () => {
    const tk = ses.firmar({ sub: 'u1' }); eq(ses.verificar(tk).sub, 'u1');
    const [c, f] = tk.split('.'); eq(ses.verificar(Buffer.from(JSON.stringify({ sub: 'u2', exp: 9999999999 })).toString('base64url') + '.' + f), null); eq(ses.verificar(c + '.' + 'A'.repeat(f.length)), null);
    eq(ses.verificar(ses.firmar({ sub: 'u1' }, -10)), null); const sv = process.env.SESSION_SECRET; delete process.env.SESSION_SECRET; eq(ses.firmar({ sub: 'u1' }), null); process.env.SESSION_SECRET = sv; });
  const par = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }), otro = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...par.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }, jwks = async () => [jwk];
  const jwt = (claims, key = par.privateKey, kid = 'k1') => { const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); const h = b({ alg: 'RS256', kid, typ: 'JWT' }), p = b(claims), sg = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), key).toString('base64url'); return h + '.' + p + '.' + sg; };
  const ahora = Math.floor(Date.now() / 1000), CID = 'cid-123.apps.googleusercontent.com';
  const claims = (x = {}) => ({ iss: 'https://accounts.google.com', aud: CID, sub: 'g-777', email: 'ana@gmail.com', email_verified: true, name: 'Ana Pérez', given_name: 'Ana', family_name: 'Pérez', picture: 'https://lh3.googleusercontent.com/a', iat: ahora, exp: ahora + 3600, ...x });
  await t('Google: token válido → usuario; audiencia, firma, emisor, vencimiento o correo sin verificar → rechazado', async () => {
    const u = await goo.verificarCredencial(jwt(claims()), CID, { jwks }); eq([u.sub, u.email, u.nombres], ['g-777', 'ana@gmail.com', 'Ana']);
    eq(await goo.verificarCredencial(jwt(claims({ aud: 'otro' })), CID, { jwks }), null);
    eq(await goo.verificarCredencial(jwt(claims(), otro.privateKey), CID, { jwks }), null);
    eq(await goo.verificarCredencial(jwt(claims({ iss: 'https://evil.com' })), CID, { jwks }), null);
    eq(await goo.verificarCredencial(jwt(claims({ exp: ahora - 3600 })), CID, { jwks }), null);
    eq(await goo.verificarCredencial(jwt(claims({ email_verified: false })), CID, { jwks }), null);
    eq(await goo.verificarCredencial(jwt(claims(), par.privateKey, 'desconocida'), CID, { jwks }), null);
    eq(await goo.verificarCredencial('basura', CID, { jwks }), null); });
  const auth = (opt) => call((rq, rs) => hAuth(rq, rs, { opciones: { jwks } }), opt);
  await t('/api/auth: login con Google crea cookie HttpOnly; "yo" la reconoce; "salir" la borra; token malo → 401', async () => {
    reset(); conAlmacen(); process.env.GOOGLE_CLIENT_ID = CID;
    const r = await auth({ method: 'POST', query: { accion: 'google' }, body: { credential: jwt(claims()) } }); eq(r.s, 200); si(/nx_sesion=.+HttpOnly/.test(r.h['set-cookie']) && /Secure/.test(r.h['set-cookie']), 'cookie insegura');
    const ck = r.h['set-cookie'].split(';')[0]; si(JSON.parse(kv.get('nx:u:g-777')).email === 'ana@gmail.com', 'no guardó el usuario');
    const y = await auth({ query: { accion: 'yo' }, headers: { cookie: ck } }); eq([y.j.usuario.email, y.j.google_client_id, y.j.requiere_cuenta], ['ana@gmail.com', CID, false]);
    process.env.REQUIERE_CUENTA = '1'; eq((await auth({ query: { accion: 'yo' } })).j.requiere_cuenta, true); delete process.env.REQUIERE_CUENTA;
    eq((await auth({ method: 'POST', query: { accion: 'google' }, body: { credential: 'mala' } })).s, 401);
    si(/Max-Age=0/.test((await auth({ method: 'POST', query: { accion: 'salir' } })).h['set-cookie']), 'no borró la cookie');
    delete process.env.GOOGLE_CLIENT_ID; const sin = await auth({ query: { accion: 'yo' } }); eq([sin.j.google_client_id, sin.j.requiere_cuenta], [null, false]); eq((await auth({ method: 'POST', query: { accion: 'google' }, body: { credential: jwt(claims()) } })).s, 503); });
  await t('/api/auth: POST desde otro origen → 403', async () => { reset(); eq((await auth({ method: 'POST', query: { accion: 'salir' }, headers: { origin: 'https://evil.com' } })).s, 403); });
  out('\n== Perfil: foto, datos y pedido actual ==');
  const cookieDe = (sub, extra = {}) => 'nx_sesion=' + ses.firmar({ sub, email: sub + '@g.com', nombre: 'Ana Pérez', foto: 'https://lh3.test/foto.jpg', ...extra });
  const jpg = (n = 600) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
  const dataJpg = (b) => 'data:image/jpeg;base64,' + b.toString('base64');
  await t('foto de perfil: subir JPEG, servirla solo a su dueño con caché privado, «yo» devuelve su URL; quitarla vuelve a la de Google', async () => {
    reset(); conAlmacen(); process.env.GOOGLE_CLIENT_ID = CID; const ck = cookieDe('g-1');
    eq((await auth({ method: 'POST', query: { accion: 'foto' }, body: { imagen: dataJpg(jpg()) } })).s, 401);
    const ok = await auth({ method: 'POST', query: { accion: 'foto' }, body: { imagen: dataJpg(jpg()) }, headers: { cookie: ck } }); eq([ok.s, ok.j.foto_propia, /^\/api\/auth\?accion=foto&v=\d+$/.test(ok.j.foto)], [200, true, true]);
    const g = await auth({ query: { accion: 'foto' }, headers: { cookie: ck } }); eq([g.s, g.h['content-type'], /private/.test(g.h['cache-control']), g.b.length], [200, 'image/jpeg', true, 604]);
    eq((await auth({ query: { accion: 'foto' }, headers: { cookie: cookieDe('g-2') } })).s, 404); eq((await auth({ query: { accion: 'foto' } })).s, 401);
    const y = await auth({ query: { accion: 'yo' }, headers: { cookie: ck } }); eq([y.j.usuario.foto_propia, y.j.usuario.foto === ok.j.foto], [true, true]);
    const q = await auth({ method: 'POST', query: { accion: 'foto-quitar' }, headers: { cookie: ck } }); eq([q.s, q.j.foto_propia], [200, false]);
    const y2 = await auth({ query: { accion: 'yo' }, headers: { cookie: ck } }); eq([y2.j.usuario.foto_propia, y2.j.usuario.foto], [false, 'https://lh3.test/foto.jpg']); eq((await auth({ query: { accion: 'foto' }, headers: { cookie: ck } })).s, 404);
    delete process.env.GOOGLE_CLIENT_ID; });
  await t('foto de perfil: rechaza PNG/SVG, no-imagen, falsos JPEG y archivos > 120 KB; sin almacén → 503', async () => {
    reset(); conAlmacen(); const ck = cookieDe('g-1'), mal = async (imagen) => (await auth({ method: 'POST', query: { accion: 'foto' }, body: { imagen }, headers: { cookie: ck } })).s;
    eq([await mal('data:image/png;base64,' + jpg().toString('base64')), await mal('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), await mal('hola'), await mal(dataJpg(Buffer.alloc(900, 1))), await mal(dataJpg(jpg(130 * 1024))), await mal('data:image/jpeg;base64,<script>')], [400, 400, 400, 400, 400, 400]);
    sinAlmacen(); eq((await auth({ method: 'POST', query: { accion: 'foto' }, body: { imagen: dataJpg(jpg()) }, headers: { cookie: ck } })).s, 503); });
  await t('datos de entrega: se guardan en el perfil (conservando estado/ciudad/referencia de la última compra) y «yo» los devuelve', async () => {
    reset(); conAlmacen(); process.env.GOOGLE_CLIENT_ID = CID; const ck = cookieDe('g-1');
    await usr.guardarPerfil('g-1', { nombre: 'A', apellido: 'B', telefono: '04141112233', direccion: 'Vieja 123', referencia: 'Frente a la plaza', estado_id: 4, ciudad_id: 99 });
    const r = await auth({ method: 'POST', query: { accion: 'perfil' }, body: { nombre: 'Ana', apellido: 'Pérez', telefono: '0412-1234567', direccion: 'Av. Principal, casa <b>2</b>, Caracas' }, headers: { cookie: ck } });
    eq([r.s, r.j.perfil.nombre, r.j.perfil.referencia, r.j.perfil.estado_id, r.j.perfil.ciudad_id], [200, 'Ana', 'Frente a la plaza', 4, 99]); si(!/[<>]/.test(r.j.perfil.direccion), 'debe limpiar < >');
    eq((await auth({ query: { accion: 'yo' }, headers: { cookie: ck } })).j.perfil.direccion.includes('Av. Principal'), true);
    const mal = async (b) => (await auth({ method: 'POST', query: { accion: 'perfil' }, body: b, headers: { cookie: ck } })).s;
    eq([await mal({ nombre: 'A', apellido: 'B' }), await mal({ nombre: 'Ana', apellido: 'Pérez', telefono: 'abc' }), await mal({ nombre: 'Ana', apellido: 'Pérez', direccion: 'corta' })], [400, 400, 400]);
    eq((await auth({ method: 'POST', query: { accion: 'perfil' }, body: { nombre: 'Ana', apellido: 'Pérez' } })).s, 401); delete process.env.GOOGLE_CLIENT_ID; });
  out('\n== Mis pedidos y rastreo de respaldo ==');
  const REFX = 'NX' + 'A'.repeat(12), REFY = 'NX' + 'B'.repeat(12);
  const regs = (ref, sub, tel4 = '5888') => ({ ref, sub, creado: new Date().toISOString(), sku: 'lampara-atrapazancudos', titulo: 'Lámpara', variante_id: 1951, variante_nombre: 'Modelo 2 · Recargable con pila', cantidad: 1, subtotal_usd: 23, envio_usd: 6.9, total_usd: 29.9, modo: 'contra_entrega', estado: 'creado', orden_id: null, tel4 });
  await t('mis-pedidos: ?activo=1 trae solo los 3 últimos y cada paso del historial lleva su etapa (para el termómetro)', async () => {
    reset(); conAlmacen(); for (let i = 0; i < 5; i++) await usr.guardarPedido({ ...regs('NX' + String(i).repeat(12), 'g-1'), creado: new Date(Date.now() - (5 - i) * 1000).toISOString() });
    const ck = cookieDe('g-1'); eq([(await call(hMp, { headers: { cookie: ck } })).j.pedidos.length, (await call(hMp, { query: { activo: '1' }, headers: { cookie: ck } })).j.pedidos.length], [5, 3]);
    reset(); conAlmacen(); await usr.guardarPedido(regs(REFX, 'g-1'));
    ruta(/ordenes\/ext:/, { s: 200, j: { data: { id: 88, estado_aprobacion: 'no_aplica', cliente: { telefono: '04125885888' } } } }); ruta(/ordenes\/88\/tracking/, { s: 200, j: { data: { numero_guia: 'DP88', status_actual: 'En camino', historial: [{ status: 'Recibido', created_at: '2026-11-24T10:00:00Z' }, { status: 'En camino', created_at: '2026-11-24T12:00:00Z' }] } } });
    const r = await call(hMp, { headers: { cookie: ck } }); const h = r.j.pedidos[0].historial; si(h.length === 2 && h.every((x) => typeof x.etapa === 'string' && x.fecha), 'el historial debe traer etapa y fecha'); });
  await t('mis-pedidos: sin sesión 401; con sesión solo ve los SUYOS; DroPanas sin la orden → "pendiente de confirmación" con su código NX', async () => {
    reset(); conAlmacen(); eq((await call(hMp, {})).s, 401);
    await usr.guardarPedido(regs(REFX, 'g-1')); await usr.guardarPedido(regs(REFY, 'g-2'));
    const r = await call(hMp, { headers: { cookie: 'nx_sesion=' + ses.firmar({ sub: 'g-1' }) } }); eq([r.s, r.j.pedidos.length, r.j.pedidos[0].referencia, r.j.pedidos[0].estado], [200, 1, REFX, 'pendiente_confirmacion']);
    eq([r.j.pedidos[0].variante, r.j.pedidos[0].total_usd], ['Modelo 2 · Recargable con pila', 29.9]); si(!JSON.stringify(r.j).includes('tel4'), 'no debe exponer tel4'); });
  await t('mis-pedidos: devuelve el contacto SOLO al dueño (para el botón de WhatsApp) y nunca el de otro usuario', async () => {
    reset(); conAlmacen(); await usr.guardarPedido({ ...regs(REFX, 'g-1'), contacto: { nombre: 'Ana Pérez', telefono: '04141234567', estado: 'Miranda', ciudad: 'Los Teques', direccion: 'Calle 1 casa 2' } }); await usr.guardarPedido({ ...regs(REFY, 'g-2'), contacto: { nombre: 'Otro', telefono: '04120000000' } });
    const r = await call(hMp, { headers: { cookie: 'nx_sesion=' + ses.firmar({ sub: 'g-1' }) } }); eq([r.j.pedidos.length, r.j.pedidos[0].contacto.ciudad], [1, 'Los Teques']); si(!JSON.stringify(r.j).includes('04120000000'), 'no debe filtrar contacto ajeno'); });
  await t('seguimiento: estados de DroPanas → entregado / en camino / cancelado / devolución (historial por categorías)', async () => {
    const { etapa } = require(path.join(root, 'lib/seguimiento.js'));
    eq([etapa('Entregado'), etapa('En camino'), etapa('Cancelado por el cliente'), etapa('Devolución en proceso'), etapa('Novedad en entrega'), etapa('Pedido anulado'), etapa('En preparación')], ['entregado', 'en_camino', 'cancelado', 'devolucion', 'novedad', 'cancelado', 'preparando']); });
  await t('mis-pedidos: incluye sku y variante_id para «Volver a pedir»', async () => {
    reset(); conAlmacen(); await usr.guardarPedido(regs(REFX, 'g-1'));
    const r = await call(hMp, { headers: { cookie: 'nx_sesion=' + ses.firmar({ sub: 'g-1' }) } }); eq([r.j.pedidos[0].sku, r.j.pedidos[0].variante_id], ['lampara-atrapazancudos', 1951]); });
  await t('mis-pedidos: con la orden en DroPanas muestra estado real y guía', async () => {
    reset(); conAlmacen(); await usr.guardarPedido(regs(REFX, 'g-1'));
    ruta(/ordenes\/ext:/, { s: 200, j: { data: { id: 88, estado_aprobacion: 'no_aplica', cliente: { telefono: '04125885888' } } } }); ruta(/ordenes\/88\/tracking/, { s: 200, j: { data: { numero_guia: 'DP88', status_actual: 'En reparto', historial: [] } } });
    const r = await call(hMp, { headers: { cookie: 'nx_sesion=' + ses.firmar({ sub: 'g-1' }) } }); eq([r.j.pedidos[0].estado, r.j.pedidos[0].numero_guia], ['en_reparto', 'DP88']); });
  await t('mis-pedidos sin almacén: disponible:false (no rompe)', async () => { reset(); delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; const r = await call(hMp, { headers: { cookie: 'nx_sesion=' + ses.firmar({ sub: 'g-1' }) } }); eq([r.s, r.j.disponible], [200, false]); });
  await t('rastreo: DroPanas no la encuentra pero la creamos nosotros → "pendiente de confirmación" (4 dígitos correctos); incorrectos → 404 y diagnóstico en logs', async () => {
    reset(); conAlmacen(); await usr.guardarPedido(regs(REFX, null, '5888'));
    const ok1 = await call(hRastreo, { query: { ref: REFX, tel: '5888' } }); eq([ok1.s, ok1.j.estado], [200, 'pendiente_confirmacion']); si(/pendiente de confirmaci/.test(ok1.j.mensaje), 'texto');
    const mal1 = await call(hRastreo, { query: { ref: REFX, tel: '0000' } }); eq(mal1.s, 404); si(logs.some((l) => /RASTREO_NO_ENCONTRADO/.test(l) && /telefono_no_coincide|orden_no_encontrada/.test(l)), 'falta diagnóstico'); });
  delete process.env.SESSION_SECRET;

  out('\n== /api/producto-pagina: vista previa Open Graph por producto y entrada directa ==');
  const hPag = require(path.join(root, 'api/producto-pagina.js'));
  await t('producto publicado: og:image usa la foto del producto, og:title su título, <base href="/"> y sin datos internos', async () => {
    for (const [sku, img] of [['auricular-casco-bt57', 'assets/auricular-casco-bt57.jpg'], ['uro-probiotic-vaginal', 'assets/uro-probiotic-vaginal.jpg'], ['mini-ups-10400', 'assets/mini-ups-10400.jpg'], ['lampara-atrapazancudos', 'assets/lampara-atrapazancudos.jpg']]) {
      const r = await call(hPag, { query: { p: sku }, headers: { host: 'nexoviastore.vercel.app' } });
      eq(r.s, 200); si(/text\/html/.test(r.h['content-type'] || ''), 'content-type');
      si(r.b.includes('<base href="/">'), 'falta base href');
      si(r.b.includes(`https://nexoviastore.vercel.app/${img}`), 'falta og:image del producto ' + sku);
      si(r.b.includes(`https://nexoviastore.vercel.app/p/${sku}`), 'falta og:url de ' + sku);
      si(!r.b.includes('og-image.jpg'), 'no debe usar la portada general en ' + sku);
      si(!/DISTRIDROP|573106517341|SKU-21762|Baruch|584221758634|SKU-21536|costo_usd|producto_id|bodega_origen_id/.test(r.b), 'dato interno expuesto en ' + sku);
    }
  });
  await t('producto inexistente o en borrador: cae de forma segura a la portada general (og-image.jpg) y POST → 405', async () => {
    for (const bad of ['no-existe', 'audifonos-tws', '../etc']) {
      const r = await call(hPag, { query: { p: bad } }); eq(r.s, 200);
      si(r.b.includes('og-image.jpg') && !r.b.includes('Audífonos Inalámbricos'), 'filtró borrador o no cayó a portada: ' + bad);
    }
    eq((await call(hPag, { method: 'POST', query: { p: 'uro-probiotic-vaginal' } })).s, 405);
  });

  out('\n== Fichas sin repetición ("antes y después") y comparador automático ==');
  await t('orden del catálogo: el producto más reciente ("nuevo": true) va primero y los anteriores detrás', async () => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/catalogo.json'), 'utf8'));
    const pubRaw = raw.productos.filter((x) => x.estado === 'publicado').map((x) => x.sku);
    eq(pubRaw, ['auricular-casco-bt57', 'uro-probiotic-vaginal', 'mini-ups-10400', 'lampara-atrapazancudos']);
    const pub = require(path.join(root, 'lib/catalogo.js')).publico(null).map((x) => x.sku);
    eq(pub[0], 'auricular-casco-bt57');
    const sc = fs.readFileSync(path.join(root, 'scripts/catalogo.js'), 'utf8');
    si(sc.includes('d.productos.unshift(') && sc.includes('debe ir al inicio de los productos publicados'), 'scripts/catalogo.js debe insertar al principio y validar orden');
  });
  await t('productos publicados: exponen antes_despues verificable y URO incluye cepas/XOS reales de OPositiv', async () => {
    const pub = require(path.join(root, 'lib/catalogo.js')).publico(null);
    for (const sku of ['auricular-casco-bt57', 'lampara-atrapazancudos', 'mini-ups-10400', 'uro-probiotic-vaginal']) {
      const p = pub.find((x) => x.sku === sku);
      si(p && p.antes_despues && p.antes_despues.antes && p.antes_despues.despues, 'falta antes_despues en ' + sku);
    }
    const bt = pub.find((x) => x.sku === 'auricular-casco-bt57');
    si(bt && bt.usd === 30 && !bt.caracteristicas && !/Baruch|584221758634|SKU-21536/.test(JSON.stringify(bt)), 'BT57 debe costar $30 sin caracteristicas duplicadas ni datos internos');
    const uro = pub.find((x) => x.sku === 'uro-probiotic-vaginal');
    si(/Lactobacillus acidophilus|L\. acidophilus/i.test(JSON.stringify(uro)) && /XOS/i.test(JSON.stringify(uro)) && !uro.caracteristicas, 'URO debe traer datos reales sin duplicar caracteristicas');
  });
  await t('index.html: renderiza "Antes y después" y oculta comparador + accesos hasta haber 2+ coincidentes', async () => {
    const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    si(/Antes y después en tu día a día/.test(idx) && /\.ad-c\.despues/.test(idx), 'falta bloque Antes y después en ficha');
    si(/<section[^>]*id="comparador"[^>]*\bhidden\b/.test(idx) && /<a href="#comparador" hidden>/.test(idx) && /\.mnav a\[hidden\]\{display:none\}/.test(idx) && /\.cmpx\[hidden\]\{display:none\}/.test(idx), 'comparador debe iniciar oculto con sus enlaces');
    si(/const catsCmp = \(\) => categorias\.filter/.test(idx) && /links\.forEach\(\(a\) => \{ a\.hidden = !cats\.length; \}\)/.test(idx) && /cs\.classList\.add\('in'\)/.test(idx), 'comparador debe activarse/ocultarse automáticamente por coincidencia');
  });
  await t('bienvenida y diseño responsivo: bienvenida sin recuadro (móvil vertical / PC horizontal) con botón ×, banner de entrega y Open Graph consistente', async () => {
    const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const vj = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    si(/<dialog class="wl" id="wl"/.test(idx) && /id="wl-x"/.test(idx) && !/class="wl-top"/.test(idx) && !/class="wl-body"/.test(idx), 'bienvenida debe mostrarse sola sin recuadro y con botón ×');
    si(/assets\/bienvenida-nexovia\.png/.test(idx) && /assets\/bienvenida-nexovia-pc\.png/.test(idx) && /assets\/banner-contra-entrega\.png/.test(idx), 'faltan las imágenes de bienvenida móvil/PC y banner');
    si(/<picture>/.test(idx) && /bienvenida-nexovia-pc\.png/.test(idx), 'bienvenida debe alternar entre versión vertical y horizontal');
    si(!/id="hero-fig"/.test(idx) && /id="hero-new"/.test(idx), '¡Recién llegado! debe mostrar solo controles sin recuadro de imagen en el hero');
    si(/grid-auto-flow:column/.test(idx) && /overflow-x:clip/.test(idx), 'catálogo debe usar scroll lateral controlado sin desborde de página');
    si(/assets\/hero-nexovia\.jpg/.test(idx) && /assets\/hero-nexovia-noche\.jpg/.test(idx), 'faltan recursos visuales día/noche del hero en index.html');
    si(/property="og:image:url"/.test(idx) && /https:\/\/nexoviastore\.vercel\.app\/og-image\.jpg/.test(idx) && /name="twitter:image:alt"/.test(idx), 'faltan metadatos Open Graph / Twitter completos con el dominio real en portada');
    si(vj.headers.some((h) => h.source === '/og-image.jpg'), 'vercel.json debe definir cabeceras públicas para /og-image.jpg');
    const rHead = await call(hPag, { method: 'HEAD', query: { p: 'auricular-casco-bt57' }, headers: { host: 'nexoviastore.vercel.app' } });
    eq(rHead.s, 200);
    const rProd = await call(hPag, { query: { p: 'auricular-casco-bt57' }, headers: { host: 'nexoviastore.vercel.app' } });
    si(rProd.b.includes('og:image:url" content="https://nexoviastore.vercel.app/assets/auricular-casco-bt57.jpg"'), 'og:image:url debe actualizarse en /p/<sku>');
    si(/abrirBienvenida\(\)/.test(idx) && /skuEnUrl\(\)/.test(idx), 'modal de bienvenida debe respetar enlaces directos a producto');
    for (const f of ['og-image.jpg', 'assets/bienvenida-nexovia.png', 'assets/bienvenida-nexovia-pc.png', 'assets/banner-contra-entrega.png', 'assets/hero-nexovia.jpg', 'assets/hero-nexovia-noche.jpg']) {
      si(fs.existsSync(path.join(root, f)), 'falta archivo ' + f);
    }
  });

  console.error = origErr; console.warn = origWarn; console.log = origLog;
  out(`\n${ok} pruebas correctas, ${mal} con fallos.`);
  process.exit(mal ? 1 : 0);
})();
