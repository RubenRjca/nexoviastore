# Auditoría de seguridad: hallazgos y estado

| # | Hallazgo | Riesgo | Estado |
|---|---|---|---|
| 1 | La referencia del pedido (`external_reference`) la elegía el navegador y era predecible: un atacante podía "reservarla" y hacer que el pedido de otro cliente se diera por duplicado y no se creara | Alto | **Corregido**: la fabrica el servidor desde un UUID aleatorio |
| 2 | `sku` como `__proto__` / `constructor` alcanzaba objetos internos | Bajo | **Corregido**: el catálogo usa `Map` |
| 3 | Texto libre (dirección, referencia, nota) podía llevar `<script>`/HTML hacia tu panel de DroPanas | Medio | **Corregido**: se eliminan `<`, `>` y caracteres de control |
| 4 | Pedidos Contra Entrega falsos (spam) generan fletes perdidos | Alto (negocio) | **Mitigado**: límite por IP, honeypot, validación. Activa `COD_REQUIERE_APROBACION=1` para confirmar cada pedido |
| 5 | Rutas aceptaban llamadas de otros sitios | Medio | **Corregido**: se exige `Sec-Fetch-Site: same-origin` y `Origin` propio |
| 6 | Faltaban cabeceras (CSP, Permissions-Policy, COOP) | Medio | **Corregido** en `vercel.json` (CSP con `unsafe-inline` por los scripts embebidos) |
| 7 | Teléfono: el `pattern` HTML era inválido en Chrome moderno | Bajo (error) | **Corregido** |
| 8 | Descuento de oferta: el precio cobrado sale siempre del servidor (`precioVigente`) | — | Verificado |
| 9 | El límite por IP vive en memoria de cada instancia: un atacante decidido puede esquivarlo | Medio | **Pendiente (tuyo)**: regla de Rate Limit en Vercel Firewall para `/api/crear-orden` y `/api/asistente`, o Turnstile/BotID |
| 10 | El asistente con IA consume saldo de Anthropic si lo abusan | Medio | **Pendiente (tuyo)**: define un límite mensual de gasto en tu cuenta de Anthropic |
| 11 | `lib/catalogo.js` y `data/catalogo.json` se pueden leer como archivos estáticos (solo hay precios públicos e IDs; ninguna llave) | Bajo | Aceptado |
| 12 | Referencias de pago anticipado falsas o repetidas | Medio | Por diseño el pedido queda retenido: verifica cada referencia en tu banco antes de aprobar |

## Higiene de llaves
- Nunca subas `.env` (ya está en `.gitignore`). Activa **Push protection / secret scanning** en GitHub.
- Si una llave llegó a pegarse en un chat, archivo o commit: **revócala y genera otra** en DroPanas.
- Las llaves duran 365 días; programa rotarlas. Activa 2FA en GitHub, Vercel y DroPanas.
