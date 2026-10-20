/**
 * Diálogos Centrales - Retratos por Voz (Foundry VTT v12 / v13 / v14)
 * Muestra en la parte inferior/central de la pantalla el retrato del PJ (o PNJ del Máster)
 * con un bocadillo animado (• • •) cuando un jugador habla por voz (LiveKit o WebRTC nativo).
 */

const MODULE_ID = "dialogos-centrales";
const SOCKET_NAME = `module.${MODULE_ID}`;

const DEFAULT_CONFIG = {
    enabled: false,         // Desactivado por defecto al instalar el módulo
    showFrame: true,        // Mostrar u ocultar el marco alrededor de la imagen
    showName: true,         // Mostrar u ocultar la placa con el nombre del PJ
    includeGM: false,
    gmActorId: "__TOKEN__", // "__TOKEN__" | "__AVATAR__" | actorId específico
    avatarSize: 115,        // px (pequeño/mediano por defecto)
    posX: 50,               // % horizontal (50% = centro)
    posY: 12,               // % desde el borde inferior
    holdDelayMs: 650        // ms de margen al dejar de hablar para evitar parpadeos entre palabras
};

// Mapa de hablantes activos en este cliente: userId -> { speaking: boolean, hideTimeout: number|null }
const activeSpeakers = new Map();

/**
 * Obtiene la configuración actual del mundo
 */
function getConfig() {
    const raw = game.settings.get(MODULE_ID, "config") || {};
    return {
        enabled: raw.enabled !== undefined ? Boolean(raw.enabled) : DEFAULT_CONFIG.enabled,
        showFrame: raw.showFrame !== undefined ? Boolean(raw.showFrame) : DEFAULT_CONFIG.showFrame,
        showName: raw.showName !== undefined ? Boolean(raw.showName) : DEFAULT_CONFIG.showName,
        includeGM: Boolean(raw.includeGM),
        gmActorId: raw.gmActorId || DEFAULT_CONFIG.gmActorId,
        avatarSize: Number(raw.avatarSize) || DEFAULT_CONFIG.avatarSize,
        posX: raw.posX !== undefined ? Number(raw.posX) : DEFAULT_CONFIG.posX,
        posY: raw.posY !== undefined ? Number(raw.posY) : DEFAULT_CONFIG.posY,
        holdDelayMs: raw.holdDelayMs !== undefined ? Number(raw.holdDelayMs) : DEFAULT_CONFIG.holdDelayMs
    };
}

/**
 * Guarda la configuración en el mundo (solo GM)
 */
async function saveConfig(newConf) {
    if (!game.user?.isGM) return;
    await game.settings.set(MODULE_ID, "config", newConf);
}

/**
 * Resuelve qué imagen, nombre y color mostrar para un usuario que está hablando
 */
function resolveSpeakerIdentity(user, config) {
    if (!user) return null;

    // Color del jugador en Foundry (en v14 user.color puede ser un objeto Color o string)
    const rawColor = user.color?.css || user.color?.toString() || "#38bdf8";

    // Caso 1: El usuario es el GM
    if (user.isGM) {
        if (!config.includeGM) return null;

        // A. Si eligió un Actor/PNJ concreto en el selector del panel
        if (config.gmActorId && config.gmActorId !== "__TOKEN__" && config.gmActorId !== "__AVATAR__") {
            const chosenActor = game.actors?.get(config.gmActorId);
            if (chosenActor) {
                return {
                    id: user.id,
                    name: chosenActor.name,
                    img: chosenActor.img || chosenActor.prototypeToken?.texture?.src || user.avatar,
                    color: "#f59e0b"
                };
            }
        }

        // B. Si eligió usar el Token seleccionado actualmente en el lienzo
        if (config.gmActorId === "__TOKEN__") {
            const controlled = canvas?.tokens?.controlled?.[0];
            if (controlled) {
                const actorImg = controlled.actor?.img || controlled.document?.texture?.src;
                const tokenName = controlled.name || controlled.actor?.name;
                if (actorImg) {
                    return {
                        id: user.id,
                        name: tokenName || user.name,
                        img: actorImg,
                        color: "#f59e0b"
                    };
                }
            }
        }

        // C. Fallback: Avatar del propio GM o su personaje asignado
        return {
            id: user.id,
            name: user.character?.name || user.name,
            img: user.character?.img || user.avatar || "icons/svg/mystery-man.svg",
            color: rawColor
        };
    }

    // Caso 2: Es un Jugador normal
    // 1º Personaje asignado oficialmente al jugador (user.character)
    if (user.character) {
        return {
            id: user.id,
            name: user.character.name,
            img: user.character.img || user.avatar || "icons/svg/mystery-man.svg",
            color: rawColor
        };
    }

    // 2º Buscar si hay un Actor en el mundo con el mismo nombre del jugador o del que sea propietario (excluyendo "Grupo")
    const ownedActor = game.actors?.find(a =>
        a.name.toLowerCase() !== "grupo" &&
        (a.name.toLowerCase() === user.name.toLowerCase() || a.ownership?.[user.id] === 3)
    );
    if (ownedActor) {
        return {
            id: user.id,
            name: ownedActor.name,
            img: ownedActor.img || user.avatar || "icons/svg/mystery-man.svg",
            color: rawColor
        };
    }

    // 3º Fallback al avatar del usuario en Foundry
    return {
        id: user.id,
        name: user.name,
        img: user.avatar || "icons/svg/mystery-man.svg",
        color: rawColor
    };
}

/* ==========================================================================
   1. GESTIÓN DEL ESCENARIO DE RETRATOS HABLANTES EN PANTALLA
   ========================================================================== */

function ensureStageElement() {
    let stage = document.getElementById("dc-speakers-stage");
    if (!stage) {
        stage = document.createElement("div");
        stage.id = "dc-speakers-stage";
        document.body.appendChild(stage);
        const conf = getConfig();
        stage.style.setProperty("--dc-avatar-size", `${conf.avatarSize}px`);
        stage.style.setProperty("--dc-pos-x", `${conf.posX}%`);
        stage.style.setProperty("--dc-pos-y", `${conf.posY}%`);
        stage.classList.toggle("dc-no-frame", !conf.showFrame);
        stage.classList.toggle("dc-no-name", !conf.showName);
    }
    return stage;
}

function applyStageConfigStyles() {
    const stage = ensureStageElement();
    const conf = getConfig();
    stage.style.setProperty("--dc-avatar-size", `${conf.avatarSize}px`);
    stage.style.setProperty("--dc-pos-x", `${conf.posX}%`);
    stage.style.setProperty("--dc-pos-y", `${conf.posY}%`);
    stage.classList.toggle("dc-no-frame", !conf.showFrame);
    stage.classList.toggle("dc-no-name", !conf.showName);

    if (!conf.enabled) {
        clearAllSpeakers();
    } else {
        // Actualizar identidades de los que estén hablando ahora mismo (por si el GM cambió de PNJ)
        for (const [userId, state] of activeSpeakers.entries()) {
            if (state.speaking) {
                renderOrUpdateSpeakerCard(userId);
            }
        }
    }
}

function renderOrUpdateSpeakerCard(userId) {
    const conf = getConfig();
    if (!conf.enabled) return;

    const user = game.users?.get(userId);
    const identity = resolveSpeakerIdentity(user, conf);
    if (!identity) {
        removeSpeakerCardImmediate(userId);
        return;
    }

    const stage = ensureStageElement();
    let card = stage.querySelector(`.dc-speaker-card[data-user-id="${userId}"]`);

    if (!card) {
        card = document.createElement("div");
        card.className = "dc-speaker-card";
        card.dataset.userId = userId;
        card.innerHTML = `
            <div class="dc-speech-bubble">
                <span class="dc-dot"></span>
                <span class="dc-dot"></span>
                <span class="dc-dot"></span>
            </div>
            <div class="dc-portrait-frame">
                <img class="dc-portrait-img" src="" alt="" />
            </div>
            <div class="dc-name-plate"></div>
        `;
        stage.appendChild(card);

        // Forzar reflow para que la transición de entrada se anime suavemente
        void card.offsetWidth;
        card.classList.add("is-visible");
    } else {
        card.classList.remove("is-leaving");
        card.classList.add("is-visible");
    }

    card.style.setProperty("--dc-user-color", identity.color);
    card.style.setProperty("--dc-user-glow", `${identity.color}88`);

    const imgEl = card.querySelector(".dc-portrait-img");
    if (imgEl && imgEl.getAttribute("src") !== identity.img) {
        imgEl.setAttribute("src", identity.img);
        imgEl.setAttribute("alt", identity.name);
    }

    const nameEl = card.querySelector(".dc-name-plate");
    if (nameEl && nameEl.textContent !== identity.name) {
        nameEl.textContent = identity.name;
    }
}

function removeSpeakerCardSmooth(userId) {
    const stage = document.getElementById("dc-speakers-stage");
    if (!stage) return;
    const card = stage.querySelector(`.dc-speaker-card[data-user-id="${userId}"]`);
    if (!card) return;

    card.classList.remove("is-visible");
    card.classList.add("is-leaving");

    setTimeout(() => {
        const st = activeSpeakers.get(userId);
        if (!st || !st.speaking) {
            card.remove();
        }
    }, 240);
}

function removeSpeakerCardImmediate(userId) {
    const stage = document.getElementById("dc-speakers-stage");
    const card = stage?.querySelector(`.dc-speaker-card[data-user-id="${userId}"]`);
    if (card) card.remove();
}

function clearAllSpeakers() {
    for (const [, st] of activeSpeakers.entries()) {
        if (st.hideTimeout) clearTimeout(st.hideTimeout);
    }
    activeSpeakers.clear();
    const stage = document.getElementById("dc-speakers-stage");
    if (stage) stage.innerHTML = "";
}

/**
 * Función central invocada cuando un usuario empieza o deja de hablar
 */
function handleUserSpeakingChange(userId, isSpeaking, fromRemoteSocket = false) {
    if (!game.ready || !userId) return;

    const conf = getConfig();

    // Si es nuestro propio usuario hablando, lo emitimos también por socket
    // para garantizar que todos los jugadores lo vean aunque tengan plegadas las cámaras
    if (!fromRemoteSocket && userId === game.user?.id && game.socket) {
        game.socket.emit(SOCKET_NAME, {
            action: "speaking",
            userId,
            isSpeaking: Boolean(isSpeaking)
        });
    }

    if (!conf.enabled) return;

    let entry = activeSpeakers.get(userId);
    if (!entry) {
        entry = { speaking: false, hideTimeout: null };
        activeSpeakers.set(userId, entry);
    }

    if (isSpeaking) {
        if (entry.hideTimeout) {
            clearTimeout(entry.hideTimeout);
            entry.hideTimeout = null;
        }
        entry.speaking = true;
        renderOrUpdateSpeakerCard(userId);
    } else {
        if (entry.hideTimeout) clearTimeout(entry.hideTimeout);
        entry.hideTimeout = setTimeout(() => {
            entry.speaking = false;
            entry.hideTimeout = null;
            removeSpeakerCardSmooth(userId);
        }, Math.max(150, conf.holdDelayMs || 650));
    }
}

/* ==========================================================================
   2. CONEXIÓN CON LIVEKIT Y SISTEMA DE VOZ DE FOUNDRY VTT
   ========================================================================== */

let speakingHooksInstalled = false;

function installVoiceDetectionHooks() {
    if (speakingHooksInstalled) return;
    speakingHooksInstalled = true;

    // A. Envolver ui.webrtc.setUserIsSpeaking (Usado tanto por avclient-livekit como por Foundry nativo)
    const wrapWebRtcUi = () => {
        if (ui.webrtc && typeof ui.webrtc.setUserIsSpeaking === "function" && !ui.webrtc._dcWrapped) {
            const originalSetSpeaking = ui.webrtc.setUserIsSpeaking.bind(ui.webrtc);
            ui.webrtc.setUserIsSpeaking = function (userId, speaking) {
                try {
                    handleUserSpeakingChange(userId, Boolean(speaking));
                } catch (err) {
                    console.warn(`${MODULE_ID} | Error en setUserIsSpeaking:`, err);
                }
                return originalSetSpeaking(userId, speaking);
            };
            ui.webrtc._dcWrapped = true;
            console.log(`${MODULE_ID} | Conectado a ui.webrtc.setUserIsSpeaking (LiveKit / WebRTC).`);
        }
    };

    wrapWebRtcUi();
    Hooks.on("renderCameraViews", () => wrapWebRtcUi());

    // B. Envolver directamente _liveKitClient.onIsSpeakingChanged si está presente avclient-livekit
    const wrapLiveKitClient = () => {
        const lkClient = game.webrtc?.client?._liveKitClient;
        if (lkClient && typeof lkClient.onIsSpeakingChanged === "function" && !lkClient._dcWrapped) {
            const origLkSpeaking = lkClient.onIsSpeakingChanged.bind(lkClient);
            lkClient.onIsSpeakingChanged = function (userId, speaking) {
                try {
                    handleUserSpeakingChange(userId, Boolean(speaking));
                } catch (err) {}
                return origLkSpeaking(userId, speaking);
            };
            lkClient._dcWrapped = true;
            console.log(`${MODULE_ID} | Conectado directamente a LiveKit onIsSpeakingChanged.`);
        }
    };

    wrapLiveKitClient();
    setTimeout(wrapLiveKitClient, 3000);

    // C. MutationObserver sobre #camera-views por si algún otro módulo altera la clase .speaking en el DOM
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === "attributes" && m.attributeName === "class") {
                const el = m.target;
                if (el instanceof HTMLElement && el.classList.contains("camera-view") && el.dataset.user) {
                    const isSpk = el.classList.contains("speaking");
                    handleUserSpeakingChange(el.dataset.user, isSpk);
                }
            }
        }
    });

    observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ["class"]
    });
}

/* ==========================================================================
   3. PANEL DE CONTROL DEL MÁSTER
   ========================================================================== */

function openGmConfigModal() {
    if (!game.user?.isGM) return;

    let backdrop = document.getElementById("dc-gm-backdrop");
    if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.id = "dc-gm-backdrop";
        backdrop.className = "dc-gm-backdrop";
        backdrop.addEventListener("click", (ev) => {
            if (ev.target === backdrop) backdrop.remove();
        });
        document.body.appendChild(backdrop);
    }

    renderGmModal(backdrop);
}

function renderGmModal(backdrop) {
    const conf = getConfig();

    // Lista de actores del mundo para que el Máster pueda elegir qué PNJ habla cuando él habla
    const actors = [...(game.actors || [])]
        .filter(a => a.name.toLowerCase() !== "grupo")
        .sort((a, b) => a.name.localeCompare(b.name));

    const actorOptionsHtml = [
        `<option value="__TOKEN__" ${conf.gmActorId === "__TOKEN__" ? "selected" : ""}>🎯 Usar Token seleccionado en el mapa</option>`,
        `<option value="__AVATAR__" ${conf.gmActorId === "__AVATAR__" ? "selected" : ""}>👤 Usar Avatar del Máster</option>`,
        `<optgroup label="Personajes y PNJs del Mundo">`,
        ...actors.map(a => `<option value="${a.id}" ${conf.gmActorId === a.id ? "selected" : ""}>🎭 ${a.name}</option>`),
        `</optgroup>`
    ].join("");

    backdrop.innerHTML = `
        <div class="dc-gm-modal">
            <div class="dc-gm-header">
                <div class="dc-gm-title">
                    <i class="fa-solid fa-comments"></i>
                    <span>DIÁLOGOS CENTRALES // RETRATOS POR VOZ</span>
                </div>
                <button type="button" class="dc-btn" id="dc-close-btn">
                    <i class="fa-solid fa-xmark"></i> Cerrar
                </button>
            </div>

            <div class="dc-gm-body">
                <!-- 1. Estado General ON / OFF -->
                <div class="dc-gm-card" style="border-color: ${conf.enabled ? "#10b981" : "#334155"};">
                    <div class="dc-gm-field">
                        <div>
                            <strong style="color:#f8fafc; font-size:14px;">Estado de Diálogos Centrales</strong>
                            <div style="color:#94a3b8; font-size:12px;">Muestra el retrato y bocadillo animado cuando alguien habla por voz</div>
                        </div>
                        <button type="button" id="dc-toggle-enabled-btn" class="dc-btn ${conf.enabled ? "dc-btn-success" : "dc-btn-danger"}" style="min-width: 135px; justify-content: center;">
                            <i class="fa-solid ${conf.enabled ? "fa-toggle-on" : "fa-toggle-off"}"></i>
                            ${conf.enabled ? "ACTIVO" : "DESACTIVADO"}
                        </button>
                    </div>
                </div>

                <!-- 2. Opciones del Máster (PNJ hablante) -->
                <div class="dc-gm-card">
                    <div class="dc-gm-card-title">
                        <span><i class="fa-solid fa-masks-theater"></i> VOZ DEL MÁSTER (OPCIONAL)</span>
                        <span style="color:#64748b; font-weight:normal;">Por defecto solo salen jugadores</span>
                    </div>
                    <div class="dc-gm-field">
                        <label for="dc-include-gm-cb" style="cursor:pointer;">Incluir al Máster cuando habla por micro</label>
                        <input type="checkbox" id="dc-include-gm-cb" ${conf.includeGM ? "checked" : ""} />
                    </div>
                    <div class="dc-gm-field" style="opacity: ${conf.includeGM ? "1" : "0.5"};">
                        <label for="dc-gm-actor-select">¿Qué retrato mostrar para el Máster?</label>
                        <select id="dc-gm-actor-select" class="dc-gm-select" style="width: 240px;">
                            ${actorOptionsHtml}
                        </select>
                    </div>
                </div>

                <!-- 3. Tamaño, Estilo y Posición en Pantalla -->
                <div class="dc-gm-card">
                    <div class="dc-gm-card-title">
                        <span><i class="fa-solid fa-sliders"></i> ESTILO, TAMAÑO Y POSICIÓN</span>
                        <button type="button" class="dc-btn" id="dc-reset-defaults-btn" style="padding:2px 8px; font-size:11px;">
                            Restaurar por defecto
                        </button>
                    </div>

                    <div class="dc-gm-field">
                        <label for="dc-show-frame-cb" style="cursor:pointer;">Mostrar marco alrededor del retrato (desmarcar para PNG transparente)</label>
                        <input type="checkbox" id="dc-show-frame-cb" ${conf.showFrame ? "checked" : ""} />
                    </div>

                    <div class="dc-gm-field">
                        <label for="dc-show-name-cb" style="cursor:pointer;">Mostrar etiqueta con el nombre del PJ debajo</label>
                        <input type="checkbox" id="dc-show-name-cb" ${conf.showName ? "checked" : ""} />
                    </div>

                    <div class="dc-gm-field">
                        <label>Tamaño de Retrato: <strong id="dc-val-size" style="color:#38bdf8;">${conf.avatarSize}px</strong></label>
                        <input type="range" id="dc-slider-size" min="70" max="240" step="5" value="${conf.avatarSize}" style="width:200px;" />
                    </div>

                    <div class="dc-gm-field">
                        <label>Altura desde el borde inferior: <strong id="dc-val-posy" style="color:#38bdf8;">${conf.posY}%</strong></label>
                        <input type="range" id="dc-slider-posy" min="2" max="75" step="1" value="${conf.posY}" style="width:200px;" />
                    </div>

                    <div class="dc-gm-field">
                        <label>Posición horizontal (50% = Centro): <strong id="dc-val-posx" style="color:#38bdf8;">${conf.posX}%</strong></label>
                        <input type="range" id="dc-slider-posx" min="15" max="85" step="1" value="${conf.posX}" style="width:200px;" />
                    </div>

                    <div class="dc-gm-field">
                        <label title="Margen antes de ocultar el retrato al hacer pausas breves al hablar">Retardo al callar: <strong id="dc-val-hold" style="color:#38bdf8;">${conf.holdDelayMs}ms</strong></label>
                        <input type="range" id="dc-slider-hold" min="200" max="1500" step="50" value="${conf.holdDelayMs}" style="width:200px;" />
                    </div>
                </div>

                <!-- 4. Botón de Prueba Visual -->
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <button type="button" class="dc-btn" id="dc-test-speakers-btn" style="width:100%; justify-content:center; padding:8px; border-color:#38bdf8; color:#38bdf8;">
                        <i class="fa-solid fa-volume-high"></i> Probar vista en pantalla (Simular varios hablando 4s)
                    </button>
                </div>
            </div>
        </div>
    `;

    backdrop.querySelector("#dc-close-btn")?.addEventListener("click", () => backdrop.remove());

    backdrop.querySelector("#dc-toggle-enabled-btn")?.addEventListener("click", async () => {
        const c = getConfig();
        c.enabled = !c.enabled;
        await saveConfig(c);
        renderGmModal(backdrop);
        ui.notifications.info(`Diálogos Centrales: ${c.enabled ? "ACTIVADO" : "DESACTIVADO"}`);
    });

    backdrop.querySelector("#dc-include-gm-cb")?.addEventListener("change", async (ev) => {
        const c = getConfig();
        c.includeGM = ev.target.checked;
        await saveConfig(c);
        renderGmModal(backdrop);
    });

    backdrop.querySelector("#dc-gm-actor-select")?.addEventListener("change", async (ev) => {
        const c = getConfig();
        c.gmActorId = ev.target.value;
        await saveConfig(c);
    });

    backdrop.querySelector("#dc-show-frame-cb")?.addEventListener("change", async (ev) => {
        const c = getConfig();
        c.showFrame = ev.target.checked;
        await saveConfig(c);
    });

    backdrop.querySelector("#dc-show-name-cb")?.addEventListener("change", async (ev) => {
        const c = getConfig();
        c.showName = ev.target.checked;
        await saveConfig(c);
    });

    // Sliders de Tamaño y Posición (previsualización en vivo al arrastrar y guardado al soltar)
    const bindSlider = (sliderId, labelId, key, unit) => {
        const slider = backdrop.querySelector(sliderId);
        const label = backdrop.querySelector(labelId);
        if (!slider) return;

        slider.addEventListener("input", (ev) => {
            const val = Number(ev.target.value);
            if (label) label.textContent = `${val}${unit}`;
            const stage = ensureStageElement();
            if (key === "avatarSize") stage.style.setProperty("--dc-avatar-size", `${val}px`);
            if (key === "posX") stage.style.setProperty("--dc-pos-x", `${val}%`);
            if (key === "posY") stage.style.setProperty("--dc-pos-y", `${val}%`);
        });

        slider.addEventListener("change", async (ev) => {
            const c = getConfig();
            c[key] = Number(ev.target.value);
            await saveConfig(c);
        });
    };

    bindSlider("#dc-slider-size", "#dc-val-size", "avatarSize", "px");
    bindSlider("#dc-slider-posy", "#dc-val-posy", "posY", "%");
    bindSlider("#dc-slider-posx", "#dc-val-posx", "posX", "%");
    bindSlider("#dc-slider-hold", "#dc-val-hold", "holdDelayMs", "ms");

    backdrop.querySelector("#dc-reset-defaults-btn")?.addEventListener("click", async () => {
        const c = getConfig();
        c.avatarSize = DEFAULT_CONFIG.avatarSize;
        c.posX = DEFAULT_CONFIG.posX;
        c.posY = DEFAULT_CONFIG.posY;
        c.holdDelayMs = DEFAULT_CONFIG.holdDelayMs;
        await saveConfig(c);
        renderGmModal(backdrop);
    });

    // Simular varios hablantes durante 4 segundos para ajustar tamaño/posición cómodamente
    backdrop.querySelector("#dc-test-speakers-btn")?.addEventListener("click", () => {
        const testUsers = game.users.filter(u => !u.isGM).slice(0, 3);
        if (testUsers.length === 0) testUsers.push(game.user);

        testUsers.forEach((u, idx) => {
            setTimeout(() => {
                renderOrUpdateSpeakerCard(u.id);
            }, idx * 180);

            setTimeout(() => {
                removeSpeakerCardSmooth(u.id);
            }, 3800 + idx * 180);
        });
    });
}

/* ==========================================================================
   4. HOOKS DE INICIO, CONTROLES Y SOCKETS DE FOUNDRY VTT
   ========================================================================== */

Hooks.once("init", () => {
    console.log(`${MODULE_ID} | Inicializando Diálogos Centrales...`);

    game.settings.register(MODULE_ID, "config", {
        name: "Configuración de Diálogos Centrales",
        scope: "world",
        config: false,
        type: Object,
        default: DEFAULT_CONFIG,
        onChange: () => {
            applyStageConfigStyles();
        }
    });

    if (game.keybindings) {
        game.keybindings.register(MODULE_ID, "openConfig", {
            name: "Abrir Configuración de Diálogos Centrales",
            hint: "Permite activar/desactivar los retratos por voz, elegir PNJ del Máster y ajustar tamaño.",
            editable: [{ key: "KeyD", modifiers: ["Alt"] }],
            restricted: true,
            onDown: () => {
                openGmConfigModal();
                return true;
            }
        });
    }

    window.DialogosCentrales = {
        openConfig: () => openGmConfigModal(),
        toggle: async () => {
            const c = getConfig();
            c.enabled = !c.enabled;
            await saveConfig(c);
            ui.notifications.info(`Diálogos Centrales: ${c.enabled ? "ACTIVADO" : "DESACTIVADO"}`);
        }
    };
});

// Botón en la barra de herramientas izquierda (Controles de Tokens)
Hooks.on("getSceneControlButtons", (controls) => {
    const toolData = {
        name: "dialogos-centrales",
        title: "Diálogos Centrales (Retratos al Hablar)",
        icon: "fa-solid fa-comments",
        visible: game.user?.isGM,
        button: true,
        onClick: () => openGmConfigModal(),
        onChange: () => openGmConfigModal()
    };

    if (Array.isArray(controls)) {
        const tokenControl = controls.find(c => c.name === "token" || c.name === "tokens");
        if (tokenControl && Array.isArray(tokenControl.tools)) {
            tokenControl.tools.push(toolData);
        }
    } else if (controls && typeof controls === "object") {
        const tokenControl = controls.tokens || controls.token;
        if (tokenControl && tokenControl.tools) {
            if (Array.isArray(tokenControl.tools)) {
                tokenControl.tools.push(toolData);
            } else {
                tokenControl.tools["dialogos-centrales"] = {
                    ...toolData,
                    order: Object.keys(tokenControl.tools).length + 1
                };
            }
        }
    }
});

// Botón también en la pestaña derecha de Escenas para el GM
Hooks.on("renderSceneDirectory", (app, html) => {
    if (!game.user?.isGM) return;
    const root = html instanceof HTMLElement ? html : html[0];
    if (!root || root.querySelector(".dc-scene-dir-btn")) return;

    const headerActions = root.querySelector(".header-actions");
    if (headerActions) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dc-scene-dir-btn";
        btn.style.cssText = "background:#0b1120; border:1px solid #10b981; color:#34d399; font-family:monospace; font-weight:bold;";
        btn.innerHTML = `<i class="fa-solid fa-comments"></i> Diálogos Centrales`;
        btn.addEventListener("click", () => openGmConfigModal());
        headerActions.appendChild(btn);
    }
});

Hooks.once("ready", () => {
    ensureStageElement();
    installVoiceDetectionHooks();

    if (game.socket) {
        game.socket.on(SOCKET_NAME, (payload) => {
            if (!payload) return;
            if (payload.action === "speaking") {
                handleUserSpeakingChange(payload.userId, payload.isSpeaking, true);
            }
        });
    }
});

