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
const origErr = console.error; console.error = (...a) => logs.push(a.join(' '));
const out = (m) => process.stdout.write(m + '\n');
async function t(nombre, fn) { try { await fn(); ok++; out('  ✔ ' + nombre); } catch (e) { mal++; out('  ✖ ' + nombre + '\n      ' + (e && e.message)); } }
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'no coincide') + ': ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); };
const si = (c, m) => { if (!c) throw new Error(m || 'se esperaba verdadero'); };

// ---------- DroPanas y almacén simulados ----------
let rutas = [], llamadas = [];
const kv = new Map(), listas = new Map(); const L = (k) => { if (!listas.has(k)) listas.set(k, []); return listas.get(k); }; let kvFalla = false;
const mk = (s, j, h = {}) => ({ ok: s >= 200 && s < 300, status: s, headers: { get: (k) => h[k.toLowerCase()] || null }, json: async () => j });
global.fetch = async (url, opt = {}) => {
  const u = new URL(url), clave = (opt.method || 'GET') + ' ' + u.pathname + u.search;
  if (u.host === 'kv.test') { // Upstash simulado
    if (kvFalla) return mk(500, {});
    const res = JSON.parse(opt.body).map(([c, ...a]) => {
      if (c === 'SET') { if (a.includes('NX') && kv.has(a[0])) return { result: null }; kv.set(a[0], a[1]); return { result: 'OK' }; }
      if (c === 'GET') return { result: kv.get(a[0]) || null };
      if (c === 'MGET') return { result: a.map((k) => kv.get(k) || null) };
      if (c === 'LPUSH') { L(a[0]).unshift(a[1]); return { result: L(a[0]).length }; }
      if (c === 'LTRIM') return { result: 'OK' };
      if (c === 'LLEN') return { result: L(a[0]).length };
      if (c === 'LREM') { listas.set(a[0], L(a[0]).filter((x) => x !== a[2])); return { result: 1 }; }
      if (c === 'LRANGE') return { result: L(a[0]).slice(a[1], a[2] + 1) };
      return { result: null };
    });
    return mk(200, res);
  }
  llamadas.push({ clave, opt });
  for (const r of rutas) if (r.re.test(clave)) { const x = typeof r.r === 'function' ? r.r(opt, u) : r.r; if (x instanceof Error) throw x; return mk(x.s, x.j, x.h); }
  return mk(404, { code: 'ORDER_NOT_FOUND' });
};
const ruta = (re, r) => rutas.unshift({ re, r });
const reset = () => { rutas = []; llamadas = []; cache.reiniciar(); cliente.reiniciarPausa(); logs.length = 0; kv.clear(); listas.clear(); kvFalla = false; };
const n = (re) => llamadas.filter((c) => re.test(c.clave)).length;
const call = async (h, { method = 'GET', query = {}, body, headers = {} } = {}) => {
  const o = { h: {} }; const res = { setHeader(k, v) { o.h[k.toLowerCase()] = v; }, status(s) { o.s = s; return this; }, json(j) { o.j = j; return this; } };
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
    const base = () => { reset(); conAlmacen(); ruta(/cotizar-envio/, { s: 200, j: { data: [{ tipo_entrega: 'domicilio', shipping_type_id: 1, disponible: true, soporta_recaudo: true }] } }); ruta(/inventario/, inv([fila(101, 50), fila(202, 9, { id: 42 })])); ruta(/productos\/101$/, detSimple); ruta(/productos\/202$/, detVar); };
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
    await t('el precio y los IDs siguen saliendo del servidor (no del navegador)', async () => { base(); post({ s: 201, j: { data: {} } }); await pedir(cuerpo({ precio_venta_usd: 0.01, producto_id: 1 })); eq([body().productos[0].precio_venta_usd, body().productos[0].producto_id], [21.9, 101]); });
    await t('cobertura: CROSS_MODE al cotizar → 503 con ALERTA (sin crear pedido)', async () => { base(); ruta(/cotizar-envio/, { s: 403, j: { code: 'CROSS_MODE_OPERATION_FORBIDDEN' } }); const r = await pedir(cuerpo()); eq([r.s, r.j.code], [503, 'CONFIG_ENTORNO']); eq(n(/POST .*ordenes$/), 0); });
  }

  out('\n== /api/productos: tasa en vivo, manual o de respaldo ==');
  const hProd = require(path.join(root, 'api/productos.js'));
  const limpiarEnv = () => { delete process.env.TASA_BS; delete process.env.TASA_BS_RESPALDO; };
  await t('sin ninguna tasa: solo USD (tasa y fuente nulas) y NINGUNA reseña sembrada en el catálogo', async () => { reset(); limpiarEnv(); ruta(/productos\/101$/, detSimple); const r = await call(hProd); eq([r.j.tasa_bs, r.j.tasa_fuente], [null, null]); si(r.j.productos.every((p) => Array.isArray(p.resenas) && p.resenas.length === 0), 'resenas debe ir vacío'); });
  await t('tasa de respaldo (TASA_BS_RESPALDO): se usa y se marca como "respaldo"', async () => { reset(); limpiarEnv(); process.env.TASA_BS_RESPALDO = '140'; ruta(/productos\/101$/, detSimple); const r = await call(hProd); eq([r.j.tasa_bs, r.j.tasa_fuente], [140, 'respaldo']); eq(r.j.productos[0].ves, Math.round(r.j.productos[0].usd * 140 * 100) / 100); limpiarEnv(); });
  await t('tasa en vivo deducida de DroPanas (precio sugerido USD y Bs) → "dropanas"', async () => { reset(); limpiarEnv(); process.env.TASA_BS_RESPALDO = '140'; ruta(/productos\/101$/, { s: 200, j: { data: { id: 101, tipo_producto: 'simple', precio_sugerido_usd: 10, precio_sugerido_ves: 1500 } } }); const r = await call(hProd); eq([r.j.tasa_bs, r.j.tasa_fuente], [150, 'dropanas']); limpiarEnv(); });
  await t('TASA_BS manual → "manual"', async () => { reset(); limpiarEnv(); process.env.TASA_BS = '152.5'; ruta(/productos\/101$/, detSimple); const r = await call(hProd); eq([r.j.tasa_bs, r.j.tasa_fuente], [152.5, 'manual']); limpiarEnv(); });

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
  delete process.env.DROPANAS_WEBHOOK_SECRET;

  out('\n== Privacidad del costo, variantes y cobertura ==');
  await t('la API pública no expone costo_usd ni IDs de DroPanas', async () => { const txt = JSON.stringify(catalogo.publico(100)); si(!/costo_usd|producto_id|bodega_origen_id/.test(txt), 'campo interno expuesto'); });
  await t('vercel.json bloquea /data, /lib y archivos internos (el costo no se sirve como estático)', async () => { const v = require(path.join(root, 'vercel.json')); const re = (v.redirects || []).map((r) => r.source); si(re.some((x) => x.includes('data') && x.includes('lib')), 'falta redirect de /data y /lib'); });
  await t('variantes: "No detallado" nunca llega como nombre', async () => { reset(); ruta(/inventario/, inv([fila(202, 3, { id: 42 })])); ruta(/productos\/202$/, { s: 200, j: { data: { tipo_producto: 'variable', variantes: [{ id: 42, color: 'No detallado', size: 'No detallado', cantidad: 3 }, { id: 43, nombre: 'Echufable' }] } } }); const i = (await call(hStock, { query: { skus: 'smartwatch-fit' } })).j.items['smartwatch-fit']; eq(i.variantes.map((v) => v.nombre), [null, 'Echufable']); });
  await t('la lámpara trae etiquetas para las variantes 1950 y 1951', async () => { const l = catalogo.publico(100).find((p) => p.sku === 'lampara-atrapazancudos'); si(l && l.variantes && l.variantes['1950'] && l.variantes['1951'] && l.variantes['1950'].nombre !== l.variantes['1951'].nombre, 'faltan variantes'); });

  console.error = origErr;
  out(`\n${ok} pruebas correctas, ${mal} con fallos.`);
  process.exit(mal ? 1 : 0);
})();
