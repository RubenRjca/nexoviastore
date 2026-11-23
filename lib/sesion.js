'use strict';
// Sesión SIN base de datos: cookie firmada con HMAC-SHA256 (HttpOnly, Secure, SameSite=Lax, 30 días).
// Variable: SESSION_SECRET (texto aleatorio de 32+ caracteres). Sin ella no se puede iniciar sesión (nunca se firma con un valor por defecto).
const crypto = require('crypto');

const NOMBRE = 'nx_sesion';
const DIAS = 30;
const secreto = () => { const s = process.env.SESSION_SECRET; return s && s.length >= 32 ? s : null; };
const b64 = (b) => Buffer.from(b).toString('base64url');
const mac = (txt, s) => crypto.createHmac('sha256', s).update(txt).digest('base64url');

function firmar(datos, ttlSeg = DIAS * 86400) {
  const s = secreto(); if (!s) return null;
  const cuerpo = b64(JSON.stringify({ ...datos, exp: Math.floor(Date.now() / 1000) + ttlSeg }));
  return cuerpo + '.' + mac(cuerpo, s);
}
function verificar(token) {
  const s = secreto(); if (!s || typeof token !== 'string') return null;
  const i = token.indexOf('.'); if (i < 1) return null;
  const cuerpo = token.slice(0, i), firma = token.slice(i + 1);
  const a = Buffer.from(mac(cuerpo, s)), b = Buffer.from(firma);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8')); return d && d.exp > Date.now() / 1000 && d.sub ? d : null; } catch (e) { return null; }
}
function leer(req) {
  const c = String((req.headers && req.headers.cookie) || '');
  for (const par of c.split(';')) { const [k, ...v] = par.trim().split('='); if (k === NOMBRE) return verificar(v.join('=')); }
  return null;
}
const atributos = (req) => { const local = /^(localhost|127\.)/.test(String((req.headers && req.headers.host) || '')); return 'Path=/; HttpOnly; SameSite=Lax' + (local ? '' : '; Secure'); };
function poner(req, res, datos) {
  const t = firmar(datos); if (!t) return false;
  res.setHeader('Set-Cookie', `${NOMBRE}=${t}; ${atributos(req)}; Max-Age=${DIAS * 86400}`); return true;
}
function borrar(req, res) { res.setHeader('Set-Cookie', `${NOMBRE}=; ${atributos(req)}; Max-Age=0`); }

module.exports = { firmar, verificar, leer, poner, borrar, configurado: () => !!secreto() };
