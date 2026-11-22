# Fase 3: pedidos robustos, reseñas reales, app instalable y frontend conectado

## Archivos
| Archivo | Estado | Qué hace |
|---|---|---|
| `api/crear-orden.js` | **Reemplaza** | v2: maneja `403 CROSS_MODE`, `202 MAINTENANCE_QUEUED` (no reenvía), `429`+`Retry-After`, `503 MAINTENANCE_ACTIVE`, `422` de stock/variante/bodega; respalda todo fallo; soporta `variante_id`. **Idempotencia y `tipo_pago` sin cambios.** |
| `api/productos.js` | **Reemplaza** | Devuelve además `tasa_fuente` (`manual`, `dropanas`, `respaldo` o `null`) |
| `api/resenas.js` | **Reemplaza** (no pude leer el anterior) | Solo reseñas reales, con moderación |
| `lib/almacen.js` | Nuevo | Cliente del almacén privado (Upstash/KV) |
| `scripts/resenas-moderar.js` | Nuevo | Aprobar / rechazar / retirar reseñas desde tu computador |
| `index.html` | **Reemplaza** | Stock, variantes, tasa de respaldo, rastreo, franja de instalación; corrige la barra superior en móvil |
| `manifest.webmanifest`, `service-worker.js`, `offline.html`, `assets/icons/*` | Nuevos | App instalable |
| `tests/backend.test.js` | Reemplaza | 76 pruebas |

No se tocaron: `vercel.json`, `lib/dropanas.js`, `api/geo.js`. Requiere la fase 2 ya desplegada (`lib/cliente.js`, `errores.js`, `stock.js`, `cotizacion.js`, `respaldo.js`, `cache.js`, `api/stock.js`, `api/rastreo.js`): confirmado en tu despliegue.

## Antes de subir
Guarda una copia de tus `api/crear-orden.js`, `api/resenas.js` e `index.html` actuales (por si quieres comparar). Sube TODO junto en un solo commit.

## Variables de entorno (Vercel → Settings → Environment Variables)
| Variable | Para qué | Obligatoria |
|---|---|---|
| `DROPANAS_API_KEY` | Llave de DroPanas (`test_sk_…` o `live_sk_…`) | Sí |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` (o `UPSTASH_REDIS_REST_URL` + `_TOKEN`) | Almacén para **reseñas** y **respaldo de pedidos**. Vercel → Storage → Upstash Redis → conectar al proyecto → redesplegar | Para reseñas y respaldo completo |
| `TASA_BS_RESPALDO` | Tasa Bs/USD que TÚ pones por si DroPanas no da una en vivo. El sitio avisa que es aproximada | Recomendada |
| `TASA_BS` | Tasa manual que tiene prioridad sobre la de DroPanas | No |
| `COD_REQUIERE_APROBACION=1` | Retiene también los pedidos Contra Entrega hasta que los apruebes (defensa contra pedidos falsos) | Recomendada |

## Reseñas
- `GET /api/resenas?sku=…` → solo aprobadas. `POST` → queda **pendiente**; no se publica sola.
- Moderar: `KV_REST_API_URL=… KV_REST_API_TOKEN=… node scripts/resenas-moderar.js listar | aprobar <id> | rechazar <id> | quitar <id>`.
- Antispam: sin enlaces, 3 por hora por IP, campo trampa, texto sin HTML. No hay ni habrá reseñas inventadas.
- Falta (frontend): mostrar las reseñas y el formulario en la ficha (esta fase no lo pidió).

## App instalable
Aviso "Descarga la app de Nexovia": en escritorio solo aparece si el navegador permite instalar; en móvil muestra la guía (iPhone: Compartir → Añadir a pantalla de inicio). Se cierra con × y no vuelve por 14 días.
El service worker NUNCA cachea `/api/*`. Para forzar actualización de lo guardado, cambia `VERSION` en `service-worker.js`.

## Límites conocidos
- Probado con DroPanas simulado y navegador real; hace falta una prueba de pedido en sandbox con tu llave.
- Productos sin `producto_id`/`bodega_origen_id` reales salen como "Próximamente" y no se pueden comprar.
- Pago anticipado sigue en "Próximamente" hasta que completes `CONFIG.PAGOS` en `index.html`.
- La franja de instalación en escritorio queda sobre la barra superior (centro); en móvil es una franja que empuja el contenido.
