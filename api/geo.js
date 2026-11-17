'use strict';
// GET /api/geo            -> estados con cobertura de envío a domicilio
// GET /api/geo?estado=ID  -> ciudades de ese estado con cobertura
const { dp } = require('../lib/dropanas');

module.exports = async (req, res) => {
  const estado = req.query.estado;
  if (estado && !/^\d+$/.test(estado)) return res.status(400).json({ message: 'Estado inválido.' });
  try {
    const r = await dp(estado ? `/geo/estados/${estado}/ciudades` : '/geo/estados');
    if (!r.ok) return res.status(502).json({ message: 'No se pudo cargar la ubicación.' });
    const data = (r.j.data || []).filter((x) => x.cobertura_domicilio);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json({ data });
  } catch (e) {
    return res.status(e.config ? 500 : 502).json({ message: 'Servicio no disponible.' });
  }
};
