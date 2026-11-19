# Flujo de trabajo: GitHub ↔ Vercel ↔ Gemini ↔ Claude

**Regla de oro:** cada tipo de cambio toca SOLO su carpeta, así nada rompe las rutas.

| Qué cambias | Dónde | Quién lo produce |
|---|---|---|
| Productos, textos, precios, ofertas, "producto de la semana" | `data/catalogo.json` | Tú, Gemini o Claude |
| Fotos de producto | `assets/productos/<sku>.webp` (800×800, menos de 150 KB) | Gemini / proveedor |
| Diseño de la página | `index.html` | Claude |
| Servidor (pedidos, seguridad) | `api/` y `lib/` | Claude |

## Pasos
1. En GitHub crea una rama (`cambios`) → sube los archivos a su carpeta → Vercel crea solo una **URL de vista previa**. Revísala.
2. Si está bien, "Merge" a `main` → Vercel publica en producción. Si algo falla, "Promote" el despliegue anterior en Vercel (1 clic).
3. GitHub Actions (`.github/workflows/validar.yml`) revisa el catálogo y la sintaxis en cada subida. Si sale en rojo, no lo publiques.
4. En Vercel, la llave `live_sk_…` va solo en el entorno **Production** y una `test_sk_…` en **Preview**: las pruebas nunca tocan pedidos reales.

## Agregar un producto
- **Que lo agregue Claude:** dime el producto (o el ID de DroPanas) y devuelvo `data/catalogo.json` actualizado.
- **Tú mismo:** `DROPANAS_API_KEY=test_sk_xxx node scripts/catalogo.js agregar <producto_id> --bodega <id>` lo deja como `borrador`.
  Completa los textos, sube la foto y cambia `"estado"` a `"publicado"`.

## Sugerencias de DroPanas (aprobación tuya)
`DROPANAS_API_KEY=test_sk_xxx node scripts/catalogo.js sugerir` ordena el catálogo por margen, precio de impulso y peso, y guarda `data/sugerencias.json`.
**Limitación:** la API no publica ventas ni rotación. Valida la demanda por tu cuenta (TikTok/Instagram, Google Trends, tus propias ventas)
y aprueba tú cada producto; ningún producto sale publicado sin que cambies su estado.

## Prompt para Gemini (textos de un producto)
> Eres redactor de e-commerce para Venezuela (español latino, tono cercano, sin exagerar). Producto: <nombre y datos del proveedor>.
> Devuelve SOLO este JSON, sin inventar especificaciones que no estén en los datos: `{"titulo":"", "descripcion":"(1-2 frases)", "por_que":"(1 frase)",
> "beneficios":["","",""], "specs":{"Tipo":"","Ideal para":""}}`

## Imágenes con Gemini
Fondo blanco liso, producto centrado, 1:1, sin texto ni logos de terceros. Expórtala a WebP 800×800 y guárdala como `assets/productos/<sku>.webp`;
luego pon `"imagen": "assets/productos/<sku>.webp"` en el producto.
