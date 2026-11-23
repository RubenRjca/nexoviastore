'use strict';
// Cuentas con Google.   GET  /api/auth?accion=yo      → quién soy + configuración pública (client id, si se exige cuenta)
//                       POST /api/auth?accion=google  → { credential } (ID token de Google) → crea la cookie de sesión
//                       POST /api/auth?accion=salir   → cierra la sesión
// Variables: GOOGLE_CLIENT_ID (público), SESSION_SECRET (32+ caracteres), REQUIERE_CUENTA=1 (opcional: exige sesión para comprar).
const sesion = require('../lib/sesion');
const { verificarCredencial } = require('../lib/google');
const usuarios = require('../lib/usuarios');
const { configurado } = require('../lib/almacen');
const { limitar } = require('../lib/cache');

const publico = (u) => ({ nombre: u.nombre || '', nombres: u.nombres || '', apellidos: u.apellidos || '', email: u.email || '', foto: u.foto || '' });

module.exports = async (req, res, deps = {}) => {
  res.setHeader('Cache-Control', 'no-store');
  const accion = String((req.query && req.query.accion) || '');
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const habilitado = !!(clientId && sesion.configurado());
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return res.status(403).json({ message: 'Origen no permitido.' });

  if (req.method === 'GET' && accion === 'yo') {
    const s = sesion.leer(req); let perfil = null;
    if (s && configurado()) { try { const u = await usuarios.obtenerUsuario(s.sub); perfil = (u && u.perfil) || null; } catch (e) { /* sin perfil guardado */ } }
    return res.status(200).json({ ok: true, usuario: s ? publico(s) : null, perfil, requiere_cuenta: process.env.REQUIERE_CUENTA === '1' && habilitado,
      google_client_id: habilitado ? clientId : null, mis_pedidos: configurado() });
  }
  if (req.method !== 'POST') return res.status(405).json({ message: 'Método no permitido.' });
  try { const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) return res.status(403).json({ message: 'Origen no permitido.' }); }
  catch (e) { return res.status(403).json({ message: 'Origen no permitido.' }); }
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (limitar('auth:' + ip, 20, 60 * 1000)) { res.setHeader('Retry-After', '30'); return res.status(429).json({ message: 'Demasiados intentos. Espera un momento.' }); }

  if (accion === 'salir') { sesion.borrar(req, res); return res.status(200).json({ ok: true }); }
  if (accion === 'google') {
    if (!habilitado) return res.status(503).json({ message: 'El inicio de sesión no está disponible por ahora.' });
    const cred = req.body && req.body.credential;
    const u = await verificarCredencial(cred, clientId, deps.opciones);
    if (!u) return res.status(401).json({ message: 'No pudimos verificar tu cuenta de Google. Inténtalo de nuevo.' });
    if (!sesion.poner(req, res, { sub: u.sub, email: u.email, nombre: u.nombre, nombres: u.nombres, apellidos: u.apellidos, foto: u.foto })) return res.status(503).json({ message: 'El inicio de sesión no está disponible por ahora.' });
    let perfil = null;
    try { await usuarios.guardarUsuario(u); const g = await usuarios.obtenerUsuario(u.sub); perfil = (g && g.perfil) || null; } catch (e) { console.error(JSON.stringify({ nivel: 'AVISO', code: 'USUARIO_NO_GUARDADO' })); }
    return res.status(200).json({ ok: true, usuario: publico(u), perfil });
  }
  return res.status(400).json({ message: 'Acción no válida.' });
};
