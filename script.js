(function () {
  const STORAGE_KEY = "sports-events-storage-v1";
  const LAST_ADMIN_KEY = "sports-events-last-admin-id";
  const JOINED_PREFIX = "sports-events-joined-";
  const TRASH_KEY = "sports-events-trash-v1";
  const TRASH_RETENTION_DAYS = 5;
  const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;
  const GOOGLE_MAPS_API_KEY = "SUA_API_KEY_AQUI";

  // BANCO DE DADOS ONLINE (Supabase)
  // Sem isso, o sistema usa apenas o navegador/localStorage.
  // Configure estes 2 campos para o mesmo evento aparecer em celulares diferentes.
  const SUPABASE_URL = "";
  const SUPABASE_ANON_KEY = "";
  const SUPABASE_TABLE = "sports_events";

  let locationAutocomplete = null;
  let selectedLocation = null;
  let publicMap = null;
  let publicMarker = null;
  let currentMapKey = "";
  let pendingMapEvent = null;

  const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

  const $ = (selector) => document.querySelector(selector);
  const page = document.body.dataset.page;

  function isCloudEnabled() {
    return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_URL.startsWith("http"));
  }

  function supabaseEndpoint(path = "") {
    return `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${SUPABASE_TABLE}${path}`;
  }

  async function cloudRequest(path, options = {}) {
    if (!isCloudEnabled()) return null;
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    };
    const response = await fetch(supabaseEndpoint(path), { ...options, headers });
    if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function cloudPullEvents() {
    if (!isCloudEnabled()) return;
    try {
      const rows = await cloudRequest("?select=id,data,deleted_at&order=updated_at.desc", { method: "GET" });
      if (!Array.isArray(rows)) return;
      const events = rows
        .filter((row) => !row.deleted_at && row.data && typeof row.data === "object")
        .map((row) => normalizeEvent({ ...row.data, id: row.id || row.data.id }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    } catch (error) {
      console.error("Erro ao sincronizar eventos do banco:", error);
    }
  }

  async function cloudUpsertEvent(event) {
    if (!isCloudEnabled() || !event?.id) return;
    try {
      await cloudRequest("?on_conflict=id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: event.id, data: event, deleted_at: null, updated_at: new Date().toISOString() })
      });
    } catch (error) {
      console.error("Erro ao salvar evento no banco:", error);
    }
  }

  async function cloudPushEvents(events) {
    if (!isCloudEnabled()) return;
    await Promise.all((events || []).map((event) => cloudUpsertEvent(normalizeEvent(event))));
  }

  async function cloudMarkDeleted(eventId) {
    if (!isCloudEnabled() || !eventId) return;
    try {
      await cloudRequest(`?id=eq.${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      });
    } catch (error) {
      console.error("Erro ao excluir evento no banco:", error);
    }
  }

  function encodeEventSnapshot(event) {
    try {
      const json = JSON.stringify(normalizeEvent(event));
      return btoa(unescape(encodeURIComponent(json)));
    } catch (error) {
      console.error("Erro ao gerar snapshot do evento:", error);
      return "";
    }
  }

  function decodeEventSnapshot(value) {
    try {
      if (!value) return null;
      return normalizeEvent(JSON.parse(decodeURIComponent(escape(atob(value)))));
    } catch (error) {
      console.error("Erro ao ler snapshot do evento:", error);
      return null;
    }
  }

  function importEventSnapshotFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get("id");
    const snapshot = decodeEventSnapshot(params.get("s"));
    if (!eventId || !snapshot || snapshot.id !== eventId) return null;
    const events = loadEvents();
    if (!events.some((event) => event.id === eventId)) {
      events.unshift(snapshot);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    }
    return snapshot;
  }

  function loadEvents() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error("Erro ao carregar eventos:", error);
      return [];
    }
  }

  function saveEvents(events) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    cloudPushEvents(events);
    window.dispatchEvent(new Event("events:changed"));
  }

  function loadTrashEvents() {
    try {
      const parsed = JSON.parse(localStorage.getItem(TRASH_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error("Erro ao carregar lixeira:", error);
      return [];
    }
  }

  function saveTrashEvents(events) {
    localStorage.setItem(TRASH_KEY, JSON.stringify(events));
    window.dispatchEvent(new Event("events:changed"));
  }

  function purgeExpiredTrashEvents() {
    const now = Date.now();
    const trash = loadTrashEvents();
    const validTrash = trash.filter((event) => {
      const deletedAt = new Date(event.deletedAt || 0).getTime();
      return deletedAt && now - deletedAt < TRASH_RETENTION_MS;
    });

    if (validTrash.length !== trash.length) {
      saveTrashEvents(validTrash);
    }

    return validTrash;
  }

  function moveEventToTrash(eventId) {
    const events = loadEvents();
    const index = events.findIndex((event) => event.id === eventId);

    if (index === -1) return false;

    const [removedEvent] = events.splice(index, 1);
    const trash = purgeExpiredTrashEvents().filter((event) => event.id !== eventId);
    trash.unshift({ ...removedEvent, deletedAt: new Date().toISOString() });

    saveEvents(events);
    saveTrashEvents(trash);
    localStorage.removeItem(LAST_ADMIN_KEY);
    cloudMarkDeleted(eventId);
    return true;
  }

  function restoreEventFromTrash(eventId) {
    const trash = purgeExpiredTrashEvents();
    const index = trash.findIndex((event) => event.id === eventId);

    if (index === -1) return false;

    const [restoredEvent] = trash.splice(index, 1);
    delete restoredEvent.deletedAt;

    const events = loadEvents().filter((event) => event.id !== eventId);
    events.unshift(restoredEvent);

    saveEvents(events);
    saveTrashEvents(trash);
    localStorage.setItem(LAST_ADMIN_KEY, eventId);
    cloudUpsertEvent(restoredEvent);
    return true;
  }

  function clearTrashEvents() {
    saveTrashEvents([]);
  }

  function getEventById(id) {
    return finalizeExpiredEvents().find((event) => event.id === id);
  }

  function normalizeEvent(event) {
    return {
      ...event,
      participants: Array.isArray(event.participants) ? event.participants : [],
      reserve: Array.isArray(event.reserve) ? event.reserve : [],
      presentIds: event.presentIds && typeof event.presentIds === "object" ? event.presentIds : {},
      status: event.status || "active"
    };
  }

  function updateEvent(eventId, updater) {
    const events = loadEvents();
    const index = events.findIndex((event) => event.id === eventId);

    if (index === -1) return null;

    const currentEvent = normalizeEvent(events[index]);
    const updatedEvent = normalizeEvent(updater(currentEvent) || currentEvent);
    events[index] = updatedEvent;
    saveEvents(events);
    return updatedEvent;
  }

  function generateEventId() {
    const events = loadEvents();
    let id = "";
    do {
      id = Math.random().toString(36).slice(2, 8).toUpperCase();
    } while (events.some((event) => event.id === id));
    return id;
  }

  function generateParticipantId() {
    return `P${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  }

  function toNumber(value) {
    return Number(String(value || "").replace(",", "."));
  }

  function getGuestNames(participant) {
    if (Array.isArray(participant.guests)) {
      return participant.guests.map((guest) => String(guest).trim()).filter(Boolean);
    }
    if (Array.isArray(participant.guestNames)) {
      return participant.guestNames.map((guest) => String(guest).trim()).filter(Boolean);
    }
    if (Array.isArray(participant.convidados)) {
      return participant.convidados.map((guest) => String(guest).trim()).filter(Boolean);
    }
    const legacyGuestCount = Math.max(0, Math.floor(Number(participant.guests || 0)));
    return Array.from({ length: legacyGuestCount }, (_, index) => `Convidado ${index + 1} (nome não informado)`);
  }

  function countPeople(participants) {
    return participants.reduce((sum, participant) => sum + 1 + getGuestNames(participant).length, 0);
  }

  function calculateEvent(event) {
    const normalized = normalizeEvent(event || {});
    const participants = normalized.participants;
    const reserve = normalized.reserve;
    const totalPeople = countPeople(participants);
    const reservePeople = countPeople(reserve);
    const remaining = Math.max(0, Number(normalized.maxPeople || 0) - totalPeople);
    const perPerson = totalPeople > 0 ? Number(normalized.totalValue || 0) / totalPeople : 0;

    return { participants, reserve, totalPeople, reservePeople, remaining, perPerson };
  }

  function promoteReserve(event) {
    event.participants = Array.isArray(event.participants) ? event.participants : [];
    event.reserve = Array.isArray(event.reserve) ? event.reserve : [];

    while (event.reserve.length) {
      const firstReserve = event.reserve[0];
      const peopleCount = 1 + getGuestNames(firstReserve).length;
      const remaining = Math.max(0, Number(event.maxPeople || 0) - countPeople(event.participants));

      if (peopleCount > remaining) break;

      const promoted = event.reserve.shift();
      promoted.promotedAt = new Date().toISOString();
      event.participants.push(promoted);
    }

    return event;
  }

  function splitParticipantByAvailableSlots(participant, availableSlots) {
    const guestNames = getGuestNames(participant);
    const mainGuestLimit = Math.max(0, availableSlots - 1);

    if (availableSlots <= 0) {
      return { mainParticipant: null, reserveItems: [{ ...participant, statusLabel: participant.statusLabel || "Reserva" }] };
    }

    const mainParticipant = {
      ...participant,
      guests: guestNames.slice(0, mainGuestLimit),
      statusLabel: participant.statusLabel || ""
    };

    const reserveItems = guestNames.slice(mainGuestLimit).map((guestName) => ({
      id: generateParticipantId(),
      name: guestName,
      guests: [],
      joinedAt: participant.joinedAt || new Date().toISOString(),
      parentParticipantId: participant.id,
      statusLabel: `Reserva - convidado de ${participant.name}`
    }));

    return { mainParticipant, reserveItems };
  }

  function addParticipantRespectingCapacity(event, participant) {
    event.participants = Array.isArray(event.participants) ? event.participants : [];
    event.reserve = Array.isArray(event.reserve) ? event.reserve : [];

    const remaining = Math.max(0, Number(event.maxPeople || 0) - countPeople(event.participants));
    const peopleToAdd = 1 + getGuestNames(participant).length;

    if (peopleToAdd <= remaining) {
      event.participants.push(participant);
      return { mainId: participant.id, reserveCount: 0, split: false };
    }

    const { mainParticipant, reserveItems } = splitParticipantByAvailableSlots(participant, remaining);

    if (mainParticipant) event.participants.push(mainParticipant);
    event.reserve.push(...reserveItems);

    return {
      mainId: mainParticipant ? mainParticipant.id : null,
      reserveCount: reserveItems.length,
      split: Boolean(mainParticipant && reserveItems.length)
    };
  }

  function formatCurrency(value) {
    return currencyFormatter.format(Number(value || 0));
  }

  function formatDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "--" : dateFormatter.format(date);
  }

  function formatDuration(hours) {
    const value = Number(hours);
    if (value === 1) return "1 hora";
    if (Number.isInteger(value)) return `${value} horas`;
    return `${String(value).replace(".", ",")} horas`;
  }

  function setFeedback(element, message, type) {
    if (!element) return;
    element.textContent = message || "";
    element.className = "feedback";
    if (type) element.classList.add(type);
  }

  function buildEventLink(eventId) {
    const url = new URL("evento.html", window.location.href);
    url.searchParams.set("id", eventId);
    const event = getEventById(eventId);
    const snapshot = event ? encodeEventSnapshot(event) : "";
    if (snapshot) url.searchParams.set("s", snapshot);
    return url.href;
  }

  function isFutureDate(value) {
    const startsAt = new Date(value);
    return !Number.isNaN(startsAt.getTime()) && startsAt.getTime() > Date.now();
  }

  function canLeaveEvent(event) {
    return new Date(event.startsAt).getTime() - Date.now() > ONE_HOUR;
  }

  function getEventEndTime(event) {
    const startsAtMs = new Date(event.startsAt).getTime();
    const durationMs = Number(event.durationHours || 0) * ONE_HOUR;
    if (Number.isNaN(startsAtMs) || durationMs <= 0) return 0;
    return startsAtMs + durationMs;
  }

  function shouldAutoConcludeEvent(event) {
    const normalized = normalizeEvent(event);
    const endTime = getEventEndTime(normalized);
    return normalized.status !== "concluded" && endTime > 0 && Date.now() >= endTime;
  }

  function finalizeExpiredEvents() {
    const events = loadEvents();
    let changed = false;
    const updatedEvents = events.map((event) => {
      if (!shouldAutoConcludeEvent(event)) return event;
      changed = true;
      return {
        ...event,
        status: "concluded",
        finishedAt: new Date().toISOString(),
        autoFinished: true
      };
    });

    if (changed) saveEvents(updatedEvents);
    return updatedEvents;
  }

  function isEventActive(event) {
    return !shouldAutoConcludeEvent(event) && normalizeEvent(event).status !== "concluded";
  }

  function loadGoogleMapsApi() {
    if (!GOOGLE_MAPS_API_KEY || GOOGLE_MAPS_API_KEY === "SUA_API_KEY_AQUI") {
      console.warn("Configure a GOOGLE_MAPS_API_KEY no script.js para ativar o autocomplete e o mapa.");
      return;
    }

    if (window.google?.maps?.places) {
      window.initGoogleMapsIntegration();
      return;
    }

    if (document.querySelector("[data-google-maps-api]")) return;

    const script = document.createElement("script");
    script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(GOOGLE_MAPS_API_KEY) + "&libraries=places&callback=initGoogleMapsIntegration";
    script.async = true;
    script.defer = true;
    script.dataset.googleMapsApi = "true";
    document.head.appendChild(script);
  }

  function getEventLocation(event) {
    const location = event?.location;
    if (!location) return { local: "", lat: null, lng: null };
    if (typeof location === "string") {
      return {
        local: location,
        lat: Number(event.locationLat || event.lat || null),
        lng: Number(event.locationLng || event.lng || null)
      };
    }
    return { local: String(location.local || location.address || ""), lat: Number(location.lat), lng: Number(location.lng) };
  }

  function hasValidCoordinates(location) {
    return Number.isFinite(location.lat) && Number.isFinite(location.lng);
  }

  function buildGoogleMapsUrl(location) {
    if (hasValidCoordinates(location)) return "https://www.google.com/maps/search/?api=1&query=" + location.lat + "," + location.lng;
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(location.local);
  }

  function initLocationAutocomplete() {
    const input = $("#locationInput");
    const latInput = $("#locationLatInput");
    const lngInput = $("#locationLngInput");
    if (!input || !window.google?.maps?.places || locationAutocomplete) return;

    locationAutocomplete = new google.maps.places.Autocomplete(input, {
      fields: ["formatted_address", "geometry", "name"],
      types: ["geocode", "establishment"]
    });

    locationAutocomplete.addListener("place_changed", () => {
      const place = locationAutocomplete.getPlace();
      if (!place.geometry?.location) {
        selectedLocation = null;
        latInput.value = "";
        lngInput.value = "";
        return;
      }

      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      const local = place.formatted_address || place.name || input.value.trim();
      selectedLocation = { local, lat, lng };
      input.value = local;
      latInput.value = String(lat);
      lngInput.value = String(lng);
    });

    input.addEventListener("input", () => {
      selectedLocation = null;
      latInput.value = "";
      lngInput.value = "";
    });
  }

  function renderPublicEventMap(event) {
    const mapElement = $("#eventMap");
    if (!mapElement) return;

    const location = getEventLocation(event);
    if (!hasValidCoordinates(location)) {
      mapElement.innerHTML = "";
      currentMapKey = "";
      return;
    }

    if (!window.google?.maps) {
      pendingMapEvent = event;
      return;
    }

    const mapKey = location.lat + "," + location.lng;
    if (currentMapKey === mapKey && publicMap && publicMarker) return;
    currentMapKey = mapKey;

    const position = { lat: location.lat, lng: location.lng };
    publicMap = new google.maps.Map(mapElement, {
      center: position,
      zoom: 16,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true
    });

    publicMarker = new google.maps.Marker({ position, map: publicMap, title: location.local });
  }

  window.initGoogleMapsIntegration = function () {
    initLocationAutocomplete();
    if (pendingMapEvent) renderPublicEventMap(pendingMapEvent);
  };

  function removeParticipantFromEvent(eventId, participantId, options = {}) {
    const event = getEventById(eventId);
    if (!event) return { ok: false, reason: "not-found" };
    if (!options.admin && !canLeaveEvent(event)) return { ok: false, reason: "locked" };

    let found = false;
    let removedFromMain = false;

    updateEvent(eventId, (eventToUpdate) => {
      eventToUpdate.participants = Array.isArray(eventToUpdate.participants) ? eventToUpdate.participants : [];
      eventToUpdate.reserve = Array.isArray(eventToUpdate.reserve) ? eventToUpdate.reserve : [];

      const mainLength = eventToUpdate.participants.length;
      eventToUpdate.participants = eventToUpdate.participants.filter((participant) => participant.id !== participantId);
      if (eventToUpdate.participants.length !== mainLength) {
        found = true;
        removedFromMain = true;
      }

      const reserveLength = eventToUpdate.reserve.length;
      eventToUpdate.reserve = eventToUpdate.reserve.filter((participant) => participant.id !== participantId);
      if (eventToUpdate.reserve.length !== reserveLength) found = true;

      if (eventToUpdate.presentIds) delete eventToUpdate.presentIds[participantId];
      if (removedFromMain) promoteReserve(eventToUpdate);
      return eventToUpdate;
    });

    if (!found) return { ok: false, reason: "not-found" };
    if (localStorage.getItem(JOINED_PREFIX + eventId) === participantId) localStorage.removeItem(JOINED_PREFIX + eventId);
    return { ok: true, promoted: removedFromMain };
  }

  function removeGuestFromEvent(eventId, participantId, guestIndex, options = {}) {
    const event = getEventById(eventId);
    if (!event) return { ok: false, reason: "not-found" };
    if (!options.admin && !canLeaveEvent(event)) return { ok: false, reason: "locked" };

    let found = false;
    let removedFromMain = false;

    updateEvent(eventId, (eventToUpdate) => {
      ["participants", "reserve"].forEach((listName) => {
        eventToUpdate[listName] = Array.isArray(eventToUpdate[listName]) ? eventToUpdate[listName] : [];
        eventToUpdate[listName] = eventToUpdate[listName].map((item) => {
          if (item.id !== participantId) return item;

          const guests = getGuestNames(item);
          if (guestIndex < 0 || guestIndex >= guests.length) return item;
          guests.splice(guestIndex, 1);
          found = true;
          if (listName === "participants") removedFromMain = true;

          if (eventToUpdate.presentIds) delete eventToUpdate.presentIds[`${participantId}:guest:${guestIndex}`];
          return { ...item, guests };
        });
      });

      if (removedFromMain) promoteReserve(eventToUpdate);
      return eventToUpdate;
    });

    return found ? { ok: true, promoted: removedFromMain } : { ok: false, reason: "not-found" };
  }

  function addGuestsToParticipant(eventId, participantId, guestNames) {
    const event = getEventById(eventId);
    if (!event) return { ok: false, reason: "not-found" };
    if (!isEventActive(event)) return { ok: false, reason: "concluded" };

    const cleanGuests = guestNames.map((name) => String(name).trim()).filter(Boolean);
    if (!cleanGuests.length) return { ok: false, reason: "empty" };

    let found = false;
    let addedToMain = 0;
    let addedToReserve = 0;

    updateEvent(eventId, (eventToUpdate) => {
      eventToUpdate.participants = Array.isArray(eventToUpdate.participants) ? eventToUpdate.participants : [];
      eventToUpdate.reserve = Array.isArray(eventToUpdate.reserve) ? eventToUpdate.reserve : [];

      const participant = eventToUpdate.participants.find((item) => item.id === participantId);
      if (!participant) return eventToUpdate;

      found = true;
      const existingGuests = getGuestNames(participant);

      cleanGuests.forEach((guestName) => {
        const remaining = Math.max(0, Number(eventToUpdate.maxPeople || 0) - countPeople(eventToUpdate.participants));
        if (remaining > 0) {
          existingGuests.push(guestName);
          addedToMain += 1;
          participant.guests = [...existingGuests];
        } else {
          eventToUpdate.reserve.push({
            id: generateParticipantId(),
            name: guestName,
            guests: [],
            joinedAt: new Date().toISOString(),
            parentParticipantId: participant.id,
            statusLabel: `Reserva - convidado de ${participant.name}`
          });
          addedToReserve += 1;
        }
      });

      participant.guests = [...existingGuests];
      return eventToUpdate;
    });

    if (!found) return { ok: false, reason: "not-main" };
    return { ok: true, addedToMain, addedToReserve };
  }

  function getLocalDateTimeValue(date) {
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 16);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }


  function getFirstName(fullName) {
    return String(fullName || "").trim().split(/\s+/)[0] || "Jogador";
  }

  function formatTeamScoreLabel(players, fallback) {
    if (!Array.isArray(players) || !players.length) return fallback;
    const names = players.map((player) => getFirstName(player.name || player)).filter(Boolean);
    if (!names.length) return fallback;
    const visibleNames = names.slice(0, 4).join(" / ");
    return names.length > 4 ? `${visibleNames} +${names.length - 4}` : visibleNames;
  }

  function getMatchTeamLabels(event) {
    const teams = event?.matchTeams || {};
    return {
      teamA: formatTeamScoreLabel(teams.teamA, "Time 1"),
      teamB: formatTeamScoreLabel(teams.teamB, "Time 2")
    };
  }

  function getPersonRows(participants) {
    const rows = [];
    participants.forEach((participant) => {
      rows.push({ key: participant.id, name: participant.name, type: "Titular", participantId: participant.id });
      getGuestNames(participant).forEach((guestName, guestIndex) => {
        rows.push({
          key: `${participant.id}:guest:${guestIndex}`,
          name: guestName,
          type: `Convidado de ${participant.name}`,
          participantId: participant.id,
          guestIndex
        });
      });
    });
    return rows;
  }

  function renderPeopleList(listElement, participants, options = {}) {
    if (!listElement) return;

    if (!participants.length) {
      listElement.innerHTML = '<li class="empty-state">Nenhum participante cadastrado.</li>';
      return;
    }

    listElement.innerHTML = participants.map((participant, reserveIndex) => {
      const guestNames = getGuestNames(participant);
      const count = 1 + guestNames.length;
      const personLabel = count === 1 ? "pessoa" : "pessoas";
      const isCurrentUser = options.currentParticipantId === participant.id;
      const joinedAt = participant.joinedAt ? ` • cadastro: ${formatDateTime(participant.joinedAt)}` : "";
      const reserveLabel = options.isReserve ? `<span class="reserve-position">Reserva #${reserveIndex + 1}</span>` : "";
      const presenceToggle = options.showPresenceToggle
        ? `<label class="presence-toggle"><input type="checkbox" data-present-person="${participant.id}" ${options.presentIds?.[participant.id] ? "checked" : ""}> No local</label>`
        : "";
      const removeButton = options.showRemoveButton
        ? `<button class="icon-trash-button small-trash" type="button" data-remove-participant="${participant.id}" aria-label="Remover ${escapeHtml(participant.name)}" title="Remover">🗑</button>`
        : "";

      const guestsList = guestNames.map((guestName, guestIndex) => {
        const guestKey = `${participant.id}:guest:${guestIndex}`;
        const guestPresenceToggle = options.showPresenceToggle
          ? `<label class="presence-toggle"><input type="checkbox" data-present-person="${guestKey}" ${options.presentIds?.[guestKey] ? "checked" : ""}> No local</label>`
          : "";
        const removeGuestButton = options.showRemoveGuestButton
          ? `<button class="icon-trash-button small-trash" type="button" data-remove-guest-participant="${participant.id}" data-remove-guest-index="${guestIndex}" aria-label="Remover convidado ${escapeHtml(guestName)}" title="Remover convidado">🗑</button>`
          : "";
        return `<div class="person-meta guest-row"><span>↳ ${escapeHtml(guestName)} (Convidado por: ${escapeHtml(participant.name)})</span><div class="person-actions">${guestPresenceToggle}${removeGuestButton}</div></div>`;
      }).join("");

      return `
        <li>
          <div>
            <div class="person-name">${reserveLabel}${escapeHtml(participant.name)}${isCurrentUser ? " (você)" : ""} → ${count} ${personLabel}${guestNames.length ? " (incluindo convidados)" : ""}</div>
            <div class="person-meta">${escapeHtml(participant.statusLabel || "")}${joinedAt}</div>
            ${guestsList}
          </div>
          <div class="person-actions">${presenceToggle}${removeButton}</div>
        </li>
      `;
    }).join("");
  }

  function shuffleArray(items) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
    }
    return copy;
  }

  function isFootballOrFutsal(sport) {
    const value = String(sport || "").toLowerCase();
    return value.includes("futebol") || value.includes("futsal");
  }

  function normalizeMatch(event) {
    const match = event?.match && typeof event.match === "object" ? event.match : {};
    const defaultDuration = isFootballOrFutsal(event?.sport) ? 7 * 60 : 10 * 60;
    const durationSeconds = Math.max(60, Math.floor(Number(match.durationSeconds || defaultDuration)));
    const targetScore = isFootballOrFutsal(event?.sport) ? 2 : Math.max(1, Math.floor(Number(match.targetScore || 2)));

    return {
      enabled: Boolean(match.enabled),
      durationSeconds,
      targetScore,
      scoreA: Math.max(0, Math.floor(Number(match.scoreA || 0))),
      scoreB: Math.max(0, Math.floor(Number(match.scoreB || 0))),
      status: match.status || "ready",
      startedAt: match.startedAt || "",
      endsAt: match.endsAt || "",
      remainingSeconds: Math.max(0, Math.floor(Number(match.remainingSeconds || durationSeconds))),
      finishedReason: match.finishedReason || ""
    };
  }

  function getMatchRemainingSeconds(match) {
    const normalized = normalizeMatch({ match });

    if (normalized.status === "running" && normalized.endsAt) {
      return Math.max(0, Math.ceil((new Date(normalized.endsAt).getTime() - Date.now()) / 1000));
    }

    if (normalized.status === "ready") return normalized.durationSeconds;
    return normalized.remainingSeconds;
  }

  function formatMatchClock(seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds || 0)));
    const minutes = Math.floor(safeSeconds / 60);
    const remainingSeconds = safeSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  function getMatchStatusText(match) {
    const status = normalizeMatch({ match }).status;
    if (status === "running") return "Partida em andamento";
    if (status === "paused") return "Partida pausada";
    if (status === "finished") return "Partida encerrada";
    return "Aguardando início";
  }

  function playWhistle() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;

      const context = new AudioContext();
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.45, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.55);
      gain.connect(context.destination);

      [0, 0.18, 0.36].forEach((offset) => {
        const oscillator = context.createOscillator();
        oscillator.type = "square";
        oscillator.frequency.setValueAtTime(1200, context.currentTime + offset);
        oscillator.connect(gain);
        oscillator.start(context.currentTime + offset);
        oscillator.stop(context.currentTime + offset + 0.12);
      });

      window.setTimeout(() => context.close(), 900);
    } catch (error) {
      console.warn("Não foi possível tocar o apito:", error);
    }
  }

  function finishMatch(eventId, reason, shouldWhistle = true) {
    let finishedNow = false;
    updateEvent(eventId, (eventToUpdate) => {
      const match = normalizeMatch(eventToUpdate);
      if (!match.enabled || match.status === "finished") return eventToUpdate;

      match.status = "finished";
      match.remainingSeconds = 0;
      match.finishedReason = reason || "Partida encerrada";
      match.finishedAt = new Date().toISOString();
      eventToUpdate.match = match;
      finishedNow = true;
      return eventToUpdate;
    });

    if (finishedNow && shouldWhistle) playWhistle();
    return finishedNow;
  }

  function checkMatchAutoFinish(eventId) {
    const event = getEventById(eventId);
    if (!event) return false;

    const match = normalizeMatch(event);
    if (!match.enabled || match.status !== "running") return false;

    if (match.scoreA >= match.targetScore || match.scoreB >= match.targetScore) {
      return finishMatch(eventId, "Placar limite atingido");
    }

    if (getMatchRemainingSeconds(match) <= 0) {
      return finishMatch(eventId, "Tempo encerrado");
    }

    return false;
  }

  function initAdminPage() {
    const form = $("#eventForm");
    const startsAtInput = $("#startsAtInput");
    const saveEventBtn = $("#saveEventBtn");
    const cancelEditBtn = $("#cancelEditBtn");
    let selectedEventId = localStorage.getItem(LAST_ADMIN_KEY) || "";
    let editingEventId = "";

    startsAtInput.min = getLocalDateTimeValue(new Date());

    function resetFormMode() {
      editingEventId = "";
      form.reset();
      selectedLocation = null;
      $("#locationLatInput").value = "";
      $("#locationLngInput").value = "";
      saveEventBtn.textContent = "Criar evento";
      cancelEditBtn.hidden = true;
      startsAtInput.min = getLocalDateTimeValue(new Date());
    }

    function fillFormForEdit(event) {
      if (!event) return;
      editingEventId = event.id;
      form.elements.name.value = event.name || "";
      form.elements.sport.value = event.sport || "";
      form.elements.startsAt.value = event.startsAt || "";
      form.elements.durationHours.value = event.durationHours || "";
      form.elements.totalValue.value = event.totalValue || "";
      form.elements.maxPeople.value = event.maxPeople || "";
      const location = getEventLocation(event);
      form.elements.location.value = location.local || "";
      $("#locationLatInput").value = hasValidCoordinates(location) ? String(location.lat) : "";
      $("#locationLngInput").value = hasValidCoordinates(location) ? String(location.lng) : "";
      selectedLocation = hasValidCoordinates(location) ? location : null;
      saveEventBtn.textContent = "Salvar alterações";
      cancelEditBtn.hidden = false;
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      if (!form.reportValidity()) {
        setFeedback($("#adminFeedback"), "Preencha todos os campos corretamente.", "error");
        return;
      }

      const data = new FormData(form);
      const startsAt = data.get("startsAt");
      const durationHours = toNumber(data.get("durationHours"));
      const totalValue = toNumber(data.get("totalValue"));
      const maxPeople = Math.floor(toNumber(data.get("maxPeople")));
      const location = selectedLocation || {
        local: String(data.get("location")).trim(),
        lat: toNumber(data.get("locationLat")),
        lng: toNumber(data.get("locationLng"))
      };

      if (!editingEventId && !isFutureDate(startsAt)) {
        setFeedback($("#adminFeedback"), "Escolha uma data e hora futuras.", "error");
        return;
      }

      if (durationHours <= 0 || totalValue <= 0 || maxPeople < 1) {
        setFeedback($("#adminFeedback"), "Use valores positivos para duração, valor e limite.", "error");
        return;
      }

      if (!location.local || !hasValidCoordinates(location)) {
        setFeedback($("#adminFeedback"), "Digite e selecione um local válido nas sugestões do Google Maps.", "error");
        return;
      }

      if (editingEventId) {
        updateEvent(editingEventId, (eventToUpdate) => {
          eventToUpdate.name = String(data.get("name")).trim();
          eventToUpdate.sport = String(data.get("sport")).trim();
          eventToUpdate.startsAt = startsAt;
          eventToUpdate.durationHours = durationHours;
          eventToUpdate.totalValue = totalValue;
          eventToUpdate.maxPeople = maxPeople;
          eventToUpdate.location = location;
          promoteReserve(eventToUpdate);
          return eventToUpdate;
        });
        selectedEventId = editingEventId;
        localStorage.setItem(LAST_ADMIN_KEY, selectedEventId);
        resetFormMode();
        setFeedback($("#adminFeedback"), "Evento atualizado com sucesso.", "success");
        renderAdmin();
        return;
      }

      const newEvent = {
        id: generateEventId(),
        name: String(data.get("name")).trim(),
        sport: String(data.get("sport")).trim(),
        startsAt,
        durationHours,
        totalValue,
        maxPeople,
        location,
        participants: [],
        reserve: [],
        presentIds: {},
        status: "active",
        match: { enabled: false },
        createdAt: new Date().toISOString()
      };

      const events = loadEvents();
      events.unshift(newEvent);
      saveEvents(events);
      selectedEventId = newEvent.id;
      localStorage.setItem(LAST_ADMIN_KEY, selectedEventId);
      resetFormMode();
      setFeedback($("#adminFeedback"), "Evento criado com sucesso.", "success");
      renderAdmin();
    });

    cancelEditBtn.addEventListener("click", () => {
      resetFormMode();
      setFeedback($("#adminFeedback"), "Edição cancelada.", "success");
    });

    $("#copyLinkBtn").addEventListener("click", async () => {
      const input = $("#eventLink");
      input.select();
      input.setSelectionRange(0, input.value.length);
      try {
        await navigator.clipboard.writeText(input.value);
        setFeedback($("#adminFeedback"), "Link copiado.", "success");
      } catch (error) {
        document.execCommand("copy");
        setFeedback($("#adminFeedback"), "Link selecionado para copiar.", "success");
      }
    });

    function openAdminModal(modalId) {
      const modal = $("#" + modalId);
      if (!modal) return;
      if (typeof modal.showModal === "function") modal.showModal();
      else modal.setAttribute("open", "");
    }

    [
      ["#openParticipantsModalBtn", "participantsModal"],
      ["#openTeamsModalBtn", "teamsModal"],
      ["#openMatchModalBtn", "matchModal"],
      ["#openTrashModalBtn", "trashModal"]
    ].forEach(([buttonSelector, modalId]) => {
      const button = $(buttonSelector);
      if (button) button.addEventListener("click", () => openAdminModal(modalId));
    });

    document.querySelectorAll("[data-close-modal]").forEach((button) => {
      button.addEventListener("click", () => {
        const modal = $("#" + button.dataset.closeModal);
        if (!modal) return;
        if (typeof modal.close === "function") modal.close();
        else modal.removeAttribute("open");
      });
    });

    document.querySelectorAll(".app-modal").forEach((modal) => {
      modal.addEventListener("click", (event) => {
        if (event.target === modal) modal.close();
      });
    });

    $("#eventsList").addEventListener("click", (event) => {
      const deleteButton = event.target.closest("[data-delete-event]");
      if (deleteButton) {
        const eventIdToDelete = deleteButton.dataset.deleteEvent;
        const removed = moveEventToTrash(eventIdToDelete);
        if (removed) {
          if (selectedEventId === eventIdToDelete) {
            selectedEventId = "";
            localStorage.removeItem(LAST_ADMIN_KEY);
          }
          setFeedback($("#adminFeedback"), "Evento movido para a lixeira.", "success");
          renderAdmin();
        }
        return;
      }

      const item = event.target.closest("[data-event-id]");
      if (!item) return;
      selectedEventId = item.dataset.eventId;
      localStorage.setItem(LAST_ADMIN_KEY, selectedEventId);
      renderAdmin();
    });

    $("#editEventBtn").addEventListener("click", () => fillFormForEdit(getEventById(selectedEventId)));

    $("#closeEventPanelBtn").addEventListener("click", () => {
      selectedEventId = "";
      localStorage.removeItem(LAST_ADMIN_KEY);
      renderAdmin();
    });

    $("#finishEventBtn").addEventListener("click", () => {
      updateEvent(selectedEventId, (eventToUpdate) => {
        eventToUpdate.status = "concluded";
        eventToUpdate.finishedAt = new Date().toISOString();
        return eventToUpdate;
      });
      selectedEventId = "";
      localStorage.removeItem(LAST_ADMIN_KEY);
      setFeedback($("#adminFeedback"), "Evento concluído e finalizado. O painel foi fechado para manter a tela limpa.", "success");
      renderAdmin();
    });

    $("#reactivateEventBtn").addEventListener("click", () => {
      updateEvent(selectedEventId, (eventToUpdate) => {
        eventToUpdate.status = "active";
        eventToUpdate.startsAt = getLocalDateTimeValue(new Date());
        delete eventToUpdate.finishedAt;
        delete eventToUpdate.autoFinished;
        return eventToUpdate;
      });
      setFeedback($("#adminFeedback"), "Evento reativado ao vivo. A duração passou a contar a partir de agora.", "success");
      renderAdmin();
    });

    $("#enableTeamsInput").addEventListener("change", () => {
      $("#teamsControls").hidden = !$("#enableTeamsInput").checked;
      $("#teamsResult").innerHTML = "";
      setFeedback($("#teamsFeedback"), "");
    });

    $("#generateTeamsBtn").addEventListener("click", () => {
      const event = getEventById(selectedEventId);
      if (!event) return;

      const requestedPlayers = Math.floor(toNumber($("#playersToDrawInput").value));
      const presentRows = getPersonRows(calculateEvent(event).participants).filter((row) => normalizeEvent(event).presentIds[row.key]);

      if (requestedPlayers < 2) {
        setFeedback($("#teamsFeedback"), "Informe pelo menos 2 jogadores.", "error");
        return;
      }

      if (presentRows.length < requestedPlayers) {
        setFeedback($("#teamsFeedback"), `Confirmados no local: ${presentRows.length}. Faltam jogadores para gerar ${requestedPlayers}.`, "error");
        return;
      }

      const shuffled = shuffleArray(presentRows);
      const selectedPlayers = shuffled.slice(0, requestedPlayers);
      const waitingPlayers = shuffled.slice(requestedPlayers);
      const split = Math.ceil(requestedPlayers / 2);
      const teamA = selectedPlayers.slice(0, split);
      const teamB = selectedPlayers.slice(split);
      const teamALabel = formatTeamScoreLabel(teamA, "Time 1");
      const teamBLabel = formatTeamScoreLabel(teamB, "Time 2");

      updateEvent(selectedEventId, (eventToUpdate) => {
        eventToUpdate.matchTeams = {
          teamA: teamA.map((person) => ({ key: person.key, name: person.name })),
          teamB: teamB.map((person) => ({ key: person.key, name: person.name })),
          waiting: waitingPlayers.map((person) => ({ key: person.key, name: person.name })),
          generatedAt: new Date().toISOString()
        };
        return eventToUpdate;
      });

      $("#teamsResult").innerHTML = `
        <div class="team-card"><h4>Time 1 <small>${escapeHtml(teamALabel)}</small></h4><ol>${teamA.map((person) => `<li>${escapeHtml(person.name)}</li>`).join("")}</ol></div>
        <div class="team-card"><h4>Time 2 <small>${escapeHtml(teamBLabel)}</small></h4><ol>${teamB.map((person) => `<li>${escapeHtml(person.name)}</li>`).join("")}</ol></div>
        <div class="team-card"><h4>Reservas para entrar no time que perder</h4>${waitingPlayers.length ? `<ol>${waitingPlayers.map((person) => `<li>${escapeHtml(person.name)}</li>`).join("")}</ol>` : '<p>Nenhum reserva confirmado além dos jogadores sorteados.</p>'}</div>
      `;
      setFeedback($("#teamsFeedback"), "Times gerados. O placar agora usa o primeiro nome dos jogadores.", "success");
      renderAdmin();
    });

    function getMatchConfigFromControls(event) {
      const isFixedSport = isFootballOrFutsal(event?.sport);
      let durationSeconds = 10 * 60;
      let targetScore = 2;

      if (isFixedSport) {
        const selectedPreset = document.querySelector("input[name='matchPreset']:checked")?.value || "7";
        durationSeconds = selectedPreset === "10" ? 10 * 60 : 7 * 60;
        targetScore = 2;
      } else {
        durationSeconds = Math.max(1, Math.floor(toNumber($("#customMatchMinutes").value) || 10)) * 60;
        targetScore = Math.max(1, Math.floor(toNumber($("#customMatchTargetScore").value) || 2));
      }

      return { durationSeconds, targetScore };
    }

    function saveMatchSettings() {
      const event = getEventById(selectedEventId);
      if (!event) return null;

      const enabled = $("#enableMatchInput").checked;
      const config = getMatchConfigFromControls(event);
      let updatedMatch = null;

      updateEvent(selectedEventId, (eventToUpdate) => {
        const currentMatch = normalizeMatch(eventToUpdate);
        updatedMatch = {
          ...currentMatch,
          enabled,
          durationSeconds: config.durationSeconds,
          targetScore: config.targetScore
        };

        if (!enabled) {
          updatedMatch.status = "ready";
          updatedMatch.scoreA = 0;
          updatedMatch.scoreB = 0;
          updatedMatch.remainingSeconds = config.durationSeconds;
          updatedMatch.finishedReason = "";
          updatedMatch.startedAt = "";
          updatedMatch.endsAt = "";
        }

        if (enabled && ["ready", "finished"].includes(updatedMatch.status)) {
          updatedMatch.remainingSeconds = config.durationSeconds;
        }

        eventToUpdate.match = updatedMatch;
        return eventToUpdate;
      });

      return updatedMatch;
    }

    $("#enableMatchInput").addEventListener("change", () => {
      saveMatchSettings();
      renderAdmin();
    });

    document.querySelectorAll("input[name='matchPreset']").forEach((input) => {
      input.addEventListener("change", () => {
        saveMatchSettings();
        renderAdmin();
      });
    });

    ["#customMatchMinutes", "#customMatchTargetScore"].forEach((selector) => {
      $(selector).addEventListener("input", () => {
        saveMatchSettings();
        renderAdmin();
      });
    });

    $("#startMatchBtn").addEventListener("click", () => {
      const event = getEventById(selectedEventId);
      if (!event || !isEventActive(event)) return;
      const config = getMatchConfigFromControls(event);

      updateEvent(selectedEventId, (eventToUpdate) => {
        const match = normalizeMatch(eventToUpdate);
        const now = Date.now();
        eventToUpdate.match = {
          ...match,
          enabled: true,
          durationSeconds: config.durationSeconds,
          targetScore: config.targetScore,
          scoreA: 0,
          scoreB: 0,
          status: "running",
          startedAt: new Date(now).toISOString(),
          endsAt: new Date(now + config.durationSeconds * 1000).toISOString(),
          remainingSeconds: config.durationSeconds,
          finishedReason: ""
        };
        return eventToUpdate;
      });

      setFeedback($("#matchFeedback"), "Partida iniciada. Timer em andamento.", "success");
      renderAdmin();
    });

    $("#pauseMatchBtn").addEventListener("click", () => {
      updateEvent(selectedEventId, (eventToUpdate) => {
        const match = normalizeMatch(eventToUpdate);
        if (match.status !== "running") return eventToUpdate;
        match.remainingSeconds = getMatchRemainingSeconds(match);
        match.status = "paused";
        match.endsAt = "";
        eventToUpdate.match = match;
        return eventToUpdate;
      });
      setFeedback($("#matchFeedback"), "Tempo pausado.", "success");
      renderAdmin();
    });

    $("#resumeMatchBtn").addEventListener("click", () => {
      updateEvent(selectedEventId, (eventToUpdate) => {
        const match = normalizeMatch(eventToUpdate);
        if (match.status !== "paused") return eventToUpdate;
        const remaining = Math.max(1, getMatchRemainingSeconds(match));
        match.status = "running";
        match.endsAt = new Date(Date.now() + remaining * 1000).toISOString();
        match.remainingSeconds = remaining;
        eventToUpdate.match = match;
        return eventToUpdate;
      });
      setFeedback($("#matchFeedback"), "Tempo retomado.", "success");
      renderAdmin();
    });

    $("#resetMatchBtn").addEventListener("click", () => {
      const event = getEventById(selectedEventId);
      if (!event) return;
      const config = getMatchConfigFromControls(event);
      updateEvent(selectedEventId, (eventToUpdate) => {
        eventToUpdate.match = {
          enabled: $("#enableMatchInput").checked,
          durationSeconds: config.durationSeconds,
          targetScore: config.targetScore,
          scoreA: 0,
          scoreB: 0,
          status: "ready",
          startedAt: "",
          endsAt: "",
          remainingSeconds: config.durationSeconds,
          finishedReason: ""
        };
        return eventToUpdate;
      });
      setFeedback($("#matchFeedback"), "Partida zerada.", "success");
      renderAdmin();
    });

    $("#matchScoreControls").addEventListener("click", (event) => {
      const button = event.target.closest("[data-score-team]");
      if (!button) return;

      updateEvent(selectedEventId, (eventToUpdate) => {
        const match = normalizeMatch(eventToUpdate);
        if (!match.enabled || match.status === "finished") return eventToUpdate;

        const field = button.dataset.scoreTeam === "A" ? "scoreA" : "scoreB";
        const delta = Number(button.dataset.scoreDelta || 0);
        match[field] = Math.max(0, Number(match[field] || 0) + delta);
        eventToUpdate.match = match;
        return eventToUpdate;
      });

      checkMatchAutoFinish(selectedEventId);
      renderAdmin();
    });

    $("#adminParticipantsList").addEventListener("change", (event) => {
      const checkbox = event.target.closest("[data-present-person]");
      if (!checkbox) return;
      updateEvent(selectedEventId, (eventToUpdate) => {
        eventToUpdate.presentIds = eventToUpdate.presentIds || {};
        if (checkbox.checked) eventToUpdate.presentIds[checkbox.dataset.presentPerson] = true;
        else delete eventToUpdate.presentIds[checkbox.dataset.presentPerson];
        return eventToUpdate;
      });
      renderAdmin();
    });

    function handleParticipantRemoveClick(event, listName) {
      const guestButton = event.target.closest("[data-remove-guest-participant]");
      if (guestButton) {
        const result = removeGuestFromEvent(selectedEventId, guestButton.dataset.removeGuestParticipant, Number(guestButton.dataset.removeGuestIndex), { admin: true });
        if (!result.ok) {
          setFeedback($("#adminRemoveFeedback"), "Convidado não encontrado.", "error");
          renderAdmin();
          return;
        }
        setFeedback($("#adminRemoveFeedback"), listName === "reserve" ? "Convidado removido da reserva." : "Convidado removido. Reserva promovida se houver vaga.", "success");
        renderAdmin();
        return;
      }

      const button = event.target.closest("[data-remove-participant]");
      if (!button) return;
      const result = removeParticipantFromEvent(selectedEventId, button.dataset.removeParticipant, { admin: true });
      if (!result.ok) {
        setFeedback($("#adminRemoveFeedback"), "Participante não encontrado.", "error");
        renderAdmin();
        return;
      }
      setFeedback($("#adminRemoveFeedback"), listName === "reserve" ? "Participante removido da reserva." : "Participante removido. Reserva promovida se houver vaga.", "success");
      renderAdmin();
    }

    $("#adminParticipantsList").addEventListener("click", (event) => handleParticipantRemoveClick(event, "main"));
    $("#adminReserveList").addEventListener("click", (event) => handleParticipantRemoveClick(event, "reserve"));

    $("#trashList").addEventListener("click", (event) => {
      const restoreButton = event.target.closest("[data-restore-event]");
      if (!restoreButton) return;
      const restored = restoreEventFromTrash(restoreButton.dataset.restoreEvent);
      if (restored) {
        setFeedback($("#trashFeedback"), "Evento restaurado. Toque no evento na lista principal para abrir os detalhes.", "success");
        renderAdmin();
      }
    });

    $("#clearTrashBtn").addEventListener("click", () => {
      clearTrashEvents();
      setFeedback($("#trashFeedback"), "Lixeira limpa.", "success");
      renderAdmin();
    });

    function renderAdmin() {
      if (selectedEventId) checkMatchAutoFinish(selectedEventId);
      const events = finalizeExpiredEvents();
      if (selectedEventId && !events.some((event) => event.id === selectedEventId)) {
        selectedEventId = "";
        localStorage.removeItem(LAST_ADMIN_KEY);
      }
      renderEventsList(events, selectedEventId);
      renderSelectedEvent(events.find((event) => event.id === selectedEventId));
      renderTrashList(purgeExpiredTrashEvents());
    }

    function renderEventsList(events, activeId) {
      const container = $("#eventsList");
      if (!events.length) {
        container.innerHTML = '<div class="empty-state">Nenhum evento criado ainda.</div>';
        return;
      }

      container.innerHTML = events.map((event) => {
        const normalized = normalizeEvent(event);
        const totals = calculateEvent(normalized);
        const activeClass = normalized.id === activeId ? " active" : "";
        const statusText = normalized.status === "concluded" ? "Concluído" : "Ao vivo";
        return `
          <div class="event-card${activeClass}">
            <button class="event-item" type="button" data-event-id="${normalized.id}">
              <div class="event-name">${escapeHtml(normalized.name)} <span class="status-mini">${statusText}</span></div>
              <div class="event-meta">${escapeHtml(normalized.sport)} • ${formatDateTime(normalized.startsAt)} • ${totals.totalPeople}/${normalized.maxPeople} pessoas • reserva: ${totals.reservePeople}</div>
            </button>
            <button class="icon-trash-button event-trash" type="button" data-delete-event="${normalized.id}" aria-label="Mover ${escapeHtml(normalized.name)} para a lixeira" title="Mover para a lixeira">🗑</button>
          </div>
        `;
      }).join("");
    }

    function renderTrashList(trashEvents) {
      const container = $("#trashList");
      if (!container) return;
      if (!trashEvents.length) {
        container.innerHTML = '<div class="empty-state">Lixeira vazia.</div>';
        return;
      }

      container.innerHTML = trashEvents.map((event) => {
        const deletedAt = formatDateTime(event.deletedAt);
        return `
          <div class="event-card trash-card">
            <div class="event-item static-event-item">
              <div class="event-name">${escapeHtml(event.name)}</div>
              <div class="event-meta">Removido em ${deletedAt} • limpeza automática em ${TRASH_RETENTION_DAYS} dias</div>
            </div>
            <button class="secondary-action small-action" type="button" data-restore-event="${event.id}">Restaurar</button>
          </div>
        `;
      }).join("");
    }

    function renderMatchControls(event) {
      const box = $("#matchControlBox");
      if (!box) return;

      const normalized = normalizeEvent(event);
      const match = normalizeMatch(normalized);
      const isFixedSport = isFootballOrFutsal(normalized.sport);
      const active = isEventActive(normalized);
      const remainingSeconds = getMatchRemainingSeconds(match);

      $("#enableMatchInput").checked = match.enabled;
      $("#matchSetupControls").hidden = !match.enabled;
      $("#soccerMatchOptions").hidden = !isFixedSport || !match.enabled;
      $("#customMatchOptions").hidden = isFixedSport || !match.enabled;
      $("#matchScoreboard").hidden = !match.enabled;

      const presetValue = match.durationSeconds === 10 * 60 ? "10" : "7";
      const presetInput = document.querySelector(`input[name='matchPreset'][value='${presetValue}']`);
      if (presetInput) presetInput.checked = true;

      $("#customMatchMinutes").value = String(Math.max(1, Math.round(match.durationSeconds / 60)));
      $("#customMatchTargetScore").value = String(match.targetScore);
      $("#matchRuleHint").textContent = isFixedSport
        ? "Futebol/Futsal: escolha 7 minutos ou 10 minutos. A partida encerra no tempo ou quando alguém fizer 2 gols."
        : "Defina o tempo e o placar/pontos limite. A partida encerra quando um dos dois limites for atingido.";

      $("#matchTimer").textContent = formatMatchClock(remainingSeconds);
      $("#matchStatus").textContent = getMatchStatusText(match);
      const teamLabels = getMatchTeamLabels(normalized);
      $("#matchTeamALabel").textContent = teamLabels.teamA;
      $("#matchTeamBLabel").textContent = teamLabels.teamB;
      $("#matchScoreA").textContent = String(match.scoreA);
      $("#matchScoreB").textContent = String(match.scoreB);
      $("#matchTargetScoreLabel").textContent = String(match.targetScore);
      $("#matchEndReason").textContent = match.finishedReason ? `Motivo: ${match.finishedReason}` : "";

      $("#startMatchBtn").disabled = !active || !match.enabled || match.status === "running";
      $("#pauseMatchBtn").disabled = !active || !match.enabled || match.status !== "running";
      $("#resumeMatchBtn").disabled = !active || !match.enabled || match.status !== "paused";
      $("#resetMatchBtn").disabled = !active || !match.enabled;
      document.querySelectorAll("#matchScoreControls button").forEach((button) => {
        button.disabled = !active || !match.enabled || match.status === "finished";
      });
    }

    function renderSelectedEvent(event) {
      const panel = $("#adminResult");
      if (!event) {
        panel.hidden = true;
        return;
      }

      const normalized = normalizeEvent(event);
      const totals = calculateEvent(normalized);
      const link = buildEventLink(normalized.id);
      panel.hidden = false;
      $("#createdEventId").textContent = `${normalized.id} • ${normalized.status === "concluded" ? "Concluído" : "Ao vivo"}`;
      $("#simulatedPath").textContent = `/evento.html?id=${normalized.id}`;
      $("#eventLink").value = link;
      $("#openEventLink").href = link;
      $("#adminPerPerson").textContent = formatCurrency(totals.perPerson);
      $("#adminRemaining").textContent = String(totals.remaining);
      $("#adminPeopleCount").textContent = String(totals.totalPeople);
      $("#adminLastUpdate").textContent = `Atualizado ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      $("#finishEventBtn").hidden = normalized.status === "concluded";
      $("#reactivateEventBtn").hidden = normalized.status !== "concluded";
      $("#enableTeamsInput").disabled = normalized.status === "concluded";
      $("#teamsControls").hidden = !$("#enableTeamsInput").checked || normalized.status === "concluded";
      renderMatchControls(normalized);

      renderPeopleList($("#adminParticipantsList"), totals.participants, {
        showRemoveButton: true,
        showRemoveGuestButton: true,
        showPresenceToggle: true,
        presentIds: normalized.presentIds
      });
      renderPeopleList($("#adminReserveList"), totals.reserve, {
        showRemoveButton: true,
        showRemoveGuestButton: true,
        isReserve: true
      });
    }

    window.addEventListener("storage", renderAdmin);
    window.addEventListener("events:changed", renderAdmin);
    window.setInterval(renderAdmin, 1000);
    renderAdmin();
  }

  function initPublicPage() {
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get("id");
    importEventSnapshotFromUrl();
    const joinForm = $("#joinForm");
    const hasGuestsInput = $("#hasGuestsInput");
    const guestsBlock = $("#guestsBlock");
    const guestsInput = $("#guestsInput");
    const guestNamesFields = $("#guestNamesFields");
    const addGuestsQuantityInput = $("#addGuestsQuantityInput");
    const addGuestNamesFields = $("#addGuestNamesFields");

    function renderGuestNameInputs() {
      const currentInputs = Array.from(guestNamesFields.querySelectorAll("[data-guest-name-input]"));
      const activeInput = document.activeElement?.matches?.("[data-guest-name-input]") ? document.activeElement : null;
      const activeIndex = activeInput ? Number(activeInput.dataset.guestIndex || -1) : -1;
      const selectionStart = activeInput ? activeInput.selectionStart : null;
      const existingNames = currentInputs.map((input) => input.value);
      const maxGuests = Number(guestsInput.max || 0);
      let quantity = hasGuestsInput.checked ? Math.floor(toNumber(guestsInput.value) || 0) : 0;
      if (maxGuests > 0) quantity = Math.min(quantity, maxGuests);
      quantity = Math.max(0, quantity);
      if (String(quantity) !== guestsInput.value && hasGuestsInput.checked) guestsInput.value = quantity ? String(quantity) : "";

      if (currentInputs.length === quantity) return;

      guestNamesFields.innerHTML = Array.from({ length: quantity }, (_, index) => {
        const value = escapeHtml(existingNames[index] || "");
        return `<label>Nome do convidado ${index + 1}<input type="text" data-guest-name-input data-guest-index="${index}" placeholder="Nome do convidado ${index + 1}" value="${value}" required minlength="2" autocomplete="off"></label>`;
      }).join("");

      if (activeIndex >= 0) {
        const nextInput = guestNamesFields.querySelector(`[data-guest-index='${activeIndex}']`);
        if (nextInput) {
          nextInput.focus();
          if (selectionStart !== null) nextInput.setSelectionRange(selectionStart, selectionStart);
        }
      }
    }


    function renderAddGuestNameInputs() {
      const currentInputs = Array.from(addGuestNamesFields.querySelectorAll("[data-add-guest-name-input]"));
      const activeInput = document.activeElement?.matches?.("[data-add-guest-name-input]") ? document.activeElement : null;
      const activeIndex = activeInput ? Number(activeInput.dataset.addGuestIndex || -1) : -1;
      const selectionStart = activeInput ? activeInput.selectionStart : null;
      const existingNames = currentInputs.map((input) => input.value);
      const quantity = Math.max(0, Math.floor(toNumber(addGuestsQuantityInput.value) || 0));

      if (currentInputs.length === quantity) return;

      addGuestNamesFields.innerHTML = Array.from({ length: quantity }, (_, index) => {
        const value = escapeHtml(existingNames[index] || "");
        return `<label>Nome do convidado ${index + 1}<input type="text" data-add-guest-name-input data-add-guest-index="${index}" placeholder="Nome do convidado ${index + 1}" value="${value}" required minlength="2" autocomplete="off"></label>`;
      }).join("");

      if (activeIndex >= 0) {
        const nextInput = addGuestNamesFields.querySelector(`[data-add-guest-index='${activeIndex}']`);
        if (nextInput) {
          nextInput.focus();
          if (selectionStart !== null) nextInput.setSelectionRange(selectionStart, selectionStart);
        }
      }
    }


    function syncGuestControls() {
      guestsBlock.hidden = !hasGuestsInput.checked;
      guestsInput.required = hasGuestsInput.checked;
      if (!hasGuestsInput.checked) {
        guestsInput.value = "";
        guestNamesFields.innerHTML = "";
        return;
      }
      if (!guestsInput.value) guestsInput.value = "1";
      renderGuestNameInputs();
    }

    hasGuestsInput.addEventListener("change", syncGuestControls);
    guestsInput.addEventListener("input", renderGuestNameInputs);
    addGuestsQuantityInput.addEventListener("input", renderAddGuestNameInputs);

    joinForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const currentEvent = getEventById(eventId);
      if (!currentEvent) {
        renderPublic();
        return;
      }

      if (!isEventActive(currentEvent)) {
        setFeedback($("#joinFeedback"), "Evento concluído. Novas confirmações estão bloqueadas.", "error");
        return;
      }

      if (!joinForm.reportValidity()) {
        setFeedback($("#joinFeedback"), "Preencha os dados e aceite o termo para confirmar.", "error");
        return;
      }

      const data = new FormData(joinForm);
      const name = String(data.get("participantName")).trim();
      const wantsGuests = hasGuestsInput.checked;
      const guestQuantity = wantsGuests ? Math.max(0, Math.floor(toNumber(data.get("guestsQuantity")) || 0)) : 0;
      const guestNames = wantsGuests ? Array.from(guestNamesFields.querySelectorAll("[data-guest-name-input]")).map((input) => input.value.trim()) : [];
      const totals = calculateEvent(currentEvent);
      const peopleToAdd = 1 + guestNames.length;

      if (!name) {
        setFeedback($("#joinFeedback"), "Informe o nome do participante.", "error");
        return;
      }
      if (wantsGuests && guestQuantity < 1) {
        setFeedback($("#joinFeedback"), "Informe a quantidade de convidados.", "error");
        return;
      }
      if (wantsGuests && (guestNames.length !== guestQuantity || guestNames.some((guestName) => !guestName))) {
        setFeedback($("#joinFeedback"), "Preencha o nome de todos os convidados.", "error");
        return;
      }

      const participant = { id: generateParticipantId(), name, guests: guestNames, joinedAt: new Date().toISOString() };
      let addResult = { mainId: participant.id, reserveCount: 0, split: false };

      updateEvent(eventId, (eventToUpdate) => {
        addResult = addParticipantRespectingCapacity(eventToUpdate, participant);
        return eventToUpdate;
      });

      localStorage.setItem(JOINED_PREFIX + eventId, addResult.mainId || participant.id);
      joinForm.reset();
      syncGuestControls();

      const message = addResult.reserveCount
        ? addResult.split
          ? "Presença confirmada. Parte dos convidados entrou na reserva por ordem de cadastro."
          : "Lista principal cheia. Você entrou na reserva por ordem de cadastro."
        : "Presença confirmada.";

      setFeedback($("#joinFeedback"), message, "success");
      renderPublic();
    });

    $("#addGuestsButton").addEventListener("click", () => {
      const participantId = localStorage.getItem(JOINED_PREFIX + eventId);
      const guestNames = Array.from(addGuestNamesFields.querySelectorAll("[data-add-guest-name-input]")).map((input) => input.value.trim());
      const quantity = Math.max(0, Math.floor(toNumber(addGuestsQuantityInput.value) || 0));

      if (!quantity || guestNames.length !== quantity || guestNames.some((name) => !name)) {
        setFeedback($("#leaveFeedback"), "Informe o nome de todos os convidados para adicionar.", "error");
        return;
      }

      const result = addGuestsToParticipant(eventId, participantId, guestNames);
      if (!result.ok) {
        setFeedback($("#leaveFeedback"), "Não foi possível adicionar convidado. Verifique se você está na lista principal.", "error");
        return;
      }

      addGuestsQuantityInput.value = "";
      addGuestNamesFields.innerHTML = "";

      const message = result.addedToReserve
        ? `Convidado adicionado. ${result.addedToReserve} entrou/entraram na reserva por falta de vaga.`
        : "Convidado adicionado.";

      setFeedback($("#leaveFeedback"), message, "success");
      renderPublic();
    });

    $("#leaveButton").addEventListener("click", () => {
      const participantId = localStorage.getItem(JOINED_PREFIX + eventId);
      const result = removeParticipantFromEvent(eventId, participantId);
      if (!result.ok && result.reason === "locked") {
        setFeedback($("#leaveFeedback"), "Não é possível sair da lista com menos de 1 hora para o evento.", "error");
        return;
      }
      if (!result.ok) {
        setFeedback($("#leaveFeedback"), "Participante não encontrado.", "error");
        renderPublic();
        return;
      }
      setFeedback($("#leaveFeedback"), "");
      setFeedback($("#joinFeedback"), "Você saiu da lista. A reserva foi promovida se havia vaga.", "success");
      renderPublic();
    });

    function handlePublicRemoveClick(event) {
      const guestButton = event.target.closest("[data-remove-guest-participant]");
      if (guestButton) {
        const result = removeGuestFromEvent(eventId, guestButton.dataset.removeGuestParticipant, Number(guestButton.dataset.removeGuestIndex));
        if (!result.ok && result.reason === "locked") {
          setFeedback($("#publicRemoveFeedback"), "Não é possível remover convidado com menos de 1 hora para o evento.", "error");
          return;
        }
        if (!result.ok) {
          setFeedback($("#publicRemoveFeedback"), "Convidado não encontrado.", "error");
          renderPublic();
          return;
        }
        setFeedback($("#publicRemoveFeedback"), "Convidado removido. Reserva promovida se havia vaga.", "success");
        renderPublic();
        return;
      }

      const button = event.target.closest("[data-remove-participant]");
      if (!button) return;
      const participantId = button.dataset.removeParticipant;
      const isCurrentUser = participantId === localStorage.getItem(JOINED_PREFIX + eventId);
      const result = removeParticipantFromEvent(eventId, participantId);
      if (!result.ok && result.reason === "locked") {
        setFeedback($("#publicRemoveFeedback"), "Não é possível sair da lista com menos de 1 hora para o evento.", "error");
        return;
      }
      if (!result.ok) {
        setFeedback($("#publicRemoveFeedback"), "Participante não encontrado.", "error");
        renderPublic();
        return;
      }
      if (isCurrentUser) setFeedback($("#joinFeedback"), "Você saiu da lista. A reserva foi promovida se havia vaga.", "success");
      else setFeedback($("#publicRemoveFeedback"), "Participante removido. Reserva promovida se havia vaga.", "success");
      renderPublic();
    }

    $("#publicParticipantsList").addEventListener("click", handlePublicRemoveClick);
    $("#publicReserveList").addEventListener("click", handlePublicRemoveClick);

    function renderPublic() {
      const event = eventId ? getEventById(eventId) : null;
      const notFoundPanel = $("#notFoundPanel");
      const eventPanel = $("#eventPanel");

      if (!event) {
        notFoundPanel.hidden = false;
        eventPanel.hidden = true;
        $("#joinPanel").hidden = true;
        $("#confirmedPanel").hidden = true;
        $("#participantsPanel").hidden = true;
        return;
      }

      const normalized = normalizeEvent(event);
      const totals = calculateEvent(normalized);
      let joinedParticipantId = localStorage.getItem(JOINED_PREFIX + eventId);
      let joinedParticipant = [...totals.participants, ...totals.reserve].find((participant) => participant.id === joinedParticipantId);

      if (joinedParticipantId && !joinedParticipant) {
        localStorage.removeItem(JOINED_PREFIX + eventId);
        joinedParticipantId = "";
      }

      const hasJoined = Boolean(joinedParticipant);
      const isInReserve = Boolean(joinedParticipant && totals.reserve.some((participant) => participant.id === joinedParticipant.id));
      const remaining = totals.remaining;
      const guestMax = Math.max(0, remaining - 1);
      const active = isEventActive(normalized);

      notFoundPanel.hidden = false;
      notFoundPanel.hidden = true;
      eventPanel.hidden = false;
      $("#publicTitle").textContent = normalized.name;
      $("#publicSport").textContent = normalized.sport;
      $("#eventName").textContent = normalized.name + (active ? "" : " (concluído)");
      $("#publicDate").textContent = formatDateTime(normalized.startsAt);
      $("#publicDuration").textContent = formatDuration(normalized.durationHours);
      $("#publicTotal").textContent = formatCurrency(normalized.totalValue);
      $("#publicPeople").textContent = `${totals.totalPeople}/${normalized.maxPeople}`;
      $("#publicPerPerson").textContent = formatCurrency(totals.perPerson);
      $("#publicRemaining").textContent = String(remaining);

      const location = getEventLocation(normalized);
      const hasLocation = Boolean(location.local);
      $("#lockedLocation").hidden = hasJoined || !hasLocation;
      $("#releasedLocation").hidden = !hasJoined || !hasLocation;
      $("#publicLocation").textContent = hasJoined && hasLocation ? location.local : "";
      const mapsButton = $("#openGoogleMapsBtn");
      if (mapsButton && hasLocation) mapsButton.href = buildGoogleMapsUrl(location);
      if (hasJoined && hasLocation && hasValidCoordinates(location)) renderPublicEventMap(normalized);

      $("#joinPanel").hidden = hasJoined || !active;
      $("#confirmedPanel").hidden = !hasJoined;
      $("#participantsPanel").hidden = !hasJoined;
      $("#addGuestBlock").hidden = !hasJoined || isInReserve || !active;

      guestsInput.max = String(Math.max(0, Number(normalized.maxPeople || 0) - 1));
      hasGuestsInput.disabled = false;
      // Não recria os campos de convidados no intervalo automático para não tirar o foco durante a digitação.
      $("#joinButton").disabled = !active;

      if (!active && !hasJoined) setFeedback($("#joinFeedback"), "Evento concluído.", "error");

      if (hasJoined) {
        const count = 1 + getGuestNames(joinedParticipant).length;
        const reserveText = isInReserve ? " Você está na reserva e subirá automaticamente quando abrir vaga." : " Você está na lista principal.";
        $("#confirmedText").textContent = `${joinedParticipant.name}, sua confirmação conta como ${count} pessoa${count > 1 ? "s" : ""}.${reserveText}`;
        $("#publicLastUpdate").textContent = `Atualizado ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
        renderPeopleList($("#publicParticipantsList"), totals.participants, {
          currentParticipantId: joinedParticipant.id,
          showRemoveButton: true,
          showRemoveGuestButton: true
        });
        renderPeopleList($("#publicReserveList"), totals.reserve, {
          currentParticipantId: joinedParticipant.id,
          showRemoveButton: true,
          showRemoveGuestButton: true,
          isReserve: true
        });
      }
    }

    window.addEventListener("storage", renderPublic);
    window.addEventListener("events:changed", renderPublic);
    window.setInterval(renderPublic, 2000);
    renderPublic();
  }

  async function bootstrap() {
    await cloudPullEvents();
    if (page === "admin") initAdminPage();
    if (page === "event") initPublicPage();
    loadGoogleMapsApi();
  }

  bootstrap();
})();
