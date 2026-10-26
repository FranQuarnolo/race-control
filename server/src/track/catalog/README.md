# Catálogo de trazados

Un JSON por circuito con el dibujo de la pista. Esta carpeta la llena un script, no se edita a mano:

```
cd server
node scripts/build-track-catalog.js "C:\...\steamapps\common\assettocorsa\content\tracks"
```

## Si Assetto Corsa está en otra PC

Que es lo normal: la PC que corre el simulador no suele ser la de desarrollo. No hace falta copiar
`content\tracks` entero —son decenas de GB de modelos 3D y texturas— ni instalar Node allá.

1. Llevar `server/scripts/recolectar-trazados.ps1` a la PC del juego (pendrive, Drive, lo que sea).
2. Botón derecho sobre el archivo → **Ejecutar con PowerShell**. O desde una consola:
   `powershell -ExecutionPolicy Bypass -File recolectar-trazados.ps1`
3. Busca el juego solo, junta únicamente los `fast_lane.ai` y deja `trazados-ac.zip` en el
   Escritorio. Son unos pocos MB.
4. Traer ese zip, descomprimirlo, y correr el generador apuntando a la carpeta `tracks` que sale:
   `node scripts/build-track-catalog.js "C:\...\tracks"`

Si no encuentra el juego, se le pasa la ruta a mano con `-Juego "D:\SteamLibrary\steamapps\common\assettocorsa"`.

## Qué hace el generador

El script lee la línea de la IA (`ai/fast_lane.ai`) que viene adentro de cada circuito de Assetto
Corsa y la convierte a los 600 puntos del formato que usa el mapa. Las coordenadas son las mismas
que reporta el servidor por UDP, así que los puntitos de los autos caen sobre el dibujo sin
convertir nada.

**La clave del archivo es el nombre de la carpeta del circuito**, con la variante pegada con `__`
cuando la pista tiene más de un trazado: `ks_monza.json`, `ks_nordschleife__endurance.json`. Es lo
que manda Assetto Corsa en `NEW_SESSION`, y por eso tiene que coincidir exactamente.

Una pista que no esté acá —un mod, una conversión— no se rompe: Race Control vuelve a aprender el
trazado de la telemetría, que es lo que hacía hasta la 0.7. Solo que tarda y queda menos prolijo.

Para agregar circuitos nuevos alcanza con volver a correr el script sobre una instalación que los
tenga: los que ya estaban se reescriben iguales.
