# Pedido de prueba de punta a punta

## Antes de empezar
- [ ] `DROPANAS_API_KEY` en Vercel: `test_sk_…` (sandbox) para ensayar, `live_sk_…` solo en Production para vender.
- [ ] `COD_REQUIERE_APROBACION=1` en Production (cada pedido queda retenido hasta que lo apruebes en DroPanas).
- [ ] `data/catalogo.json`: producto con `producto_id`, `bodega_origen_id` (lámpara: 21692 / bodega 1) y `estado: publicado`.
- [ ] `npm run validar:produccion` → 0 errores. `node tests/backend.test.js` → todo en verde.
- [ ] Opcional: Upstash conectado (reseñas, webhook, respaldo de pedidos) y `DROPANAS_WEBHOOK_SECRET` + URL `/api/webhook` registrada en DroPanas.

## Pasos
1. Abrir el sitio → "Ver ficha" → "Ver detalles completos" → "Comprar ahora".
2. **Variantes:** el selector debe decir "Modelo 1 · Enchufable (USB)" y "Modelo 2 · Recargable con pila" (nunca "No detallado"). Elige una.
3. Completa tus datos, estado y ciudad con cobertura, y envía (Contra Entrega).
4. En DroPanas abre el pedido y **verifica**: la variante elegida (ID 1950 = Enchufable, 1951 = Recargable; si están cruzados, avísame), la bodega, el monto con recaudo y la referencia `NX…`.
5. Aprueba o cancela el pedido en DroPanas. Prueba el rastreo en el sitio (referencia + últimos 4 dígitos del teléfono).
6. Revisa DroPanas → API REST → Logs (respuestas 2xx) y los logs de Vercel (sin ALERTA).
7. Comparte el enlace por WhatsApp: debe verse la imagen "Ahora puedes comprar contra entrega" (WhatsApp guarda caché; usa el depurador de Facebook para refrescar).
