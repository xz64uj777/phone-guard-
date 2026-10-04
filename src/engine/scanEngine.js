import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import * as Battery from "expo-battery";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as FileSystem from "expo-file-system";
import * as Network from "expo-network";
import { Platform } from "react-native";

const LAST_SCAN_KEY = "phoneguard.lastScan.v1";
const ALERTS_KEY = "phoneguard.alerts.v1";
const SETTINGS_KEY = "phoneguard.settings.v1";

export const DEFAULT_SETTINGS = {
  offlineFirst: true,
  uploadPersonalFiles: false,
  confirmEveryDelete: true,
  largeFileBytes: 20 * 1024 * 1024,
  cacheAlertBytes: 40 * 1024 * 1024,
};

function finding(partial) {
  return {
    id: partial.id,
    category: partial.category,
    title: partial.title,
    status: partial.status,
    detail: partial.detail,
    evidence: partial.evidence || "No raw evidence retained.",
    limitation: partial.limitation || null,
    remediation: partial.remediation || null,
    action: partial.action || null,
  };
}

function bytes(n) {
  if (n == null || Number.isNaN(n)) return "unknown";
  const u = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

async function safe(label, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), label };
  }
}

function dirUri(dir) {
  if (!dir) return null;
  return dir.endsWith("/") ? dir : `${dir}/`;
}

async function listTree(root, depthLimit = 3, cap = 350) {
  const files = [];
  async function walk(dir, depth) {
    if (depth > depthLimit || files.length >= cap) return;
    let names = [];
    try {
      names = await FileSystem.readDirectoryAsync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= cap) return;
      const uri = `${dir}${name}`;
      let info;
      try {
        info = await FileSystem.getInfoAsync(uri);
      } catch {
        continue;
      }
      if (info.isDirectory) {
        await walk(`${uri}/`, depth + 1);
      } else {
        files.push({
          name,
          uri,
          size: info.size || 0,
          mtime: info.modificationTime || null,
        });
      }
    }
  }
  await walk(dirUri(root), 0);
  return files;
}

function duplicatesOf(files) {
  const groups = new Map();
  for (const file of files) {
    if (!file.size) continue;
    const key = `${file.size}:${file.name}`;
    const bucket = groups.get(key) || [];
    bucket.push(file);
    groups.set(key, bucket);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export function scoreScan(findings) {
  const verified = findings.filter((f) =>
    ["ok", "watch", "risk"].includes(f.status)
  );
  const blocked = findings.filter((f) => f.status === "not_accessible");
  const needs = findings.filter((f) => f.status === "needs_action");
  let score = 100;
  for (const f of verified) {
    if (f.status === "risk") score -= 16;
    if (f.status === "watch") score -= 7;
  }
  score = Math.max(0, Math.min(100, score));
  const coverage = findings.length
    ? Math.round((verified.length / findings.length) * 100)
    : 0;
  return {
    score,
    coverage,
    verified: verified.length,
    blocked: blocked.length,
    needsAction: needs.length,
    risks: verified.filter((f) => f.status === "risk").length,
    watches: verified.filter((f) => f.status === "watch").length,
    note:
      coverage < 100
        ? "Score uses verified checks only. Blocked areas are not treated as clean."
        : "Every check in this run was verified.",
  };
}

export async function loadSettings() {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(next) {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
}

export async function loadLastScan() {
  try {
    const raw = await AsyncStorage.getItem(LAST_SCAN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function loadAlerts() {
  try {
    const raw = await AsyncStorage.getItem(ALERTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveScan(report) {
  await AsyncStorage.setItem(LAST_SCAN_KEY, JSON.stringify(report));
  const alerts = report.findings
    .filter((f) => ["risk", "watch", "needs_action"].includes(f.status))
    .map((f) => ({
      id: `${report.scannedAt}:${f.id}`,
      at: report.scannedAt,
      title: f.title,
      status: f.status,
      detail: f.detail,
      read: false,
    }));
  await AsyncStorage.setItem(ALERTS_KEY, JSON.stringify(alerts.slice(0, 40)));
}

export async function markAlertsRead() {
  const alerts = await loadAlerts();
  await AsyncStorage.setItem(
    ALERTS_KEY,
    JSON.stringify(alerts.map((a) => ({ ...a, read: true })))
  );
}

export async function runPhoneGuardScan(onProgress) {
  const settings = await loadSettings();
  const findings = [];
  const log = [];

  function emit(step) {
    log.push(step);
    onProgress?.({
      step,
      log: [...log],
      findings: [...findings],
    });
  }

  function add(item) {
    findings.push(finding(item));
    emit(item.title);
  }

  emit("Starting local scan. Nothing is uploaded.");

  if (Platform.OS !== "android") {
    add({
      id: "platform",
      category: "System",
      title: "Not running on Android",
      status: "needs_action",
      detail: `This build is running on ${Platform.OS}. Android-only checks will stay unverified.`,
      evidence: `Platform.OS=${Platform.OS}`,
      remediation: "Open PhoneGuard in Expo Go on the Android phone you want checked.",
    });
  } else {
    add({
      id: "platform",
      category: "System",
      title: "Running on Android",
      status: "ok",
      detail: "Scan context is an Android app process, not a desktop guess.",
      evidence: `Platform.OS=android`,
    });
  }

  const device = await safe("device", async () => ({
    brand: Device.brand,
    manufacturer: Device.manufacturer,
    modelName: Device.modelName,
    osName: Device.osName,
    osVersion: Device.osVersion,
    deviceYearClass: Device.deviceYearClass,
    totalMemory: Device.totalMemory,
    isDevice: Device.isDevice,
    platformApiLevel: Device.platformApiLevel,
  }));
  if (device.ok) {
    const d = device.value;
    add({
      id: "device-identity",
      category: "Device",
      title: "Device identity readable",
      status: "ok",
      detail: `${d.manufacturer || d.brand || "Unknown"} ${d.modelName || "device"} · Android ${d.osVersion || "?"} · API ${d.platformApiLevel || "?"}`,
      evidence: d.isDevice
        ? "expo-device reports a physical device."
        : "expo-device reports an emulator. Treat results as lab-only.",
      limitation: "Model and API level are not a malware verdict.",
    });
    if (!d.isDevice) {
      add({
        id: "emulator",
        category: "Integrity",
        title: "Emulator session",
        status: "watch",
        detail: "This process is not on a physical handset.",
        evidence: "Device.isDevice=false",
      });
    }
    if (d.totalMemory) {
      add({
        id: "memory",
        category: "Performance",
        title: "Installed memory",
        status: "ok",
        detail: `${bytes(d.totalMemory)} reported by the system to this app.`,
        evidence: `Device.totalMemory=${d.totalMemory}`,
        limitation: "This is capacity, not live pressure. Android does not give third-party apps a trustworthy per-process hit list.",
      });
    }
  } else {
    add({
      id: "device-identity",
      category: "Device",
      title: "Device identity unavailable",
      status: "not_accessible",
      detail: device.error,
      evidence: "expo-device threw.",
    });
  }

  const appInfo = await safe("application", async () => ({
    name: Application.applicationName,
    id: Application.applicationId,
    version: Application.nativeApplicationVersion,
    build: Application.nativeBuildVersion,
  }));
  if (appInfo.ok) {
    add({
      id: "self-app",
      category: "Apps",
      title: "This app only",
      status: "ok",
      detail: `${appInfo.value.name} · ${appInfo.value.id} · ${appInfo.value.version || "dev"}`,
      evidence: "expo-application can read the host app, not the rest of the drawer.",
      limitation:
        "QUERY_ALL_PACKAGES is intentionally not requested. PhoneGuard will not invent an installed-app list.",
    });
  }

  add({
    id: "installed-apps",
    category: "Apps",
    title: "Installed-app inventory",
    status: "not_accessible",
    detail:
      "Android does not let a normal app list every package and its permissions. Play policy also restricts QUERY_ALL_PACKAGES.",
    evidence: "No PackageManager query was attempted.",
    limitation: "A result of 'no spyware apps found' would be fake here.",
    remediation: "Open the system app list and review permissions per app yourself.",
    action: "apps",
  });

  add({
    id: "permission-audit",
    category: "Privacy",
    title: "Other apps' permission grants",
    status: "not_accessible",
    detail:
      "Grant state for camera, mic, SMS, location, and accessibility belongs to each app and the system settings UI.",
    evidence: "AppOps / PackageManager permission tables are not exposed to this process.",
    remediation: "Use the in-app permission center to jump into Android settings.",
    action: "permissions",
  });

  const battery = await safe("battery", async () => {
    const [level, state, lowPower, saver] = await Promise.all([
      Battery.getBatteryLevelAsync(),
      Battery.getBatteryStateAsync(),
      Battery.isLowPowerModeEnabledAsync(),
      Battery.isBatteryOptimizationEnabledAsync?.() ?? Promise.resolve(null),
    ]);
    return { level, state, lowPower, saver };
  });
  if (battery.ok) {
    const pct = Math.round((battery.value.level || 0) * 100);
    const stateName =
      {
        [Battery.BatteryState.CHARGING]: "charging",
        [Battery.BatteryState.FULL]: "full",
        [Battery.BatteryState.UNPLUGGED]: "unplugged",
        [Battery.BatteryState.UNKNOWN]: "unknown",
      }[battery.value.state] || "unknown";
    const low = pct > 0 && pct <= 15 && stateName === "unplugged";
    add({
      id: "battery-level",
      category: "Battery",
      title: low ? "Battery is low" : "Battery level readable",
      status: low ? "watch" : "ok",
      detail: `${pct}% · ${stateName}${battery.value.lowPower ? " · low-power mode on" : ""}`,
      evidence: `Battery.getBatteryLevelAsync=${battery.value.level}`,
      remediation: low ? "Charge the phone or turn on battery saver." : null,
      action: "battery",
    });
    add({
      id: "battery-health",
      category: "Battery",
      title: "Battery health / cycle count",
      status: "not_accessible",
      detail:
        "Cycle count, manufacture date, and health grade are not available to third-party apps through the public BatteryManager on current Android.",
      evidence: "No health extra was read because the API does not provide one.",
      remediation: "Check Settings > Battery > Battery health if the OEM exposes it.",
      action: "battery",
    });
  } else {
    add({
      id: "battery-level",
      category: "Battery",
      title: "Battery diagnostics blocked",
      status: "not_accessible",
      detail: battery.error,
      evidence: "expo-battery failed.",
    });
  }

  const net = await safe("network", async () => Network.getNetworkStateAsync());
  if (net.ok) {
    add({
      id: "network",
      category: "Network",
      title: "Active network type",
      status: "ok",
      detail: `${net.value.type || "unknown"} · connected=${String(net.value.isConnected)} · internet=${String(net.value.isInternetReachable)}`,
      evidence: "expo-network ConnectivityManager summary only.",
      limitation: "This does not list remote controllers, open ports, or which app owns traffic.",
    });
  }
  add({
    id: "vpn",
    category: "Network",
    title: "VPN session owner",
    status: "not_accessible",
    detail:
      "Android does not tell a normal app which VPN is connected, or whether a local VPN firewall is intercepting traffic.",
    evidence: "VpnService / NetworkCapabilities transport owner not queried.",
    remediation: "Open VPN settings and confirm only a VPN you installed is active.",
    action: "vpn",
  });
  add({
    id: "per-app-traffic",
    category: "Network",
    title: "Per-app connection log",
    status: "not_accessible",
    detail:
      "A full NetGuard-style log needs a local VPN the user turns on. PhoneGuard does not install one in this build, and it does not upload destinations.",
    evidence: "No VpnService is running inside this app.",
    remediation: "Use a local firewall you trust if you need per-app destinations. Do not grant it to an app you did not install.",
  });

  const sandboxRoots = [
    ["App documents", FileSystem.documentDirectory],
    ["App cache", FileSystem.cacheDirectory],
  ].filter(([, uri]) => !!uri);

  let cacheBytes = 0;
  const sandboxFiles = [];
  for (const [label, uri] of sandboxRoots) {
    const tree = await listTree(uri, 3, 250);
    sandboxFiles.push(...tree.map((f) => ({ ...f, root: label })));
    const total = tree.reduce((sum, f) => sum + (f.size || 0), 0);
    if (label === "App cache") cacheBytes = total;
    add({
      id: `sandbox-${label}`,
      category: "Storage",
      title: `${label} scanned`,
      status: "ok",
      detail: `${tree.length} files · ${bytes(total)} inside this app's private storage.`,
      evidence: uri,
      limitation: "This is PhoneGuard's own sandbox, not other apps' Android/data.",
    });
  }

  if (cacheBytes >= settings.cacheAlertBytes) {
    add({
      id: "cache-large",
      category: "Cleanup",
      title: "Own cache is large",
      status: "watch",
      detail: `${bytes(cacheBytes)} in PhoneGuard cache. Safe to clear after confirmation.`,
      evidence: `cacheBytes=${cacheBytes}`,
      remediation: "Storage tab → Clear own cache. Other apps' caches are not touched.",
      action: "storage",
    });
  } else {
    add({
      id: "cache-large",
      category: "Cleanup",
      title: "Own cache is small",
      status: "ok",
      detail: `${bytes(cacheBytes)} in PhoneGuard cache.`,
      evidence: `cacheBytes=${cacheBytes}`,
    });
  }

  add({
    id: "shared-storage",
    category: "Storage",
    title: "Shared storage / other apps' files",
    status: "needs_action",
    detail:
      "Full shared storage is not granted. Android scoped storage blocks a silent sweep of Downloads, Android/data, and other apps.",
    evidence: "No all-files access requested.",
    limitation: "A folder you pick in the Storage tab is the only extra tree that becomes verified.",
    remediation: "Storage tab → Scan a folder you choose. Review duplicates before any delete.",
    action: "storage",
  });

  const dupes = duplicatesOf(sandboxFiles);
  const large = sandboxFiles.filter((f) => f.size >= settings.largeFileBytes);
  add({
    id: "duplicates",
    category: "Cleanup",
    title: dupes.length ? "Duplicate names in sandbox" : "No sandbox duplicates",
    status: dupes.length ? "watch" : "ok",
    detail: dupes.length
      ? `${dupes.length} name+size groups. These are candidates, not auto-deleted.`
      : "No same-name, same-size pairs in the scanned sandbox.",
    evidence: `groups=${dupes.length}; large=${large.length}`,
  });

  add({
    id: "accessibility",
    category: "Privacy",
    title: "Accessibility services",
    status: "not_accessible",
    detail:
      "The list of enabled accessibility services is a protected setting. A third-party app cannot honestly certify that none are active.",
    evidence: "Settings.Secure enabled_accessibility_services was not read.",
    remediation: "Open Accessibility settings and disable services you do not recognize.",
    action: "accessibility",
  });
  add({
    id: "device-admin",
    category: "Privacy",
    title: "Device admin / profile owner",
    status: "not_accessible",
    detail:
      "Device-admin and work-profile owners are not enumerable here. PhoneGuard is not a device-policy controller.",
    evidence: "DevicePolicyManager not bound.",
    remediation: "Open Security settings and device-admin apps. Remove admins you did not enroll.",
    action: "security",
  });
  add({
    id: "overlay",
    category: "Privacy",
    title: "Draw-over-other-apps grants",
    status: "not_accessible",
    detail: "SYSTEM_ALERT_WINDOW grants for other packages are not listed to this app.",
    evidence: "No AppOps read.",
    remediation: "Open special app access → Display over other apps.",
    action: "overlay",
  });
  add({
    id: "notification-listener",
    category: "Privacy",
    title: "Notification listeners",
    status: "not_accessible",
    detail: "Which apps can read notifications is a protected setting.",
    evidence: "NotificationListenerService bindings not visible.",
    remediation: "Open notification listener access and revoke unknown apps.",
    action: "notifications",
  });

  add({
    id: "root",
    category: "Integrity",
    title: "Root indicator",
    status: "not_accessible",
    detail:
      "A non-root app cannot prove the device is unrooted. Common file probes are incomplete and easy to hide. PhoneGuard does not pretend a missing su binary is a clean bill.",
    evidence: "No root probe executed.",
    remediation: "If you did not unlock the bootloader, treat root claims from random apps as unverified.",
  });
  add({
    id: "bootloader",
    category: "Integrity",
    title: "Bootloader / verified boot",
    status: "not_accessible",
    detail:
      "Verified-boot state and bootloader lock live in system properties this app is not allowed to trust.",
    evidence: "ro.boot.verifiedbootstate not read.",
    remediation: "OEM settings or fastboot on a computer are the legitimate sources.",
  });
  add({
    id: "play-integrity",
    category: "Integrity",
    title: "Play Integrity verdict",
    status: "not_accessible",
    detail:
      "A Play Integrity verdict needs Google Play services and a network call to Google. Offline-first mode does not request one.",
    evidence: "No attestation request sent.",
    limitation: "Leaving this blank is intentional. It is not a pass.",
  });

  const digest = await safe("digest", async () =>
    Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      `${Application.applicationId || "phoneguard"}:${Date.now()}`
    )
  );

  const summary = scoreScan(findings);
  const report = {
    scannedAt: new Date().toISOString(),
    offline: true,
    uploaded: false,
    localReceipt: digest.ok ? digest.value.slice(0, 16) : null,
    summary,
    findings,
    storage: {
      cacheBytes,
      sandboxFileCount: sandboxFiles.length,
      duplicateGroups: dupes.map((group) =>
        group.map((f) => ({ name: f.name, uri: f.uri, size: f.size, root: f.root }))
      ),
      largeFiles: large.map((f) => ({
        name: f.name,
        uri: f.uri,
        size: f.size,
        root: f.root,
      })),
    },
  };
  await saveScan(report);
  await writeScanLog(report);
  emit("Scan log written on device. No upload.");
  return report;
}

export async function scanGrantedFolder(directoryUri) {
  const files = [];
  async function walk(uri, depth) {
    if (depth > 2 || files.length >= 300) return;
    let names = [];
    try {
      names = await FileSystem.StorageAccessFramework.readDirectoryAsync(uri);
    } catch {
      return;
    }
    for (const child of names) {
      if (files.length >= 300) return;
      let info;
      try {
        info = await FileSystem.getInfoAsync(child);
      } catch {
        continue;
      }
      if (info.isDirectory) {
        await walk(child, depth + 1);
      } else {
        const name = decodeURIComponent(child.split("/").pop() || "file");
        files.push({ name, uri: child, size: info.size || 0 });
      }
    }
  }
  await walk(directoryUri, 0);
  const dupes = duplicatesOf(files);
  const large = files.filter((f) => f.size >= DEFAULT_SETTINGS.largeFileBytes);
  return {
    directoryUri,
    fileCount: files.length,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    duplicateGroups: dupes,
    largeFiles: large,
    truncated: files.length >= 300,
  };
}

export async function clearOwnCache() {
  const root = FileSystem.cacheDirectory;
  if (!root) return { deleted: 0, bytes: 0 };
  const files = await listTree(root, 3, 400);
  let deleted = 0;
  let freed = 0;
  for (const file of files) {
    try {
      await FileSystem.deleteAsync(file.uri, { idempotent: true });
      deleted += 1;
      freed += file.size || 0;
    } catch {
      // skip locked files
    }
  }
  return { deleted, bytes: freed };
}

export async function deleteGrantedFile(uri) {
  await FileSystem.StorageAccessFramework.deleteAsync(uri);
}

export function formatScanLog(report) {
  if (!report) return "No scan yet.\n";
  const s = report.summary || {};
  const lines = [
    "PhoneGuard scan log",
    `When: ${report.scannedAt}`,
    `Uploaded: ${report.uploaded === false ? "no" : "unknown"}`,
    `Receipt: ${report.localReceipt || "none"}`,
    `Score: ${s.score ?? "-"}  coverage: ${s.coverage ?? 0}%`,
    `Verified: ${s.verified ?? 0}  risks: ${s.risks ?? 0}  watches: ${s.watches ?? 0}  blocked: ${s.blocked ?? 0}  needs action: ${s.needsAction ?? 0}`,
    s.note || "",
    "Blocked and needs-action lines are gaps, not malware hits.",
    "",
  ];
  for (const f of report.findings || []) {
    lines.push(`[${f.status}] ${f.category} — ${f.title}`);
    lines.push(f.detail || "");
    lines.push(`Evidence: ${f.evidence || "none"}`);
    if (f.limitation) lines.push(`Limit: ${f.limitation}`);
    if (f.remediation) lines.push(`Do this: ${f.remediation}`);
    lines.push("");
  }
  if (report.storage) {
    lines.push(`Sandbox files: ${report.storage.sandboxFileCount ?? 0}`);
    lines.push(`Own cache bytes: ${report.storage.cacheBytes ?? 0}`);
  }
  return lines.join("\n");
}

export async function writeScanLog(report) {
  const text = formatScanLog(report);
  const root = FileSystem.documentDirectory || FileSystem.cacheDirectory;
  if (!root) return { uri: null, text };
  const uri = `${root}phoneguard-scan.txt`;
  await FileSystem.writeAsStringAsync(uri, text);
  return { uri, text };
}

export { bytes };
