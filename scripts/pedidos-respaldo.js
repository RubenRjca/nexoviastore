#!/usr/bin/env node
'use strict';
// Lista los pedidos respaldados (rechazados, en cola o con error de red) para recuperarlos a mano. Se corre en TU computador:
//   KV_REST_API_URL=... KV_REST_API_TOKEN=... node scripts/pedidos-respaldo.js [--completo] [--n 50]
// Por defecto el teléfono sale enmascarado y sin dirección; --completo muestra todo (datos personales: úsalo con cuidado).
const { recientes, enmascarar } = require('../lib/respaldo');
const completo = process.argv.includes('--completo');
const i = process.argv.indexOf('--n'), n = i > 0 ? Number(process.argv[i + 1]) || 50 : 50;
recientes(n).then((l) => {
  if (!l.length) return console.log('Sin registros (o falta KV_REST_API_URL / KV_REST_API_TOKEN).');
  for (const r of l) {
    console.log(`${r.ts}  ${r.tipo.toUpperCase().padEnd(9)} ${r.ref}  ${r.sku} x${r.cantidad}  ${r.metodo_pago}  http=${r.http} code=${r.code || '-'}${r.solicitud_id ? ' cola#' + r.solicitud_id : ''}`);
    if (completo && r.cliente) console.log(`    ${r.cliente.nombre} ${r.cliente.apellido} · ${r.cliente.telefono} · ${r.direccion && r.direccion.direccion} (estado ${r.direccion && r.direccion.state_id}, ciudad ${r.direccion && r.direccion.city_id})${r.pago ? ' · pago ' + JSON.stringify(r.pago) : ''}`);
    else if (r.cliente) console.log(`    tel ${enmascarar(r.cliente.telefono)}`);
  }
  console.log(`\n${l.length} registro(s). Se conservan 30 días.`);
});
