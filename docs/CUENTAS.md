# Cuentas con Google, Mis pedidos y precio con envío

## Qué hace
- Inicio de sesión con Google (sin contraseñas). Sesión en cookie firmada `nx_sesion` (30 días).
- «Historial de compras»: código NX destacado, estado automático ligado a la cuenta; el rastreo manual (NX + 4 dígitos) sigue disponible.
- **Precio final único**: el cliente ve y paga solo el `precio_venta_usd` del catálogo (envío incluido, sin desglose). Ese mismo precio se envía a DroPanas. El flete cotizado se usa solo en el servidor para el margen y nunca se muestra ni se devuelve al navegador.
- Alerta en logs `MARGEN_BAJO` si la ganancia estimada (precio final − costo − envío cotizado − comisión) < `MARGEN_MIN_USD` (no bloquea la venta). Lámpara a US$ 29: ganancia ≈ 9,01 (envío 4,50) a 6,61 (envío 6,90).
- Variantes estrictas (1950 y 1951) y log `ORDEN_CREADA` con la variante enviada.
- Respaldo en Upstash de cada pedido; el rastreo funciona aunque DroPanas aún no confirme el pedido.

## Google Cloud Console (una vez)
1. APIs y servicios → Credenciales → Crear credenciales → **ID de cliente de OAuth** → tipo **Aplicación web**.
2. Orígenes JavaScript autorizados: `https://nexoviastore-kappa.vercel.app` (y tu dominio propio si lo tienes). No hace falta URI de redireccionamiento ni *client secret*.
3. Pantalla de consentimiento: publícala en **Producción** (si no, solo entran usuarios de prueba).
4. Copia el ID de cliente a Vercel como `GOOGLE_CLIENT_ID`.

## Variables en Vercel
| Variable | Valor |
|---|---|
| `DROPANAS_API_KEY` | Llave real o sandbox (`live_sk_…` / `test_sk_…`) |
| `DROPANAS_WEBHOOK_SECRET` | Secreto HMAC del webhook (`/api/webhook`) |
| `GOOGLE_CLIENT_ID` | ID de cliente web de Google |
| `SESSION_SECRET` | ≥ 32 caracteres aleatorios |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash (historial, reseñas, respaldo y webhook) |
| `REQUIERE_CUENTA` | `1` en producción (exige Google) o `0` (compra libre) |
| `COD_REQUIERE_APROBACION` | `1` (retiene contra entrega para aprobar tras confirmar) |
| `MARGEN_MIN_USD` | `5` (alerta `MARGEN_BAJO` en logs si baja de este mínimo) |
| `COMISION_USD` | `0.5` (confirma con DroPanas si es fija o porcentaje) |
| `WHATSAPP_TIENDA` | `584245474761` (solo dígitos; sin variable usa este por defecto) |
| `GEMINI_API_KEY` | Opcional para `/api/chat` (sin ella usa respaldo local) |

Tras cambiar variables, haz **Redeploy**.

## Cómo activar la cuenta obligatoria
1. Entra desde tu celular en Chrome/Safari, toca **Ingresar** y verifica que Google te deja entrar y que ves «Historial de compras».
2. Haz un pedido de prueba y comprueba que aparece en «Historial de compras» con su **código de compra** (`NX…`).
3. Pon `REQUIERE_CUENTA=1` y `COD_REQUIERE_APROBACION=1` en Vercel y haz **Redeploy**.

Dentro de Instagram, TikTok o WhatsApp Google bloquea el inicio de sesión: la tienda detecta esos navegadores y pide abrir el enlace en Chrome o Safari.

## Claves en Upstash
`nx:u:{sub}` perfil · `nx:uf:{sub}` foto propia · `nx:uo:{sub}` pedidos del usuario (ZSET) · `nx:o:{ref}` pedido (400 días) · `nx:wh:{ref}` último evento del webhook · `nx:pedido:{ref}` respaldo de fallos/cola.

## Qué verificar tras el primer pedido
- En DroPanas, la variante del pedido (1950 Enchufable / 1951 Recargable). Si salen cruzadas, hay que intercambiar las etiquetas en `data/catalogo.json`.
- En los logs de Vercel: línea `ORDEN_CREADA` (variante enviada, total, envío, ganancia) y ausencia de `PEDIDO_NO_GUARDADO` o `MARGEN_BAJO` inesperado.
- Que el cliente reciba su **código de compra** (`NX…`), pueda reenviar la confirmación por WhatsApp y consultar el avance en **Historial de compras** o **Rastrear mi pedido**.
- Si aparece `RASTREO_NO_ENCONTRADO`, mira la `causa`.

## Cómo añadir y validar productos nuevos
1. Agrega el producto en `data/catalogo.json` inicialmente con `"estado": "borrador"` (manualmente o con `DROPANAS_API_KEY=… node scripts/catalogo.js agregar <producto_id> --bodega <id>`).
2. Completa solo datos **verificados** (sin inventar peso, autonomía ni especificaciones no confirmadas): `sku`, `titulo`, `descripcion`, `por_que`, `beneficios` (mín. 3), `specs`, `imagen` en `assets/`, `precio_venta_usd`, `costo_usd`, `producto_id`, `bodega_origen_id` y `variantes` (si aplica, con sus imágenes en `assets/`).
3. **Regla de «Recién llegado»:** al publicar un producto nuevo (incluso varios el mismo día), quita `"nuevo": true` (pon `"nuevo": false`) del producto anterior que lo tenía y déjalo únicamente en el producto más reciente. La portada (`index.html`, `pintarNuevos()`) toma dinámicamente tanto la pastilla **«¡Recién llegado!»** como la **imagen destacada y el enlace del hero** de ese único producto marcado con `"nuevo": true` (usando `assets/hero-lampara.jpg` solo como respaldo si ningún producto tiene `"nuevo": true`).
4. **Regla permanente de adaptabilidad (celular, tablet, laptop y PC):** todas las imágenes del sitio (`hero`, tarjetas del catálogo, producto de la semana, ficha, miniaturas `.vt`, comparador, vista previa al compartir y visor `#lb`) deben mantenerse sin recortes ni ampliaciones forzadas (`max-width: 100%`, `height: auto`, `object-fit: contain`), probando que no haya desbordamiento horizontal ni cortes en pantallas de celular, tablet, laptop y escritorio. Al actualizar imágenes o estilos del hero, sube también `VERSION` en `service-worker.js` para limpiar la caché de los navegadores.
5. Cambia `"estado"` a `"publicado"` cuando esté listo y ejecuta antes de abrir PR:
   - `npm run validar` (o `npm run validar:produccion` para exigir IDs reales)
   - `node tests/backend.test.js` (deben pasar las 131 pruebas sin regresiones).
