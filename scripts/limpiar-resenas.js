#!/usr/bin/env node
'use strict';
// Quita TODAS las reseñas sembradas (inventadas) de data/catalogo.json. Las reseñas reales viven solo en /api/resenas.
//   node scripts/limpiar-resenas.js --dry     (solo muestra qué quitaría)
//   node scripts/limpiar-resenas.js           (aplica; deja "resenas": [] en cada producto)
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'data', 'catalogo.json');
const dry = process.argv.includes('--dry');
const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let n = 0;
for (const p of d.productos) { const k = Array.isArray(p.resenas) ? p.resenas.length : 0; if (k) { n += k; console.log(`- ${p.sku}: ${k} reseña(s) sembrada(s)`); } if (!dry) p.resenas = []; }
if (!dry) fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n');
console.log(dry ? `\n(simulación) se quitarían ${n} reseñas.` : `\nListo: ${n} reseñas sembradas eliminadas de data/catalogo.json.`);
