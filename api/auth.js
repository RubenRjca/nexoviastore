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

const publico = (u, g) => ({ nombre: u.nombre || '', nombres: u.nombres || '', apellidos: u.apellidos || '', email: u.email || '', foto: (g && g.foto_v) ? '/api/auth?accion=foto&v=' + g.foto_v : (u.foto || ''), foto_propia: !!(g && g.foto_v) });
const FOTO_MAX = 120 * 1024; // bytes ya decodificados; el navegador envía ~320 px en JPEG (≈ 30 KB)
const limpiarTxt = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

module.exports = async (req, res, deps = {}) => {
  res.setHeader('Cache-Control', 'no-store');
  const accion = String((req.query && req.query.accion) || '');
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const habilitado = !!(clientId && sesion.configurado());
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return res.status(403).json({ message: 'Origen no permitido.' });

  if (req.method === 'GET' && accion === 'yo') {
    const s = sesion.leer(req); let perfil = null, g = null;
    if (s && configurado()) { try { g = await usuarios.obtenerUsuario(s.sub); perfil = (g && g.perfil) || null; } catch (e) { /* sin perfil guardado */ } }
    return res.status(200).json({ ok: true, usuario: s ? publico(s, g) : null, perfil, requiere_cuenta: process.env.REQUIERE_CUENTA === '1' && habilitado,
      google_client_id: habilitado ? clientId : null, mis_pedidos: configurado() });
  }
  if (req.method === 'GET' && accion === 'foto') { // la foto propia solo la ve su dueño (la identifica la cookie de sesión)
    const s = sesion.leer(req); if (!s) return res.status(401).json({ message: 'Inicia sesión.' });
    let b64 = null; try { b64 = await usuarios.obtenerFoto(s.sub); } catch (e) { /* sin foto */ }
    if (!b64) return res.status(404).json({ message: 'Sin foto.' });
    res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.status(200).send(Buffer.from(b64, 'base64'));
  }
  if (req.method !== 'POST') return res.status(405).json({ message: 'Método no permitido.' });
  try { const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) return res.status(403).json({ message: 'Origen no permitido.' }); }
  catch (e) { return res.status(403).json({ message: 'Origen no permitido.' }); }
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (limitar('auth:' + ip, 20, 60 * 1000)) { res.setHeader('Retry-After', '30'); return res.status(429).json({ message: 'Demasiados intentos. Espera un momento.' }); }

  if (accion === 'salir') { sesion.borrar(req, res); return res.status(200).json({ ok: true }); }
  if (accion === 'foto' || accion === 'foto-quitar' || accion === 'perfil') { // acciones de la cuenta: exigen sesión y almacén
    const s = sesion.leer(req); if (!s) return res.status(401).json({ ok: false, code: 'LOGIN_REQUERIDO', message: 'Inicia sesión.' });
    if (!configurado()) return res.status(503).json({ message: 'Esta función aún no está disponible.' });
    try {
      if (accion === 'foto-quitar') { await usuarios.guardarFoto(s.sub, null); return res.status(200).json({ ok: true, foto: s.foto || '', foto_propia: false }); }
      if (accion === 'foto') {
        const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.imagen) || ''));
        const buf = m ? Buffer.from(m[1], 'base64') : null;
        if (!buf || buf.length < 200 || buf.length > FOTO_MAX || !(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return res.status(400).json({ message: 'La imagen no es válida. Usa una foto JPG, PNG o WebP.' });
        await usuarios.guardarFoto(s.sub, buf.toString('base64'));
        const g = await usuarios.obtenerUsuario(s.sub); return res.status(200).json({ ok: true, foto: '/api/auth?accion=foto&v=' + g.foto_v, foto_propia: true });
      }
      // perfil: datos que se rellenan solos en la próxima compra
      const b = req.body || {}, nombre = limpiarTxt(b.nombre, 60), apellido = limpiarTxt(b.apellido, 60), telefono = limpiarTxt(b.telefono, 20), direccion = limpiarTxt(b.direccion, 250);
      if (nombre.length < 2 || apellido.length < 2) return res.status(400).json({ message: 'Escribe tu nombre y apellido.' });
      if (telefono && !/^[0-9+\s\-()]{10,20}$/.test(telefono)) return res.status(400).json({ message: 'El teléfono no es válido.' });
      if (direccion && direccion.length < 8) return res.status(400).json({ message: 'La dirección es muy corta.' });
      const g = (await usuarios.obtenerUsuario(s.sub)) || {}; const perfil = { ...(g.perfil || {}), nombre, apellido, telefono, direccion };
      await usuarios.guardarPerfil(s.sub, perfil); return res.status(200).json({ ok: true, perfil });
    } catch (e) { return res.status(503).json({ message: 'No pudimos guardar. Inténtalo de nuevo en un momento.' }); }
  }
  if (accion === 'google') {
    if (!habilitado) return res.status(503).json({ message: 'El inicio de sesión no está disponible por ahora.' });
    const cred = req.body && req.body.credential;
    const u = await verificarCredencial(cred, clientId, deps.opciones);
    if (!u) return res.status(401).json({ message: 'No pudimos verificar tu cuenta de Google. Inténtalo de nuevo.' });
    if (!sesion.poner(req, res, { sub: u.sub, email: u.email, nombre: u.nombre, nombres: u.nombres, apellidos: u.apellidos, foto: u.foto })) return res.status(503).json({ message: 'El inicio de sesión no está disponible por ahora.' });
    let perfil = null;
    try { await usuarios.guardarUsuario(u); const g = await usuarios.obtenerUsuario(u.sub); perfil = (g && g.perfil) || null; } catch (e) { console.error(JSON.stringify({ nivel: 'AVISO', code: 'USUARIO_NO_GUARDADO' })); }
    return res.status(200).json({ ok: true, usuario: publico(u, await usuarios.obtenerUsuario(u.sub).catch(() => null)), perfil });
  }
  return res.status(400).json({ message: 'Acción no válida.' });
};
