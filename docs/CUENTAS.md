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
| `GOOGLE_CLIENT_ID` | ID de cliente web de Google |
| `SESSION_SECRET` | ≥ 32 caracteres aleatorios |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash (historial de pedidos) |
| `REQUIERE_CUENTA` | `0` (por defecto, compra libre) o `1` (exige cuenta) |
| `MARGEN_MIN_USD` | 5 |
| `COMISION_USD` | 0.5 (confirma con DroPanas si es fija o porcentaje) |

Tras cambiar variables, haz **Redeploy**.

## Cómo activar la cuenta obligatoria
1. Entra desde tu celular en Chrome/Safari, toca **Ingresar** y verifica que Google te deja entrar y que ves «Historial de compras».
2. Haz un pedido de prueba y comprueba que aparece en «Historial de compras».
3. Pon `REQUIERE_CUENTA=1` en Vercel y redeploy.

Dentro de Instagram, TikTok o WhatsApp Google bloquea el inicio de sesión: la tienda detecta esos navegadores y pide abrir el enlace en Chrome o Safari.

## Claves en Upstash
`nx:u:{sub}` perfil · `nx:uo:{sub}` pedidos del usuario (ZSET) · `nx:o:{ref}` pedido (400 días).

## Qué verificar tras el primer pedido
- En DroPanas, la variante del pedido (1950 Enchufable / 1951 Recargable). Si salen cruzadas, hay que intercambiar las etiquetas en `data/catalogo.json`.
- En los logs de Vercel: línea `ORDEN_CREADA` (variante enviada, total, envío, ganancia) y ausencia de `PEDIDO_NO_GUARDADO`.
- Si aparece `RASTREO_NO_ENCONTRADO`, mira la `causa`.
