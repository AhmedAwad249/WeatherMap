"use strict";

// Page elements and settings
const config = window.WEATHERMAP_CONFIG || {};
const form = document.querySelector("#search-form");
const cityInput = document.querySelector("#city-input");
const searchButton = document.querySelector("#search-button");
const statusMessage = document.querySelector("#status-message");
const errorMessage = document.querySelector("#error-message");
const favoritesList = document.querySelector("#favorites");
const manualShare = document.querySelector("#manual-share");
const clearSearchButton = document.querySelector("#clear-search");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const mobileLayout = window.matchMedia("(max-width: 600px)");
const savedCities = document.querySelector("#saved-cities");
savedCities.open = !mobileLayout.matches;

let map;
let currentMarker;
let currentResult;
let isLoading = false;
let lastGeocodingRequest = 0;
const geocodingCache = new Map();
let favorites = readStored("weathermap-favorites", []).filter(isValidLocation).slice(0, 8);
let recentCities = readStored("weathermap-recent", []).filter(isValidLocation).slice(0, 3);
let temperatureUnit = readStored("weathermap-unit", "celsius");
if (temperatureUnit !== "fahrenheit") temperatureUnit = "celsius";

// Browser storage
function readStored(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(fallback)) return Array.isArray(value) ? value : fallback;
    return typeof value === typeof fallback ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    setStatus("Browser storage is unavailable. Your changes will last until you close this page.");
    return false;
  }
}

function isValidLocation(location) {
  return (
    location &&
    typeof location.name === "string" &&
    typeof location.label === "string" &&
    Number.isFinite(location.latitude) &&
    Math.abs(location.latitude) <= 90 &&
    Number.isFinite(location.longitude) &&
    Math.abs(location.longitude) <= 180
  );
}

// Map setup and controls
function initMap() {
  if (!window.L) {
    showError("The map could not load. Check your connection and refresh the page.");
    return;
  }

  map = L.map("map", {
    scrollWheelZoom: false,
    fadeAnimation: !reducedMotion.matches,
    zoomAnimation: !reducedMotion.matches
  }).setView([15.5007, 32.5599], 6);
  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
  }).addTo(map);
  tiles.on("tileerror", () => {
    setStatus(
      "Some map tiles could not load. Check your connection; city search is still available."
    );
  });
  map.on("resize", updateMapControls);
  map.on("zoomend", updateZoomButtons);
  updateMapControls();
}

function updateZoomButtons() {
  document.querySelector("#zoom-in").disabled = map.getZoom() >= map.getMaxZoom();
  document.querySelector("#zoom-out").disabled = map.getZoom() <= map.getMinZoom();
}

function updateMapControls() {
  if (!map) return;
  map.zoomControl.getContainer().hidden = mobileLayout.matches;
  updateZoomButtons();
  if (currentMarker) {
    const popup = currentMarker.getPopup();
    popup.options.maxWidth = mobileLayout.matches ? Math.min(300, map.getSize().x - 64) : 300;
    popup.options.autoPanPaddingTopLeft = mobileLayout.matches ? [12, 12] : [60, 12];
    if (currentMarker.isPopupOpen()) popup.update();
  }
}

function setStatus(message) {
  statusMessage.textContent = message;
}

function showPopupMessage(feedback, message, isError = false) {
  setStatus(message);
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
  currentMarker?.getPopup().update();
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
  statusMessage.hidden = true;
  setStatus(currentResult ? `Last result: ${currentResult.location.label}.` : "");
}

function clearError() {
  errorMessage.textContent = "";
  errorMessage.hidden = true;
  statusMessage.hidden = false;
  cityInput.removeAttribute("aria-invalid");
}

function setLoading(loading) {
  isLoading = loading;
  searchButton.disabled = loading;
  cityInput.readOnly = loading;
  clearSearchButton.disabled = loading;
  form.setAttribute("aria-busy", String(loading));
  document.querySelector("#search-spinner").hidden = !loading;
  document.querySelector("#search-button-text").textContent = loading
    ? "Finding weather…"
    : "Get Weather";
  document.querySelectorAll(".favorite-city, .location-shortcut").forEach((button) => {
    button.disabled = loading;
  });
}

async function fetchJson(url, serviceName) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(`${serviceName} took too long to respond. Please try again.`);
    }
    throw new Error(`Could not reach ${serviceName}. Check your connection and try again.`);
  }

  if (response.status === 429) {
    throw new Error(`${serviceName} is receiving too many requests. Please wait and try again.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${serviceName} denied access. Check the API key or service settings.`);
  }
  if (!response.ok) {
    throw new Error(`${serviceName} is unavailable right now. Please try again later.`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`${serviceName} returned an unreadable response. Please try again.`);
  }
}

// Ignore vowel marks and tatweel when matching Arabic city searches.
function normalizeCitySearch(city) {
  return city
    .normalize("NFC")
    .replace(/[\u0640\u064b-\u065f\u0670]/g, "")
    .replace(/،/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

function getSearchLanguage(city) {
  return /\p{Script=Arabic}/u.test(city) ? "ar" : "en";
}

// First find the coordinates, then request the current weather.
async function getCoordinates(city) {
  const cacheKey = city.toLocaleLowerCase();
  if (geocodingCache.has(cacheKey)) return geocodingCache.get(cacheKey);

  // The public geocoder allows at most one request per second, never autocomplete.
  const waitTime = 1100 - (Date.now() - lastGeocodingRequest);
  if (waitTime > 0) await new Promise((resolve) => setTimeout(resolve, waitTime));
  lastGeocodingRequest = Date.now();

  const url = new URL(config.geocodingUrl || "https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({
    q: city,
    format: "jsonv2",
    limit: "1",
    addressdetails: "1",
    "accept-language": getSearchLanguage(city) === "ar" ? "ar,en" : "en"
  });
  const results = await fetchJson(url, "City search");
  if (!Array.isArray(results)) {
    throw new Error("City search returned an unexpected result. Please try again.");
  }
  if (!results.length) {
    throw new Error("We couldn’t find that location. Try a city name followed by its country.");
  }

  const place = results[0];
  if (!place || place.lat == null || place.lon == null) {
    throw new Error("This location has no usable map coordinates. Try another city.");
  }
  const address = place.address || {};
  const name = address.city || address.town || address.village || place.name || city;
  const location = {
    name,
    label: [name, address.state, address.country]
      .filter((part, index, parts) => part && parts.indexOf(part) === index)
      .join(", "),
    latitude: Number(place.lat),
    longitude: Number(place.lon)
  };
  if (!isValidLocation(location)) {
    throw new Error("This location has no usable map coordinates. Try another city.");
  }
  geocodingCache.set(cacheKey, location);
  return location;
}

async function getWeather(latitude, longitude, language) {
  const url = new URL("https://api.openweathermap.org/data/2.5/weather");
  url.search = new URLSearchParams({
    lat: latitude,
    lon: longitude,
    appid: config.openWeatherApiKey.trim(),
    units: "metric",
    lang: language
  });
  const weather = await fetchJson(url, "OpenWeatherMap");
  if (
    !Number.isFinite(weather?.main?.temp) ||
    !Number.isFinite(weather?.main?.humidity) ||
    !Number.isFinite(weather?.wind?.speed) ||
    !Number.isFinite(weather?.clouds?.all) ||
    typeof weather?.weather?.[0]?.description !== "string"
  ) {
    throw new Error("The weather report is incomplete. Please try again shortly.");
  }
  return weather;
}

async function handleSearch(event, savedLocation) {
  event?.preventDefault();
  if (isLoading) return;
  clearError();
  closeManualShare();
  updateSearchControls();
  const city = normalizeCitySearch(cityInput.value);
  if (!savedLocation && !city) {
    cityInput.setAttribute("aria-invalid", "true");
    showError("Enter a city first, such as Khartoum, Sudan.");
    cityInput.focus();
    return;
  }
  if (!map) {
    showError("The map is not available. Check your connection and refresh to try again.");
    return;
  }
  if (!config.openWeatherApiKey?.trim()) {
    showError("Weather is not connected yet. Add your OpenWeatherMap API key in js/config.js.");
    return;
  }

  setLoading(true);
  setStatus(`Finding weather for ${savedLocation?.name || city}…`);
  try {
    const location = savedLocation || (await getCoordinates(city));
    const weather = await getWeather(
      location.latitude,
      location.longitude,
      getSearchLanguage(city)
    );
    currentResult = { location, weather };
    showWeather(location, weather);
    recentCities = [
      location,
      ...recentCities.filter((city) => locationId(city) !== locationId(location))
    ].slice(0, 3);
    const savedRecent = saveStored("weathermap-recent", recentCities);
    geocodingCache.set(normalizeCitySearch(location.label).toLocaleLowerCase(), location);
    renderRecentCities();
    setStatus(
      savedRecent
        ? `Weather ready for ${location.label}.`
        : `Weather ready for ${location.label}. Recent searches could not be saved.`
    );
    if (mobileLayout.matches) {
      cityInput.blur();
      if (savedCities.contains(document.activeElement)) document.activeElement.blur();
      savedCities.open = false;
      document.querySelector(".map-section").scrollIntoView({
        behavior: reducedMotion.matches ? "instant" : "smooth",
        block: "start"
      });
    }
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
}

function formatTemperature(celsius) {
  const value = temperatureUnit === "fahrenheit" ? (celsius * 9) / 5 + 32 : celsius;
  return `${Math.round(value)}°${temperatureUnit === "fahrenheit" ? "F" : "C"}`;
}

// Build popup and saved-city elements using textContent for place names.
function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) {
    element.textContent = text;
    element.dir = "auto";
  }
  return element;
}

function locationId(location) {
  return `${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`;
}

function isFavorite(location) {
  return favorites.some((favorite) => locationId(favorite) === locationId(location));
}

function createWeatherPopup(location, weather) {
  const card = createElement("article", "weather-card");
  card.append(createElement("h3", "", location.name));
  const region = location.label.startsWith(`${location.name}, `)
    ? location.label.slice(location.name.length + 2)
    : location.label;
  if (region !== location.name) card.append(createElement("p", "weather-place", region));

  const temperatureRow = createElement("div", "temperature-row");
  temperatureRow.append(createElement("span", "temperature", formatTemperature(weather.main.temp)));
  const condition = weather.weather[0];
  if (/^\d{2}[dn]$/.test(condition.icon)) {
    const icon = createElement("img", "weather-icon");
    icon.src = `https://openweathermap.org/img/wn/${condition.icon}@2x.png`;
    icon.alt = condition.description;
    icon.width = 64;
    icon.height = 64;
    temperatureRow.append(icon);
  }
  card.append(temperatureRow, createElement("p", "weather-description", condition.description));

  const details = createElement("dl", "weather-details");
  for (const [label, value] of [
    ["Humidity", `${weather.main.humidity}%`],
    ["Wind", `${weather.wind.speed} m/s`],
    ["Clouds", `${weather.clouds.all}%`]
  ]) {
    const item = createElement("div");
    item.append(createElement("dt", "", label), createElement("dd", "", value));
    details.append(item);
  }
  card.append(details);

  const actions = createElement("div", "weather-actions");
  const shareButton = createElement("button", "button button-primary", "Share Weather");
  const actionFeedback = createElement("p", "popup-feedback");
  shareButton.type = "button";
  shareButton.addEventListener("click", async () => {
    shareButton.disabled = true;
    try {
      await shareWeather(location, weather, actionFeedback);
    } finally {
      shareButton.disabled = false;
    }
  });
  const saveButton = createElement(
    "button",
    "button button-secondary",
    isFavorite(location) ? "Remove from favorites" : "Save to favorites"
  );
  saveButton.type = "button";
  saveButton.setAttribute("aria-pressed", String(isFavorite(location)));
  saveButton.addEventListener("click", () => toggleFavorite(location, saveButton, actionFeedback));
  actions.append(shareButton, saveButton);
  card.append(actions, actionFeedback);

  return card;
}

function showWeather(location, weather) {
  map.stop();
  if (currentMarker) map.removeLayer(currentMarker);
  const coordinates = [location.latitude, location.longitude];
  const markerIcon = L.divIcon({
    className: "weather-pin",
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -36]
  });
  currentMarker = L.marker(coordinates, {
    icon: markerIcon,
    title: `Weather in ${location.name}`
  }).addTo(map);
  currentMarker.bindPopup(createWeatherPopup(location, weather), {
    maxWidth: 300,
    autoPanPaddingTopLeft: [60, 12],
    autoPanPaddingBottomRight: [12, 12]
  });
  updateMapControls();
  document.querySelector("#map-heading").textContent = location.label;
  document.querySelector("#show-weather").hidden = false;
  document.querySelector("#new-search").hidden = false;
  renderFavorites();
  // Let the map finish moving before the popup adjusts its position.
  const marker = currentMarker;
  if (reducedMotion.matches) {
    map.setView(coordinates, 10, { animate: false });
    marker.openPopup();
  } else {
    map.once("moveend", () => {
      if (currentMarker === marker) marker.openPopup();
    });
    map.flyTo(coordinates, 10, { duration: 0.8 });
  }
}

function toggleFavorite(location, button, feedback) {
  clearError();
  const alreadySaved = isFavorite(location);
  if (!alreadySaved && favorites.length >= 8) {
    const message = "You can save up to 8 cities. Remove one before adding another.";
    showError(message);
    showPopupMessage(feedback, message, true);
    return;
  }
  if (alreadySaved) {
    favorites = favorites.filter((favorite) => locationId(favorite) !== locationId(location));
  } else {
    favorites.push(location);
  }
  const saved = saveStored("weathermap-favorites", favorites);
  button.textContent = alreadySaved ? "Save to favorites" : "Remove from favorites";
  button.setAttribute("aria-pressed", String(!alreadySaved));
  renderFavorites();
  const message = saved
    ? `${location.name} ${alreadySaved ? "removed from" : "saved to"} favorites.`
    : "Changed for this visit. Browser storage is unavailable.";
  showPopupMessage(feedback, message, !saved);
}

function updateSavedSummary() {
  const cityIds = [...favorites, ...recentCities].map(locationId);
  const count = new Set(cityIds).size;
  document.querySelector("#saved-summary").textContent = count ? `(${count})` : "";
}

function renderFavorites() {
  updateSavedSummary();
  favoritesList.replaceChildren();
  document.querySelector("#favorites-empty").hidden = favorites.length > 0;
  for (const location of favorites) {
    const chip = createElement("div", "favorite-chip");
    const cityButton = createElement("button", "favorite-city", location.name);
    cityButton.type = "button";
    cityButton.title = location.label;
    if (currentResult && locationId(location) === locationId(currentResult.location)) {
      cityButton.setAttribute("aria-current", "location");
      chip.classList.add("is-current");
    }
    cityButton.setAttribute("aria-label", `Get weather for ${location.label}`);
    cityButton.disabled = isLoading;
    cityButton.addEventListener("click", () => searchSavedCity(location));
    const removeButton = createElement("button", "favorite-remove", "×");
    removeButton.type = "button";
    removeButton.setAttribute("aria-label", `Remove ${location.name} from favorites`);
    removeButton.addEventListener("click", () => {
      clearError();
      const removedIndex = favorites.findIndex(
        (favorite) => locationId(favorite) === locationId(location)
      );
      favorites = favorites.filter((favorite) => locationId(favorite) !== locationId(location));
      const saved = saveStored("weathermap-favorites", favorites);
      renderFavorites();
      refreshPopup();
      if (saved) setStatus(`${location.name} removed from favorites.`);
      const remainingButtons = favoritesList.querySelectorAll(".favorite-remove");
      (remainingButtons[Math.min(removedIndex, remainingButtons.length - 1)] || cityInput).focus();
    });
    chip.append(cityButton, removeButton);
    favoritesList.append(chip);
  }
}

function renderRecentCities() {
  updateSavedSummary();
  const container = document.querySelector("#recent-cities");
  container.replaceChildren();
  document.querySelector("#recent-heading").textContent = recentCities.length
    ? "Recent searches"
    : "Try a city";
  document.querySelector("#clear-recent").hidden = recentCities.length === 0;
  const suggestions = recentCities.length
    ? recentCities
    : [
        { name: "Khartoum", label: "Khartoum, Sudan" },
        { name: "Port Sudan", label: "Port Sudan, Sudan" },
        { name: "London", label: "London, UK" }
      ];
  for (const location of suggestions) {
    const button = createElement("button", "location-shortcut", location.name);
    button.type = "button";
    button.title = location.label;
    button.setAttribute("aria-label", `Get weather for ${location.label}`);
    button.disabled = isLoading;
    button.addEventListener("click", () => searchSavedCity(location));
    container.append(button);
  }
}

function searchSavedCity(location) {
  cityInput.value = location.label;
  handleSearch(null, isValidLocation(location) ? location : null);
}

function refreshPopup() {
  if (currentResult) {
    currentMarker.setPopupContent(
      createWeatherPopup(currentResult.location, currentResult.weather)
    );
  }
}

function updateSearchControls() {
  clearSearchButton.hidden = cityInput.value.length === 0;
}

function closeManualShare() {
  if (manualShare.open) manualShare.close();
  manualShare.hidden = true;
}

async function shareWeather(location, weather, feedback) {
  clearError();
  closeManualShare();
  feedback.textContent = "";
  feedback.classList.remove("is-error");
  const message = `Weather in ${location.label}: ${formatTemperature(weather.main.temp)}, ${weather.weather[0].description}. Humidity ${weather.main.humidity}%, wind ${weather.wind.speed} m/s, clouds ${weather.clouds.all}%. — WeatherMap`;
  if (navigator.share) {
    try {
      await navigator.share({ title: `Weather in ${location.name}`, text: message });
      showPopupMessage(feedback, "Weather shared.");
      return;
    } catch (error) {
      if (error.name === "AbortError") {
        showPopupMessage(feedback, "Sharing cancelled.");
        return;
      }
    }
  }
  try {
    await navigator.clipboard.writeText(message);
    showPopupMessage(feedback, "Weather copied. Paste it into a message to share.");
  } catch {
    const shareText = document.querySelector("#share-text");
    shareText.value = message;
    manualShare.hidden = false;
    manualShare.showModal();
    shareText.focus();
    shareText.select();
    showPopupMessage(feedback, "Copy the selected message in the dialog to share it.");
  }
}

function updateUnitButtons() {
  document.querySelectorAll("[data-unit]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.unit === temperatureUnit));
  });
}

// Page actions
function changeLayout() {
  savedCities.open = !mobileLayout.matches;
  updateMapControls();
}

function clearSearch() {
  cityInput.value = "";
  clearError();
  setStatus("");
  updateSearchControls();
  cityInput.focus();
}

function clearRecentCities() {
  recentCities = [];
  clearError();
  const saved = saveStored("weathermap-recent", recentCities);
  renderRecentCities();
  if (saved) setStatus("Recent searches cleared.");
  cityInput.focus();
}

function startNewSearch(event) {
  event.preventDefault();
  cityInput.focus();
  cityInput.select();
}

function showCurrentWeather() {
  if (!currentResult) return;
  map.stop();
  map.setView(currentMarker.getLatLng(), 10, { animate: false });
  currentMarker.openPopup();
}

function editCity() {
  clearError();
  updateSearchControls();
}

function changeTemperatureUnit(event) {
  clearError();
  temperatureUnit = event.currentTarget.dataset.unit;
  const saved = saveStored("weathermap-unit", temperatureUnit);
  updateUnitButtons();
  closeManualShare();
  refreshPopup();
  if (saved) {
    setStatus(
      `Temperatures shown in ${temperatureUnit === "fahrenheit" ? "Fahrenheit" : "Celsius"}.`
    );
  }
}

function finishSharing() {
  closeManualShare();
  currentMarker?.openPopup();
  document.querySelector(".weather-actions button")?.focus();
}

function restoreShareFocus() {
  manualShare.hidden = true;
  if (currentMarker?.isPopupOpen()) {
    document.querySelector(".weather-actions button")?.focus();
  }
}

// Connect the controls, then load the map and saved preferences.
form.addEventListener("submit", handleSearch);
cityInput.addEventListener("input", editCity);
clearSearchButton.addEventListener("click", clearSearch);
mobileLayout.addEventListener("change", changeLayout);
document.querySelector("#clear-recent").addEventListener("click", clearRecentCities);
document.querySelector("#new-search").addEventListener("click", startNewSearch);
document.querySelector("#show-weather").addEventListener("click", showCurrentWeather);
document.querySelector("#close-share").addEventListener("click", finishSharing);
document.querySelector("#zoom-in").addEventListener("click", () => map?.zoomIn());
document.querySelector("#zoom-out").addEventListener("click", () => map?.zoomOut());
manualShare.addEventListener("close", restoreShareFocus);
document.querySelectorAll("[data-unit]").forEach((button) => {
  button.addEventListener("click", changeTemperatureUnit);
});

initMap();
renderFavorites();
renderRecentCities();
updateUnitButtons();
updateSearchControls();
