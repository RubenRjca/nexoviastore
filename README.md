# Nexovia Store

Tienda de gadgets para Venezuela con **Pago Contra Entrega** y **Pago Directo Anticipado**, integrada con DroPanas.
Sitio estático + funciones serverless de Vercel. No requiere build.

```
index.html            Diseño: banner, categorías, producto de la semana, catálogo, comparador, ficha, checkout (2 pagos), asistente, footer, Open Graph
data/catalogo.json    TODOS los productos (textos, precios, ofertas, estado publicado/borrador, IDs de DroPanas)
scripts/catalogo.js   sugerir (ranking de DroPanas) · agregar (borrador) · validar
docs/FLUJO.md        Flujo GitHub ↔ Vercel ↔ Gemini ↔ Claude · docs/SEGURIDAD.md  Auditoría
.github/workflows/    Validación automática en cada subida
og-image.jpg          Imagen para vistas previas en WhatsApp/Instagram (1200×630)
assets/               Isotipo y foto del banner
lib/catalogo.js       Lee data/catalogo.json (solo productos "publicado")
lib/dropanas.js       Cliente de la API (cotizar envío, stock, tasa) con caché
api/crear-orden.js    Crea el pedido: valida, protege la llave, idempotencia, cobertura y stock
api/productos.js      Catálogo público + tasa Bs
api/geo.js            Estados y ciudades con cobertura (IDs de DroPanas)
api/asistente.js      Asistente de ventas con IA (opcional)
```

## Despliegue
1. Sube esta carpeta a GitHub (`.env*` ya está en `.gitignore`).
2. En Vercel: **Add New → Project** → importa el repo (Framework: *Other*, sin build).
3. **Settings → Environment Variables**: crea `DROPANAS_API_KEY` con tu llave `test_sk_…` (ver `.env.example`).
4. Despliega y haz un pedido de prueba. En sandbox solo despacha Pídelo y Punto (domicilio), que es lo que usa esta tienda.
5. Cuando todo funcione, cambia la variable a `live_sk_…` y vuelve a desplegar.

## Antes de vender (pendiente de tu lado)
- **`data/catalogo.json`**: reemplaza los 6 productos de ejemplo y completa `producto_id`, `bodega_origen_id` y `precio_venta_usd`
  (`GET /api/v1/productos` y `/bodegas`). Con `null`, el pedido se rechaza a propósito.
- **`index.html` → `CONFIG.PAGOS`**: escribe los datos de Pago Móvil, Zelle, Ávila Pay y transferencia que aceptes.
  Los métodos sin datos no se ofrecen. Sin ninguno, "Pago Directo Anticipado" aparece como "Próximamente".
- **`CONFIG.WHATSAPP`** (botón del asistente) y los enlaces de Facebook, TikTok y WhatsApp del footer (`TODO`).
- **Dominio**: cambia `www.nexovia.store` por el tuyo en `canonical` y `og:*` del `<head>`.
- Páginas legales (términos, privacidad, devoluciones) y el carrito/cuenta/favoritos del header (hoy solo visuales).

## Cómo funciona la seguridad
- La llave `DROPANAS_API_KEY` solo existe en el servidor. El navegador envía el `sku` y la cantidad; precio, producto y bodega se leen de `lib/catalogo.js`.
- **Sin duplicados**: cada pedido lleva `external_reference` + `Idempotency-Key` (UUID v4). Los reintentos reutilizan ambos; si el formulario cambia, se genera una llave nueva.
- **Cobertura**: antes de crear el pedido se consulta `cotizar-envio` (domicilio disponible y, en contra entrega, que soporte recaudo).
- **Stock**: se consulta el inventario de la bodega (mejor esfuerzo). La validación definitiva es la de DroPanas (`SIN_STOCK_EN_BODEGA`), que también se traduce a un mensaje claro.
- Límite por IP, campo trampa anti-bots, validación de origen y detalles técnicos solo en los logs de Vercel (nunca al cliente).

## Pago anticipado
Se crea con `tipo_pago: "sin_recaudo"` y `requiere_aprobacion: true`: el pedido queda **retenido** (sin guía, sin descontar stock y sin cobrar a tu wallet)
hasta que verifiques el pago (el método y la referencia van en la nota del pedido) y lo apruebes en tu panel de DroPanas.
Al aprobarlo, DroPanas debita tu wallet: mantén saldo disponible.

## Asistente de ventas
Botón flotante con respuestas rápidas gratuitas. Con `ANTHROPIC_API_KEY`, el texto libre lo responde un asistente de IA (`api/asistente.js`) que solo conoce los datos de la tienda;
cada mensaje se factura a tu cuenta de Anthropic. Para usar otro bot (p. ej. LucidBot), cambia `CONFIG.API_ASISTENTE`.
