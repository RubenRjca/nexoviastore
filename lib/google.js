'use strict';
// Verifica el ID token de "Iniciar sesión con Google" (JWT RS256) sin librerías:
// firma con las claves públicas de Google (JWKS), emisor, audiencia (tu GOOGLE_CLIENT_ID), vigencia y correo verificado.
const crypto = require('crypto');

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let cacheKeys = { claves: null, hasta: 0 };
async function jwksPorDefecto() {
  if (cacheKeys.claves && cacheKeys.hasta > Date.now()) return cacheKeys.claves;
  const r = await fetch(JWKS_URL, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error('jwks ' + r.status);
  const j = await r.json(); cacheKeys = { claves: j.keys || [], hasta: Date.now() + 60 * 60 * 1000 };
  return cacheKeys.claves;
}
const parte = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Devuelve { sub, email, nombre, nombres, apellidos, foto } o null si el token no es válido.
async function verificarCredencial(token, clientId, { jwks = jwksPorDefecto, ahora = () => Math.floor(Date.now() / 1000) } = {}) {
  try {
    if (!clientId || typeof token !== 'string' || token.length > 4096) return null;
    const p = token.split('.'); if (p.length !== 3) return null;
    const h = parte(p[0]), c = parte(p[1]);
    if (h.alg !== 'RS256' || !h.kid) return null;
    const jwk = (await jwks()).find((k) => k.kid === h.kid); if (!jwk) return null;
    const ok = crypto.verify('RSA-SHA256', Buffer.from(p[0] + '.' + p[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(p[2], 'base64url'));
    if (!ok) return null;
    if (c.iss !== 'https://accounts.google.com' && c.iss !== 'accounts.google.com') return null;
    if (c.aud !== clientId) return null;
    if (!(c.exp > ahora() - 60) || (c.iat && c.iat > ahora() + 300)) return null;
    if (!c.sub || !c.email || c.email_verified !== true) return null;
    return { sub: String(c.sub), email: String(c.email), nombre: String(c.name || '').slice(0, 80), nombres: String(c.given_name || '').slice(0, 50), apellidos: String(c.family_name || '').slice(0, 50), foto: /^https:\/\//.test(c.picture || '') ? c.picture : '' };
  } catch (e) { return null; }
}
module.exports = { verificarCredencial };
