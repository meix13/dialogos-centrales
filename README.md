# Diálogos Centrales (`dialogos-centrales`)

Módulo para **Foundry VTT (v12 / v13 / v14)** que muestra automáticamente en la zona inferior/central de la pantalla el retrato del personaje del jugador (con un bocadillo de puntos animados `• • •`) cuando habla por micrófono (compatible con **LiveKit** `avclient-livekit` y con el sistema WebRTC nativo de Foundry).

## Características

- **Detección automática de voz:** Integrado con `ui.webrtc.setUserIsSpeaking`, `avclient-livekit` y sincronización por sockets para que todos vean quién habla aunque tengan las cámaras plegadas.
- **Multijugador dinámico:** Si hablan varios jugadores a la vez, los retratos se hacen sitio suavemente en fila y desaparecen con transición al callar (con retardo anti-parpadeo configurable entre palabras).
- **Opción para incluir al Máster con selector de PNJ:** Por defecto solo aparecen los jugadores, pero el Máster puede activar su voz y elegir en un desplegable qué **PNJ / Actor** del mundo quiere que aparezca cuando él hable (o usar el Token que tenga seleccionado en el mapa).
- **Tamaño y Posición configurables en vivo:** Deslizadores para ajustar el tamaño en píxeles (`70px` – `220px`), la altura y la posición horizontal, con botón de prueba visual de 4 segundos.
- **Accesos rápidos para el GM:**
  - Icono de bocadillo (`💬`) en la barra izquierda (Controles de Tokens).
  - Botón `Diálogos Centrales` en la cabecera de la pestaña *Escenas*.
  - Atajo de teclado `Alt + D`.

