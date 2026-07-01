/*      Blackmagic Camera Control WebUI
        WebUI Script functions
        (c) Dylan Speiser 2024              
        github.com/DylanSpeiser
*/

/* Global variables */
var cameras = []; // Array to store all of the camera objects
var ci = 0; // Index into this array for the currently selected camera.
// cameras[ci] is used to reference the currently selected camera object

var WBMode = 0; // 0: balance, 1: tint

var defaultControlsHTML;

var unsavedChanges = [];
var ccWheelState = {};
var ccNumberState = {};

// Set everything up
function bodyOnLoad() {
  defaultControlsHTML = document.getElementById(
    "allCamerasContainer"
  ).innerHTML;
  // prefill camera hostname (or IP address)
  document.getElementById("hostnameInput").value = localStorage.getItem(
    "camerahostname_" + ci.toString()
  );
  if (localStorage.getItem("camerasecurity_" + ci.toString()) === "true") {
    document.getElementById("secureCheckbox").checked = true;
  }

  setupColorWheels();
  setupCCNumberFields();
}

function setupCCNumberFields() {
  document.querySelectorAll('[data-cc-row]').forEach((el) => {
    const row = parseInt(el.dataset.ccRow, 10);
    const key = `${row}-${el.className}`;
    const cfg = {
      row,
      step: row === 2 ? 0.015 : 0.005,
      decimals: 2,
      min: row === 2 && el.classList.contains("CClumaLabel") ? 0 : null,
      max: row === 2 && el.classList.contains("CClumaLabel") ? 3 : null,
    };

    ccNumberState[key] = {
      dragging: false,
      startX: 0,
      startValue: 0,
      moved: false,
      cfg,
    };

    el.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ccNumberState[key].startX = ev.clientX;
      ccNumberState[key].startValue = parseCCNumberText(el.innerText);
      ccNumberState[key].moved = false;
      ccNumberState[key].dragging = true;
      el.classList.add("ccNumberDragActive");
      document.body.classList.add("ccNumberDragging");

      const moveHandler = (moveEv) => {
        if (!ccNumberState[key].dragging) return;
        moveEv.preventDefault();

        const deltaX = moveEv.clientX - ccNumberState[key].startX;
        if (!ccNumberState[key].moved && Math.abs(deltaX) < 4) return;
        ccNumberState[key].moved = true;

        const newValue = ccNumberState[key].startValue + deltaX * cfg.step;
        const clamped = clampNumberByField(cfg, newValue);
        setCCNumberValue(el, clamped, cfg.decimals);
        unsavedChanges.push(`CC${row}`);
      };

      const upHandler = () => {
        ccNumberState[key].dragging = false;
        el.classList.remove("ccNumberDragActive");
        document.body.classList.remove("ccNumberDragging");
        window.removeEventListener("mousemove", moveHandler);
        window.removeEventListener("mouseup", upHandler);

        if (!ccNumberState[key].moved) {
          el.focus();
          placeCaretAtEnd(el);
          return;
        }

        commitCCNumberField(el);
      };

      window.addEventListener("mousemove", moveHandler, { passive: false });
      window.addEventListener("mouseup", upHandler, { once: true });
    });

    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        el.blur();
        commitCCNumberField(el);
      } else {
        unsavedChanges.push(`CC${row}`);
      }
    });

    el.addEventListener("blur", () => {
      if (!ccNumberState[key].dragging) commitCCNumberField(el);
    });

    el.addEventListener("dragstart", (ev) => ev.preventDefault());
  });
}

function normalizeCCNumberText(text) {
  return String(text || "").replace(/[^\d.\-+]/g, "");
}

function parseCCNumberText(text) {
  const parsed = parseFloat(normalizeCCNumberText(text));
  return Number.isFinite(parsed) ? parsed : 0;
}

function setCCNumberValue(el, value, decimals) {
  el.innerText = value.toFixed(decimals);
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function clampNumberByField(cfg, value) {
  if (cfg.min !== null) value = Math.max(cfg.min, value);
  if (cfg.max !== null) value = Math.min(cfg.max, value);
  return value;
}

function commitCCNumberField(el) {
  const row = parseInt(el.dataset.ccRow, 10);
  const value = parseCCNumberText(el.innerText);
  setCCNumberValue(el, value, 2);
  setCCFromUI(row);
}

function setupColorWheels() {
  document.querySelectorAll(".ccWheel").forEach((wheel) => {
    const ccIndex = parseInt(wheel.dataset.cc, 10);
    ccWheelState[ccIndex] = {
      x: 0,
      y: 0,
      dragging: false,
      locked: false,
      dragBaseX: 0,
      dragBaseY: 0,
      dragStartX: 0,
      dragStartY: 0,
      lastLocalApplyAt: 0,
      lastSent: { r: null, g: null, b: null, luma: null },
      lastApplied: { x: 0, y: 0, radius: 0 },
    };

    const updateFromPointer = (clientX, clientY) => {
      const rect = wheel.getBoundingClientRect();
      const rawDx = (clientX - ccWheelState[ccIndex].dragStartX) / (rect.width / 2);
      const rawDy = (clientY - ccWheelState[ccIndex].dragStartY) / (rect.height / 2);
      const sensitivity = 0.18;
      const dx = clamp(ccWheelState[ccIndex].dragBaseX + rawDx * sensitivity, -1, 1);
      const dy = clamp(ccWheelState[ccIndex].dragBaseY + rawDy * sensitivity, -1, 1);
      const radius = clamp(Math.sqrt(dx * dx + dy * dy), 0, 1);
      ccWheelState[ccIndex].x = dx;
      ccWheelState[ccIndex].y = dy;
      applyCCWheel(ccIndex, dx, dy, radius);
    };

    wheel.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ccWheelState[ccIndex].dragging = true;
      ccWheelState[ccIndex].locked = true;
      document.body.classList.add("draggingWheel");
      ccWheelState[ccIndex].dragStartX = ev.clientX;
      ccWheelState[ccIndex].dragStartY = ev.clientY;
      ccWheelState[ccIndex].dragBaseX = ccWheelState[ccIndex].x || 0;
      ccWheelState[ccIndex].dragBaseY = ccWheelState[ccIndex].y || 0;
      let moved = false;

      const moveHandler = (moveEv) => {
        if (!ccWheelState[ccIndex].dragging) return;
        moveEv.preventDefault();
        if (!moved) {
          const deltaX = Math.abs(moveEv.clientX - ccWheelState[ccIndex].dragStartX);
          const deltaY = Math.abs(moveEv.clientY - ccWheelState[ccIndex].dragStartY);
          if (deltaX < 2 && deltaY < 2) return;
          moved = true;
        }
        updateFromPointer(moveEv.clientX, moveEv.clientY);
      };

      const upHandler = () => {
        ccWheelState[ccIndex].dragging = false;
        ccWheelState[ccIndex].locked = false;
        document.body.classList.remove("draggingWheel");
        window.removeEventListener("mousemove", moveHandler);
        window.removeEventListener("mouseup", upHandler);
      };

      window.addEventListener("mousemove", moveHandler, { passive: false });
      window.addEventListener("mouseup", upHandler, { once: true });
    });

    wheel.addEventListener("dragstart", (ev) => ev.preventDefault());
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp >= 0 && hp < 1) {
    r = c; g = x;
  } else if (hp < 2) {
    r = x; g = c;
  } else if (hp < 3) {
    g = c; b = x;
  } else if (hp < 4) {
    g = x; b = c;
  } else if (hp < 5) {
    r = x; b = c;
  } else {
    r = c; b = x;
  }
  const m = l - c / 2;
  return { r: r + m, g: g + m, b: b + m };
}

function applyCCWheel(which, dx, dy, radius) {
  const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
  const hue = (angle + 360) % 360;
  const sat = clamp(Math.max(0, radius - 0.08) / 0.92, 0, 1);
  const rgb = hslToRgb(hue, sat, 0.5);
  const neutral = which === 2 ? 1 : 0;
  const scale = which === 2 ? 1.1 : 0.7;
  const ccobject = {
    red: clamp(neutral + (rgb.r - 0.5) * scale, which === 2 ? 0 : -1, which === 2 ? 2 : 1),
    green: clamp(neutral + (rgb.g - 0.5) * scale, which === 2 ? 0 : -1, which === 2 ? 2 : 1),
    blue: clamp(neutral + (rgb.b - 0.5) * scale, which === 2 ? 0 : -1, which === 2 ? 2 : 1),
    luma: parseFloat(document.getElementsByClassName("CClumaLabel")[which].innerHTML),
  };

  if (which === 2) {
    ccobject.luma = 1.0;
  }

  if (which === 0) {
    cameras[ci].PUTdata("/colorCorrection/lift", ccobject);
  } else if (which === 1) {
    cameras[ci].PUTdata("/colorCorrection/gamma", ccobject);
  } else if (which === 2) {
    cameras[ci].PUTdata("/colorCorrection/gain", ccobject);
  } else if (which === 3) {
    cameras[ci].PUTdata("/colorCorrection/offset", ccobject);
  }

  ccWheelState[which] = ccWheelState[which] || { x: 0, y: 0, dragging: false, locked: false, lastApplied: { x: 0, y: 0, radius: 0 } };
  ccWheelState[which].x = dx;
  ccWheelState[which].y = dy;
  ccWheelState[which].lastApplied = { x: dx, y: dy, radius: radius };
  ccWheelState[which].lastLocalApplyAt = Date.now();
  ccWheelState[which].lastSent = {
    r: ccobject.red,
    g: ccobject.green,
    b: ccobject.blue,
    luma: ccobject.luma,
  };

  unsavedChanges = unsavedChanges.filter((e) => !e.includes("CC" + which));
  drawCCWheel(which, dx, dy, radius);
}

function drawCCWheel(which, dx, dy, radius) {
  const wheel = document.querySelector(`.ccWheel[data-cc="${which}"]`);
  if (!wheel) return;
  const ctx = wheel.getContext("2d");
  const size = wheel.width;
  const center = size / 2;
  ctx.clearRect(0, 0, size, size);

  const gradient = ctx.createRadialGradient(center, center, 6, center, center, center - 5);
  gradient.addColorStop(0, "#555");
  gradient.addColorStop(1, "#151515");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(center, center, center - 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 4;
  ctx.strokeStyle = "#666";
  ctx.beginPath();
  ctx.arc(center, center, center - 7, 0, Math.PI * 2);
  ctx.stroke();

  const hue = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
  const color = hslToRgb(hue, radius, 0.5);
  ctx.fillStyle = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, 0.95)`;
  ctx.beginPath();
  ctx.arc(center + dx * (center - 16), center + dy * (center - 16), 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#eaeaea";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(center, center, center - 16, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.beginPath();
  ctx.arc(center, center, 4, 0, Math.PI * 2);
  ctx.fill();
}

function syncCCWheel(which) {
  if (ccWheelState[which]?.locked) return;
  if (ccWheelState[which]?.dragging) return;
  const state = ccWheelState[which];
  if (Date.now() - (state?.lastLocalApplyAt || 0) < 700) return;
  const rEl = document.getElementsByClassName("CCredLabel")[which];
  const gEl = document.getElementsByClassName("CCgreenLabel")[which];
  const bEl = document.getElementsByClassName("CCblueLabel")[which];
  if (!rEl || !gEl || !bEl) return;

  const r = parseFloat(rEl.innerHTML);
  const g = parseFloat(gEl.innerHTML);
  const b = parseFloat(bEl.innerHTML);
  const lastSent = state?.lastSent || {};
  const nearlySame =
    lastSent.r !== null &&
    Math.abs(r - lastSent.r) < 0.03 &&
    Math.abs(g - lastSent.g) < 0.03 &&
    Math.abs(b - lastSent.b) < 0.03;
  if (nearlySame) return;
  const neutral = which === 2 ? 1 : 0;
  const scale = which === 2 ? 2 : 2;
  const rr = (r - neutral) / scale + 0.5;
  const gg = (g - neutral) / scale + 0.5;
  const bb = (b - neutral) / scale + 0.5;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const sat = max === 0 ? 0 : (max - min) / max;

  let hue = 0;
  if (max !== min) {
    if (max === rr) hue = (60 * ((gg - bb) / (max - min)) + 360) % 360;
    else if (max === gg) hue = 60 * ((bb - rr) / (max - min)) + 120;
    else hue = 60 * ((rr - gg) / (max - min)) + 240;
  }

  const radius = clamp(sat, 0, 1);
  const rad = (hue * Math.PI) / 180;
  const dx = Math.cos(rad) * radius;
  const dy = -Math.sin(rad) * radius;
  ccWheelState[which] = ccWheelState[which] || {
    x: 0,
    y: 0,
    dragging: false,
    locked: false,
    lastSent: { r: null, g: null, b: null, luma: null },
    lastApplied: { x: 0, y: 0, radius: 0 },
  };
  ccWheelState[which].x = dx;
  ccWheelState[which].y = dy;
  ccWheelState[which].lastApplied = { x: dx, y: dy, radius: radius };
  drawCCWheel(which, dx, dy, radius);
}

// Checks the hostname, if it replies successfully then a new BMCamera object
//  is made and gets put in the array at ind
function initCamera() {
  // Get hostname from Hostname text field
  let hostname = document.getElementById("hostnameInput").value;
  let security = document.getElementById("secureCheckbox").checked;

  try {
    // Check if the hostname is valid
    let response = sendRequest(
      "GET",
      (security ? "https://" : "http://") + hostname + "/control/api/v1/system",
      ""
    );

    if (response.status < 300) {
      // Success, make a new camera, get all relevant info, and populate the UI
      cameras[ci] = new BMCamera(hostname, security);
      // Save camera hostname and security status in local storage
      localStorage.setItem("camerahostname_" + ci, hostname);
      localStorage.setItem("camerasecurity_" + ci, security);
      cameras[ci].updateUI = updateUIAll;

      cameras[ci].active = true;
      let supportedFormats = sendRequest(
        "GET",
        (security ? "https://" : "http://") +
          hostname +
          "/control/api/v1/system/supportedFormats"
      );

      cameras[ci].propertyData[`/system/supportedFormats`] = supportedFormats;

      document.getElementById("connectionErrorSpan").innerHTML = "Connected.";
      document
        .getElementById("connectionErrorSpan")
        .setAttribute("style", "color: #6e6e6e;");
    } else {
      // Something has gone wrong, tell the user
      document.getElementById("connectionErrorSpan").innerHTML =
        response.statusText;
    }
  } catch (error) {
    // Something has gone wrong, tell the user
    document.getElementById("connectionErrorSpan").title = error;
    document.getElementById("connectionErrorSpan").innerHTML =
      "Error " +
      error.code +
      ": " +
      error.name +
      " (Your hostname is probably incorrect, hover for more details)";
  }

  unsavedChanges = unsavedChanges.filter((e) => {
    return e !== "Hostname";
  });
}

// =============================== UI Updater ==================================
// =============================================================================

function updateUIAll() {
  // ========== Camera Name ==========

  document.getElementById("cameraName").innerHTML = cameras[ci].name;

  // ========== Hostname ==========

  if (!unsavedChanges.includes("Hostname")) {
    document.getElementById("hostnameInput").value = cameras[ci].hostname;
  }

  // ========== Format ==========
  // Селекты
  const codecSelect = document.getElementById("formatCodecSelect");
  const resSelect = document.getElementById("formatResSelect");
  const fpsSelect = document.getElementById("formatFPSSelect");

  // Объект камеры
  const camera = cameras[ci]; // твой объект камеры

  // Функция для обновления списка кодеков
  function updateCodecs() {
    const codecs = camera.propertyData[
      "/system/supportedFormats"
    ].supportedFormats
      .map((f) => f.codecs)
      .flat()
      .map((c) => c);

    const uniqueCodecs = [...new Set(codecs)];

    codecSelect.innerHTML = uniqueCodecs
      .map((c) => `<option value="${c}">${c}</option>`)
      .join("");

    const currentCodec = camera.propertyData["/system/format"]?.codec;

    codecSelect.value = currentCodec;

    updateResolutions();
  }

  function updateResolutions() {
    const selectedCodec = codecSelect.value;
    const formats =
      camera.propertyData["/system/supportedFormats"].supportedFormats;

    const availableRes = formats
      .filter((f) => f.codecs.includes(selectedCodec))
      .map((f) => `${f.recordResolution.width}x${f.recordResolution.height}`);

    const uniqueRes = [...new Set(availableRes)];

    resSelect.innerHTML = uniqueRes
      .map((r) => `<option value="${r}">${r}</option>`)
      .join("");

    const currentRes = camera.propertyData["/system/format"]?.recordResolution;
    resSelect.value = `${currentRes?.width}x${currentRes?.height}`;

    updateFPS();
  }

  function updateFPS() {
    const selectedCodec = codecSelect.value;
    const selectedRes = resSelect.value.split("x").map(Number);

    const formats =
      camera.propertyData["/system/supportedFormats"].supportedFormats;
    const matchingFormat = formats.find(
      (f) =>
        f.codecs.includes(selectedCodec) &&
        f.recordResolution.width === selectedRes[0] &&
        f.recordResolution.height === selectedRes[1]
    );

    const fpsOptions = matchingFormat?.frameRates || [];
    fpsSelect.innerHTML = fpsOptions
      .map((fps) => `<option>${fps} fps</option>`)
      .join("");

    const currentFPS = camera.propertyData["/system/format"]?.frameRate;
    if (fpsOptions.includes(currentFPS)) {
      fpsSelect.value = `${currentFPS} fps`;
    }
  }

  codecSelect.addEventListener("change", updateResolutions);
  resSelect.addEventListener("change", updateFPS);

  updateCodecs();

  // ========== Recording State ==========

  if (cameras[ci].propertyData["/transports/0/record"]?.recording) {
    document
      .getElementById("cameraControlHeadContainer")
      .classList.add("liveCam");
    document
      .getElementById("cameraControlExpandedHeadContainer")
      .classList.add("liveCam");
  } else {
    document
      .getElementById("cameraControlHeadContainer")
      .classList.remove("liveCam");
    document
      .getElementById("cameraControlExpandedHeadContainer")
      .classList.remove("liveCam");
  }

  // ========== Playback Loop State ==========
  let loopState = cameras[ci].propertyData["/transports/0/playback"]?.loop;
  let singleClipState =
    cameras[ci].propertyData["/transports/0/playback"]?.singleClip;

  let loopButton = document.getElementById("loopButton");
  let singleClipButton = document.getElementById("singleClipButton");

  if (loopState) {
    loopButton.classList.add("activated");
  } else {
    loopButton.classList.remove("activated");
  }

  if (singleClipState) {
    singleClipButton.classList.add("activated");
  } else {
    singleClipButton.classList.remove("activated");
  }

  // ========== Timecode ==========

  document.getElementById("timecodeLabel").innerHTML = parseTimecode(
    cameras[ci].propertyData["/transports/0/timecode"]?.timecode
  );

  // ========== Presets Dropdown ==========

  if (!unsavedChanges.includes("presets")) {
    var presetsList = document.getElementById("presetsDropDown");

    presetsList.innerHTML = "";

    cameras[ci].propertyData["/presets"]?.presets.forEach((presetItem) => {
      let presetName = presetItem.split(".", 1);

      let textNode = document.createTextNode(presetName);
      let optionNode = document.createElement("option");
      optionNode.setAttribute("name", "presetOption" + presetName);
      optionNode.appendChild(textNode);
      document.getElementById("presetsDropDown").appendChild(optionNode);
    });

    // ========== Active Preset ==========

    var presetsList = document.getElementById("presetsDropDown");

    presetsList.childNodes.forEach((child) => {
      if (
        child.nodeName == "OPTION" &&
        child.value + ".cset" ==
          cameras[ci].propertyData["/presets/active"]?.preset
      ) {
        child.selected = true;
      } else {
        child.selected = false;
      }
    });
  }

  // ========== Iris ==========

  document.getElementById("irisRange").value =
    cameras[ci].propertyData["/lens/iris"]?.normalised;
  document.getElementById("apertureStopsLabel").innerHTML =
    cameras[ci].propertyData["/lens/iris"]?.apertureStop.toFixed(1);

  // ========== Zoom ==========

  document.getElementById("zoomRange").value =
    cameras[ci].propertyData["/lens/zoom"]?.normalised;
  document.getElementById("zoomMMLabel").innerHTML =
    cameras[ci].propertyData["/lens/zoom"]?.focalLength + "mm";

  // ========== Focus ==========

  document.getElementById("focusRange").value =
    cameras[ci].propertyData["/lens/focus"]?.normalised;

  // ========== ISO ==========
  if (!unsavedChanges.includes("ISO")) {
    if (cameras[ci].propertyData["/video/iso"])
      document.getElementById("ISOInput").value =
        cameras[ci].propertyData["/video/iso"]?.iso;
  }

  // ========== GAIN ==========

  if (!unsavedChanges.includes("Gain")) {
    let gainString = "";
    let gainInt = cameras[ci].propertyData["/video/gain"]?.gain;

    if (gainInt >= 0) {
      gainString = "+" + gainInt + "db";
    } else {
      gainString = gainInt + "db";
    }

    document.getElementById("gainSpan").innerHTML = gainString;
  }

  // ========== WHITE BALANCE ===========

  if (!unsavedChanges.includes("WB")) {
    document.getElementById("whiteBalanceSpan").innerHTML =
      cameras[ci].propertyData["/video/whiteBalance"]?.whiteBalance + "K";
  }

  if (!unsavedChanges.includes("WBT")) {
    document.getElementById("whiteBalanceTintSpan").innerHTML =
      cameras[ci].propertyData["/video/whiteBalanceTint"]?.whiteBalanceTint;
  }

  // =========== ND =============

  if (!unsavedChanges.includes("ND")) {
    if (cameras[ci].propertyData["/video/ndFilter"]) {
      document.getElementById("ndFilterSpan").innerHTML =
        cameras[ci].propertyData["/video/ndFilter"]?.stop;
    } else {
      document.getElementById("ndFilterSpan").innerHTML = 0;
      document.getElementById("ndFilterSpan").disabled = true;
    }
  }

  // ============ Shutter =====================

  if (!unsavedChanges.includes("Shutter")) {
    let shutterString = "SS";
    let shutterObj = cameras[ci].propertyData["/video/shutter"];

    if (shutterObj?.shutterSpeed) {
      shutterString = "1/" + shutterObj.shutterSpeed;
    } else if (shutterObj?.shutterAngle) {
      var shangleString = (shutterObj.shutterAngle / 100).toFixed(1).toString();
      if (shangleString.indexOf(".0") > 0) {
        shutterString = parseFloat(shangleString).toFixed(0) + "°";
      } else {
        shutterString = shangleString + "°";
      }
    }

    document.getElementById("shutterSpan").innerHTML = shutterString;
  }

  // =========== Auto Exposure Mode ===========

  if (!unsavedChanges.includes("AutoExposure")) {
    let AEmodeSelect = document.getElementById("AEmodeDropDown");
    let AEtypeSelect = document.getElementById("AEtypeDropDown");

    AEmodeSelect.value = cameras[ci].propertyData["/video/autoExposure"]?.mode;
    AEtypeSelect.value = cameras[ci].propertyData["/video/autoExposure"]?.type;
  }

  // =========== COLOR CORRECTION =============

  // Lift
  if (!unsavedChanges.includes("CC0")) {
    let liftProps = cameras[ci].propertyData["/colorCorrection/lift"];
    document.getElementsByClassName("CClumaLabel")[0].innerHTML =
      liftProps?.luma.toFixed(2);
    document.getElementsByClassName("CCredLabel")[0].innerHTML =
      liftProps?.red.toFixed(2);
    document.getElementsByClassName("CCgreenLabel")[0].innerHTML =
      liftProps?.green.toFixed(2);
    document.getElementsByClassName("CCblueLabel")[0].innerHTML =
      liftProps?.blue.toFixed(2);
  }

  // Gamma
  if (!unsavedChanges.includes("CC1")) {
    let gammaProps = cameras[ci].propertyData["/colorCorrection/gamma"];
    document.getElementsByClassName("CClumaLabel")[1].innerHTML =
      gammaProps?.luma.toFixed(2);
    document.getElementsByClassName("CCredLabel")[1].innerHTML =
      gammaProps?.red.toFixed(2);
    document.getElementsByClassName("CCgreenLabel")[1].innerHTML =
      gammaProps?.green.toFixed(2);
    document.getElementsByClassName("CCblueLabel")[1].innerHTML =
      gammaProps?.blue.toFixed(2);
  }

  // Gain
  if (!unsavedChanges.includes("CC2")) {
    let gainProps = cameras[ci].propertyData["/colorCorrection/gain"];
    document.getElementsByClassName("CClumaLabel")[2].innerHTML =
      gainProps?.luma.toFixed(2);
    document.getElementsByClassName("CCredLabel")[2].innerHTML =
      gainProps?.red.toFixed(2);
    document.getElementsByClassName("CCgreenLabel")[2].innerHTML =
      gainProps?.green.toFixed(2);
    document.getElementsByClassName("CCblueLabel")[2].innerHTML =
      gainProps?.blue.toFixed(2);
  }

  // Offset
  if (!unsavedChanges.includes("CC3")) {
    let offsetProps = cameras[ci].propertyData["/colorCorrection/offset"];
    document.getElementsByClassName("CClumaLabel")[3].innerHTML =
      offsetProps?.luma.toFixed(2);
    document.getElementsByClassName("CCredLabel")[3].innerHTML =
      offsetProps?.red.toFixed(2);
    document.getElementsByClassName("CCgreenLabel")[3].innerHTML =
      offsetProps?.green.toFixed(2);
    document.getElementsByClassName("CCblueLabel")[3].innerHTML =
      offsetProps?.blue.toFixed(2);
  }

  // Contrast
  if (!unsavedChanges.includes("CC4")) {
    let constrastProps = cameras[ci].propertyData["/colorCorrection/contrast"];
    document.getElementById("CCcontrastPivotRange").value =
      constrastProps?.pivot;
    document.getElementById("CCcontrastPivotLabel").innerHTML =
      constrastProps?.pivot.toFixed(2);
    document.getElementById("CCcontrastAdjustRange").value =
      constrastProps?.adjust;
    document.getElementById("CCcontrastAdjustLabel").innerHTML =
      parseInt(constrastProps?.adjust * 50) + "%";
  }

  // Color
  if (!unsavedChanges.includes("CC5")) {
    let colorProps = cameras[ci].propertyData["/colorCorrection/color"];
    document.getElementById("CChueRange").value = colorProps?.hue;
    document.getElementById("CCcolorHueLabel").innerHTML =
      parseInt((colorProps?.hue + 1) * 180) + "°";

    document.getElementById("CCsaturationRange").value = colorProps?.saturation;
    document.getElementById("CCcolorSatLabel").innerHTML =
      parseInt(colorProps?.saturation * 50) + "%";

    let lumaContributionProps =
      cameras[ci].propertyData["/colorCorrection/lumaContribution"];
    document.getElementById("CClumaContributionRange").value =
      lumaContributionProps?.lumaContribution;
    document.getElementById("CCcolorLCLabel").innerHTML =
      parseInt(lumaContributionProps?.lumaContribution * 100) + "%";
  }

  syncCCWheel(0);
  syncCCWheel(1);
  syncCCWheel(2);
  syncCCWheel(3);

  // ============ Footer Links ===============
  document.getElementById("documentationLink").href =
    (cameras[ci].useHTTPS ? "https://" : "http://") +
    cameras[ci].hostname +
    "/control/documentation.html";
  document.getElementById("mediaManagerLink").href =
    (cameras[ci].useHTTPS ? "https://" : "http://") + cameras[ci].hostname;
}

// ==============================================================================

// Called when the user changes tabs to a different camera
function switchCamera(index) {
  if (cameras[ci]) {
    cameras[ci].active = false;
  }

  ci = index;

  // Reset the Controls
  document.getElementById("allCamerasContainer").innerHTML =
    defaultControlsHTML;

  // Update the UI

  for (var i = 0; i < 8; i++) {
    if (i == ci) {
      document
        .getElementsByClassName("cameraSwitchLabel")
        [i].classList.add("selectedCam");
    } else {
      document
        .getElementsByClassName("cameraSwitchLabel")
        [i].classList.remove("selectedCam");
    }
  }

  document.getElementById("cameraNumberLabel").innerHTML = "CAM" + (ci + 1);
  document.getElementById("cameraName").innerHTML = "CAMERA NAME";
  document.getElementById("hostnameInput").value = localStorage.getItem(
    "camerahostname_" + ci.toString()
  );
  if (localStorage.getItem("camerasecurity_" + ci.toString()) === "true") {
    document.getElementById("secureCheckbox").checked = true;
  }
  if (cameras[ci]) {
    cameras[ci].active = true;
  }
}

// For not-yet-implemented Color Correction UI
function setCCMode(mode) {
  if (mode == 0) {
    // Lift
  } else if (mode == 1) {
    // Gamma
  } else {
    // Gain
  }

  for (var i = 0; i < 3; i++) {
    if (i == mode) {
      document
        .getElementsByClassName("ccTabLabel")
        [i].classList.add("selectedTab");
    } else {
      document
        .getElementsByClassName("ccTabLabel")
        [i].classList.remove("selectedTab");
    }
  }
}

// Allows for changing WB/Tint displayed in the UI
function swapWBMode() {
  if (WBMode == 0) {
    // Balance
    document.getElementById("WBLabel").innerHTML = "TINT";
    document.getElementById("WBValueContainer").classList.add("dNone");
    document.getElementById("WBTintValueContainer").classList.remove("dNone");

    WBMode = 1;
  } else {
    //Tint
    document.getElementById("WBLabel").innerHTML = "BALANCE";
    document.getElementById("WBValueContainer").classList.remove("dNone");
    document.getElementById("WBTintValueContainer").classList.add("dNone");

    WBMode = 0;
  }
}

// Triggered by the button by those text boxes. Reads the info from the inputs and sends it to the camera.
function manualAPICall() {
  const requestRadioGET = document.getElementById("requestTypeGET");

  const requestEndpointText = document.getElementById(
    "manualRequestEndpointLabel"
  ).value;
  let requestData = "";

  try {
    requestData = JSON.parse(
      document.getElementById("manualRequestBodyLabel").value
    );
  } catch (err) {
    document.getElementById("manualRequestResponseP").innerHTML = err;
  }

  const requestMethod = requestRadioGET.checked ? "GET" : "PUT";
  const requestURL = cameras[ci].APIAddress + requestEndpointText;

  let response = sendRequest(requestMethod, requestURL, requestData);

  document.getElementById("manualRequestResponseP").innerHTML =
    JSON.stringify(response);
}

/*  Control Calling Functions   */
/*    Makes the HTML cleaner.   */
function codecChange(selectElement) {
  const selectedCodec = selectElement.value;
  const supportedFormats =
    cameras[ci].propertyData["/system/supportedFormats"].supportedFormats;

  const formatsForCodec = supportedFormats.filter((f) =>
    f.codecs.includes(selectedCodec)
  );

  let currentWidth =
    cameras[ci].propertyData["/system/format"].recordResolution.width;
  let currentHeight =
    cameras[ci].propertyData["/system/format"].recordResolution.height;

  let formatToUse = formatsForCodec.find(
    (f) =>
      f.recordResolution.width === currentWidth &&
      f.recordResolution.height === currentHeight
  );

  if (!formatToUse) {
    formatToUse = formatsForCodec.reduce((prev, curr) =>
      curr.recordResolution.width * curr.recordResolution.height >
      prev.recordResolution.width * prev.recordResolution.height
        ? curr
        : prev
    );
  }

  cameras[ci].PUTdata("/system/format", {
    codec: selectedCodec,
    frameRate: cameras[ci].propertyData["/system/format"].frameRate,
    recordResolution: formatToUse.recordResolution,
    sensorResolution: formatToUse.sensorResolution,
  });

  const resSelect = document.getElementById("formatResSelect");
  resSelect.value = `${formatToUse.recordResolution.width}x${formatToUse.recordResolution.height}`;
}

function resChange(selectElement) {
  const selectedValue = selectElement.value;

  const [width, height] = selectedValue.split("x").map(Number);

  cameras[ci].PUTdata("/system/format", {
    codec: cameras[ci].propertyData["/system/format"].codec,
    frameRate: cameras[ci].propertyData["/system/format"].frameRate,
    recordResolution: {
      width: width,
      height: height,
    },
    sensorResolution: {
      width: width,
      height: height,
    },
  });
}

function fpsChange(selectElement) {
  const selectedValue = selectElement.value;

  const frameRate = parseFloat(selectedValue);

  cameras[ci].PUTdata("/system/format", {
    codec: cameras[ci].propertyData["/system/format"].codec,
    frameRate: frameRate.toString(),
    recordResolution:
      cameras[ci].propertyData["/system/format"].recordResolution,
    sensorResolution:
      cameras[ci].propertyData["/system/format"].sensorResolution,
  });
}

function decreaseND() {
  cameras[ci].PUTdata("/video/ndFilter", {
    stop: cameras[ci].propertyData["/video/ndFilter"].stop - 2,
  });
}

function increaseND() {
  cameras[ci].PUTdata("/video/ndFilter", {
    stop: cameras[ci].propertyData["/video/ndFilter"].stop + 2,
  });
}

function decreaseGain() {
  cameras[ci].PUTdata("/video/gain", {
    gain: cameras[ci].propertyData["/video/gain"].gain - 2,
  });
}

function increaseGain() {
  cameras[ci].PUTdata("/video/gain", {
    gain: cameras[ci].propertyData["/video/gain"].gain + 2,
  });
}

function decreaseShutter() {
  let cam = cameras[ci];

  if ("shutterSpeed" in cam.propertyData["/video/shutter"]) {
    cam.PUTdata("/video/shutter", {
      shutterSpeed: cam.propertyData["/video/shutter"].shutterSpeed + 10,
    });
  } else {
    cam.PUTdata("/video/shutter", {
      shutterAngle: cam.propertyData["/video/shutter"].shutterAngle - 1000,
    });
  }
}

function increaseShutter() {
  let cam = cameras[ci];

  if ("shutterSpeed" in cam.propertyData["/video/shutter"]) {
    cam.PUTdata("/video/shutter", {
      shutterSpeed: cam.propertyData["/video/shutter"].shutterSpeed - 10,
    });
  } else {
    cam.PUTdata("/video/shutter", {
      shutterAngle: cam.propertyData["/video/shutter"].shutterAngle + 1000,
    });
  }
}

function handleShutterInput() {
  let inputString = document.getElementById("shutterSpan").innerHTML;

  if (event.key === "Enter") {
    let cam = cameras[ci];

    if ("shutterSpeed" in cam.propertyData["/video/shutter"]) {
      if (inputString.indexOf("1/") >= 0) {
        cam.PUTdata("/video/shutter", {
          shutterSpeed: parseInt(inputString.substring(2)),
        });
      } else {
        cam.PUTdata("/video/shutter", { shutterSpeed: parseInt(inputString) });
      }
    } else {
      cam.PUTdata("/video/shutter", {
        shutterAngle: parseInt(parseFloat(inputString) * 100),
      });
    }

    unsavedChanges = unsavedChanges.filter((e) => {
      return e !== "Shutter";
    });
  } else {
    unsavedChanges.push("Shutter");
  }
}

function decreaseWhiteBalance() {
  cameras[ci].PUTdata("/video/whiteBalance", {
    whiteBalance:
      cameras[ci].propertyData["/video/whiteBalance"].whiteBalance - 50,
  });
}

function increaseWhiteBalance() {
  cameras[ci].PUTdata("/video/whiteBalance", {
    whiteBalance:
      cameras[ci].propertyData["/video/whiteBalance"].whiteBalance + 50,
  });
}

function decreaseWhiteBalanceTint() {
  cameras[ci].PUTdata("/video/whiteBalanceTint", {
    whiteBalanceTint:
      cameras[ci].propertyData["/video/whiteBalanceTint"].whiteBalanceTint - 1,
  });
}

function increaseWhiteBalanceTint() {
  cameras[ci].PUTdata("/video/whiteBalanceTint", {
    whiteBalanceTint:
      cameras[ci].propertyData["/video/whiteBalanceTint"].whiteBalanceTint + 1,
  });
}

function presetInputHandler() {
  let selectedPreset = document.getElementById("presetsDropDown").value;

  cameras[ci].PUTdata("/presets/active", { preset: selectedPreset + ".cset" });

  unsavedChanges = unsavedChanges.filter((e) => {
    return e !== "presets";
  });
}

function hostnameInputHandler() {
  let newHostname = document.getElementById("hostnameInput").value;

  if (event.key === "Enter") {
    event.preventDefault;
    unsavedChanges = unsavedChanges.filter((e) => {
      return e !== "Hostname";
    });
    initCamera();
  } else {
    unsavedChanges.push("Hostname");
  }
}

function AEmodeInputHandler() {
  let AEmode = document.getElementById("AEmodeDropDown").value;
  let AEtype = document.getElementById("AEtypeDropDown").value;

  cameras[ci].PUTdata("/video/autoExposure", { mode: AEmode, type: AEtype });

  unsavedChanges = unsavedChanges.filter((e) => {
    return e !== "AutoExposure";
  });
}

function ISOInputHandler() {
  let ISOInput = document.getElementById("ISOInput");

  if (event.key === "Enter") {
    event.preventDefault;
    cameras[ci].PUTdata("/video/iso", { iso: parseInt(ISOInput.value) });
    unsavedChanges = unsavedChanges.filter((e) => {
      return e !== "ISO";
    });
  } else {
    unsavedChanges.push("ISO");
  }
}

// 0: lift, 1: gamma, 2: gain, 3: offset, 4: contrast, 5: color & LC
function CCInputHandler(which) {
  if (event.key === "Enter") {
    event.preventDefault;
    setCCFromUI(which);
  } else {
    unsavedChanges.push("CC" + which);
  }
}

function NDFilterInputHandler() {
  if (event.key === "Enter") {
    event.preventDefault;
    cameras[ci].PUTdata("/video/ndFilter", {
      stop: parseInt(document.getElementById("ndFilterSpan").innerHTML),
    });
    unsavedChanges = unsavedChanges.filter((e) => {
      return e !== "ND";
    });
  } else {
    unsavedChanges.push("ND");
  }
}

function GainInputHandler() {
  if (event.key === "Enter") {
    event.preventDefault;
    cameras[ci].PUTdata("/video/gain", {
      gain: parseInt(document.getElementById("gainSpan").innerHTML),
    });
    unsavedChanges = unsavedChanges.filter((e) => {
      return e !== "Gain";
    });
  } else {
    unsavedChanges.push("Gain");
  }
}

function WBInputHandler() {
  if (event.key === "Enter") {
    event.preventDefault;
    cameras[ci].PUTdata("/video/whiteBalance", {
      whiteBalance: parseInt(
        document.getElementById("whiteBalanceSpan").innerHTML
      ),
    });
    unsavedChanges = unsavedChanges.filter((e) => {
      return e !== "WB";
    });
  } else {
    unsavedChanges.push("WB");
  }
}

function WBTInputHandler() {
  if (event.key === "Enter") {
    event.preventDefault;
    cameras[ci].PUTdata("/video/whiteBalanceTint", {
      whiteBalanceTint: parseInt(
        document.getElementById("whiteBalanceTintSpan").innerHTML
      ),
    });
    unsavedChanges = unsavedChanges.filter((e) => {
      return e !== "WBT";
    });
  } else {
    unsavedChanges.push("WBT");
  }
}

// 0: lift, 1: gamma, 2: gain, 3: offset
function setCCFromUI(which) {
  if (which < 4) {
    var lumaFloat = parseFloat(
      document.getElementsByClassName("CClumaLabel")[which].innerHTML
    );
    var redFloat = parseFloat(
      document.getElementsByClassName("CCredLabel")[which].innerHTML
    );
    var greenFloat = parseFloat(
      document.getElementsByClassName("CCgreenLabel")[which].innerHTML
    );
    var blueFloat = parseFloat(
      document.getElementsByClassName("CCblueLabel")[which].innerHTML
    );

    var ccobject = {
      red: redFloat,
      green: greenFloat,
      blue: blueFloat,
      luma: lumaFloat,
    };
  }

  if (which == 0) {
    cameras[ci].PUTdata("/colorCorrection/lift", ccobject);
  } else if (which == 1) {
    cameras[ci].PUTdata("/colorCorrection/gamma", ccobject);
  } else if (which == 2) {
    cameras[ci].PUTdata("/colorCorrection/gain", ccobject);
  } else if (which == 3) {
    cameras[ci].PUTdata("/colorCorrection/offset", ccobject);
  } else if (which == 4) {
    let pivotFloat = parseFloat(
      document.getElementById("CCcontrastPivotLabel").innerHTML
    );
    let adjustInt = parseInt(
      document.getElementById("CCcontrastAdjustLabel").innerHTML
    );

    let adjustFloat = adjustInt / 50.0;

    cameras[ci].PUTdata("/colorCorrection/contrast", {
      pivot: pivotFloat,
      adjust: adjustFloat,
    });
  } else {
    let hueInt = parseInt(document.getElementById("CCcolorHueLabel").innerHTML);
    let satInt = parseInt(document.getElementById("CCcolorSatLabel").innerHTML);
    let lumCoInt = parseInt(
      document.getElementById("CCcolorLCLabel").innerHTML
    );

    let hueFloat = hueInt / 180.0 - 1.0;
    let satFloat = satInt / 50.0;
    let lumCoFloat = lumCoInt / 100.0;

    cameras[ci].PUTdata("/colorCorrection/color", {
      hue: hueFloat,
      saturation: satFloat,
    });
    cameras[ci].PUTdata("/colorCorrection/lumaContribution", {
      lumaContribution: lumCoFloat,
    });
  }

  unsavedChanges = unsavedChanges.filter((e) => {
    return !e.includes("CC" + which);
  });
}

// Reset Color Correction Values
// 0: lift, 1: gamma, 2: gain, 3: offset, 4: contrast, 5: color & LC
function resetCC(which) {
  if (which == 0) {
    cameras[ci].PUTdata("/colorCorrection/lift", {
      red: 0.0,
      green: 0.0,
      blue: 0.0,
      luma: 0.0,
    });
  } else if (which == 1) {
    cameras[ci].PUTdata("/colorCorrection/gamma", {
      red: 0.0,
      green: 0.0,
      blue: 0.0,
      luma: 0.0,
    });
  } else if (which == 2) {
    cameras[ci].PUTdata("/colorCorrection/gain", {
      red: 1.0,
      green: 1.0,
      blue: 1.0,
      luma: 1.0,
    });
  } else if (which == 3) {
    cameras[ci].PUTdata("/colorCorrection/offset", {
      red: 0.0,
      green: 0.0,
      blue: 0.0,
      luma: 0.0,
    });
  } else if (which == 4) {
    cameras[ci].PUTdata("/colorCorrection/contrast", {
      pivot: 0.5,
      adjust: 1.0,
    });
  } else if (which == 5) {
    cameras[ci].PUTdata("/colorCorrection/color", {
      hue: 0.0,
      saturation: 1.0,
    });
    cameras[ci].PUTdata("/colorCorrection/lumaContribution", {
      lumaContribution: 1.0,
    });
  }

  unsavedChanges = unsavedChanges.filter((e) => {
    return !e.includes("CC" + which);
  });
}

// Triggered by the Loop and Single Clip buttons
function loopHandler(callerString) {
  let playbackState = cameras[ci].propertyData["/transports/0/playback"];

  if (callerString === "Loop") {
    playbackState.loop = !playbackState.loop;
  } else if (callerString === "Single Clip") {
    playbackState.singleClip = !playbackState.singleClip;
  }

  cameras[ci].PUTdata("/transports/0/playback", playbackState);
}

/*  Helper Functions   */
function parseTimecode(timecodeBCD) {
  let noDropFrame = timecodeBCD & 0b01111111111111111111111111111111; // The first bit of the timecode is 1 if "Drop Frame Timecode" is on. We don't want to include that in the display.
  let decimalTCInt = parseInt(noDropFrame.toString(16), 10); // Convert the BCD number into base ten
  let decimalTCString = decimalTCInt.toString().padStart(8, "0"); // Convert the base ten number to a string eight characters long
  let finalTCString = decimalTCString.match(/.{1,2}/g).join(":"); // Put colons between every two characters
  return finalTCString;
}
