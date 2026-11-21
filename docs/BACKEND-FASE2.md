# Backend fase 2: stock real, rastreo, respaldo y manejo de códigos de DroPanas

## Qué se agregó (todo NUEVO salvo `lib/catalogo.js`)
| Archivo | Para qué |
|---|---|
| `api/stock.js` | `GET /api/stock?skus=a,b` → disponibilidad pública (variantes incluidas, cantidades topadas en 10) |
| `api/rastreo.js` | `GET /api/rastreo?ref=NX…&tel=1234` → estado y tracking del pedido (sin datos personales) |
| `lib/cache.js` | Caché de éxitos y de **fallos**, una sola llamada a la vez, dato obsoleto si DroPanas falla, límites por clave |
| `lib/cliente.js` | Envoltura de `lib/dropanas.js` (sin tocarlo): no lanza excepciones y **pausa todas las llamadas tras un 429 hasta que pase `Retry-After`** |
| `lib/errores.js` | Clasifica cada código de DroPanas → HTTP, mensaje seguro para el cliente y ALERTA en logs si es un problema de configuración |
| `lib/stock.js` | Existencias reales por producto y variante (`/productos/{id}` + `/bodegas/{id}/inventario`) y `puedeComprar()` |
| `lib/cotizacion.js` | Cobertura por ruta con caché, conservando el motivo del fallo |
| `lib/respaldo.js` | Respaldo privado de pedidos fallidos / en cola (Upstash o Vercel KV por REST) |
| `lib/catalogo.js` | **Modificado**: `publico()` ya no expone reseñas del catálogo (siempre `[]`) |
| `scripts/limpiar-resenas.js` | Borra las reseñas sembradas de `data/catalogo.json` (`--dry` para simular) |
| `scripts/pedidos-respaldo.js` | Lista los pedidos respaldados (teléfono enmascarado salvo `--completo`) |
| `tests/backend.test.js` | 65 pruebas con DroPanas y almacén simulados: `node tests/backend.test.js` |

No se tocaron `vercel.json`, `lib/dropanas.js`, `api/crear-orden.js`, `api/geo.js` ni `api/resenas.js`.

## Variables de entorno (opcionales)
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` (o `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`): activan el respaldo con detalle completo.
  Sin ellas el respaldo solo deja el log enmascarado y avisa `guardado:false`. Se crean con Vercel → Storage → Upstash Redis.

## Lo que NO se puede activar sin tocar `api/crear-orden.js`
El manejo explícito de 202/403/422/503 al **crear** pedidos y el respaldo de rechazos viven dentro de ese archivo.
La versión lista y probada está en `propuestas/crear-orden.propuesta.js` (+ `crear-orden.diff`). Para activarla:
copiarla sobre `api/crear-orden.js`. Mientras tanto, `crear-orden` actual sigue funcionando igual que hoy.

## Límites conocidos
- Cachés y límites por IP viven en la memoria de cada instancia serverless (suficiente para poco tráfico; con más, usar Upstash/Firewall).
- `lib/dropanas.js` (protegido) no expone las cabeceras `X-RateLimit-*`; la protección reacciona al 429 y a `Retry-After`.
- Formato real de `variante` en el inventario: la documentación solo muestra `null`; el código acepta objeto o número. Verificar en sandbox.
- Probado solo con respuestas simuladas según la documentación.
