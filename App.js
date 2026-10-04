import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import * as IntentLauncher from "expo-intent-launcher";
import * as FileSystem from "expo-file-system";
import { colors, statusColor, statusLabel } from "./src/theme";
import {
  bytes,
  clearOwnCache,
  deleteGrantedFile,
  loadAlerts,
  loadLastScan,
  loadSettings,
  markAlertsRead,
  runPhoneGuardScan,
  saveSettings,
  scanGrantedFolder,
  writeScanLog,
} from "./src/engine/scanEngine";

const TABS = [
  { id: "overview", label: "Score" },
  { id: "scan", label: "Scan" },
  { id: "storage", label: "Storage" },
  { id: "access", label: "Access" },
  { id: "alerts", label: "Alerts" },
];

const SETTINGS_ACTIONS = [
  { id: "apps", label: "App list", action: "android.settings.APPLICATION_SETTINGS", note: "Review every installed app. PhoneGuard cannot list them." },
  { id: "permissions", label: "Permission manager", action: "android.settings.MANAGE_APPLICATIONS_SETTINGS", note: "Per-app grants live here, not in this process." },
  { id: "security", label: "Security", action: "android.settings.SECURITY_SETTINGS", note: "Device admin, screen lock, encryption status." },
  { id: "vpn", label: "VPN", action: "android.settings.VPN_SETTINGS", note: "Confirm the active VPN is one you installed." },
  { id: "accessibility", label: "Accessibility", action: "android.settings.ACCESSIBILITY_SETTINGS", note: "Disable services you do not recognize." },
  { id: "overlay", label: "Special access", action: "android.settings.MANAGE_DEFAULT_APPS_SETTINGS", note: "Then open Display over other apps in special access." },
  { id: "notifications", label: "Notification access", action: "android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS", note: "Revoke listeners you did not enable." },
  { id: "battery", label: "Battery", action: "android.settings.BATTERY_SAVER_SETTINGS", note: "OEM battery health, if present, is in system settings." },
  { id: "storage", label: "Storage settings", action: "android.settings.INTERNAL_STORAGE_SETTINGS", note: "System storage breakdown. This app only measured its own sandbox." },
  { id: "usage", label: "Usage access", action: "android.settings.USAGE_ACCESS_SETTINGS", note: "Required before any future usage-based app audit. Not used yet." },
  { id: "allfiles", label: "All files access", action: "android.settings.MANAGE_ALL_FILES_ACCESS_PERMISSION", note: "PhoneGuard does not request this. Granting it is optional and broad." },
];

function openSettings(action) {
  return IntentLauncher.startActivityAsync(action).catch(() =>
    IntentLauncher.startActivityAsync("android.settings.SETTINGS")
  );
}

function ScoreRing({ score, coverage }) {
  const color = score >= 85 ? colors.ok : score >= 65 ? colors.watch : colors.risk;
  return (
    <View style={styles.ring}>
      <Text style={[styles.ringScore, { color }]}>{score}</Text>
      <Text style={styles.ringCaption}>verified score</Text>
      <Text style={styles.ringMeta}>{coverage}% of checks verified</Text>
    </View>
  );
}

function FindingCard({ item, onAction }) {
  const color = statusColor[item.status] || colors.muted;
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={styles.cardCat}>{item.category}</Text>
        <Text style={[styles.badge, { color, borderColor: color }]}>{statusLabel[item.status]}</Text>
      </View>
      <Text style={styles.cardTitle}>{item.title}</Text>
      <Text style={styles.cardBody}>{item.detail}</Text>
      <Text style={styles.evidence}>Evidence: {item.evidence}</Text>
      {item.limitation ? <Text style={styles.limit}>Limit: {item.limitation}</Text> : null}
      {item.remediation ? <Text style={styles.fix}>Do this: {item.remediation}</Text> : null}
      {item.action ? (
        <Pressable style={styles.linkBtn} onPress={() => onAction(item.action)}>
          <Text style={styles.linkBtnText}>Open Android setting</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function App() {
  const [tab, setTab] = useState("overview");
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("Idle. No network scan is running.");
  const [log, setLog] = useState([]);
  const [filter, setFilter] = useState("all");
  const [alerts, setAlerts] = useState([]);
  const [settings, setSettings] = useState(null);
  const [folder, setFolder] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [notice, setNotice] = useState("");
  const [logPath, setLogPath] = useState("");

  useEffect(() => {
    loadLastScan().then(setReport);
    loadAlerts().then(setAlerts);
    loadSettings().then(setSettings);
  }, []);

  const findings = report?.findings || [];
  const visible = useMemo(() => {
    if (filter === "all") return findings;
    if (filter === "issues") return findings.filter((f) => f.status === "risk" || f.status === "watch");
    return findings.filter((f) => f.status === filter);
  }, [findings, filter]);

  async function startScan() {
    setBusy(true);
    setTab("scan");
    setNotice("");
    try {
      const next = await runPhoneGuardScan((progress) => {
        setStep(progress.step);
        setLog(progress.log);
      });
      setReport(next);
      setAlerts(await loadAlerts());
      const written = await writeScanLog(next);
      setLogPath(written.uri || "");
      setStep("Done. Results are below. Blocked lines are gaps, not hits.");
      setTab("scan");
      setFilter("all");
    } catch (error) {
      setStep(error?.message || "Scan failed.");
    } finally {
      setBusy(false);
    }
  }

  async function pickFolder() {
    setNotice("");
    const perm = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perm.granted) {
      setNotice("Folder access denied. Shared storage stays unverified.");
      return;
    }
    setBusy(true);
    try {
      const result = await scanGrantedFolder(perm.directoryUri);
      setFolder(result);
      setNotice(
        result.truncated
          ? "Folder scan hit the 300-file cap. This is a sample, not a full disk image."
          : "Folder scan finished on-device."
      );
    } catch (error) {
      setNotice(error?.message || "Could not read that folder.");
    } finally {
      setBusy(false);
    }
  }

  function askClearCache() {
    setConfirm({
      title: "Clear PhoneGuard cache?",
      body: "Deletes files only inside this app's cache. Other apps, photos, and downloads are not touched.",
      confirmLabel: "Delete cache",
      run: async () => {
        const result = await clearOwnCache();
        setNotice(`Removed ${result.deleted} cache files · ${bytes(result.bytes)}.`);
        setConfirm(null);
      },
    });
  }

  function askDelete(file) {
    setConfirm({
      title: `Delete ${file.name}?`,
      body: `${bytes(file.size)} · ${file.uri}`,
      confirmLabel: "Delete this file",
      run: async () => {
        await deleteGrantedFile(file.uri);
        setFolder((prev) =>
          prev
            ? {
                ...prev,
                largeFiles: prev.largeFiles.filter((f) => f.uri !== file.uri),
                duplicateGroups: prev.duplicateGroups
                  .map((g) => g.filter((f) => f.uri !== file.uri))
                  .filter((g) => g.length > 1),
              }
            : prev
        );
        setNotice(`Deleted ${file.name}.`);
        setConfirm(null);
      },
    });
  }

  async function shareLog() {
    if (!report) {
      setNotice("Run a scan first.");
      return;
    }
    const written = await writeScanLog(report);
    setLogPath(written.uri || "");
    await Share.share({
      title: "PhoneGuard scan log",
      message: written.text,
    });
    setNotice(written.uri ? `Log file: ${written.uri}` : "Log shared. File path unavailable.");
  }

  function jump(actionId) {
    const match = SETTINGS_ACTIONS.find((a) => a.id === actionId);
    if (match) openSettings(match.action);
  }

  return (
    <View style={styles.root}>
      <ExpoStatusBar style="light" />
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={styles.header}>
        <Text style={styles.mark}>PhoneGuard</Text>
        <Text style={styles.tag}>What this phone is up to — only what Android allows an app to see.</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {tab === "overview" && (
          <View>
            <ScoreRing score={report?.summary.score ?? "–"} coverage={report?.summary.coverage ?? 0} />
            <Text style={styles.note}>{report?.summary.note || "No scan yet. Score stays blank until a local scan runs."}</Text>
            <View style={styles.stats}>
              <Stat label="Risks" value={report?.summary.risks ?? "–"} />
              <Stat label="Watches" value={report?.summary.watches ?? "–"} />
              <Stat label="Blocked" value={report?.summary.blocked ?? "–"} />
              <Stat label="Action" value={report?.summary.needsAction ?? "–"} />
            </View>
            <Pressable style={styles.primary} onPress={startScan} disabled={busy}>
              {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryText}>Run local scan</Text>}
            </Pressable>
            <Pressable style={styles.secondary} onPress={shareLog} disabled={!report}>
              <Text style={styles.secondaryText}>Save and share log</Text>
            </Pressable>
            {logPath ? <Text style={styles.meta}>{logPath}</Text> : null}
            <Text style={styles.meta}>
              {report
                ? `Last scan ${report.scannedAt} · ${report.summary.verified} verified · ${report.summary.blocked} blocked · ${report.summary.needsAction} need you`
                : "Offline-first. Personal files are not uploaded."}
            </Text>
            {findings.length === 0 ? (
              <Text style={styles.note}>No results yet. Run a scan. The list opens on the Scan tab.</Text>
            ) : (
              findings.slice(0, 8).map((item) => <FindingCard key={item.id} item={item} onAction={jump} />)
            )}
          </View>
        )}

        {tab === "scan" && (
          <View>
            <Text style={styles.section}>Scan log</Text>
            <Text style={styles.note}>{step}</Text>
            <Pressable style={styles.primary} onPress={startScan} disabled={busy}>
              <Text style={styles.primaryText}>{busy ? "Scanning…" : "Run again"}</Text>
            </Pressable>
            <View style={styles.filters}>
              {["all", "issues", "needs_action", "not_accessible", "ok"].map((id) => (
                <Pressable key={id} onPress={() => setFilter(id)} style={[styles.chip, filter === id && styles.chipOn]}>
                  <Text style={styles.chipText}>{id.replace("_", " ")}</Text>
                </Pressable>
              ))}
            </View>
            {visible.map((item) => (
              <FindingCard key={item.id} item={item} onAction={jump} />
            ))}
            {log.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardCat}>Receipt</Text>
                <Text style={styles.evidence}>{report?.localReceipt ? `Local id ${report.localReceipt}` : "In progress"}</Text>
                <Text style={styles.cardBody}>{log.join(" · ")}</Text>
              </View>
            )}
          </View>
        )}

        {tab === "storage" && (
          <View>
            <Text style={styles.section}>Storage analyzer</Text>
            <Text style={styles.note}>
              Sandbox is always measurable. Shared storage is scanned only after you pick a folder. Deletes wait for confirmation.
            </Text>
            <Text style={styles.meta}>
              Own cache {bytes(report?.storage.cacheBytes || 0)} · sandbox files {report?.storage.sandboxFileCount ?? 0}
            </Text>
            <Pressable style={styles.primary} onPress={pickFolder}>
              <Text style={styles.primaryText}>Scan a folder you choose</Text>
            </Pressable>
            <Pressable style={styles.secondary} onPress={askClearCache}>
              <Text style={styles.secondaryText}>Clear own cache</Text>
            </Pressable>
            {notice ? <Text style={styles.fix}>{notice}</Text> : null}
            {folder && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Granted folder</Text>
                <Text style={styles.cardBody}>
                  {folder.fileCount} files · {bytes(folder.totalBytes)}
                  {folder.truncated ? " · capped at 300" : ""}
                </Text>
                <Text style={styles.evidence}>{folder.directoryUri}</Text>
              </View>
            )}
            {(folder?.largeFiles || report?.storage.largeFiles || []).map((file) => (
              <View key={file.uri} style={styles.card}>
                <Text style={styles.cardTitle}>{file.name}</Text>
                <Text style={styles.cardBody}>{bytes(file.size)} · {file.root || "granted folder"}</Text>
                {file.root ? null : (
                  <Pressable style={styles.linkBtn} onPress={() => askDelete(file)}>
                    <Text style={styles.linkBtnText}>Review delete</Text>
                  </Pressable>
                )}
              </View>
            ))}
            {(folder?.duplicateGroups || []).map((group, idx) => (
              <View key={`d-${idx}`} style={styles.card}>
                <Text style={styles.cardTitle}>Duplicate group · {group[0]?.name}</Text>
                {group.map((file) => (
                  <View key={file.uri} style={styles.dupRow}>
                    <Text style={styles.cardBody}>{bytes(file.size)}</Text>
                    <Pressable onPress={() => askDelete(file)}>
                      <Text style={styles.linkBtnText}>Delete</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ))}
          </View>
        )}

        {tab === "access" && (
          <View>
            <Text style={styles.section}>Android permission center</Text>
            <Text style={styles.note}>
              These open system screens. PhoneGuard does not copy their contents and does not mark them clear just because the screen opened.
            </Text>
            {SETTINGS_ACTIONS.map((item) => (
              <Pressable key={item.id} style={styles.card} onPress={() => openSettings(item.action)}>
                <Text style={styles.cardTitle}>{item.label}</Text>
                <Text style={styles.cardBody}>{item.note}</Text>
                <Text style={styles.evidence}>{item.action}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {tab === "alerts" && (
          <View>
            <Text style={styles.section}>Maintenance alerts</Text>
            <Text style={styles.note}>Local only. Generated from the last scan. No push account.</Text>
            <Pressable
              style={styles.secondary}
              onPress={async () => {
                await markAlertsRead();
                setAlerts(await loadAlerts());
              }}
            >
              <Text style={styles.secondaryText}>Mark read</Text>
            </Pressable>
            {alerts.length === 0 && <Text style={styles.meta}>No alerts yet.</Text>}
            {alerts.map((alert) => (
              <View key={alert.id} style={styles.card}>
                <Text style={[styles.badge, { color: statusColor[alert.status], borderColor: statusColor[alert.status] }]}>
                  {statusLabel[alert.status]}{alert.read ? " · read" : ""}
                </Text>
                <Text style={styles.cardTitle}>{alert.title}</Text>
                <Text style={styles.cardBody}>{alert.detail}</Text>
                <Text style={styles.evidence}>{alert.at}</Text>
              </View>
            ))}
            {settings && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Policy</Text>
                <Text style={styles.cardBody}>Offline-first: {String(settings.offlineFirst)}</Text>
                <Text style={styles.cardBody}>Upload personal files: {String(settings.uploadPersonalFiles)}</Text>
                <Text style={styles.cardBody}>Confirm every delete: {String(settings.confirmEveryDelete)}</Text>
                <Pressable
                  style={styles.linkBtn}
                  onPress={async () => {
                    const next = { ...settings, uploadPersonalFiles: false, offlineFirst: true, confirmEveryDelete: true };
                    setSettings(next);
                    await saveSettings(next);
                    setNotice("Upload stays off.");
                  }}
                >
                  <Text style={styles.linkBtnText}>Lock offline policy</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      <View style={styles.tabs}>
        {TABS.map((item) => (
          <Pressable key={item.id} style={styles.tab} onPress={() => setTab(item.id)}>
            <Text style={[styles.tabText, tab === item.id && styles.tabOn]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>

      <Modal visible={!!confirm} transparent animationType="fade">
        <View style={styles.modalBg}>
          <View style={styles.modal}>
            <Text style={styles.cardTitle}>{confirm?.title}</Text>
            <Text style={styles.cardBody}>{confirm?.body}</Text>
            <Pressable style={styles.primary} onPress={confirm?.run}>
              <Text style={styles.primaryText}>{confirm?.confirmLabel || "Confirm"}</Text>
            </Pressable>
            <Pressable style={styles.secondary} onPress={() => setConfirm(null)}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingTop: 54, paddingHorizontal: 20, paddingBottom: 8 },
  mark: { color: colors.text, fontSize: 22, fontWeight: "600", letterSpacing: 0.3 },
  tag: { color: colors.muted, marginTop: 4, fontSize: 13, lineHeight: 18 },
  body: { padding: 20, paddingBottom: 120 },
  ring: {
    alignSelf: "center",
    width: 180,
    height: 180,
    borderRadius: 90,
    borderWidth: 1,
    borderColor: colors.steel,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 12,
  },
  ringScore: { fontSize: 52, fontWeight: "500" },
  ringCaption: { color: colors.steel, fontSize: 12, letterSpacing: 0.6 },
  ringMeta: { color: colors.muted, fontSize: 11, marginTop: 4 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  meta: { color: colors.blocked, fontSize: 12, marginVertical: 8 },
  stats: { flexDirection: "row", gap: 8, marginBottom: 14 },
  stat: { flex: 1, backgroundColor: colors.surface, padding: 10, borderRadius: 8 },
  statValue: { color: colors.text, fontSize: 18 },
  statLabel: { color: colors.muted, fontSize: 11, marginTop: 2 },
  primary: { backgroundColor: colors.steel, paddingVertical: 12, borderRadius: 8, alignItems: "center", marginBottom: 8 },
  primaryText: { color: colors.bg, fontWeight: "600" },
  secondary: { borderColor: colors.line, borderWidth: 1, paddingVertical: 12, borderRadius: 8, alignItems: "center", marginBottom: 8 },
  secondaryText: { color: colors.steel },
  section: { color: colors.text, fontSize: 18, marginBottom: 6 },
  card: { backgroundColor: colors.surface, borderRadius: 10, padding: 14, marginTop: 10, borderWidth: 1, borderColor: colors.line },
  cardTop: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  cardCat: { color: colors.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 },
  cardTitle: { color: colors.text, fontSize: 16, marginTop: 6, marginBottom: 4 },
  cardBody: { color: colors.steel, fontSize: 13, lineHeight: 18 },
  evidence: { color: colors.blocked, fontSize: 11, marginTop: 8 },
  limit: { color: colors.info, fontSize: 12, marginTop: 6, lineHeight: 17 },
  fix: { color: colors.watch, fontSize: 12, marginTop: 6, lineHeight: 17 },
  badge: { fontSize: 10, borderWidth: 1, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  linkBtn: { marginTop: 10 },
  linkBtnText: { color: colors.ok, fontSize: 13 },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginVertical: 8 },
  chip: { borderColor: colors.line, borderWidth: 1, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5 },
  chipOn: { borderColor: colors.steel },
  chipText: { color: colors.steel, fontSize: 11 },
  dupRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  tabs: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderTopColor: colors.line,
    borderTopWidth: 1,
    paddingBottom: 18,
    paddingTop: 10,
  },
  tab: { flex: 1, alignItems: "center" },
  tabText: { color: colors.blocked, fontSize: 12 },
  tabOn: { color: colors.text },
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.72)", justifyContent: "center", padding: 24 },
  modal: { backgroundColor: colors.surface2, borderRadius: 12, padding: 16 },
});
