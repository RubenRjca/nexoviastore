# SKILL / REGLAS MAESTRAS DEL PROYECTO: NEXOVIA STORE

## 1. Arquitectura y Protección Crítica (NO ROMPER)
- **Stack:** Sitio estático (`index.html`) + Funciones Serverless de Vercel (`/api/*.js`) conectadas a la API de DroPanas.
- **Archivos Intocables:** NO borres, renombres ni cambies la firma de `vercel.json`, `lib/dropanas.js`, `api/crear-orden.js` ni `api/geo.js`. Ya están probados en producción sobre Vercel (`https://nexoviastore-kappa.vercel.app/`).
- **Seguridad:** Nunca expongas `DROPANAS_API_KEY` en el frontend (`index.html` o JS del cliente). Toda comunicación con DroPanas debe pasar exclusivamente por `/api/*` usando `process.env.DROPANAS_API_KEY` y manteniendo la validación de datos e idempotencia (`Idempotency-Key`) en las órdenes.
- **Rutas de Imágenes:** Todas las imágenes locales residen en `/assets/` (ej. `assets/isotipo.png`, `assets/hero-cargador.jpg`). Usa rutas relativas limpias (`assets/...`).

## 2. Reglas de Negocio y Logística (Venezuela / DroPanas)
- **Moneda:** Muestra precios en USD y su equivalente calculado en Bolívares (Bs).
- **Métodos de Pago:**
  1. *Pago Contra Entrega* (cobrando al recibir en domicilio según cobertura de `api/geo.js`).
  2. *Pago Directo Anticipado* (Pago Móvil, Zelle, etc., sujeto a verificación).
- **Rastreo de Pedidos:** NO inventes rastreadores falsos ni estados simulados. Si no hay un endpoint real conectado en `/api/`, ofrece consulta rápida vía WhatsApp con número de orden prellenado y muestra tiempos estimados claros de entrega según cobertura.

## 3. Estándar de Cada Producto en el Catálogo (`lib/catalogo.js`)
Cada producto agregado o editado debe incluir estructura completa para alta conversión:
- `sku`, `titulo`, `precio_venta_usd`, `producto_id` (ID real de DroPanas), `bodega_origen_id` (ID real de bodega).
- `imagenes`: array de rutas o URLs válidas + `video` opcional.
- `descripcion`: explicación clara y vendedora orientada al comprador en Venezuela.
- `por_que_comprarlo`: propuesta de valor directa (el problema que resuelve).
- `ventajas`: lista de 3 a 5 beneficios concretos.
- `resenas`: 2 a 3 reseñas breves y realistas de clientes.

## 4. Diseño e Identidad Visual
- **Paleta:** Azul petróleo (`#2C5D76`), coral (`#ED7F61`), fondos blancos/claros limpios y pie de página oscuro.
- **Secciones Obligatorias:**
  - Hero principal con propuesta de Pago Contra Entrega.
  - Sección **Producto de la Semana** destacada.
  - **Comparador de Productos** interactivo (contrastando precio, ventajas y uso).
  - Cuadrícula de productos con apertura de ficha detallada (descripción, por qué comprarlo, ventajas, reseñas y botón de compra).
  - Carrito lateral con opción de cantidad y descuento por llevar 2+ unidades.
