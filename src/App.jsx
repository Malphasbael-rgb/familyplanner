import { useState, useEffect, useRef, useCallback } from "react";
import {
  supabase, loadAll,
  dbAddChild, dbDelChild, dbUpdateChildCoins,
  dbAddTask, dbDelTask, dbUpdateTaskStatus,
  dbAddReward, dbDelReward,
  dbAddRedemption, dbUpdateRedemptionStatus,
} from "./supabase.js";

const getTodayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const today = getTodayISO();
const genId = () => Math.random().toString(36).substr(2, 9);
const PARENT_PIN_KEY = "familyplanner-parent-pin-v1";
const DEFAULT_PARENT_PIN = "258000";
const CLOUD_SETTINGS_REWARD_ID = "__familyplanner_parent_settings__";
const CLOUD_SETTINGS_TITLE = "__familyplanner_parent_settings__";
const OVERDUE_TRACK_KEY = "familyplanner-overdue-track-v1";
const COMPLETED_HISTORY_DAYS = 14;
const LIFETIME_COINS_KEY = "familyplanner-lifetime-coins-v1";
const LEVELS = [
  { level: 1, name: "Starter", min: 0 },
  { level: 2, name: "Helper", min: 100 },
  { level: 3, name: "Doorzetter", min: 250 },
  { level: 4, name: "Teamspeler", min: 450 },
  { level: 5, name: "Superheld", min: 700 },
  { level: 6, name: "Kampioen", min: 1000 },
  { level: 7, name: "Meester", min: 1350 },
  { level: 8, name: "Expert", min: 1750 },
  { level: 9, name: "Legende", min: 2200 },
  { level: 10, name: "Ultieme Held", min: 2700 },
];

const getStoredParentPin = () => {
  try {
    const pin = localStorage.getItem(PARENT_PIN_KEY);
    return /^\d{6}$/.test(pin || "") ? pin : DEFAULT_PARENT_PIN;
  } catch {
    return DEFAULT_PARENT_PIN;
  }
};
const setStoredParentPin = (pin) => {
  try { localStorage.setItem(PARENT_PIN_KEY, pin); } catch {}
};
const isCloudSettingsReward = (r) => r?.id === CLOUD_SETTINGS_REWARD_ID || r?.title === CLOUD_SETTINGS_TITLE;
const stripCloudSettingsFromData = (d) => ({
  ...d,
  rewards: Array.isArray(d?.rewards) ? d.rewards.filter(r => !isCloudSettingsReward(r)) : [],
});

const isPenaltyRedemption = (r) => Number(r?.cost || 0) < 0 || String(r?.rewardId || "").startsWith("penalty:");
const getPenaltyReason = (r) => {
  if (!isPenaltyRedemption(r)) return "";
  const title = String(r?.rewardTitle || "");
  return title.replace(/^Ecoins afgepakt\s*[—-]\s*/i, "").trim() || "Geen reden opgegeven";
};
async function fetchCloudSettings() {
  const res = await supabase.from("rewards").select("id,title,description").eq("id", CLOUD_SETTINGS_REWARD_ID).maybeSingle();
  if (res.error) throw new Error(`loadCloudSettings: ${res.error.message}`);
  const raw = res.data?.description || "";
  if (!raw) return { parentPin: null, lifetimeCoinsMap: {} };
  try {
    const parsed = JSON.parse(raw);
    return {
      parentPin: /^\d{6}$/.test(parsed?.parentPin || "") ? parsed.parentPin : null,
      lifetimeCoinsMap: parsed?.lifetimeCoinsMap && typeof parsed.lifetimeCoinsMap === "object" ? parsed.lifetimeCoinsMap : {},
    };
  } catch {
    return { parentPin: null, lifetimeCoinsMap: {} };
  }
}
async function saveCloudSettingsToCloud(patch = {}) {
  const current = await fetchCloudSettings().catch(() => ({ parentPin: null, lifetimeCoinsMap: {} }));
  const next = {
    parentPin: /^\d{6}$/.test(String(patch.parentPin ?? current.parentPin ?? "")) ? String(patch.parentPin ?? current.parentPin) : null,
    lifetimeCoinsMap: patch.lifetimeCoinsMap && typeof patch.lifetimeCoinsMap === "object" ? patch.lifetimeCoinsMap : (current.lifetimeCoinsMap || {}),
  };
  const payload = { id: CLOUD_SETTINGS_REWARD_ID, title: CLOUD_SETTINGS_TITLE, description: JSON.stringify(next), cost: 999999, emoji: "🔐" };
  const res = await supabase.from("rewards").upsert(payload, { onConflict: "id" }).select("id").single();
  if (res.error) throw new Error(`saveCloudSettings: ${res.error.message}`);
}

function diffDays(fromDate, toDate) {
  const start = new Date(`${fromDate}T00:00:00`);
  const end = new Date(`${toDate}T00:00:00`);
  return Math.max(0, Math.floor((end - start) / 86400000));
}

function loadOverdueTrack() {
  try {
    return JSON.parse(localStorage.getItem(OVERDUE_TRACK_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveOverdueTrack(track) {
  localStorage.setItem(OVERDUE_TRACK_KEY, JSON.stringify(track));
}

function loadLifetimeCoins() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIFETIME_COINS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveLifetimeCoins(map) {
  try {
    localStorage.setItem(LIFETIME_COINS_KEY, JSON.stringify(map || {}));
  } catch {}
}

function getChildLifetimeCoinsValue(child, lifetimeMap = {}) {
  if (!child) return 0;
  const raw = lifetimeMap?.[child.id];
  if (Number.isFinite(Number(raw))) return Math.max(0, Number(raw));
  if (Number.isFinite(Number(child.lifetimeCoins))) return Math.max(0, Number(child.lifetimeCoins));
  return Math.max(0, Number(child.coins || 0));
}

function getLevelInfo(totalCoins = 0) {
  const safeCoins = Math.max(0, Number(totalCoins || 0));
  let current = LEVELS[0];
  for (const level of LEVELS) {
    if (safeCoins >= level.min) current = level;
    else break;
  }
  const idx = LEVELS.findIndex(l => l.level === current.level);
  const next = LEVELS[idx + 1] || null;
  const currentMin = current.min;
  const nextMin = next ? next.min : current.min;
  const progress = next ? Math.max(0, Math.min(1, (safeCoins - currentMin) / Math.max(1, nextMin - currentMin))) : 1;
  return {
    ...current,
    coins: safeCoins,
    nextLevel: next?.level || null,
    nextName: next?.name || null,
    nextMin,
    progress,
    remaining: next ? Math.max(0, next.min - safeCoins) : 0,
    isMax: !next,
  };
}

const TASK_META_OPEN = "[[FPMETA]]";
const TASK_META_CLOSE = "[[/FPMETA]]";

function encodeTaskDesc(visibleDesc, meta = {}) {
  const cleanDesc = (visibleDesc || "").trim();
  const payload = {
    maxCoins: Math.max(1, Number(meta.maxCoins || 1)),
    durationDays: Math.max(1, parseInt(meta.durationDays || 1, 10)),
    doneOn: typeof meta.doneOn === "string" ? meta.doneOn : null,
    approvedOn: typeof meta.approvedOn === "string" ? meta.approvedOn : null,
    recurrenceType: ["daily", "weekly"].includes(meta.recurrenceType) ? meta.recurrenceType : "none",
    isTemplate: !!meta.isTemplate,
    recurrenceSourceId: typeof meta.recurrenceSourceId === "string" ? meta.recurrenceSourceId : null,
    dayPart: ["allDay", "morning", "afternoon", "evening", "weekly"].includes(meta.dayPart) ? meta.dayPart : "allDay",
    requiresParentApproval: Object.prototype.hasOwnProperty.call(meta, "requiresParentApproval") ? !!meta.requiresParentApproval : true,
    lockedCoins: Number.isFinite(Number(meta.lockedCoins)) ? Math.max(0, Number(meta.lockedCoins)) : null,
    taskEmoji: typeof meta.taskEmoji === "string" ? meta.taskEmoji.trim().slice(0, 8) : "",
  };
  const metaBlock = `${TASK_META_OPEN}${JSON.stringify(payload)}${TASK_META_CLOSE}`;
  return cleanDesc ? `${cleanDesc}${metaBlock}` : metaBlock;
}

function parseTaskDesc(rawDesc = "", fallbackCoins = 1) {
  const fullDesc = String(rawDesc || "");
  const start = fullDesc.indexOf(TASK_META_OPEN);
  const end = fullDesc.indexOf(TASK_META_CLOSE);
  let visibleDesc = fullDesc;
  let meta = {};

  if (start !== -1 && end !== -1 && end > start) {
    const jsonPart = fullDesc.slice(start + TASK_META_OPEN.length, end);
    visibleDesc = `${fullDesc.slice(0, start)}${fullDesc.slice(end + TASK_META_CLOSE.length)}`.trim();
    try {
      meta = JSON.parse(jsonPart);
    } catch {
      meta = {};
    }
  }

  const maxCoins = Math.max(1, Number(meta.maxCoins || fallbackCoins || 1));
  const durationDays = Math.max(1, parseInt(meta.durationDays || 1, 10));
  const baseDecay = Math.floor(maxCoins / durationDays);
  const lastDecay = maxCoins - (baseDecay * (durationDays - 1));
  const doneOn = typeof meta.doneOn === "string" ? meta.doneOn : null;
  const approvedOn = typeof meta.approvedOn === "string" ? meta.approvedOn : null;
  const recurrenceType = ["daily", "weekly"].includes(meta.recurrenceType) ? meta.recurrenceType : "none";
  const isTemplate = !!meta.isTemplate;
  const recurrenceSourceId = typeof meta.recurrenceSourceId === "string" ? meta.recurrenceSourceId : null;
  const dayPart = ["allDay", "morning", "afternoon", "evening", "weekly"].includes(meta.dayPart) ? meta.dayPart : "allDay";
  const requiresParentApproval = Object.prototype.hasOwnProperty.call(meta, "requiresParentApproval") ? !!meta.requiresParentApproval : true;
  const lockedCoins = Number.isFinite(Number(meta.lockedCoins)) ? Math.max(0, Number(meta.lockedCoins)) : null;
  const taskEmoji = typeof meta.taskEmoji === "string" ? meta.taskEmoji.trim().slice(0, 8) : "";

  return { visibleDesc, maxCoins, durationDays, baseDecay, lastDecay, doneOn, approvedOn, recurrenceType, isTemplate, recurrenceSourceId, dayPart, requiresParentApproval, lockedCoins, taskEmoji };
}

function updateTaskDescMeta(rawDesc = "", fallbackCoins = 1, patch = {}) {
  const info = parseTaskDesc(rawDesc, fallbackCoins);
  return encodeTaskDesc(info.visibleDesc, {
    maxCoins: info.maxCoins,
    durationDays: info.durationDays,
    doneOn: Object.prototype.hasOwnProperty.call(patch, "doneOn") ? patch.doneOn : info.doneOn,
    approvedOn: Object.prototype.hasOwnProperty.call(patch, "approvedOn") ? patch.approvedOn : info.approvedOn,
    recurrenceType: Object.prototype.hasOwnProperty.call(patch, "recurrenceType") ? patch.recurrenceType : info.recurrenceType,
    isTemplate: Object.prototype.hasOwnProperty.call(patch, "isTemplate") ? patch.isTemplate : info.isTemplate,
    recurrenceSourceId: Object.prototype.hasOwnProperty.call(patch, "recurrenceSourceId") ? patch.recurrenceSourceId : info.recurrenceSourceId,
    dayPart: Object.prototype.hasOwnProperty.call(patch, "dayPart") ? patch.dayPart : info.dayPart,
    requiresParentApproval: Object.prototype.hasOwnProperty.call(patch, "requiresParentApproval") ? patch.requiresParentApproval : info.requiresParentApproval,
    lockedCoins: Object.prototype.hasOwnProperty.call(patch, "lockedCoins") ? patch.lockedCoins : info.lockedCoins,
    taskEmoji: Object.prototype.hasOwnProperty.call(patch, "taskEmoji") ? patch.taskEmoji : info.taskEmoji,
  });
}

function getTaskCompletedAnchorDate(task) {
  if (!task) return null;
  const info = parseTaskDesc(task.desc, task.coins);
  if (task.status === "approved") return info.approvedOn || info.doneOn || task.date || null;
  if (task.status === "done") return info.doneOn || task.date || null;
  return null;
}

function isTaskOlderThanHistoryWindow(task, referenceDate = getTodayISO()) {
  const anchorDate = getTaskCompletedAnchorDate(task);
  if (!anchorDate) return false;
  return diffDays(anchorDate, referenceDate) >= COMPLETED_HISTORY_DAYS;
}

function shouldKeepCompletedVisible(task, referenceDate = getTodayISO()) {
  if (!task) return false;
  const info = parseTaskDesc(task.desc, task.coins);
  if (task.status === "done") {
    return (info.doneOn || task.date) === referenceDate;
  }
  if (task.status === "approved") {
    return (info.approvedOn || info.doneOn || task.date) === referenceDate;
  }
  return true;
}

function getTaskRemainingCoins(task, referenceDate = today) {
  const info = parseTaskDesc(task.desc, task.coins);
  const elapsedDays = Math.max(0, diffDays(task.date, referenceDate));
  if (elapsedDays >= info.durationDays) return 0;
  return Math.max(0, info.maxCoins - (info.baseDecay * elapsedDays));
}

function getTaskDaysLeft(task, referenceDate = today) {
  const info = parseTaskDesc(task.desc, task.coins);
  const elapsedDays = Math.max(0, diffDays(task.date, referenceDate));
  return Math.max(0, info.durationDays - elapsedDays);
}

function isRecurringTemplateTask(task) {
  if (!task) return false;
  const info = parseTaskDesc(task.desc, task.coins);
  return task.status === "template" || info.isTemplate;
}

function getRecurringType(task) {
  const info = parseTaskDesc(task?.desc, task?.coins);
  return info.recurrenceType || "none";
}

function getRecurringLabel(task) {
  const type = getRecurringType(task);
  if (type === "daily") return "Dagelijks";
  if (type === "weekly") return "Wekelijks";
  return "Eenmalig";
}

function getRecurringOccurrenceDate(templateTask, referenceDate = getTodayISO()) {
  if (!isRecurringTemplateTask(templateTask)) return null;
  const info = parseTaskDesc(templateTask.desc, templateTask.coins);
  if (!templateTask.date || templateTask.date > referenceDate) return null;
  if (info.recurrenceType === "daily") return referenceDate;
  if (info.recurrenceType === "weekly") {
    const daysBetween = diffDays(templateTask.date, referenceDate);
    return daysBetween >= 0 && daysBetween % 7 === 0 ? referenceDate : null;
  }
  return null;
}


const DAY_PART_OPTIONS = [
  { value: "allDay", label: "Hele dag", startHour: 0, emoji: "🗓️" },
  { value: "morning", label: "Ochtend", startHour: 6, emoji: "🌅" },
  { value: "afternoon", label: "Middag", startHour: 12, emoji: "🌞" },
  { value: "evening", label: "Avond", startHour: 18, emoji: "🌙" },
  { value: "weekly", label: "Weektaak", startHour: 0, emoji: "📅" },
];

const CHILD_TASK_SECTIONS = [
  { key: "allDay", title: "Hele dag", empty: "Geen hele-dagtaken", emoji: "🗓️" },
  { key: "morning", title: "Ochtend", empty: "Geen ochtendtaken", emoji: "🌅" },
  { key: "afternoon", title: "Middag", empty: "Geen middagtaken", emoji: "🌞" },
  { key: "evening", title: "Avond", empty: "Geen avondtaken", emoji: "🌙" },
  { key: "weekly", title: "Weektaken", empty: "Geen weektaken", emoji: "📅" },
];

function normalizeDayPart(value) {
  return DAY_PART_OPTIONS.some((item) => item.value === value) ? value : "allDay";
}

function getDayPartConfig(dayPart = "allDay") {
  return DAY_PART_OPTIONS.find((item) => item.value === normalizeDayPart(dayPart)) || DAY_PART_OPTIONS[0];
}

function getDayPartLabel(dayPart = "allDay") {
  return getDayPartConfig(dayPart).label;
}

function isTaskVisibleForChildNow(task, now = new Date()) {
  if (!task || task.status !== "pending") return true;
  const info = parseTaskDesc(task.desc, task.coins);
  const taskDate = task?.date || "";
  const nowDate = getTodayISO();
  if (!taskDate) return true;
  if (taskDate < nowDate) return true;
  if (taskDate > nowDate) return false;
  if (info.dayPart === "weekly") return true;
  const config = getDayPartConfig(info.dayPart);
  const currentHour = now.getHours() + (now.getMinutes() / 60);
  return currentHour >= config.startHour;
}

function getTaskSectionKey(task) {
  const info = parseTaskDesc(task?.desc, task?.coins);
  return ["allDay", "morning", "afternoon", "evening", "weekly"].includes(info.dayPart) ? info.dayPart : "allDay";
}

function dedupeVisibleTasks(tasks = []) {
  const statusRank = { pending: 1, done: 2, approved: 3 };
  const picked = new Map();

  for (const task of tasks) {
    const info = parseTaskDesc(task?.desc, task?.coins);
    const sectionKey = getTaskSectionKey(task);

    const dedupeKey = info.recurrenceSourceId
      ? [task.childId || "", info.recurrenceSourceId, task.date || "", sectionKey].join("__")
      : [task.id || "", sectionKey].join("__");

    const current = picked.get(dedupeKey);
    if (!current) {
      picked.set(dedupeKey, task);
      continue;
    }

    const currentRank = statusRank[current.status] || 0;
    const nextRank = statusRank[task.status] || 0;

    if (nextRank > currentRank) {
      picked.set(dedupeKey, task);
      continue;
    }

    if (nextRank === currentRank) {
      const currentCoins = Number(current.coins || 0);
      const nextCoins = Number(task.coins || 0);
      if (nextCoins > currentCoins) {
        picked.set(dedupeKey, task);
        continue;
      }
      if (nextCoins === currentCoins && String(task.id || "") > String(current.id || "")) {
        picked.set(dedupeKey, task);
      }
    }
  }

  return Array.from(picked.values());
}


function buildTaskPayloadFromMeta(baseTask, metaPatch = {}, taskPatch = {}) {
  const info = parseTaskDesc(baseTask?.desc, baseTask?.coins);
  return {
    title: baseTask.title,
    desc: encodeTaskDesc(info.visibleDesc, {
      maxCoins: Object.prototype.hasOwnProperty.call(metaPatch, "maxCoins") ? metaPatch.maxCoins : info.maxCoins,
      durationDays: Object.prototype.hasOwnProperty.call(metaPatch, "durationDays") ? metaPatch.durationDays : info.durationDays,
      doneOn: Object.prototype.hasOwnProperty.call(metaPatch, "doneOn") ? metaPatch.doneOn : null,
      approvedOn: Object.prototype.hasOwnProperty.call(metaPatch, "approvedOn") ? metaPatch.approvedOn : null,
      recurrenceType: Object.prototype.hasOwnProperty.call(metaPatch, "recurrenceType") ? metaPatch.recurrenceType : info.recurrenceType,
      isTemplate: Object.prototype.hasOwnProperty.call(metaPatch, "isTemplate") ? metaPatch.isTemplate : info.isTemplate,
      recurrenceSourceId: Object.prototype.hasOwnProperty.call(metaPatch, "recurrenceSourceId") ? metaPatch.recurrenceSourceId : info.recurrenceSourceId,
      dayPart: Object.prototype.hasOwnProperty.call(metaPatch, "dayPart") ? metaPatch.dayPart : info.dayPart,
      requiresParentApproval: Object.prototype.hasOwnProperty.call(metaPatch, "requiresParentApproval") ? metaPatch.requiresParentApproval : info.requiresParentApproval,
      lockedCoins: Object.prototype.hasOwnProperty.call(metaPatch, "lockedCoins") ? metaPatch.lockedCoins : null,
      taskEmoji: Object.prototype.hasOwnProperty.call(metaPatch, "taskEmoji") ? metaPatch.taskEmoji : info.taskEmoji,
    }),
    coins: Object.prototype.hasOwnProperty.call(taskPatch, "coins") ? taskPatch.coins : info.maxCoins,
    date: Object.prototype.hasOwnProperty.call(taskPatch, "date") ? taskPatch.date : baseTask.date,
    childId: Object.prototype.hasOwnProperty.call(taskPatch, "childId") ? taskPatch.childId : baseTask.childId,
    status: Object.prototype.hasOwnProperty.call(taskPatch, "status") ? taskPatch.status : baseTask.status,
  };
}

const REWARD_META_OPEN = "[[FPREWARD]]";
const REWARD_META_CLOSE = "[[/FPREWARD]]";

function encodeRewardDesc(visibleDesc, meta = {}) {
  const cleanDesc = (visibleDesc || "").trim();
  const targetChildIds = Array.isArray(meta.targetChildIds) ? meta.targetChildIds.filter(Boolean) : [];
  const payload = { targetChildIds };
  const metaBlock = `${REWARD_META_OPEN}${JSON.stringify(payload)}${REWARD_META_CLOSE}`;
  return cleanDesc ? `${cleanDesc}${metaBlock}` : metaBlock;
}

function parseRewardDesc(rawDesc = "") {
  const fullDesc = String(rawDesc || "");
  const start = fullDesc.indexOf(REWARD_META_OPEN);
  const end = fullDesc.indexOf(REWARD_META_CLOSE);
  let visibleDesc = fullDesc;
  let meta = {};

  if (start !== -1 && end !== -1 && end > start) {
    const jsonPart = fullDesc.slice(start + REWARD_META_OPEN.length, end);
    visibleDesc = `${fullDesc.slice(0, start)}${fullDesc.slice(end + REWARD_META_CLOSE.length)}`.trim();
    try {
      meta = JSON.parse(jsonPart);
    } catch {
      meta = {};
    }
  }

  const targetChildIds = Array.isArray(meta.targetChildIds) ? meta.targetChildIds.filter(Boolean) : [];
  return { visibleDesc, targetChildIds };
}

function rewardVisibleForChild(reward, childId) {
  const info = parseRewardDesc(reward?.desc || "");
  return info.targetChildIds.length === 0 || info.targetChildIds.includes(childId);
}

function getRewardTargetLabel(reward, children = []) {
  const info = parseRewardDesc(reward?.desc || "");
  if (info.targetChildIds.length === 0) return "Alle kinderen";
  const names = info.targetChildIds
    .map(id => children.find(c => c.id === id))
    .filter(Boolean)
    .map(c => `${getChildAvatar(c)} ${c.name}`);
  return names.length ? names.join(" · ") : "Specifieke kinderen";
}

const DAGEN   = ["zondag","maandag","dinsdag","woensdag","donderdag","vrijdag","zaterdag"];
const MAANDEN = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];
const AVATARS = ["👧","👦","🧒","🦊","🐱","🐶","🐸","🦄","🐻","🐼","🐯","🐨"];
// Grote emoji database met zoektags (Nederlands + Engels)
const EMOJI_DB = [
  // ── IJsjes & desserts ──
  { e:"🍦", t:"ijsje ijs softijs ice cream dessert zoet lekker" },
  { e:"🍧", t:"ijsje sorbet ijs cup dessert zoet" },
  { e:"🍨", t:"ijs ice cream dessert kom" },
  { e:"🍰", t:"taart cake gebak verjaardag feest zoet punt" },
  { e:"🎂", t:"verjaardag birthday cake taart feest kaarsjes" },
  { e:"🧁", t:"cupcake taart zoet bakken muffin" },
  { e:"🍩", t:"donut donuts zoet gebak ring" },
  { e:"🍪", t:"koekje cookie zoet bakken biscuit" },
  { e:"🍫", t:"chocolade chocolate zoet snoep reep" },
  { e:"🍬", t:"snoep candy zoet dropje" },
  { e:"🍭", t:"lolly snoep candy zoet suiker" },
  { e:"🍮", t:"pudding vla dessert zoet" },
  { e:"🍯", t:"honing honey zoet" },
  { e:"🥧", t:"taart pie gebak appeltaart" },
  { e:"🧆", t:"falafel snack eten" },
  { e:"🍡", t:"dango snoep zoet japans" },
  { e:"🍢", t:"eten snack japans" },
  { e:"🍣", t:"sushi japans eten vis" },
  { e:"🍤", t:"garnaal tempura eten" },
  // ── Fastfood & snacks ──
  { e:"🍕", t:"pizza eten pizzeria italiaans" },
  { e:"🍔", t:"hamburger burger eten fastfood" },
  { e:"🌮", t:"taco mexicaans eten" },
  { e:"🌯", t:"wrap broodje eten sandwich" },
  { e:"🍟", t:"friet patat fastfood chips" },
  { e:"🍿", t:"popcorn bioscoop film cinema snack" },
  { e:"🌭", t:"hotdog worst broodje eten" },
  { e:"🥪", t:"sandwich broodje eten lunch" },
  { e:"🥙", t:"falafel wrap broodje eten" },
  { e:"🧆", t:"snack eten" },
  { e:"🥓", t:"spek bacon ontbijt" },
  { e:"🍗", t:"kip chicken eten" },
  { e:"🍖", t:"vlees eten" },
  { e:"🥩", t:"steak vlees eten" },
  { e:"🍝", t:"pasta spaghetti eten italiaans" },
  { e:"🍜", t:"noodles ramen soep eten aziatisch" },
  { e:"🍛", t:"curry eten rijst" },
  { e:"🍲", t:"soep stew eten warm" },
  { e:"🥘", t:"stoofpot eten warm" },
  { e:"🫕", t:"fondue eten warm" },
  { e:"🥗", t:"salade gezond eten" },
  { e:"🥙", t:"pitabroodje wrap eten" },
  { e:"🧇", t:"wafel wafels ontbijt" },
  { e:"🥞", t:"pannenkoeken pancakes ontbijt" },
  { e:"🥐", t:"croissant brood bakkerij ontbijt" },
  { e:"🍞", t:"brood bakkerij eten" },
  { e:"🥖", t:"stokbrood Frans brood eten" },
  { e:"🥨", t:"pretzel snack eten" },
  { e:"🧀", t:"kaas eten" },
  { e:"🥚", t:"ei eten ontbijt" },
  { e:"🍳", t:"ei bakken ontbijt spiegelei" },
  // ── Fruit & groenten ──
  { e:"🍎", t:"appel fruit eten gezond" },
  { e:"🍓", t:"aardbei fruit zoet gezond" },
  { e:"🍇", t:"druiven fruit zoet" },
  { e:"🍉", t:"watermeloen fruit zomer" },
  { e:"🍊", t:"sinaasappel fruit gezond" },
  { e:"🍋", t:"citroen fruit zuur" },
  { e:"🍌", t:"banaan fruit gezond" },
  { e:"🍍", t:"ananas fruit tropisch" },
  { e:"🥭", t:"mango fruit tropisch zoet" },
  { e:"🍑", t:"perzik fruit zoet" },
  { e:"🍒", t:"kers kersen fruit zoet" },
  { e:"🫐", t:"bosbes blauwe bes fruit" },
  { e:"🥝", t:"kiwi fruit gezond" },
  { e:"🍅", t:"tomaat fruit gezond" },
  { e:"🥑", t:"avocado fruit gezond" },
  { e:"🌽", t:"maïs groenten eten" },
  { e:"🥕", t:"wortel groenten gezond" },
  { e:"🥦", t:"broccoli groenten gezond" },
  { e:"🥬", t:"sla groenten gezond" },
  { e:"🍄", t:"paddenstoel natuur eten" },
  // ── Drinken ──
  { e:"🧃", t:"sap drinken juice frisdrank pak" },
  { e:"🥤", t:"frisdrank cola milkshake drinken cup" },
  { e:"🧋", t:"bubbletea boba drinken thee" },
  { e:"☕", t:"koffie cappuccino latte drinken warm" },
  { e:"🍵", t:"thee drinken warm kop" },
  { e:"🥛", t:"melk milk drinken glas" },
  { e:"🍹", t:"cocktail smoothie drinken zomer" },
  { e:"🍶", t:"drinken warm" },
  { e:"🧊", t:"ijs ice koud drinken" },
  // ── Sport & bewegen ──
  { e:"⚽", t:"voetbal soccer sport spelen bal" },
  { e:"🏀", t:"basketbal sport spelen bal" },
  { e:"🏈", t:"american football sport spelen" },
  { e:"⚾", t:"honkbal baseball sport" },
  { e:"🥎", t:"softball sport" },
  { e:"🎾", t:"tennis sport spelen racket" },
  { e:"🏐", t:"volleybal sport spelen" },
  { e:"🏉", t:"rugby sport spelen" },
  { e:"🥏", t:"frisbee sport buiten spelen" },
  { e:"🎱", t:"biljart pool sport spel" },
  { e:"🏸", t:"badminton sport spelen" },
  { e:"🏒", t:"ijshockey winter sport" },
  { e:"🥍", t:"lacrosse sport" },
  { e:"🏓", t:"pingpong tafeltennis sport spelen" },
  { e:"🏸", t:"badminton sport" },
  { e:"🥅", t:"doel voetbal hockey sport" },
  { e:"🎿", t:"skiën ski winter sport sneeuw" },
  { e:"🛷", t:"slee sleeën winter sneeuw" },
  { e:"🏂", t:"snowboarden winter sport sneeuw" },
  { e:"⛷️", t:"skiën ski winter sport" },
  { e:"🏊", t:"zwemmen zwembad sport water" },
  { e:"🤽", t:"waterpolo zwemmen water sport" },
  { e:"🚣", t:"roeien kano boot water sport" },
  { e:"🏄", t:"surfen water sport strand golven" },
  { e:"🧗", t:"klimmen klimmuur sport avontuur" },
  { e:"🚴", t:"fietsen fiets sport buiten" },
  { e:"🏇", t:"paardrijden paard sport" },
  { e:"🤸", t:"turnen gymnast sport acrobaat" },
  { e:"🤼", t:"worstelen judo sport" },
  { e:"🥋", t:"judo karate sport vechtsporten" },
  { e:"🤺", t:"schermen sport" },
  { e:"🏋️", t:"gewichtheffen gym sporten fitness" },
  { e:"🤾", t:"handbal sport" },
  { e:"⛳", t:"golf sport buiten" },
  { e:"🎯", t:"darten sport spel mikken" },
  { e:"🎳", t:"bowlen bowling sport spel" },
  { e:"🥊", t:"boksen sport bokshandschoen" },
  { e:"🎣", t:"vissen hengelen buiten hobby" },
  { e:"🧘", t:"yoga mediteren ontspanning rust" },
  { e:"🛹", t:"skateboard skaten sport" },
  { e:"🛼", t:"rolschaatsen skaten sport" },
  { e:"⛸️", t:"schaatsen ijs winter sport" },
  { e:"🛺", t:"tuk-tuk rijden" },
  { e:"🪂", t:"parachutespringen avontuur vliegen" },
  { e:"🤿", t:"duiken snorkelen water sport" },
  { e:"🏹", t:"boogschieten sport" },
  // ── Entertainment & media ──
  { e:"🎮", t:"gamen game controller videospel spel console" },
  { e:"🕹️", t:"gamen joystick game videospel arcade retro" },
  { e:"🎲", t:"bordspel spel spelen dobbelstenen" },
  { e:"🃏", t:"kaartspel kaarten spelen" },
  { e:"🀄", t:"mahjong kaartspel spel" },
  { e:"🧩", t:"puzzel legpuzzel spel denken" },
  { e:"♟️", t:"schaken schaakspel spel" },
  { e:"🎭", t:"theater toneel show toneelstuk" },
  { e:"🎬", t:"bioscoop film cinema movie kijken" },
  { e:"📺", t:"tv televisie kijken film serie binge" },
  { e:"📱", t:"telefoon smartphone schermtijd app social media" },
  { e:"💻", t:"computer laptop schermtijd internet" },
  { e:"🖥️", t:"computer desktop schermtijd" },
  { e:"🎵", t:"muziek zingen lied liedjes noten" },
  { e:"🎤", t:"zingen karaoke muziek microfoon" },
  { e:"🎧", t:"muziek luisteren koptelefoon headphones" },
  { e:"🎸", t:"gitaar elektrisch muziek instrument" },
  { e:"🎹", t:"piano keyboard muziek instrument" },
  { e:"🎺", t:"trompet muziek instrument" },
  { e:"🥁", t:"drums muziek instrument slaan" },
  { e:"🎷", t:"saxofoon muziek instrument jazz" },
  { e:"🪗", t:"accordeon muziek instrument" },
  { e:"🎻", t:"viool muziek instrument strijken" },
  { e:"🪘", t:"drum conga muziek instrument" },
  { e:"🎙️", t:"microfoon podcast opnemen zingen" },
  { e:"📻", t:"radio muziek luisteren" },
  { e:"📚", t:"boek lezen bibliotheek verhaal" },
  { e:"📖", t:"boek lezen verhaal pagina" },
  { e:"📓", t:"notitieboek schrijven" },
  { e:"🗞️", t:"krant lezen nieuws" },
  // ── Uitjes & reizen ──
  { e:"🎡", t:"kermis attractiepark pretpark reuzenrad uitje" },
  { e:"🎢", t:"achtbaan pretpark attractiepark uitje" },
  { e:"🎠", t:"carrousel kermis uitje draaien" },
  { e:"🏖️", t:"strand beach zee vakantie zon zomer" },
  { e:"🏝️", t:"eiland tropisch vakantie strand" },
  { e:"⛺", t:"kamperen tent buiten natuur" },
  { e:"🏕️", t:"kamperen buiten natuur camping" },
  { e:"🌳", t:"natuur bos wandelen buiten boom" },
  { e:"🏔️", t:"berg wandelen natuur sneeuw hiken" },
  { e:"⛰️", t:"berg natuur wandelen hiken" },
  { e:"🗻", t:"berg fuji natuur" },
  { e:"🏞️", t:"natuur park wandelen landschap" },
  { e:"✈️", t:"vliegtuig reizen vakantie vliegen" },
  { e:"🚁", t:"helikopter vliegen reizen" },
  { e:"🚂", t:"trein reizen uitje stoom" },
  { e:"🚢", t:"boot schip cruise reizen water" },
  { e:"🛳️", t:"cruiseschip boot reizen vakantie" },
  { e:"⛵", t:"zeilboot water reizen" },
  { e:"🚀", t:"ruimte avontuur raket astronaut" },
  { e:"🛸", t:"ufo ruimte avontuur" },
  { e:"🗺️", t:"kaart reizen avontuur ontdekken" },
  { e:"🏰", t:"kasteel ridder uitje avontuur" },
  { e:"🗽", t:"vrijheidsbeeld reizen" },
  { e:"🗼", t:"toren parijs reizen" },
  { e:"🌍", t:"wereld reizen vakantie globe" },
  { e:"🌏", t:"wereld reizen azië globe" },
  { e:"🎪", t:"circus show uitje feest tent" },
  { e:"🐠", t:"aquarium vissen zee uitje vis" },
  { e:"🦁", t:"dierentuin leeuw dier uitje" },
  { e:"🐘", t:"dierentuin olifant dier uitje" },
  { e:"🦒", t:"dierentuin giraffe dier uitje" },
  { e:"🦓", t:"dierentuin zebra dier uitje" },
  { e:"🎡", t:"kermis attractiepark" },
  { e:"🎆", t:"vuurwerk feest show" },
  { e:"🎇", t:"vuurwerk sparkle feest" },
  // ── Cadeaus & feest ──
  { e:"🎁", t:"cadeau present verrassing feest cadeautje" },
  { e:"🎉", t:"feest party verjaardag confetti" },
  { e:"🎊", t:"feest party confetti ballonnen" },
  { e:"🎈", t:"ballon feest verjaardag party" },
  { e:"🥳", t:"feest verjaardag party viering" },
  { e:"⭐", t:"ster beloning speciaal goed uitstekend" },
  { e:"🌟", t:"ster goud speciaal beloning glinstering" },
  { e:"✨", t:"glitter magie speciaal mooi schitteren" },
  { e:"💫", t:"ster draaien magie speciaal" },
  { e:"🏆", t:"trofee winnaar prijs beloning kampioen beker" },
  { e:"🥇", t:"goud eerste prijs winnaar medaille" },
  { e:"🥈", t:"zilver tweede prijs medaille" },
  { e:"🥉", t:"brons derde prijs medaille" },
  { e:"🎖️", t:"medaille prijs beloning" },
  { e:"🏅", t:"medaille sport prijs" },
  { e:"👑", t:"kroon koning koningin prinses prins speciaal" },
  { e:"💎", t:"diamant juweel speciaal bijzonder" },
  { e:"💰", t:"geld coins beloning schat" },
  { e:"💵", t:"geld euro beloning" },
  { e:"🎀", t:"strik cadeau lint cadeautje roze" },
  { e:"🎗️", t:"lint strik speciaal" },
  // ── Speelgoed ──
  { e:"🧸", t:"knuffel teddybeer beer speelgoed zacht" },
  { e:"🪆", t:"matroesjka pop speelgoed" },
  { e:"🪀", t:"jojo speelgoed spelen" },
  { e:"🪁", t:"katapult speelgoed" },
  { e:"🎎", t:"pop japans speelgoed" },
  { e:"🎏", t:"vlieger wind buiten spelen" },
  { e:"🪁", t:"boogschieten speelgoed" },
  { e:"🚗", t:"auto rijden speelgoed model" },
  { e:"🚕", t:"auto taxi speelgoed" },
  { e:"🚙", t:"auto jeep speelgoed" },
  { e:"🏎️", t:"raceauto rijden snel speelgoed" },
  { e:"🚓", t:"politieauto speelgoed" },
  { e:"🚒", t:"brandweerauto speelgoed" },
  { e:"🚑", t:"ambulance speelgoed" },
  { e:"🚚", t:"vrachtwagen speelgoed" },
  { e:"🚁", t:"helikopter speelgoed vliegen" },
  { e:"✈️", t:"vliegtuig speelgoed" },
  { e:"🚀", t:"raket speelgoed ruimte" },
  { e:"🤖", t:"robot speelgoed technologie toekomst" },
  { e:"👾", t:"alien game pixel speelgoed" },
  { e:"🧲", t:"magneet experiment wetenschap" },
  // ── Hobby & knutselen ──
  { e:"🎨", t:"schilderen tekenen kunst knutselen verf" },
  { e:"✏️", t:"tekenen schrijven potlood knutselen" },
  { e:"🖌️", t:"schilderen tekenen kunst penseel" },
  { e:"🖍️", t:"kleuren tekenen knutselen kleurpotlood" },
  { e:"✂️", t:"knippen knutselen schaar" },
  { e:"🪡", t:"naaien handwerk hobby" },
  { e:"🧵", t:"naaien handwerk draad hobby" },
  { e:"🧶", t:"breien haken handwerk hobby wol" },
  { e:"📸", t:"foto fotografie camera" },
  { e:"📷", t:"camera foto fotografie" },
  { e:"🔭", t:"sterrenkijker sterren ruimte astronomie" },
  { e:"🔬", t:"microscoop wetenschap experiment" },
  { e:"🧪", t:"experiment wetenschap scheikunde" },
  { e:"🧫", t:"wetenschap experiment lab" },
  { e:"⚗️", t:"chemie experiment wetenschap kolf" },
  { e:"🪄", t:"magie toverstaf toveren goochelen" },
  { e:"🎩", t:"goochelaar hoed magie" },
  { e:"🃏", t:"kaarttruc magie goochelen" },
  { e:"🧱", t:"lego bouwen stenen blokken" },
  { e:"🏗️", t:"bouwen lego constructie" },
  { e:"🔧", t:"knutselen sleutelen gereedschap" },
  { e:"🔨", t:"hameren bouwen knutselen" },
  { e:"🪚", t:"zagen bouwen knutselen" },
  { e:"🗿", t:"beeldhouwen kunst" },
  { e:"🎭", t:"toneelspelen theater rollenspel" },
  { e:"🎪", t:"circus acrobatiek show" },
  // ── Dieren ──
  { e:"🐶", t:"hond puppy huisdier dier golden retriever" },
  { e:"🐱", t:"kat poes kitten huisdier dier" },
  { e:"🐭", t:"muis muisje dier" },
  { e:"🐹", t:"hamster huisdier dier" },
  { e:"🐰", t:"konijn haas huisdier dier" },
  { e:"🦊", t:"vos dier rood slim" },
  { e:"🐻", t:"beer teddybeer dier" },
  { e:"🐼", t:"panda beer dier schattig" },
  { e:"🐨", t:"koala beer dier schattig australie" },
  { e:"🐯", t:"tijger dier gestreept" },
  { e:"🦁", t:"leeuw dier wild" },
  { e:"🐮", t:"koe dier boer" },
  { e:"🐷", t:"varken big dier" },
  { e:"🐸", t:"kikker dier groen" },
  { e:"🐵", t:"aap dier" },
  { e:"🙈", t:"aap zie niet dier" },
  { e:"🐔", t:"kip dier boerderij" },
  { e:"🐧", t:"pinguïn dier koud" },
  { e:"🐦", t:"vogel dier vliegen" },
  { e:"🦆", t:"eend vogel water dier" },
  { e:"🦅", t:"arend vogel krachtig dier" },
  { e:"🦉", t:"uil vogel wijs dier" },
  { e:"🦇", t:"vleermuis nacht dier" },
  { e:"🐺", t:"wolf dier wild" },
  { e:"🦋", t:"vlinder insect mooi natuur" },
  { e:"🐛", t:"rups insect natuur" },
  { e:"🐝", t:"bij insect honing natuur" },
  { e:"🐞", t:"lieveheersbeestje insect natuur" },
  { e:"🦗", t:"krekel insect natuur" },
  { e:"🦎", t:"hagedis reptiel natuur" },
  { e:"🐍", t:"slang reptiel dier" },
  { e:"🦕", t:"dinosaurus prehistorie dier" },
  { e:"🦖", t:"t-rex dinosaurus dier" },
  { e:"🐢", t:"schildpad dier langzaam" },
  { e:"🦈", t:"haai vis zee dier" },
  { e:"🐙", t:"octopus zee dier" },
  { e:"🦑", t:"inktvis zee dier" },
  { e:"🦀", t:"krab zee dier" },
  { e:"🦞", t:"kreeft zee dier" },
  { e:"🐡", t:"vis zee dier" },
  { e:"🐬", t:"dolfijn zee dier slim" },
  { e:"🐳", t:"walvis zee groot dier" },
  { e:"🦭", t:"zeehond water dier" },
  { e:"🐊", t:"krokodil reptiel dier" },
  { e:"🦒", t:"giraf lang dier zoo" },
  { e:"🦘", t:"kangoeroe springen dier australie" },
  { e:"🦛", t:"neushoorn dier groot" },
  { e:"🦏", t:"neushoorn dier" },
  { e:"🐫", t:"kameel woestijn dier" },
  { e:"🦙", t:"lama alpaca dier" },
  { e:"🦌", t:"hert ree dier natuur" },
  { e:"🐑", t:"schaap wol dier boerderij" },
  { e:"🐐", t:"geit dier boerderij" },
  { e:"🦓", t:"zebra gestreept dier" },
  { e:"🐘", t:"olifant groot dier" },
  { e:"🦜", t:"papegaai vogel praten huisdier" },
  { e:"🦚", t:"pauw vogel mooi kleurrijk" },
  { e:"🦩", t:"flamingo vogel roze" },
  { e:"🦢", t:"zwaan vogel elegant" },
  { e:"🕊️", t:"duif vogel vrede" },
  { e:"🦄", t:"eenhoorn magisch speciaal regenboog" },
  { e:"🐉", t:"draak fantastisch avontuur vuur" },
  { e:"🦦", t:"otter water dier schattig" },
  { e:"🦥", t:"luiaard langzaam dier" },
  { e:"🦔", t:"egel schattig dier" },
  { e:"🐇", t:"konijn haas dier snel" },
  { e:"🦫", t:"bever dier water" },
  // ── Natuur & weer ──
  { e:"🌈", t:"regenboog mooi speciaal kleurrijk" },
  { e:"☀️", t:"zon zonnig warm buiten zomer" },
  { e:"🌤️", t:"zon wolken lekker weer" },
  { e:"⛅", t:"bewolkt zon wolken" },
  { e:"🌧️", t:"regen buiten nat" },
  { e:"⛈️", t:"onweer storm regen" },
  { e:"🌩️", t:"bliksem storm onweer" },
  { e:"❄️", t:"sneeuw winter koud ijs" },
  { e:"⛄", t:"sneeuwpop sneeuw winter" },
  { e:"🌊", t:"golf zee water strand" },
  { e:"🌋", t:"vulkaan natuur avontuur" },
  { e:"🌸", t:"kersenbloesem bloem lente mooi" },
  { e:"🌺", t:"hibiscus bloem mooi natuur tropisch" },
  { e:"🌻", t:"zonnebloem bloem geel mooi" },
  { e:"🌹", t:"roos bloem mooi romantisch" },
  { e:"🌷", t:"tulp bloem nederland lente" },
  { e:"🌿", t:"plant natuur groen" },
  { e:"🍀", t:"klavertje vier geluk natuur" },
  { e:"🍃", t:"blad natuur groen wind" },
  { e:"🍂", t:"herfstblad herfst seizoen" },
  { e:"🍁", t:"esdoornblad herfst canada" },
  { e:"🌲", t:"boom pijnboom natuur" },
  { e:"🌳", t:"boom natuur bos wandelen" },
  { e:"🌴", t:"palmboom tropisch strand vakantie" },
  { e:"🎋", t:"bamboe natuur" },
  { e:"🌵", t:"cactus woestijn natuur" },
  { e:"🌾", t:"tarwe natuur oogst" },
  { e:"🍄", t:"paddenstoel natuur bos" },
  { e:"🌙", t:"maan nacht laat opblijven" },
  { e:"🌛", t:"maan nacht slaap" },
  { e:"⭐", t:"ster nacht ruimte" },
  { e:"🌠", t:"vallende ster wens ruimte" },
  { e:"🌌", t:"melkweg ruimte sterren nacht" },
  { e:"☄️", t:"komeet ruimte avontuur" },
  { e:"🌅", t:"zonsopgang ochtend mooi natuur" },
  { e:"🌄", t:"zonsondergang berg natuur mooi" },
  { e:"🏔️", t:"berg sneeuw natuur wandelen hiken" },
  { e:"🏜️", t:"woestijn droog natuur" },
  { e:"🏝️", t:"tropisch eiland strand vakantie" },
  { e:"🌍", t:"aarde wereld globe natuur" },
  // ── Kleding & uiterlijk ──
  { e:"👗", t:"jurk kleding shoppen mode meisje" },
  { e:"👘", t:"kimono japans kleding" },
  { e:"🥻", t:"sari kleding" },
  { e:"👔", t:"overhemd kleding formeel" },
  { e:"👕", t:"t-shirt kleding casual" },
  { e:"👖", t:"jeans broek kleding" },
  { e:"🩱", t:"badpak zwemmen kleding" },
  { e:"🩲", t:"zwembroek kleding zomer" },
  { e:"🩳", t:"shorts kleding zomer" },
  { e:"🩴", t:"slippers strand kleding" },
  { e:"👟", t:"sneakers schoenen kleding sport" },
  { e:"👠", t:"hakken schoenen elegant" },
  { e:"👡", t:"sandaal schoenen zomer" },
  { e:"👢", t:"laarzen schoenen winter" },
  { e:"🥾", t:"wandelschoenen sport buiten" },
  { e:"🎩", t:"hoge hoed kleding elegant" },
  { e:"🧢", t:"pet cap kleding sport" },
  { e:"👒", t:"zomerhoed kleding zomer" },
  { e:"⛑️", t:"helm veiligheid kleding" },
  { e:"👜", t:"tas handtas shoppen mode" },
  { e:"👛", t:"portemonnee tas geld" },
  { e:"🎒", t:"rugzak tas school avontuur" },
  { e:"💼", t:"aktetas tas werk" },
  { e:"🌂", t:"paraplu regen kleding" },
  { e:"💄", t:"lippenstift make-up schminken mooi beauty" },
  { e:"💅", t:"nagels nagellak beauty mooi schminken" },
  { e:"💍", t:"ring sieraden mooi elegant" },
  { e:"💎", t:"diamant juweel sieraden" },
  { e:"👓", t:"bril zien" },
  { e:"🕶️", t:"zonnebril zomer strand cool" },
  { e:"🥽", t:"veiligheidsbril experiment" },
  { e:"🧣", t:"sjaal winter warm kleding" },
  { e:"🧤", t:"handschoenen winter warm" },
  { e:"🧥", t:"jas winter warm kleding" },
  { e:"🩰", t:"balletschoenen dans ballet" },
  // ── Kunst & cultuur ──
  { e:"🎭", t:"masker theater toneel kunst" },
  { e:"🖼️", t:"schilderij kunst museum" },
  { e:"🎨", t:"palet schilderen kunst" },
  { e:"🎪", t:"circus tent show" },
  { e:"🎠", t:"carrousel pretpark" },
  { e:"🎡", t:"reuzenrad kermis" },
  { e:"🎢", t:"achtbaan pretpark" },
  { e:"💃", t:"dansen dans meisje" },
  { e:"🕺", t:"dansen dans jongen disco" },
  { e:"👯", t:"dansen samen" },
  { e:"🩰", t:"ballet dansen" },
  { e:"🎻", t:"viool muziek klassiek" },
  { e:"🪕", t:"banjo muziek country" },
  { e:"🎸", t:"gitaar muziek rock" },
  { e:"🎹", t:"piano muziek klassiek" },
  { e:"🎷", t:"saxofoon muziek jazz" },
  { e:"🎺", t:"trompet muziek" },
  { e:"🥁", t:"drums muziek slaan" },
  // ── Ontspanning & thuis ──
  { e:"💤", t:"slapen uitslapen vrij rust nap" },
  { e:"🛋️", t:"bank ontspannen thuis luieren relaxen" },
  { e:"🛁", t:"bad bubbelbad ontspannen warm" },
  { e:"🚿", t:"douche wassen schoon" },
  { e:"💆", t:"massage ontspannen rust spa" },
  { e:"🧖", t:"spa sauna ontspannen" },
  { e:"🎑", t:"natuur buiten genieten" },
  { e:"🧺", t:"picknicken mand buiten" },
  { e:"🏡", t:"thuis huis fijn" },
  { e:"🕯️", t:"kaars romantisch gezellig" },
  { e:"🔥", t:"vuur kampvuur warm" },
  { e:"🛌", t:"slapen bed rust" },
  { e:"🌙", t:"avond nacht laat rust" },
  { e:"🎑", t:"genieten buiten natuur" },
  // ── Technologie ──
  { e:"🤖", t:"robot ai technologie toekomst" },
  { e:"💻", t:"laptop computer programmeren" },
  { e:"🖥️", t:"computer monitor scherm" },
  { e:"⌨️", t:"toetsenbord computer typen" },
  { e:"🖱️", t:"muis computer klikken" },
  { e:"📱", t:"telefoon smartphone app" },
  { e:"📲", t:"smartphone bellen appen" },
  { e:"⌚", t:"smartwatch horloge technologie" },
  { e:"📡", t:"satelliet signaal technologie" },
  { e:"🔋", t:"batterij energie opladen" },
  { e:"💡", t:"lamp idee licht" },
  { e:"🔭", t:"telescoop sterren kijken" },
  { e:"🔬", t:"microscoop wetenschap" },
  { e:"🛰️", t:"satelliet ruimte technologie" },
  { e:"🚁", t:"drone vliegen technologie" },
  // ── Ruimte & avontuur ──
  { e:"🚀", t:"raket ruimte avontuur astronaut" },
  { e:"🛸", t:"ufo vliegende schotel ruimte" },
  { e:"🌌", t:"melkweg sterren ruimte nacht" },
  { e:"🌠", t:"vallende ster wens ruimte" },
  { e:"🌙", t:"maan ruimte nacht" },
  { e:"☀️", t:"zon ruimte energie" },
  { e:"🪐", t:"planeet saturnus ruimte" },
  { e:"⭐", t:"ster ruimte heelal" },
  { e:"☄️", t:"komeet meteoriet ruimte" },
  { e:"👨‍🚀", t:"astronaut ruimte avontuur" },
  { e:"🌍", t:"aarde planeet ruimte" },
  // ── Eten restaurant ──
  { e:"🍽️", t:"bord restaurant eten" },
  { e:"🥢", t:"eetstokjes japans chinees eten" },
  { e:"🍴", t:"bestek mes vork eten restaurant" },
  { e:"🥄", t:"lepel eten soep" },
  { e:"🧂", t:"zout koken eten" },
  { e:"🫙", t:"pot opslaan koken" },
  { e:"🫖", t:"theepot thee drinken" },
  // ── Symbolen & overig ──
  { e:"❤️", t:"hart liefde rood" },
  { e:"🧡", t:"hart oranje vriendschap" },
  { e:"💛", t:"hart geel zon" },
  { e:"💚", t:"hart groen natuur" },
  { e:"💙", t:"hart blauw" },
  { e:"💜", t:"hart paars" },
  { e:"🖤", t:"hart zwart" },
  { e:"🤍", t:"hart wit" },
  { e:"💗", t:"roze hart liefde" },
  { e:"💖", t:"glitterhart speciaal" },
  { e:"💝", t:"cadeauhart cadeau" },
  { e:"🌺", t:"bloem mooi" },
  { e:"🦋", t:"vlinder mooi" },
  { e:"🌈", t:"regenboog kleurrijk" },
  { e:"✨", t:"glitter sparkle bijzonder" },
  { e:"🎆", t:"vuurwerk feest" },
  { e:"🎇", t:"vuurwerk sparkler" },
  { e:"🎑", t:"buiten natuur" },
  { e:"🎐", t:"wind natuur" },
  { e:"🎍", t:"bamboe natuur japan" },
  { e:"🎋", t:"wensboom japan" },
  { e:"🎎", t:"poppen japan" },
  { e:"🎏", t:"vlieger wind buiten" },
  { e:"🎑", t:"maanfestival" },
  { e:"🎃", t:"halloween pompoen" },
  { e:"🎄", t:"kerstboom kerst feest" },
  { e:"🎅", t:"kerstman kerst cadeau" },
  { e:"🎆", t:"vuurwerk oud nieuw feest" },
  { e:"🌺", t:"bloem mooi" },
];

const ALL_EMOJIS = EMOJI_DB.map(x => x.e);

function normalizeEmojiSearchText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TASK_EMOJI_RULES = [
  { e: "🪥", patterns: ["tanden poetsen", "poets tanden", "tanden", "mond spoelen", "mondverzorging"] },
  { e: "🛏️", patterns: ["bed opmaken", "bed maken", "bedtijd", "naar bed", "pyjama", "slaap"] },
  { e: "🚿", patterns: ["douchen", "douche", "wassen", "haar wassen", "bad nemen", "in bad"] },
  { e: "👕", patterns: ["aankleden", "omkleden", "kleren aantrekken", "jas aandoen"] },
  { e: "🧦", patterns: ["sokken", "schoenen aandoen", "schoenen aantrekken"] },
  { e: "🧸", patterns: ["speelgoed opruimen", "speelgoed", "knuffels opruimen", "kamer netjes"] },
  { e: "🧹", patterns: ["opruimen", "opruim", "vegen", "stofzuigen", "schoonmaken", "poetsen", "afstoffen"] },
  { e: "🗑️", patterns: ["vuilnis", "afval", "prullenbak", "container", "kliko"] },
  { e: "🧺", patterns: ["wasmand", "was", "kleding wassen", "kleren opruimen", "was opvouwen"] },
  { e: "🍽️", patterns: ["tafel dekken", "tafel afruimen", "borden", "keuken helpen", "afwassen"] },
  { e: "🍎", patterns: ["fruit eten", "fruit", "appel eten", "gezond eten", "groente eten"] },
  { e: "🥤", patterns: ["drinken", "water drinken", "melk drinken", "sap drinken"] },
  { e: "📚", patterns: ["lezen", "boek lezen", "voorlezen", "bibliotheek", "huiswerk lezen"] },
  { e: "✏️", patterns: ["schrijven", "tekenen", "kleurplaat", "kleuren", "oefenen schrijven"] },
  { e: "🧮", patterns: ["rekenen", "sommen", "tafels oefenen"] },
  { e: "🎒", patterns: ["schooltas", "tas inpakken", "school spullen", "naar school"] },
  { e: "📝", patterns: ["huiswerk", "opdracht maken", "werkblad", "leren"] },
  { e: "🎹", patterns: ["piano", "keyboard", "muziek oefenen"] },
  { e: "🎸", patterns: ["gitaar", "muziekles", "instrument oefenen"] },
  { e: "🎵", patterns: ["zingen", "liedje oefenen", "muziek luisteren"] },
  { e: "⚽", patterns: ["voetbal", "buiten spelen", "trainen", "sport", "bewegen"] },
  { e: "🚴", patterns: ["fietsen", "fiets", "naar buiten"] },
  { e: "🏊", patterns: ["zwemmen", "zwemles", "zwembad"] },
  { e: "🐶", patterns: ["hond", "hond uitlaten", "huisdier verzorgen", "voer geven"] },
  { e: "🐱", patterns: ["kat", "kat voeren", "kattenbak"] },
  { e: "🌱", patterns: ["plant water", "plantjes", "tuin", "water geven"] },
  { e: "🛒", patterns: ["boodschappen", "winkel", "supermarkt"] },
  { e: "⏰", patterns: ["op tijd", "wekker", "klaarmaken", "ochtendroutine"] },
  { e: "🙏", patterns: ["helpen", "mama helpen", "papa helpen", "assisteren"] },
  { e: "📅", patterns: ["weektaak", "deze week", "voor zondag", "voor het weekend"] },
];

function findRuleBasedTaskEmoji(title = "", desc = "", dayPart = "allDay") {
  const source = normalizeEmojiSearchText(`${title} ${desc}`);
  if (!source) return null;
  let best = null;
  TASK_EMOJI_RULES.forEach(rule => {
    let score = 0;
    rule.patterns.forEach(pattern => {
      const p = normalizeEmojiSearchText(pattern);
      if (!p) return;
      if (source.includes(p)) score = Math.max(score, 100 + p.length);
      else {
        const words = p.split(" ").filter(Boolean);
        const matched = words.filter(w => source.includes(w)).length;
        if (matched === words.length && words.length > 0) score = Math.max(score, 70 + words.join("").length);
        else if (matched > 0) score = Math.max(score, matched * 10);
      }
    });
    if (!best || score > best.score) best = { emoji: rule.e, score };
  });
  if (best && best.score >= 30) return best.emoji;
  return null;
}

function searchEmojis(query) {
  if (!query || query.trim().length < 1) return ALL_EMOJIS.slice(0, 30);
  const q = normalizeEmojiSearchText(query);
  const words = q.split(/\s+/).filter(Boolean);
  const scored = EMOJI_DB.map(item => {
    const tags = normalizeEmojiSearchText(item.t);
    let score = 0;
    words.forEach(w => {
      if (!w) return;
      if (tags.includes(` ${w} `) || tags.startsWith(`${w} `) || tags.endsWith(` ${w}`) || tags === w) score += w.length > 3 ? 7 : 3;
      else if (tags.includes(w)) score += w.length > 4 ? 3 : 1;
    });
    if (q && tags.includes(q)) score += 12;
    return { ...item, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  if (scored.length === 0) return ALL_EMOJIS.slice(0, 30);
  return [...new Set(scored.map(x => x.e))];
}

function getAutoTaskEmoji(title = "", desc = "", dayPart = "allDay") {
  const ruleEmoji = findRuleBasedTaskEmoji(title, desc, dayPart);
  if (ruleEmoji) return ruleEmoji;
  const query = `${title} ${desc}`.trim();
  const matches = searchEmojis(query);
  if (matches.length && query) return matches[0];
  const fallbackByDayPart = {
    morning: "🌅",
    afternoon: "🌞",
    evening: "🌙",
    weekly: "📅",
    allDay: "✨",
  };
  return fallbackByDayPart[normalizeDayPart(dayPart)] || "✨";
}

function getTaskDisplayEmoji(task) {
  const info = parseTaskDesc(task?.desc, task?.coins);
  if (info.taskEmoji) return info.taskEmoji;
  return getAutoTaskEmoji(task?.title || "", info.visibleDesc || "", info.dayPart || "allDay");
}

const FEITJES = [
  { feit: "Een koe geeft meer melk als ze naar muziek luistert! 🎵", emoji: "🐄" },
  { feit: "Octopussen hebben drie harten én blauw bloed! 💙", emoji: "🐙" },
  { feit: "Een slak kan 3 jaar lang slapen zonder wakker te worden.", emoji: "🐌" },
  { feit: "Vlinders proeven met hun pootjes! 🦋", emoji: "🦋" },
  { feit: "Een groep flamingo's heet een 'flamboyance'. Wat een naam!", emoji: "🦩" },
  { feit: "Olifanten zijn de enige dieren die niet kunnen springen!", emoji: "🐘" },
  { feit: "Een kat spendeert 70% van zijn leven aan slapen. Mega!", emoji: "😺" },
  { feit: "Honing bederft nooit — ze vonden 3000 jaar oude honing in Egypte!", emoji: "🍯" },
  { feit: "Pinguïns geven een kiezelsteentje als huwelijksaanzoek! 💍", emoji: "🐧" },
  { feit: "Een mens knippert gemiddeld 15 keer per minuut met zijn ogen.", emoji: "👁️" },
  { feit: "Wormen hebben vijf harten! ❤️❤️❤️❤️❤️", emoji: "🪱" },
  { feit: "IJsberen hebben geen witte vacht — elk haartje is doorzichtig!", emoji: "🐻‍❄️" },
  { feit: "Een groep katten heet een 'clowder'. Grappig woord toch?", emoji: "🐱" },
  { feit: "Krokodillen kunnen hun tong niet uitsteken. Probeer het zelf!", emoji: "🐊" },
  { feit: "Bananen zijn licht radioactief — maar geen paniek! 😄", emoji: "🍌" },
  { feit: "Zeesterren hebben geen hersenen en geen bloed.", emoji: "⭐" },
  { feit: "Sommige kikkers kunnen bevriezen en dan gewoon weer ontdooien! ❄️", emoji: "🐸" },
  { feit: "De tong van een giraf is 45 cm lang én paars van kleur!", emoji: "🦒" },
  { feit: "Dolfijnen hebben namen voor elkaar — ze roepen elkaar bij een geluidje!", emoji: "🐬" },
  { feit: "Mieren kunnen 50 keer hun eigen gewicht tillen. Stel je voor!", emoji: "🐜" },
  { feit: "De ogen van een struisvogel zijn groter dan zijn hersenen!", emoji: "🦤" },
  { feit: "Een groep uilen heet een 'parlement'. Uilen zijn dus politici! 🦉", emoji: "🦉" },
  { feit: "Een schildpad kan door zijn billen ademen. Handig toch?", emoji: "🐢" },
  { feit: "Honden hebben een unieke neusafdruk, net als wij vingerafdrukken!", emoji: "🐶" },
  { feit: "Een bij moet 2 miljoen bloemen bezoeken voor één pot honing!", emoji: "🐝" },
  { feit: "Bananen zijn bessen, maar aardbeien officieel niet.", emoji: "🍓" },
  { feit: "Een wombat maakt kubusvormige poep. Ja, echt.", emoji: "🟫" },
  { feit: "Otters slapen soms hand in hand zodat ze niet wegdrijven.", emoji: "🦦" },
  { feit: "Een kolibrie kan achteruit vliegen.", emoji: "🐦" },
  { feit: "Een dag op Venus duurt langer dan een jaar op Venus.", emoji: "🪐" },
  { feit: "Bijen vertellen met een dans waar de bloemen zijn.", emoji: "💃" },
  { feit: "Sommige bomen wisselen via hun wortels voedingsstoffen uit.", emoji: "🌳" },
  { feit: "Een eekhoorn maakt soms nep-verstopplekken om anderen te foppen.", emoji: "🐿️" },
  { feit: "Een kangoeroe kan niet achteruit lopen.", emoji: "🦘" },
  { feit: "Een zeepaardje zwemt heel slecht, maar ziet er wel fantastisch uit.", emoji: "🪸" },
  { feit: "IJsberen hebben een zwarte huid onder hun vacht.", emoji: "🐻" },
  { feit: "Je hersenen voelen zelf geen pijn.", emoji: "🧠" },
  { feit: "Er bestaan paddenstoelen die in het donker kunnen gloeien.", emoji: "🍄" },
  { feit: "Sommige vissen kunnen licht maken.", emoji: "🐟" },
  { feit: "Een regenboog is eigenlijk een volledige cirkel, maar meestal zie je maar een deel.", emoji: "🌈" },
  { feit: "Popcorn knalt omdat er een klein beetje water in de maiskorrel zit.", emoji: "🍿" },
  { feit: "Een wolk kan verrassend zwaar zijn.", emoji: "☁️" },
  { feit: "De zon lijkt geel, maar is eigenlijk wit.", emoji: "☀️" },
  { feit: "Sneeuw dempt geluid, daarom voelt de wereld soms extra stil aan.", emoji: "❄️" },
  { feit: "Een kraai kan puzzels oplossen en gereedschap gebruiken.", emoji: "🪶" },
  { feit: "Een spin is geen insect, maar een spinachtige.", emoji: "🕷️" },
  { feit: "Sommige eenden slapen met één oog open.", emoji: "🦆" },
  { feit: "Lama’s laten met hun oren en gezicht goed zien hoe ze zich voelen.", emoji: "🦙" },
  { feit: "Een goudvis kan meer onthouden dan mensen vroeger dachten.", emoji: "🐠" },
  { feit: "Een cheeta is supersnel, maar ook vrij snel moe.", emoji: "🐆" },
  { feit: "Een kameel bewaart geen water in zijn bult.", emoji: "🐫" },
  { feit: "Een octopus kan een kokosnoot gebruiken als schuilplek.", emoji: "🥥" },
  { feit: "Sommige slangen kunnen warmte 'zien'.", emoji: "🐍" },
  { feit: "Een blauwe vinvis is het grootste dier dat we kennen.", emoji: "🐋" },
  { feit: "Een mier is belachelijk sterk voor zijn formaat.", emoji: "🏋️" },
  { feit: "Er bestaan vulkanen onder water.", emoji: "🌋" },
  { feit: "Kwallen bestaan al langer dan dinosaurussen.", emoji: "🪼" },
  { feit: "De maan drijft elk jaar een klein beetje verder van de aarde weg.", emoji: "🌕" },
  { feit: "Sommige bloemen ruiken naar chocola.", emoji: "🌸" },
  { feit: "Uilen kunnen hun ogen niet rollen zoals wij.", emoji: "👀" },
  { feit: "Een nijlpaard kan sneller rennen dan veel mensen denken.", emoji: "🦛" },
  { feit: "Koala’s slapen bijna de hele dag.", emoji: "🐨" },
  { feit: "Een zebra is zwart met witte strepen.", emoji: "🦓" },
  { feit: "Sommige krabben versieren hun schelp of lichaam expres.", emoji: "🦀" },
  { feit: "Sommige mieren doen aan landbouw en kweken hun eigen voedsel.", emoji: "🌱" },
  { feit: "Een kat kan spinnen als hij blij is, maar soms ook als hij stress heeft.", emoji: "😽" },
  { feit: "Een walvislied kan enorm ver onder water reizen.", emoji: "🎶" },
  { feit: "Er is zand dat een zingend geluid kan maken.", emoji: "🏜️" },
  { feit: "Je kunt niet niezen met je ogen open.", emoji: "🤧" },
  { feit: "Een haai kan ouder zijn dan sommige boomsoorten.", emoji: "🦈" },
  { feit: "Raven zijn nieuwsgierig naar glimmende dingen.", emoji: "✨" },
  { feit: "Een panda kan verrassend goed klimmen.", emoji: "🐼" },
  { feit: "Er zijn vissen die over de zeebodem lijken te lopen.", emoji: "🚶" },
  { feit: "Regen kan soms naar aarde ruiken door stofjes uit de grond.", emoji: "🌧️" },
  { feit: "Sommige vogels slapen half wakker om veilig te blijven.", emoji: "😴" },
  { feit: "Een mens heeft heel veel botten die sterker zijn dan ze eruitzien.", emoji: "🦴" },
  { feit: "Een slak heeft veel meer tandjes dan je zou verwachten.", emoji: "😁" },
  { feit: "Er zijn kwallen die bijna onsterfelijk lijken.", emoji: "♾️" },
  { feit: "Een kameleon verandert niet alleen van kleur voor camouflage, maar ook voor communicatie.", emoji: "🦎" },
  { feit: "Een groep wolven heeft vaak sterke sociale regels.", emoji: "🐺" },
  { feit: "Een pinguïn lijkt onder water bijna te vliegen.", emoji: "🌊" },
  { feit: "Sommige spinnen kunnen met hun draad door de lucht zweven.", emoji: "🪂" },
  { feit: "Het hart van een blauwe vinvis is gigantisch groot.", emoji: "❤️" },
  { feit: "Er zijn meer sterren dan je brein gezellig kan bevatten.", emoji: "🌌" },
  { feit: "Een neushoornvogelhelm ziet eruit alsof hij een ingebouwde hoed draagt.", emoji: "🎩" },
  { feit: "Sommige kikkers lijken na een winter bijna weer tot leven te komen.", emoji: "🧊" },
  { feit: "Een octopus is slim genoeg om potjes open te maken.", emoji: "🫙" },
  { feit: "Dolfijnen slapen nooit helemaal tegelijk met hun hele brein.", emoji: "🧠" },
  { feit: "Een pijlstaartrog lijkt onder water soms te vliegen als een ruimteschip-pannenkoek.", emoji: "🥞" },
];

const INIT = {
  children: [
    { id: "c1", name: "Nevah",  avatar: "👸", coins: 35, pin: "1234" },
    { id: "c2", name: "Kylian", avatar: "👦", coins: 20, pin: "0000" },
  ],
  tasks: [
    { id: "t1", title: "Kamer opruimen",  desc: "Alles netjes opgeruimd", childId: "c1", coins: 10, date: today, status: "pending"  },
    { id: "t2", title: "Tanden poetsen",  desc: "",                        childId: "c1", coins: 5,  date: today, status: "done"     },
    { id: "t3", title: "Huiswerk maken",  desc: "Rekenen blz 12",          childId: "c1", coins: 15, date: today, status: "approved" },
    { id: "t4", title: "Brood halen",     desc: "",                        childId: "c2", coins: 10, date: today, status: "pending"  },
    { id: "t5", title: "Vuilnis buiten",  desc: "",                        childId: "c2", coins: 8,  date: today, status: "done"     },
  ],
  rewards: [
    { id: "r1", title: "IJsje",           desc: "Één bolletje ijs",    cost: 20, emoji: "🍦" },
    { id: "r2", title: "Extra schermtijd",desc: "30 minuten extra",    cost: 30, emoji: "📱" },
    { id: "r3", title: "Bioscoopje",      desc: "Film uitzoeken",      cost: 80, emoji: "🎬" },
  ],
  redemptions: [],
};

// ─── KINDTHEMA'S ──────────────────────────────────────────────────────────────
const THEMES = {
  Nevah: {
    bg:             "linear-gradient(160deg,#fff1f7 0%,#ffe4f1 52%,#ffd6ea 100%)",
    hdr:            "linear-gradient(135deg,#ff6fae 0%,#ff3d8f 100%)",
    hdrShadow:      "0 8px 32px rgba(255,61,143,.32)",
    pri:            "#ff4f9a", priD:"#e11d74", priL:"#ffe4f1",
    tabOnColor:     "#ff4f9a",
    taskDoneBg:     "#fff1f7", taskDoneBorder:"#ff6fae",
    deco:           ["🎀","🌸","💖","👑","🦄","✨","💅","🌺","🍭","🩷"],
    headerDeco:     ["🎀","🌸","💖","✨","👑","🦄"],
    taskIcon:       "💖", rewardIcon:"🎀",
    greeting:       "Hey prinses",
    progressColor:  "rgba(255,214,234,.95)",
  },
  Kylian: {
    bg:             "linear-gradient(160deg,#e8f4ff 0%,#dbeafe 50%,#e0f2fe 100%)",
    hdr:            "linear-gradient(135deg,#2563eb 0%,#0ea5e9 100%)",
    hdrShadow:      "0 8px 32px rgba(37,99,235,.30)",
    pri:            "#2563eb", priD:"#1d4ed8", priL:"#dbeafe",
    tabOnColor:     "#2563eb",
    taskDoneBg:     "#eff6ff", taskDoneBorder:"#3b82f6",
    deco:           ["🚀","⚡","🦕","🏆","🎮","⚽","🔥","💥","🛸","🦖"],
    headerDeco:     ["🚀","⚡","🦕","⭐","🎮","🚀"],
    taskIcon:       "⚡", rewardIcon:"🏆",
    greeting:       "Hey kampioen",
    progressColor:  "rgba(200,230,255,.9)",
  },
};
const DEFAULT_THEME = {
  bg:"linear-gradient(160deg,#f0f4ff 0%,#e8e4ff 100%)",
  hdr:"linear-gradient(135deg,#6c63ff 0%,#4f46e5 100%)",
  hdrShadow:"0 8px 32px rgba(108,99,255,.3)",
  pri:"#6c63ff", priD:"#4f46e5", priL:"#ede9ff", tabOnColor:"#6c63ff",
  taskDoneBg:"#d1fae5", taskDoneBorder:"#10b981",
  deco:["⭐","🎉","🌟","✨"], headerDeco:["⭐","🎉"],
  taskIcon:"📋", rewardIcon:"🎁", greeting:"Hoi",
  progressColor:"rgba(255,255,255,.9)",
};
const getTheme = (name) => THEMES[name] || DEFAULT_THEME;
const normalizeName = (v = "") => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const isNevahChild = (child) => {
  const nm = normalizeName(child?.name || "");
  return child?.id === "c1" || ["nevah","neoah","nevaah","nevha","neva"].includes(nm) || /^neva+h$/.test(nm);
};
const getChildTheme = (child) => isNevahChild(child) ? THEMES.Nevah : getTheme(child?.name || "");
const getChildAvatar = (child) => isNevahChild(child) ? "👸" : (child?.avatar || "🧒");

// ─── WEB AUDIO SOUNDS ──────────────────────────────────────────────────────────
function useSound() {
  const ctxRef = useRef(null);

  const getCtx = useCallback(async () => {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    if (!ctxRef.current) ctxRef.current = new AudioCtor();
    if (ctxRef.current.state === "suspended") {
      try {
        await ctxRef.current.resume();
      } catch (e) {}
    }
    return ctxRef.current;
  }, []);

  useEffect(() => {
    const unlockAudio = async () => {
      await getCtx();
    };

    window.addEventListener("click", unlockAudio, { once: true });
    window.addEventListener("touchstart", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });

    return () => {
      window.removeEventListener("click", unlockAudio);
      window.removeEventListener("touchstart", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, [getCtx]);

  const playTaskDone = useCallback(async () => {
    try {
      const ctx = await getCtx();
      if (!ctx) return;
      const notes = [
        [659.25, 0.00, 0.10, "triangle", 0.20],
        [783.99, 0.07, 0.10, "triangle", 0.22],
        [987.77, 0.15, 0.12, "triangle", 0.24],
        [1318.51, 0.26, 0.24, "triangle", 0.26],
      ];
      notes.forEach(([freq, delay, dur, type, vol]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const shimmer = ctx.createOscillator();
        const shimmerGain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        shimmer.connect(shimmerGain); shimmerGain.connect(ctx.destination);
        osc.type = type;
        shimmer.type = "sine";
        osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
        shimmer.frequency.setValueAtTime(freq * 2, ctx.currentTime + delay);
        const t = ctx.currentTime + delay;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(vol, t + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        shimmerGain.gain.setValueAtTime(0.0001, t);
        shimmerGain.gain.linearRampToValueAtTime(vol * 0.35, t + 0.01);
        shimmerGain.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.9);
        osc.start(t); osc.stop(t + dur + 0.05);
        shimmer.start(t); shimmer.stop(t + dur + 0.05);
      });
      // zachte "whoosh" voor iets meer beloningsgevoel
      const whoosh = ctx.createOscillator();
      const whooshGain = ctx.createGain();
      whoosh.connect(whooshGain); whooshGain.connect(ctx.destination);
      whoosh.type = "sawtooth";
      const t0 = ctx.currentTime;
      whoosh.frequency.setValueAtTime(240, t0);
      whoosh.frequency.exponentialRampToValueAtTime(620, t0 + 0.16);
      whooshGain.gain.setValueAtTime(0.0001, t0);
      whooshGain.gain.linearRampToValueAtTime(0.028, t0 + 0.03);
      whooshGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.20);
      whoosh.start(t0); whoosh.stop(t0 + 0.22);
    } catch(e) {}
  }, [getCtx]);

  const playCoin = useCallback(async (index = 0) => {
    try {
      const ctx = await getCtx();
      if (!ctx) return;
      const delay = index * 0.095;
      const t = ctx.currentTime + delay;
      const body = ctx.createOscillator();
      const bodyGain = ctx.createGain();
      const ping = ctx.createOscillator();
      const pingGain = ctx.createGain();
      const sparkle = ctx.createOscillator();
      const sparkleGain = ctx.createGain();
      body.connect(bodyGain); bodyGain.connect(ctx.destination);
      ping.connect(pingGain); pingGain.connect(ctx.destination);
      sparkle.connect(sparkleGain); sparkleGain.connect(ctx.destination);

      const baseFreqs = [880, 987.77, 1174.66, 1318.51, 1567.98];
      const base = baseFreqs[index % baseFreqs.length];
      body.type = "triangle";
      ping.type = "sine";
      sparkle.type = "square";
      body.frequency.setValueAtTime(base, t);
      body.frequency.exponentialRampToValueAtTime(base * 0.72, t + 0.18);
      ping.frequency.setValueAtTime(base * 2.02, t);
      ping.frequency.exponentialRampToValueAtTime(base * 1.45, t + 0.16);
      sparkle.frequency.setValueAtTime(base * 3.1, t + 0.02);

      bodyGain.gain.setValueAtTime(0.0001, t);
      bodyGain.gain.linearRampToValueAtTime(0.16, t + 0.008);
      bodyGain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);

      pingGain.gain.setValueAtTime(0.0001, t);
      pingGain.gain.linearRampToValueAtTime(0.12, t + 0.006);
      pingGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

      sparkleGain.gain.setValueAtTime(0.0001, t + 0.02);
      sparkleGain.gain.linearRampToValueAtTime(0.05, t + 0.03);
      sparkleGain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);

      body.start(t); body.stop(t + 0.24);
      ping.start(t); ping.stop(t + 0.2);
      sparkle.start(t + 0.02); sparkle.stop(t + 0.15);
    } catch(e) {}
  }, [getCtx]);

  const playAllDone = useCallback(async () => {
    try {
      const ctx = await getCtx();
      if (!ctx) return;
      // Vrolijke fanfare: oplopende akkoorden + trompet-achtig
      const notes = [
        // intro trompetstoot
        [523.25, 0,    0.08, "square", 0.18],
        [523.25, 0.07, 0.08, "square", 0.18],
        [523.25, 0.14, 0.08, "square", 0.18],
        [659.25, 0.21, 0.12, "square", 0.20],
        // melodie omhoog
        [523.25, 0.36, 0.10, "sine",   0.22],
        [587.33, 0.47, 0.10, "sine",   0.22],
        [659.25, 0.58, 0.10, "sine",   0.22],
        [698.46, 0.69, 0.10, "sine",   0.22],
        [783.99, 0.80, 0.18, "sine",   0.26],
        // hoog hoogtepunt
        [1046.5, 1.02, 0.10, "sine",   0.20],
        [1174.7, 1.13, 0.10, "sine",   0.20],
        [1318.5, 1.24, 0.30, "sine",   0.28],
        // dalende afsluiter
        [1046.5, 1.57, 0.10, "sine",   0.18],
        [880.00, 1.68, 0.10, "sine",   0.18],
        [783.99, 1.79, 0.10, "sine",   0.18],
        [1046.5, 1.92, 0.45, "sine",   0.30],
      ];
      notes.forEach(([freq, delay, dur, type, vol]) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = type;
        osc.frequency.value = freq;
        const t = ctx.currentTime + delay;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(vol, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.start(t); osc.stop(t + dur + 0.05);
      });
      // gelijktijdig bas
      [[130.81,0,.5,"sine",.12],[130.81,.55,.5,"sine",.12],[196.00,1.1,.5,"sine",.12],[261.63,1.65,.8,"sine",.15]].forEach(([freq,delay,dur,type,vol])=>{
        const osc=ctx.createOscillator(); const gain=ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type=type; osc.frequency.value=freq;
        const t=ctx.currentTime+delay;
        gain.gain.setValueAtTime(0,t);
        gain.gain.linearRampToValueAtTime(vol,t+0.03);
        gain.gain.exponentialRampToValueAtTime(0.001,t+dur);
        osc.start(t); osc.stop(t+dur+0.05);
      });
    } catch(e) {}
  }, [getCtx]);

  const playCoinBurst = useCallback((count = 6) => {
    for (let i = 0; i < count; i++) playCoin(i);
  }, [playCoin]);

  const playSpend = useCallback(async () => {
    try {
      const ctx = await getCtx();
      if (!ctx) return;
      // Kassa-geluid: dalende tonen + kort geruis = geld dat weggaat
      [
        [880.00, 0.00, 0.07, "triangle", 0.28],
        [698.46, 0.07, 0.07, "triangle", 0.24],
        [523.25, 0.14, 0.07, "triangle", 0.20],
        [392.00, 0.21, 0.12, "triangle", 0.16],
      ].forEach(([freq, delay, dur, type, vol]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = type;
        osc.frequency.value = freq;
        const t = ctx.currentTime + delay;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(vol, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.start(t); osc.stop(t + dur + 0.05);
      });
      // kassa "pling" achteraf
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2); gain2.connect(ctx.destination);
      osc2.type = "sine";
      osc2.frequency.value = 1200;
      const t2 = ctx.currentTime + 0.36;
      gain2.gain.setValueAtTime(0, t2);
      gain2.gain.linearRampToValueAtTime(0.22, t2 + 0.01);
      gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.18);
      osc2.start(t2); osc2.stop(t2 + 0.22);
    } catch(e) {}
  }, [getCtx]);

  const playDrumroll = useCallback(async (duration = 3000) => {
    try {
      const ctx = await getCtx();
      if (!ctx) return;
      const dur = duration / 1000;
      const t0  = ctx.currentTime + 0.05;

      // ── Hoofdtoon: snel oplopende frequentie (als een meter die oploopt) ──
      const osc1 = ctx.createOscillator();
      const g1   = ctx.createGain();
      osc1.connect(g1); g1.connect(ctx.destination);
      osc1.type = "sawtooth";
      osc1.frequency.setValueAtTime(80, t0);
      osc1.frequency.exponentialRampToValueAtTime(1200, t0 + dur * 0.92);
      g1.gain.setValueAtTime(0, t0);
      g1.gain.linearRampToValueAtTime(0.18, t0 + 0.15);
      g1.gain.setValueAtTime(0.18, t0 + dur * 0.85);
      g1.gain.linearRampToValueAtTime(0.0, t0 + dur);
      osc1.start(t0); osc1.stop(t0 + dur + 0.1);

      // ── Tweede toon een octaaf hoger, zachter ──
      const osc2 = ctx.createOscillator();
      const g2   = ctx.createGain();
      osc2.connect(g2); g2.connect(ctx.destination);
      osc2.type = "sine";
      osc2.frequency.setValueAtTime(160, t0);
      osc2.frequency.exponentialRampToValueAtTime(2400, t0 + dur * 0.92);
      g2.gain.setValueAtTime(0, t0);
      g2.gain.linearRampToValueAtTime(0.09, t0 + 0.2);
      g2.gain.setValueAtTime(0.09, t0 + dur * 0.85);
      g2.gain.linearRampToValueAtTime(0.0, t0 + dur);
      osc2.start(t0); osc2.stop(t0 + dur + 0.1);

      // ── Lage dreun die opbouwt als spanning ──
      const osc3 = ctx.createOscillator();
      const g3   = ctx.createGain();
      osc3.connect(g3); g3.connect(ctx.destination);
      osc3.type = "sine";
      osc3.frequency.setValueAtTime(40, t0);
      osc3.frequency.linearRampToValueAtTime(90, t0 + dur);
      g3.gain.setValueAtTime(0, t0);
      g3.gain.linearRampToValueAtTime(0.22, t0 + dur * 0.6);
      g3.gain.linearRampToValueAtTime(0.0, t0 + dur);
      osc3.start(t0); osc3.stop(t0 + dur + 0.1);

      // ── Korte piek-klap helemaal aan het einde ──
      const oscEnd = ctx.createOscillator();
      const gEnd   = ctx.createGain();
      oscEnd.connect(gEnd); gEnd.connect(ctx.destination);
      oscEnd.type = "square";
      oscEnd.frequency.setValueAtTime(600, t0 + dur);
      oscEnd.frequency.exponentialRampToValueAtTime(200, t0 + dur + 0.15);
      gEnd.gain.setValueAtTime(0.4, t0 + dur);
      gEnd.gain.exponentialRampToValueAtTime(0.001, t0 + dur + 0.18);
      oscEnd.start(t0 + dur); oscEnd.stop(t0 + dur + 0.2);

    } catch(e) {}
  }, [getCtx]);

  return { playTaskDone, playCoin, playCoinBurst, playAllDone, playSpend, playDrumroll };
}

// ─── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Baloo+2:wght@700;800&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Nunito',sans-serif;background:#f0f4ff;color:#1e2340}
  :root{
    --pri:#6c63ff;--pri-d:#4f46e5;--pri-l:#ede9ff;
    --grn:#10b981;--grn-l:#d1fae5;
    --yel:#f59e0b;--yel-l:#fef3c7;
    --red:#ef4444;--red-l:#fee2e2;
    --sur:#fff;--sur2:#f8f9ff;--bor:#e2e8f8;--t2:#6b7280;
    --r:16px;--rs:10px;--sh:0 4px 24px rgba(108,99,255,.10);
  }
  .app{min-height:100vh;display:flex;flex-direction:column;overflow-x:hidden}

  /* ── HOME ── */
  .home{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;background:linear-gradient(160deg,#f0f4ff 0%,#e8e4ff 60%,#fce7ff 100%);overflow:hidden;position:relative}
  .home-bg-deco{position:absolute;inset:0;pointer-events:none;overflow:hidden}
  .home-bg-blob{position:absolute;border-radius:50%;filter:blur(60px);opacity:.18}

  .home-banner{text-align:center;margin-bottom:40px;animation:popIn .5s cubic-bezier(.34,1.56,.64,1) both}
  .home-logo{font-family:'Baloo 2',cursive;font-size:52px;font-weight:800;color:var(--pri);line-height:1;display:flex;align-items:center;justify-content:center;gap:12px;text-shadow:0 4px 20px rgba(108,99,255,.2)}
  .home-sub{font-size:17px;color:var(--t2);font-weight:700;margin-top:8px}
  .home-date{display:inline-flex;align-items:center;gap:10px;background:white;border-radius:50px;padding:10px 24px;border:2px solid var(--bor);box-shadow:var(--sh);margin-top:16px}
  .home-date-day{font-family:'Baloo 2',cursive;font-size:18px;font-weight:800;color:var(--pri);text-transform:capitalize}
  .home-date-full{font-size:13px;color:var(--t2);font-weight:600;text-transform:capitalize}

  .home-label{font-family:'Baloo 2',cursive;font-size:22px;font-weight:800;color:#4b5563;margin-bottom:28px;text-align:center;animation:popIn .5s .1s cubic-bezier(.34,1.56,.64,1) both}

  .home-kids{display:flex;gap:28px;margin-bottom:52px;flex-wrap:wrap;justify-content:center}
  .home-kid{
    display:flex;flex-direction:column;align-items:center;gap:0;
    border-radius:32px;border:3px solid transparent;
    cursor:pointer;transition:all .25s cubic-bezier(.34,1.56,.64,1);
    background:white;overflow:hidden;
    min-width:200px;width:220px;
    box-shadow:0 8px 32px rgba(0,0,0,.10);
    animation:popIn .4s cubic-bezier(.34,1.56,.64,1) both;
    position:relative;
  }
  .home-kid:nth-child(2){animation-delay:.12s}
  .home-kid:hover{transform:translateY(-12px) scale(1.04);box-shadow:0 24px 60px rgba(0,0,0,.18)}
  .home-kid:active{transform:scale(.97)}

  .home-kid-top{width:100%;padding:32px 20px 20px;display:flex;flex-direction:column;align-items:center;gap:10px}
  .home-kid-av{font-size:96px;line-height:1;filter:drop-shadow(0 6px 14px rgba(0,0,0,.15));animation:floatAv 3s ease-in-out infinite alternate}
  @keyframes floatAv{from{transform:translateY(0)}to{transform:translateY(-8px)}}
  .home-kid-name{font-family:'Baloo 2',cursive;font-size:32px;font-weight:800;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.15)}
  .home-kid-deco{font-size:20px;letter-spacing:4px;opacity:.85}

  .home-kid-bottom{width:100%;background:#fff;padding:18px 20px 22px;display:flex;flex-direction:column;align-items:center;gap:8px}
  .home-kid-coins{font-size:22px;font-weight:900;color:var(--yel);display:flex;align-items:center;gap:6px}
  .home-kid-tasks{font-size:13px;font-weight:700;color:var(--t2)}
  .home-kid-cta{margin-top:4px;padding:10px 28px;border-radius:50px;border:none;font-family:'Nunito',sans-serif;font-weight:800;font-size:14px;cursor:pointer;color:#fff;transition:all .2s;box-shadow:0 4px 14px rgba(0,0,0,.15)}
  .home-kid-cta:hover{transform:scale(1.06);box-shadow:0 6px 20px rgba(0,0,0,.2)}

  .home-parent-btn{background:rgba(255,255,255,.7);backdrop-filter:blur(8px);border:2px solid var(--bor);border-radius:50px;padding:14px 34px;font-family:'Nunito',sans-serif;font-weight:700;font-size:15px;color:var(--t2);cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:10px;box-shadow:0 2px 16px rgba(0,0,0,.07)}
  .home-parent-btn:hover{border-color:var(--pri);color:var(--pri);transform:translateY(-2px);box-shadow:var(--sh)}

  /* ── HEADER ── */
  .hdr{background:#fff;border-bottom:2px solid var(--bor);padding:0 20px;display:flex;align-items:center;justify-content:space-between;height:64px;position:sticky;top:0;z-index:100;box-shadow:0 2px 12px rgba(108,99,255,.07)}
  .logo{font-family:'Baloo 2',cursive;font-size:21px;font-weight:800;color:var(--pri);display:flex;align-items:center;gap:8px}
  .back-btn{padding:7px 16px;border-radius:50px;font-family:'Nunito',sans-serif;font-weight:700;font-size:13px;border:2px solid var(--bor);cursor:pointer;background:transparent;color:var(--t2);transition:all .2s;display:flex;align-items:center;gap:5px}
  .back-btn:hover{border-color:var(--pri);color:var(--pri)}

  /* ── MAIN ── */
  .main{flex:1;padding:24px 20px;max-width:1060px;margin:0 auto;width:100%}
  .card{background:#fff;border-radius:var(--r);border:2px solid var(--bor);padding:22px;box-shadow:var(--sh)}
  .g3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  .ga{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
  @media(max-width:660px){.g3{grid-template-columns:1fr}}

  /* ── BUTTONS ── */
  .btn{padding:9px 18px;border-radius:50px;font-family:'Nunito',sans-serif;font-weight:700;font-size:13px;border:none;cursor:pointer;transition:all .18s;display:inline-flex;align-items:center;gap:5px}
  .bp{background:var(--pri);color:#fff;box-shadow:0 3px 12px rgba(108,99,255,.3)}
  .bp:hover{background:var(--pri-d);transform:translateY(-1px)}
  .bg{background:var(--grn);color:#fff}.bg:hover{background:#059669}
  .bh{background:var(--sur2);color:var(--t2);border:2px solid var(--bor)}
  .bh:hover{border-color:var(--pri);color:var(--pri)}
  .bsm{padding:6px 13px;font-size:12px}
  .btn:disabled{opacity:.5;cursor:not-allowed;transform:none!important}

  /* ── FORM ── */
  .fg{margin-bottom:14px}
  .fl{display:block;font-weight:700;font-size:12px;margin-bottom:5px;color:#374151}
  .fi,.fs,.ft{width:100%;padding:9px 13px;border-radius:var(--rs);border:2px solid var(--bor);font-family:'Nunito',sans-serif;font-size:13px;background:var(--sur2);color:#1e2340;outline:none;transition:border-color .2s}
  .fi:focus,.fs:focus,.ft:focus{border-color:var(--pri);background:#fff}
  .dark-form .fl{color:rgba(226,232,240,.92);font-weight:800}
  .dark-form .fi,.dark-form .fs,.dark-form .ft{background:rgba(255,255,255,.96);color:#0f172a;border-color:rgba(148,163,184,.28)}
  .dark-form .fi::placeholder,.dark-form .fs::placeholder,.dark-form .ft::placeholder{color:#64748b}
  .dark-form .fi:focus,.dark-form .fs:focus,.dark-form .ft:focus{background:#fff;border-color:#818cf8;box-shadow:0 0 0 4px rgba(129,140,248,.14)}
  .parent-quiet{--t1:#f8fbff;--t2:#dbe7f5;--bor:rgba(148,163,184,.22)}
  .parent-quiet .fl{color:#f8fbff!important;font-weight:800;letter-spacing:.01em}
  .parent-quiet .fi,.parent-quiet .fs,.parent-quiet .ft{background:rgba(255,255,255,.99)!important;color:#0f172a!important;border-color:rgba(148,163,184,.38)!important}
  .parent-quiet .fi::placeholder,.parent-quiet .fs::placeholder,.parent-quiet .ft::placeholder{color:#64748b!important;opacity:1}
  .parent-quiet .fi:focus,.parent-quiet .fs:focus,.parent-quiet .ft:focus{background:#fff!important;border-color:#818cf8!important;box-shadow:0 0 0 4px rgba(129,140,248,.18)!important}
  .parent-quiet .tab{color:#e6eef8!important}
  .parent-quiet .tab.on{color:#ffffff!important}
  .parent-quiet .card,.parent-quiet .tr{color:#eef4ff}
  .parent-quiet .emp,.parent-quiet .muted,.parent-quiet .help,.parent-quiet small{color:#d7e3f4!important}
  .parent-quiet .bh{background:rgba(30,41,59,.92)!important;color:#eef4ff!important;border-color:rgba(148,163,184,.30)!important}
  .parent-quiet .bh:hover{border-color:rgba(129,140,248,.55)!important;color:#ffffff!important}
  .parent-quiet .bp{box-shadow:0 10px 24px rgba(79,70,229,.20)!important}
  .parent-quiet button,.parent-quiet input,.parent-quiet select,.parent-quiet textarea{font-weight:700}
  .ft{resize:vertical;min-height:65px}
  .fr{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media(max-width:480px){.fr{grid-template-columns:1fr}}

  /* ── BADGES ── */
  .bd{display:inline-flex;align-items:center;gap:3px;padding:2px 9px;border-radius:50px;font-size:11px;font-weight:700}
  .by{background:var(--yel-l);color:#b45309}
  .bgn{background:var(--grn-l);color:#065f46}
  .bbl{background:#dbeafe;color:#1d4ed8}

  /* ── TABS ── */
  .tabs{display:flex;gap:3px;background:var(--sur2);border-radius:50px;padding:4px;margin-bottom:22px;width:fit-content;flex-wrap:wrap}
  .tab{padding:7px 16px;border-radius:50px;font-weight:700;font-size:13px;cursor:pointer;border:none;transition:all .2s;background:transparent;color:var(--t2)}
  .tab.on{background:#fff;color:var(--pri);box-shadow:0 2px 8px rgba(0,0,0,.1)}

  /* ── SECTION ── */
  .sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px}
  .st{font-family:'Baloo 2',cursive;font-size:19px;font-weight:800}
  .frow{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}

  /* ── TASK ROW (parent) ── */
  .tr{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:var(--rs);border:2px solid var(--bor);margin-bottom:8px;background:var(--sur2);transition:all .2s}
  .tr:hover{border-color:var(--pri);box-shadow:0 2px 10px rgba(108,99,255,.1)}
  .pi{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:var(--rs);border:2px solid var(--yel-l);background:var(--yel-l);margin-bottom:8px;flex-wrap:wrap}

  /* ── KID THEME DECO ── */
  .kid-page{min-height:100vh;transition:background .3s}
  .kid-deco-strip{display:flex;justify-content:center;gap:10px;font-size:22px;margin-bottom:14px;flex-wrap:wrap;animation:decoFloat 3s ease-in-out infinite alternate}
  @keyframes decoFloat{from{transform:translateY(0)}to{transform:translateY(-6px)}}
  .kid-deco-float{display:inline-block;animation:singleFloat var(--df) ease-in-out infinite alternate}
  @keyframes singleFloat{from{transform:translateY(0) rotate(-5deg)}to{transform:translateY(-8px) rotate(5deg)}}

  /* ── KID HEADER (themed) ── */
  .kh{background:linear-gradient(135deg,var(--pri) 0%,var(--pri-d) 100%);border-radius:22px;padding:28px 32px;margin-bottom:16px;color:#fff;display:flex;align-items:center;gap:20px;box-shadow:0 8px 32px rgba(108,99,255,.3);position:relative;overflow:hidden}
  .kh-left{display:flex;align-items:center;gap:18px;flex:1}
  .kh-right{display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,.15);border-radius:18px;padding:14px 22px;min-width:130px;gap:4px;border:2px solid rgba(255,255,255,.2);flex-shrink:0}
  .kh-coins-label{font-size:11px;font-weight:800;opacity:.8;text-transform:uppercase;letter-spacing:.8px}
  .kh-coins-val{font-family:'Baloo 2',cursive;font-size:44px;font-weight:800;line-height:1;display:flex;align-items:center;gap:6px}
  .kh-coins-val.pop{animation:coinNumPop .4s ease}

  /* ── COIN COUNTER in header ── */
  .coin-counter{font-size:20px;font-weight:900;display:flex;align-items:center;gap:7px;margin-bottom:2px;position:relative}
  .coin-counter-num{transition:transform .3s;display:inline-block}
  .coin-counter-num.pop{animation:coinNumPop .4s ease}

  /* ── DATE + FACT CARDS ── */
  .kid-info-row{display:grid;grid-template-columns:1fr 2fr;gap:14px;margin-bottom:22px}
  @media(max-width:560px){.kid-info-row{grid-template-columns:1fr}}
  .kid-date-card{background:#fff;border-radius:20px;border:2px solid var(--bor);padding:18px 20px;box-shadow:var(--sh);display:flex;flex-direction:column;justify-content:center;gap:4px}
  .kid-date-card-day{font-family:'Baloo 2',cursive;font-size:22px;font-weight:800;color:var(--pri);text-transform:capitalize}
  .kid-date-card-full{font-size:13px;color:var(--t2);font-weight:600;text-transform:capitalize}
  .kid-fact-card{background:#fff;border-radius:20px;border:2px solid var(--bor);padding:18px 20px;box-shadow:var(--sh);display:flex;align-items:flex-start;gap:14px}
  .kid-fact-emoji{font-size:36px;flex-shrink:0;line-height:1;margin-top:2px}
  .kid-fact-label{font-size:11px;font-weight:800;color:var(--pri);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
  .kid-fact-text{font-size:14px;font-weight:700;line-height:1.5}

  /* ── KID TASK ── */
  .kt{background:#fff;border-radius:18px;padding:16px 18px;margin-bottom:10px;display:flex;align-items:center;gap:14px;border:3px solid var(--bor);transition:all .25s;box-shadow:0 2px 8px rgba(0,0,0,.04)}
  .kt:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(108,99,255,.12)}
  .kt.kdone{background:var(--grn-l);border-color:var(--grn)}
  .kt.kappr{background:var(--grn-l);border-color:var(--grn);opacity:.8}
  .kc{width:40px;height:40px;border-radius:50%;border:3px solid var(--bor);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;transition:all .2s;background:#fff;user-select:none}
  .kc:hover:not(.kcd){border-color:var(--grn);transform:scale(1.12)}
  .kc.kchk{background:var(--grn);border-color:var(--grn);animation:checkPop .35s ease}
  .kc.kcd{cursor:default}

  /* ── REWARD CARD ── */
  .rc{background:#fff;border-radius:18px;padding:18px;border:3px solid var(--bor);text-align:center;transition:all .2s;cursor:pointer}
  .rc:hover:not(.rca){border-color:var(--pri);transform:translateY(-3px);box-shadow:0 8px 24px rgba(108,99,255,.15)}
  .rca{opacity:.5;cursor:not-allowed}

  /* ── MODAL ── */
  .ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;animation:fi .15s ease}
  .mo{background:#fff;border-radius:22px;padding:28px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.22);animation:su .2s ease;max-height:90vh;overflow-y:auto}
  .mt{font-family:'Baloo 2',cursive;font-size:21px;font-weight:800;margin-bottom:18px}
  .ma{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
  .ap{display:flex;flex-wrap:wrap;gap:7px;margin-top:6px}
  .ao{font-size:26px;cursor:pointer;padding:5px;border-radius:9px;border:2px solid transparent;transition:all .15s}
  .ao:hover{background:var(--pri-l)}.ao.aon{border-color:var(--pri);background:var(--pri-l)}

  /* ── PROGRESS ── */
  .pb{height:9px;border-radius:50px;overflow:hidden;margin:7px 0}
  .pf{height:100%;border-radius:50px;background:rgba(255,255,255,.9);transition:width .5s ease}

  /* ── EMPTY ── */
  .emp{text-align:center;padding:36px 16px;color:var(--t2)}
  .ei{font-size:44px;margin-bottom:10px}
  .et{font-weight:700;font-size:15px}

  /* ── FLYING COIN ── */
  .flying-coin{position:fixed;font-size:30px;pointer-events:none;z-index:9999;animation:flyCoin var(--dur) cubic-bezier(.18,.72,.22,1) forwards;filter:drop-shadow(0 6px 14px rgba(255,190,45,.35))}
  .flying-coin::before{content:"";position:absolute;left:50%;top:50%;width:18px;height:18px;border-radius:50%;transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(255,238,170,.9) 0%, rgba(255,208,64,.3) 45%, rgba(255,208,64,0) 70%);z-index:-1;animation:coinGlow var(--dur) ease-out forwards}
  .flying-sparkle{position:fixed;pointer-events:none;z-index:9997;font-size:15px;animation:sparkleTrail var(--sdur) ease-out forwards;opacity:.95}
  @keyframes flyCoin{
    0%  { transform:translate(0,0) scale(.55) rotate(-18deg);   opacity:0 }
    10% { opacity:1 }
    42% { transform:translate(calc(var(--tx) * .45),calc(var(--ty-mid) * .72)) scale(1.28) rotate(140deg); opacity:1 }
    72% { transform:translate(calc(var(--tx) * .82),calc(var(--ty-mid) * 1.05)) scale(1.08) rotate(260deg); opacity:1 }
    100%{ transform:translate(var(--tx),var(--ty)) scale(0.32) rotate(430deg); opacity:0 }
  }
  @keyframes coinGlow{
    0%{transform:translate(-50%,-50%) scale(.4);opacity:0}
    20%{opacity:1}
    100%{transform:translate(-50%,-50%) scale(1.8);opacity:0}
  }
  @keyframes sparkleTrail{
    0%{transform:translate(0,0) scale(.4) rotate(0deg);opacity:0}
    18%{opacity:1}
    100%{transform:translate(var(--stx),var(--sty)) scale(1.1) rotate(180deg);opacity:0}
  }

  /* ── COIN BURST OVERLAY ── */
  .coin-burst-overlay{position:fixed;inset:0;pointer-events:none;z-index:9998;display:flex;align-items:center;justify-content:center}
  .burst-coin{position:absolute;font-size:32px;animation:burstCoin var(--bdur) ease-out forwards}
  @keyframes burstCoin{
    0%  { transform:translate(0,0) scale(0) rotate(0deg);   opacity:1 }
    50% { opacity:1; transform:translate(var(--bx),var(--by)) scale(1.4) rotate(180deg) }
    100%{ transform:translate(var(--bx2),var(--by2)) scale(0.2) rotate(400deg); opacity:0 }
  }

  /* ── KEYFRAMES ── */
  @keyframes fi{from{opacity:0}to{opacity:1}}
  @keyframes su{from{transform:translateY(28px);opacity:0}to{transform:translateY(0);opacity:1}}
  @keyframes popIn{0%{transform:scale(.82);opacity:0}100%{transform:scale(1);opacity:1}}
  @keyframes checkPop{0%{transform:scale(1)}40%{transform:scale(1.4)}70%{transform:scale(0.9)}100%{transform:scale(1)}}
  @keyframes coinNumPop{0%{transform:scale(1)}30%{transform:scale(1.5)}70%{transform:scale(0.9)}100%{transform:scale(1)}}
  @keyframes taskDoneShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-4px)}40%{transform:translateX(4px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}
  .shake{animation:taskDoneShake .4s ease}

  /* ── SLAY GIRL POPUP ── */
  .slay-popup{
    position:absolute; top:-20px; left:50%; transform:translateX(-50%);
    background:linear-gradient(135deg,#ff6eb4,#ff3d9a);
    color:#fff; font-family:'Baloo 2',cursive; font-weight:800;
    font-size:18px; padding:6px 18px; border-radius:50px;
    white-space:nowrap; pointer-events:none; z-index:99;
    box-shadow:0 4px 20px rgba(255,60,150,.45);
    animation:slayPop .9s ease forwards;
  }
  @keyframes slayPop{
    0%  { opacity:0; transform:translateX(-50%) translateY(10px) scale(.7) }
    25% { opacity:1; transform:translateX(-50%) translateY(-18px) scale(1.15) }
    70% { opacity:1; transform:translateX(-50%) translateY(-24px) scale(1) }
    100%{ opacity:0; transform:translateX(-50%) translateY(-38px) scale(.9) }
  }

  /* ── PIN SCHERM (tweede blok, dit is de echte) ── */
  .pin-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);backdrop-filter:blur(6px);animation:feestFadeIn .2s ease}
  .pin-card{background:#fff;border-radius:32px;padding:40px 36px;text-align:center;box-shadow:0 32px 80px rgba(0,0,0,.25);animation:feestCardIn .4s cubic-bezier(.34,1.56,.64,1) both;min-width:320px;max-width:360px;width:90%}
  .pin-avatar{font-size:72px;line-height:1;margin-bottom:8px;display:block}
  .pin-title{font-family:'Baloo 2',cursive;font-size:26px;font-weight:800;margin-bottom:4px}
  .pin-sub{font-size:14px;color:var(--t2);font-weight:600;margin-bottom:24px}
  .pin-dots{display:flex;justify-content:center;gap:14px;margin-bottom:28px}
  .pin-dot{width:18px;height:18px;border-radius:50%;border:3px solid var(--bor);transition:all .15s}
  .pin-dot.filled{border-color:var(--pin-pri);background:var(--pin-pri);transform:scale(1.15)}
  .pin-dot.wrong{border-color:#ef4444;background:#ef4444;animation:pinWrong .35s ease}
  @keyframes pinWrong{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}
  .pin-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
  .pin-btn{aspect-ratio:1;border-radius:50%;border:2px solid var(--bor);background:#f8f9ff;font-family:'Baloo 2',cursive;font-size:22px;font-weight:800;cursor:pointer;transition:all .12s;color:#1e2340;display:flex;align-items:center;justify-content:center}
  .pin-btn:hover{background:var(--pin-l);border-color:var(--pin-pri);transform:scale(1.08)}
  .pin-btn:active{transform:scale(.94)}
  .pin-btn.zero{grid-column:2}
  .pin-del{background:transparent;border:none;font-size:22px;cursor:pointer;color:var(--t2);padding:8px;border-radius:50%;transition:all .15s}
  .pin-del:hover{color:#ef4444;background:#fee2e2}
  .pin-cancel{margin-top:4px;background:none;border:none;font-size:13px;font-weight:700;color:var(--t2);cursor:pointer;padding:8px 16px;border-radius:50px;transition:all .2s}
  .pin-cancel:hover{background:var(--sur2);color:var(--pri)}
  .pin-error{font-size:13px;font-weight:700;color:#ef4444;margin-bottom:12px;min-height:20px;animation:popIn .2s ease}

  /* ── FEEST OVERLAY ── */
  .feest-overlay{
    position:fixed; inset:0; z-index:9990; pointer-events:none;
    display:flex; align-items:center; justify-content:center;
  }
  .feest-backdrop{
    position:absolute; inset:0;
    background:rgba(108,99,255,.18);
    animation:feestFadeIn .3s ease;
  }
  .feest-card{
    position:relative; z-index:2;
    background:linear-gradient(135deg,#6c63ff 0%,#f59e0b 100%);
    border-radius:32px; padding:40px 52px; text-align:center;
    box-shadow:0 24px 80px rgba(108,99,255,.5);
    animation:feestCardIn .5s cubic-bezier(.34,1.56,.64,1) both;
    color:#fff;
  }
  .feest-emoji-row{ font-size:52px; margin-bottom:12px; animation:feestBounce 1s ease infinite alternate }
  .feest-title{ font-family:'Baloo 2',cursive; font-size:38px; font-weight:800; margin-bottom:6px; text-shadow:0 2px 12px rgba(0,0,0,.2) }
  .feest-sub{ font-size:17px; font-weight:700; opacity:.9; margin-bottom:24px }
  .feest-confetti{ position:fixed; inset:0; pointer-events:none; overflow:hidden; z-index:9991 }
  .confetti-piece{
    position:absolute; width:10px; height:14px; border-radius:3px;
    animation:confettiFall var(--cf-dur) var(--cf-delay) ease-in forwards;
    top:-20px;
  }
  @keyframes feestFadeIn{ from{opacity:0} to{opacity:1} }
  @keyframes feestCardIn{ from{transform:scale(.4) rotate(-8deg);opacity:0} to{transform:scale(1) rotate(0deg);opacity:1} }
  @keyframes feestBounce{ from{transform:translateY(0) rotate(-5deg)} to{transform:translateY(-12px) rotate(5deg)} }
  @keyframes confettiFall{
    0%  { transform:translateX(0) translateY(-20px) rotate(0deg); opacity:1 }
    80% { opacity:1 }
    100%{ transform:translateX(var(--cf-x)) translateY(110vh) rotate(var(--cf-rot)); opacity:0 }
  }

  /* ── PIN SCHERM ── */
  .pin-screen{
    position:fixed;inset:0;z-index:8000;
    display:flex;align-items:center;justify-content:center;
    padding:24px;
  }
  .pin-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.45);backdrop-filter:blur(6px)}
  .pin-card{
    position:relative;z-index:2;
    background:#fff;border-radius:32px;padding:40px 36px 36px;
    width:100%;max-width:360px;text-align:center;
    box-shadow:0 32px 80px rgba(0,0,0,.25);
    animation:feestCardIn .35s cubic-bezier(.34,1.56,.64,1) both;
  }
  .pin-avatar{font-size:72px;line-height:1;margin-bottom:8px}
  .pin-name{font-family:'Baloo 2',cursive;font-size:28px;font-weight:800;margin-bottom:4px}
  .pin-label{font-size:14px;font-weight:700;color:var(--t2);margin-bottom:24px}
  .pin-dots{display:flex;justify-content:center;gap:14px;margin-bottom:28px}
  .pin-dot{
    width:20px;height:20px;border-radius:50%;
    border:3px solid;transition:all .2s;
    background:transparent;
  }
  .pin-dot.filled{background:currentColor;transform:scale(1.15)}
  .pin-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
  .pin-btn{
    aspect-ratio:1;border-radius:50%;border:2px solid var(--bor);
    background:var(--sur2);font-family:'Baloo 2',cursive;
    font-size:26px;font-weight:800;cursor:pointer;
    transition:all .15s;display:flex;align-items:center;justify-content:center;
    color:#1e2340;user-select:none;
  }
  .pin-btn:hover{transform:scale(1.1);border-color:currentColor}
  .pin-btn:active{transform:scale(.93)}
  .pin-btn.del{font-size:20px;color:var(--t2);border-color:transparent;background:transparent}
  .pin-btn.del:hover{background:var(--red-l);color:var(--red);border-color:transparent}
  .pin-error{font-size:13px;font-weight:700;color:var(--red);margin-bottom:8px;animation:shake .4s ease}
  .pin-cancel{background:none;border:none;font-family:'Nunito',sans-serif;font-weight:700;font-size:13px;color:var(--t2);cursor:pointer;padding:8px 16px;border-radius:50px;transition:all .2s}
  .pin-cancel:hover{background:var(--sur2);color:var(--pri)}
`;

// ─── FLYING COINS COMPONENT ────────────────────────────────────────────────────
function FlyingCoins({ coins, targetRef, onDone }) {
  const [particles, setParticles] = useState([]);
  const [sparkles, setSparkles] = useState([]);

  useEffect(() => {
    const count = Math.min(Math.max(Math.floor(coins / 2), 6), 14);
    const centerX = window.innerWidth * 0.5;
    const centerY = window.innerHeight * 0.58;
    const newParticles = Array.from({ length: count }, (_, i) => ({
      id: genId(),
      delay: i * 0.07,
      dur: 0.95 + Math.random() * 0.45,
      tx: (Math.random() - 0.5) * 260,
      tyMid: -(150 + Math.random() * 110),
      ty: -(250 + Math.random() * 100),
      startX: centerX + (Math.random() - 0.5) * 180,
      startY: centerY + Math.random() * 70,
    }));
    const sparkleIcons = ["✨","⭐","💫"];
    const newSparkles = Array.from({ length: count * 2 }, (_, i) => ({
      id: genId(),
      icon: sparkleIcons[i % sparkleIcons.length],
      delay: i * 0.035,
      dur: 0.55 + Math.random() * 0.35,
      x: centerX + (Math.random() - 0.5) * 140,
      y: centerY - 20 + (Math.random() - 0.5) * 90,
      stx: (Math.random() - 0.5) * 220,
      sty: -(40 + Math.random() * 170),
    }));
    setParticles(newParticles);
    setSparkles(newSparkles);

    const maxDur = (count - 1) * 70 + 1500;
    const timer = setTimeout(onDone, maxDur);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      {sparkles.map(s => (
        <div
          key={s.id}
          className="flying-sparkle"
          style={{
            left: s.x,
            top: s.y,
            "--stx": `${s.stx}px`,
            "--sty": `${s.sty}px`,
            "--sdur": `${s.dur}s`,
            animationDelay: `${s.delay}s`,
          }}
        >
          {s.icon}
        </div>
      ))}
      {particles.map(p => (
        <div
          key={p.id}
          className="flying-coin"
          style={{
            left: p.startX,
            top:  p.startY,
            "--tx": `${p.tx}px`,
            "--ty-mid": `${p.tyMid}px`,
            "--ty": `${p.ty}px`,
            "--dur": `${p.dur}s`,
            animationDelay: `${p.delay}s`,
          }}
        >
          🪙
        </div>
      ))}
    </>
  );
}

// ─── PIN SCHERM ────────────────────────────────────────────────────────────────
function PinScreen({ child, theme: th, onSuccess, onCancel }) {
  const [entered, setEntered] = useState("");
  const [wrong,   setWrong]   = useState(false);
  const [error,   setError]   = useState("");
  const PIN_LEN = (child?.pin || "1234").length;

  const press = (digit) => {
    if (entered.length >= PIN_LEN) return;
    const next = entered + digit;
    setEntered(next);
    setWrong(false);
    setError("");
    if (next.length === PIN_LEN) {
      setTimeout(() => {
        if (next === child.pin) {
          onSuccess();
        } else {
          setWrong(true);
          setError("Oeps! Dat is niet de juiste code 🙈");
          setTimeout(() => { setEntered(""); setWrong(false); }, 600);
        }
      }, 120);
    }
  };

  const del = () => { setEntered(e => e.slice(0,-1)); setError(""); setWrong(false); };

  const KEYS = ["1","2","3","4","5","6","7","8","9"];

  return (
    <div className="pin-overlay" onClick={onCancel}>
      <div className="pin-card"
        style={{ "--pin-pri": th.pri, "--pin-l": th.priL }}
        onClick={e => e.stopPropagation()}>
        <span className="pin-avatar">{getChildAvatar(child)}</span>
        <div className="pin-title" style={{ color: th.pri }}>Hoi {child?.name}!</div>
        <div className="pin-sub">Voer jouw pincode in 🔐</div>

        {/* Dots */}
        <div className="pin-dots">
          {Array.from({ length: PIN_LEN }).map((_, i) => (
            <div key={i} className={`pin-dot ${i < entered.length ? (wrong ? "wrong" : "filled") : ""}`}
              style={i < entered.length && !wrong ? { "--pin-pri": th.pri } : {}} />
          ))}
        </div>

        {/* Error */}
        <div className="pin-error">{error}</div>

        {/* Numpad */}
        <div className="pin-grid">
          {KEYS.map(k => (
            <button key={k} className="pin-btn" onClick={() => press(k)}>{k}</button>
          ))}
          {/* bottom row: empty / 0 / del */}
          <div />
          <button className="pin-btn zero" onClick={() => press("0")}>0</button>
          <button className="pin-del" onClick={del}>⌫</button>
        </div>

        <button className="pin-cancel" onClick={onCancel}>← Terug</button>
      </div>
    </div>
  );
}

// ─── FEEST OVERLAY ────────────────────────────────────────────────────────────
function ParentPinOverlay({ expectedPin, onSuccess, onCancel }) {
  const [entered, setEntered] = useState("");
  const [wrong, setWrong] = useState(false);
  const [error, setError] = useState("");
  const PIN_LEN = 6;
  const press = (n) => {
    if (entered.length >= PIN_LEN) return;
    const next = entered + n;
    setEntered(next);
    if (next.length === PIN_LEN) {
      if (next === expectedPin) onSuccess();
      else {
        setWrong(true);
        setError("Onjuiste oudercode");
        setTimeout(() => { setEntered(""); setWrong(false); }, 600);
      }
    }
  };
  const del = () => {
    if (!entered.length) return;
    setEntered(v => v.slice(0, -1));
    setWrong(false);
    setError("");
  };
  const KEYS = ["1","2","3","4","5","6","7","8","9"];
  return (
    <div className="pin-overlay" onClick={onCancel}>
      <div className="pin-card" style={{ "--pin-pri": "#6c63ff", "--pin-l": "#ede9fe" }} onClick={e => e.stopPropagation()}>
        <span className="pin-avatar">🔑</span>
        <div className="pin-title" style={{ color: "#6c63ff" }}>Ouder login</div>
        <div className="pin-sub">Voer de 6-cijferige oudercode in</div>
        <div className="pin-dots">
          {Array.from({ length: PIN_LEN }).map((_, i) => (
            <div key={i} className={`pin-dot ${i < entered.length ? (wrong ? "wrong" : "filled") : ""}`} style={i < entered.length && !wrong ? { "--pin-pri": "#6c63ff" } : {}} />
          ))}
        </div>
        <div className="pin-error">{error}</div>
        <div className="pin-grid">
          {KEYS.map(k => <button key={k} className="pin-btn" onClick={() => press(k)}>{k}</button>)}
          <button className="pin-btn zero" onClick={() => press("0")}>0</button>
          <button className="pin-del" onClick={del}>⌫</button>
        </div>
        <button className="pin-cancel" onClick={onCancel}>← Terug</button>
      </div>
    </div>
  );
}

const CONFETTI_COLORS = ["#6c63ff","#f59e0b","#10b981","#ef4444","#ec4899","#3b82f6","#fff","#ffd700"];
const FEEST_MESSAGES = [
  { emoji:"🏆🎉🏆", title:"Alle taken klaar!", sub:"Wat een held! Je bent geweldig! 🌟" },
  { emoji:"🎊⭐🎊", title:"Yes! Gedaan!", sub:"Jij bent de beste! 🥇" },
  { emoji:"🚀🌟🚀", title:"Superprestatie!", sub:"Alle taken afgevinkt! Trots op jou! 💪" },
  { emoji:"👑🎈👑", title:"Kampioen van de dag!", sub:"Alle taken zijn klaar! Wauw! ✨" },
];

function FeestOverlay({ childName, onClose }) {
  const msg = FEEST_MESSAGES[Math.floor(Math.random() * FEEST_MESSAGES.length)];
  const pieces = Array.from({ length: 60 }, (_, i) => ({
    id: i,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    left: Math.random() * 100,
    dur:  1.8 + Math.random() * 1.4,
    delay: Math.random() * 0.8,
    x: (Math.random() - 0.5) * 300,
    rot: Math.random() * 720 - 360,
    wide: Math.random() > 0.5,
  }));

  // auto-close after 4s
  useEffect(() => {
    const t = setTimeout(onClose, 4200);
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      <div className="feest-confetti">
        {pieces.map(p => (
          <div key={p.id} className="confetti-piece" style={{
            left: `${p.left}%`,
            background: p.color,
            width: p.wide ? 14 : 8,
            borderRadius: p.wide ? "50%" : 3,
            "--cf-dur":   `${p.dur}s`,
            "--cf-delay": `${p.delay}s`,
            "--cf-x":     `${p.x}px`,
            "--cf-rot":   `${p.rot}deg`,
          }} />
        ))}
      </div>
      <div className="feest-overlay" onClick={onClose}>
        <div className="feest-backdrop" />
        <div className="feest-card" onClick={e => e.stopPropagation()}>
          <div className="feest-emoji-row">{msg.emoji}</div>
          <div className="feest-title">{msg.title}</div>
          <div className="feest-sub">{childName}, {msg.sub}</div>
          <button className="btn bp" style={{ fontSize:15, padding:"10px 28px", marginTop:4 }} onClick={onClose}>
            🎉 Bedankt!
          </button>
        </div>
      </div>
    </>
  );
}

function LevelUpOverlay({ event, onClose }) {
  if (!event) return null;
  const style = event.style === "magical"
    ? {
        bg: "linear-gradient(135deg,#ff7ac8 0%,#ffa8e8 35%,#c084fc 100%)",
        glow: "0 0 0 8px rgba(255,255,255,.18), 0 24px 80px rgba(255,122,200,.45)",
        accent: "#fff7fb",
        title: "✨ LEVEL UP! ✨",
        button: "linear-gradient(135deg,#ec4899 0%,#c026d3 100%)",
        deco: ["✨","🦄","🌈","💖","⭐","🪄"],
      }
    : {
        bg: "linear-gradient(135deg,#0f172a 0%,#1d4ed8 45%,#22c55e 100%)",
        glow: "0 0 0 8px rgba(255,255,255,.12), 0 24px 80px rgba(37,99,235,.5)",
        accent: "#eff6ff",
        title: "🚀 LEVEL UP! 🚀",
        button: "linear-gradient(135deg,#2563eb 0%,#0ea5e9 100%)",
        deco: ["⚡","🎮","🏆","🛡️","💥","🚀"],
      };

  const pieces = Array.from({ length: 70 }, (_, i) => ({
    id: i,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    left: Math.random() * 100,
    dur:  1.8 + Math.random() * 1.4,
    delay: Math.random() * 0.8,
    x: (Math.random() - 0.5) * 320,
    rot: Math.random() * 720 - 360,
    wide: Math.random() > 0.5,
  }));

  return (
    <>
      <div className="feest-confetti">
        {pieces.map(p => (
          <div key={p.id} className="confetti-piece" style={{
            left: `${p.left}%`,
            background: p.color,
            width: p.wide ? 14 : 8,
            borderRadius: p.wide ? "50%" : 3,
            "--cf-dur": `${p.dur}s`,
            "--cf-delay": `${p.delay}s`,
            "--cf-x": `${p.x}px`,
            "--cf-rot": `${p.rot}deg`,
          }} />
        ))}
      </div>
      <div className="feest-overlay">
        <div className="feest-backdrop" />
        <div className="feest-card" onClick={e => e.stopPropagation()} style={{
          maxWidth: 520,
          width: "min(92vw, 520px)",
          padding: "22px 20px 24px",
          background: style.bg,
          color: "white",
          boxShadow: style.glow,
          border: "2px solid rgba(255,255,255,.22)",
          overflow: "hidden",
        }}>
          <div style={{ position:"absolute", inset:0, pointerEvents:"none", opacity:.16, fontSize:36, display:"grid", gridTemplateColumns:"repeat(3,1fr)", padding:18 }}>
            {style.deco.map((d, i) => <div key={i} style={{ textAlign: i % 3 === 1 ? "center" : i % 3 === 2 ? "right" : "left" }}>{d}</div>)}
          </div>
          <div style={{ position:"relative" }}>
            <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 1.2, opacity: .95 }}>{style.title}</div>
            <div style={{ display:"flex", justifyContent:"center", margin:"16px 0 10px" }}>
              <div style={{
                width: 148, height: 148, borderRadius: "50%",
                background: "radial-gradient(circle at 30% 30%, rgba(255,255,255,.95), rgba(255,255,255,.2) 42%, rgba(255,255,255,.08) 100%)",
                border: "5px solid rgba(255,255,255,.35)",
                display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
                boxShadow: "inset 0 0 30px rgba(255,255,255,.35), 0 18px 38px rgba(0,0,0,.22)",
                animation: "levelPulse 1.6s ease-in-out infinite",
              }}>
                <div style={{ fontSize: 18, fontWeight: 900, color: event.style === "magical" ? "#be185d" : "#1d4ed8", textTransform:"uppercase" }}>Level</div>
                <div style={{ fontSize: 56, fontWeight: 900, lineHeight: 1, color: event.style === "magical" ? "#be185d" : "#0f172a" }}>{event.level}</div>
              </div>
            </div>
            <div style={{ fontSize: 34, fontWeight: 900, lineHeight: 1.05, marginTop: 4 }}>{event.childName}</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: style.accent, marginTop: 8 }}>{event.name}</div>
            <div style={{ fontSize: 15, opacity: .95, marginTop: 12 }}>Je hebt nu <strong>{event.lifetimeCoins}</strong> lifetime coins verdiend.</div>
            <div style={{ fontSize: 13, opacity: .92, marginTop: 8 }}>{event.isMax ? "🏁 Max level bereikt!" : `Nog ${event.remaining} coins tot level ${event.nextLevel} — ${event.nextName}`}</div>
            <button className="btn bp" style={{
              marginTop: 18,
              minWidth: 190,
              background: style.button,
              color: "#fff",
              border: "none",
              boxShadow: "0 10px 24px rgba(0,0,0,.24)",
            }} onClick={onClose}>
              {event.style === "magical" ? "Yay! Verder ✨" : "Gaaf! Verder 🚀"}
            </button>
          </div>
        </div>
      </div>
      <style>{`@keyframes levelPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }`} </style>
    </>
  );
}

// ─── APP ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,    setScreen]    = useState("home");
  const [data,      setData]      = useState(INIT);
  const [loading,   setLoading]   = useState(true);
  const [modal,     setModal]     = useState(null);
  const [activeKid, setActiveKid] = useState(null);
  const [tab,       setTab]       = useState("dashboard");
  const [kidTab,    setKidTab]    = useState("tasks");
  const [prevApproved, setPrevApproved] = useState({});
  const [showCoins,    setShowCoins]    = useState(null);
  const activeKidName = data.children.find(c => c.id === activeKid)?.name || "";
  const { playTaskDone, playCoinBurst, playAllDone, playSpend, playDrumroll } = useSound();
  const coinTargetRef = useRef(null);
  const [showFeest, setShowFeest] = useState(false);
  const [levelUpEvent, setLevelUpEvent] = useState(null);
  const [lifetimeCoinsMap, setLifetimeCoinsMap] = useState({});
  const [pinChild,  setPinChild]  = useState(null);
  const [pinParent, setPinParent] = useState(false);
  const [parentPin, setParentPin] = useState(DEFAULT_PARENT_PIN);

  useEffect(() => {
    saveLifetimeCoins(lifetimeCoinsMap);
  }, [lifetimeCoinsMap]);

  const getLifetimeCoinsForChild = useCallback((childOrId) => {
    const child = typeof childOrId === "string" ? data.children.find(c => c.id === childOrId) : childOrId;
    return getChildLifetimeCoinsValue(child, lifetimeCoinsMap);
  }, [data.children, lifetimeCoinsMap]);

  const awardCoinsToChild = useCallback(async (childId, earnedCoins) => {
    const child = data.children.find(c => c.id === childId);
    const safeEarned = Math.max(0, Number(earnedCoins || 0));
    if (!child || safeEarned <= 0) return;
    const currentLifetime = getLifetimeCoinsForChild(child);
    const nextLifetime = currentLifetime + safeEarned;
    const oldLevel = getLevelInfo(currentLifetime);
    const newLevel = getLevelInfo(nextLifetime);
    await dbUpdateChildCoins(child.id, Number(child.coins || 0) + safeEarned);
    const nextLifetimeMap = { ...lifetimeCoinsMap, [child.id]: nextLifetime };
    setLifetimeCoinsMap(nextLifetimeMap);
    saveLifetimeCoins(nextLifetimeMap);
    await saveCloudSettingsToCloud({ parentPin, lifetimeCoinsMap: nextLifetimeMap }).catch(err => console.error("saveLifetimeCoinsToCloud:", err));
    if (newLevel.level > oldLevel.level) {
      setLevelUpEvent({
        childId: child.id,
        childName: child.name,
        level: newLevel.level,
        name: newLevel.name,
        nextLevel: newLevel.nextLevel,
        nextName: newLevel.nextName,
        remaining: newLevel.remaining,
        isMax: newLevel.isMax,
        lifetimeCoins: nextLifetime,
        style: isNevahChild(child) ? "magical" : "game",
      });
    }
  }, [data.children, getLifetimeCoinsForChild, lifetimeCoinsMap, parentPin]);

  // ── Laad data uit Supabase bij opstarten ──
  useEffect(() => {
    Promise.allSettled([loadAll(), fetchCloudSettings()])
      .then(([dataRes, settingsRes]) => {
        if (dataRes.status === "fulfilled") setData(stripCloudSettingsFromData(dataRes.value));
        else console.error("Laad fout:", dataRes.reason);
        const localLifetime = loadLifetimeCoins();
        if (settingsRes.status === "fulfilled") {
          const cloudSettings = settingsRes.value || {};
          if (/^\d{6}$/.test(cloudSettings.parentPin || "")) {
            setParentPin(cloudSettings.parentPin);
            setStoredParentPin(cloudSettings.parentPin);
          } else {
            setParentPin(getStoredParentPin());
          }
          setLifetimeCoinsMap(cloudSettings.lifetimeCoinsMap && Object.keys(cloudSettings.lifetimeCoinsMap).length > 0 ? cloudSettings.lifetimeCoinsMap : localLifetime);
        } else {
          setParentPin(getStoredParentPin());
          setLifetimeCoinsMap(localLifetime);
        }
        setLoading(false);
      })
      .catch(err => { console.error("Laad fout:", err); setParentPin(getStoredParentPin()); setLoading(false); });
  }, []);

  // ── Helper: herlaad alle data na een wijziging ──
  const reload = useCallback(() => Promise.allSettled([loadAll(), fetchCloudSettings()])
    .then(([dataRes, settingsRes]) => {
      if (dataRes.status === "fulfilled") setData(stripCloudSettingsFromData(dataRes.value));
      else console.error(dataRes.reason);
      if (settingsRes.status === "fulfilled") {
        const cloudSettings = settingsRes.value || {};
        if (/^\d{6}$/.test(cloudSettings.parentPin || "")) {
          setParentPin(cloudSettings.parentPin);
          setStoredParentPin(cloudSettings.parentPin);
        }
        if (cloudSettings.lifetimeCoinsMap && typeof cloudSettings.lifetimeCoinsMap === "object") {
          setLifetimeCoinsMap(cloudSettings.lifetimeCoinsMap);
          saveLifetimeCoins(cloudSettings.lifetimeCoinsMap);
        }
      }
    })
    .catch(console.error), []);

  const processRecurringTemplates = useCallback(async () => {
    if (loading || !data.tasks?.length) return;

    const referenceDate = getTodayISO();
    const templateTasks = data.tasks.filter((task) => isRecurringTemplateTask(task) && getRecurringType(task) !== "none");
    if (!templateTasks.length) return;

    const inserts = [];
    const plannedKeys = new Set();

    for (const templateTask of templateTasks) {
      const occurrenceDate = getRecurringOccurrenceDate(templateTask, referenceDate);
      if (!occurrenceDate) continue;

      const templateInfo = parseTaskDesc(templateTask.desc, templateTask.coins);
      const occurrenceKey = [templateTask.childId, templateTask.id, occurrenceDate].join("__");
      const exists = data.tasks.some((task) => {
        if (isRecurringTemplateTask(task)) return false;
        if (task.childId !== templateTask.childId || task.date !== occurrenceDate) return false;
        const info = parseTaskDesc(task.desc, task.coins);
        return info.recurrenceSourceId === templateTask.id;
      });

      if (exists || plannedKeys.has(occurrenceKey)) continue;
      plannedKeys.add(occurrenceKey);

      inserts.push({
        id: genId(),
        ...buildTaskPayloadFromMeta(templateTask, {
          recurrenceType: "none",
          isTemplate: false,
          recurrenceSourceId: templateTask.id,
          doneOn: null,
          approvedOn: null,
          lockedCoins: null,
          durationDays: templateInfo.recurrenceType === "daily" ? 1 : templateInfo.durationDays,
          dayPart: templateInfo.recurrenceType === "weekly" ? "weekly" : templateInfo.dayPart,
        }, {
          status: "pending",
          date: occurrenceDate,
          coins: templateInfo.maxCoins,
        }),
      });
    }

    if (!inserts.length) return;

    for (const task of inserts) {
      await dbAddTask(task);
    }
    reload();
  }, [data.tasks, loading, reload]);

  // ── Verwerk gemiste taken: coins vervallen op basis van max coins ÷ duur ──
  const processMissedTasks = useCallback(async () => {
    if (loading || !data.tasks?.length) return;

    let changed = false;
    const referenceDate = getTodayISO();

    for (const task of data.tasks) {
      if (task.status !== "pending" || isRecurringTemplateTask(task) || !task.date || task.date >= referenceDate) continue;

      const nextCoins = getTaskRemainingCoins(task, referenceDate);

      if (nextCoins <= 0) {
        await dbDelTask(task.id);
        changed = true;
        continue;
      }

      if (nextCoins !== Number(task.coins || 0)) {
        const { error } = await supabase.from("tasks").update({ coins: nextCoins }).eq("id", task.id);
        if (error) throw error;
        changed = true;
      }
    }

    if (changed) reload();
  }, [data.tasks, loading, reload]);

  const cleanupOldCompletedTasks = useCallback(async () => {
    if (loading || !data.tasks?.length) return;

    const oldCompleted = data.tasks.filter(
      (task) => (task.status === "done" || task.status === "approved") && isTaskOlderThanHistoryWindow(task, getTodayISO())
    );

    if (!oldCompleted.length) return;

    for (const task of oldCompleted) {
      await dbDelTask(task.id);
    }

    reload();
  }, [data.tasks, loading, reload]);

  // ── Maak waar nodig losse taken aan uit terugkerende sjablonen ──
  useEffect(() => {
    if (!loading) processRecurringTemplates().catch(err => console.error('Terugkerende taken genereren mislukt:', err));
  }, [loading, data.tasks, processRecurringTemplates]);

  // ── Realtime: luister naar wijzigingen in de database ──
  // Zodra een ander apparaat iets wijzigt, wordt de data hier automatisch bijgewerkt
  useEffect(() => {
    if (!loading) processMissedTasks().catch(err => console.error("Gemiste taken verwerken mislukt:", err));
  }, [loading, data.tasks, processMissedTasks]);

  useEffect(() => {
    if (!loading) cleanupOldCompletedTasks().catch(err => console.error("Opschonen oude afgeronde taken mislukt:", err));
  }, [loading, data.tasks, cleanupOldCompletedTasks]);

  const cleanupOrphanedRecurringTasks = useCallback(async () => {
    if (loading || !data.tasks?.length) return;

    const templateIds = new Set(
      data.tasks
        .filter(task => isRecurringTemplateTask(task) && getRecurringType(task) !== "none")
        .map(task => task.id)
    );

    const orphaned = data.tasks.filter(task => {
      if (isRecurringTemplateTask(task)) return false;
      const info = parseTaskDesc(task.desc, task.coins);
      return !!info.recurrenceSourceId && !templateIds.has(info.recurrenceSourceId);
    });

    if (!orphaned.length) return;

    for (const task of orphaned) {
      await dbDelTask(task.id);
    }

    reload();
  }, [data.tasks, loading, reload]);

  useEffect(() => {
    if (!loading) cleanupOrphanedRecurringTasks().catch(err => console.error("Opschonen losse taken zonder sjabloon mislukt:", err));
  }, [loading, data.tasks, cleanupOrphanedRecurringTasks]);


  useEffect(() => {
    const channel = supabase
      .channel('familyplanner-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'children' },    () => reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' },       () => reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rewards' },     () => reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'redemptions' }, () => reload())
      .subscribe();

    const onVisible = () => {
      if (document.visibilityState === 'visible') reload();
    };
    const onFocus = () => reload();
    const onPageShow = () => reload();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, 8000);

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      supabase.removeChannel(channel);
    };
  }, [reload]);

  const db = {
    addChild: async (c) => {
      const id = genId();
      await dbAddChild({ id, coins: 0, ...c });
      const nextLifetimeMap = { ...lifetimeCoinsMap, [id]: 0 };
      setLifetimeCoinsMap(nextLifetimeMap);
      saveLifetimeCoins(nextLifetimeMap);
      await saveCloudSettingsToCloud({ parentPin, lifetimeCoinsMap: nextLifetimeMap }).catch(err => console.error("saveLifetimeCoinsToCloud:", err));
      reload();
    },
    updateChildPin: async (id, pin) => {
      await supabase.from("children").update({ pin }).eq("id", id);
      reload();
    },
    setChildCoins: async (id, coins) => {
      await dbUpdateChildCoins(id, Math.max(0, Number(coins) || 0));
      reload();
    },
    takeCoins: async (id, amount, reason) => {
      const child = data.children.find(c => c.id === id);
      const wanted = Math.max(0, Number(amount) || 0);
      if (!child || wanted <= 0) return;
      const actual = Math.min(child.coins || 0, wanted);
      if (actual <= 0) return;
      const cleanReason = String(reason || "").trim() || "Geen reden opgegeven";
      await dbUpdateChildCoins(id, Math.max(0, (child.coins || 0) - actual));
      await supabase.from('redemptions').insert({
        id: genId(),
        child_id: id,
        reward_id: `penalty:${genId()}`,
        reward_title: `Ecoins afgepakt — ${cleanReason}`,
        reward_emoji: '⚠️',
        cost: -actual,
        date: getTodayISO(),
        status: 'approved'
      });
      reload();
    },
    resetAllCoins: async () => {
      await Promise.all(data.children.map(c => dbUpdateChildCoins(c.id, 0)));
      reload();
    },
    updateParentPin: async (pin) => {
      if (!/^\d{6}$/.test(pin || "")) return;
      await saveCloudSettingsToCloud({ parentPin: pin, lifetimeCoinsMap });
      setStoredParentPin(pin);
      setParentPin(pin);
      reload();
    },
    delChild: async (id) => {
      await dbDelChild(id);
      setLifetimeCoinsMap(prev => { const next = { ...prev }; delete next[id]; return next; });
      reload();
    },
    addTask: async (t) => {
      const id = genId();
      await dbAddTask({ id, status: t.status || 'pending', ...t });
      reload();
    },
    delTask: async (id) => {
      const task = data.tasks.find(t => t.id === id);
      if (!task) return;

      const info = parseTaskDesc(task.desc, task.coins);
      if (isRecurringTemplateTask(task)) {
        const generatedChildren = data.tasks.filter(t => {
          if (t.id === id || isRecurringTemplateTask(t)) return false;
          const childInfo = parseTaskDesc(t.desc, t.coins);
          return childInfo.recurrenceSourceId === id;
        });
        for (const childTask of generatedChildren) {
          await dbDelTask(childTask.id);
        }
      }

      await dbDelTask(id);
      reload();
    },
    markDone: async (id) => {
      const task = data.tasks.find(t => t.id === id);
      if (!task) return;
      const todayNow = getTodayISO();
      const taskInfo = parseTaskDesc(task.desc, task.coins);
      const earnedCoins = Math.max(0, getTaskRemainingCoins(task, todayNow));
      if (earnedCoins <= 0) {
        await dbDelTask(id);
        reload();
        return;
      }

      const child = data.children.find(c => c.id === task.childId);
      if (!taskInfo.requiresParentApproval) {
        const description = updateTaskDescMeta(task.desc, task.coins, { doneOn: todayNow, approvedOn: todayNow, lockedCoins: earnedCoins });
        await supabase.from('tasks').update({ status: 'approved', description, coins: earnedCoins }).eq('id', id);
        if (child) await awardCoinsToChild(child.id, earnedCoins);
      } else {
        const description = updateTaskDescMeta(task.desc, task.coins, { doneOn: todayNow, approvedOn: null, lockedCoins: earnedCoins });
        await supabase.from('tasks').update({ status: 'done', description, coins: earnedCoins }).eq('id', id);
      }
      reload();
    },
    approve: async (id) => {
      const task = data.tasks.find(t => t.id === id);
      if (!task) return;
      const approvedCoins = Math.max(0, Number(task.coins || 0));
      const description = updateTaskDescMeta(task.desc, task.coins, { approvedOn: getTodayISO(), lockedCoins: approvedCoins });
      await supabase.from('tasks').update({ status: 'approved', description, coins: approvedCoins }).eq('id', id);
      const child = data.children.find(c => c.id === task.childId);
      if (child) await awardCoinsToChild(child.id, approvedCoins);
      reload();
    },
    reject: async (id) => {
      const task = data.tasks.find(t => t.id === id);
      if (!task) return;
      const currentCoins = Math.max(0, getTaskRemainingCoins(task, getTodayISO()));
      const description = updateTaskDescMeta(task.desc, task.coins, { doneOn: null, approvedOn: null, lockedCoins: null });
      await supabase.from('tasks').update({ status: 'pending', description, coins: currentCoins || task.coins }).eq('id', id);
      reload();
    },
    addReward: async (r) => {
      const id = genId();
      await dbAddReward({ id, ...r });
      reload();
    },
    delReward: async (id) => {
      await dbDelReward(id);
      reload();
    },
    redeem: async (childId, rewardId) => {
      const r = data.rewards.find(x => x.id === rewardId);
      const c = data.children.find(x => x.id === childId);
      if (!r || !c) return;
      if (!rewardVisibleForChild(r, childId)) return;
      const reserved = data.redemptions
        .filter(x => x.childId === childId && x.status === 'pending')
        .reduce((s, x) => s + x.cost, 0);
      if (c.coins - reserved < r.cost) return;
      const id = genId();
      await dbAddRedemption({ id, childId, rewardId, rewardTitle: r.title, rewardEmoji: r.emoji, cost: r.cost, date: today });
      reload();
    },
    approveRedemption: async (id) => {
      const red = data.redemptions.find(r => r.id === id);
      if (!red) return;
      const child = data.children.find(c => c.id === red.childId);
      if (child) await dbUpdateChildCoins(child.id, child.coins - red.cost);
      await dbUpdateRedemptionStatus(id, 'approved');
      reload();
    },
    rejectRedemption: async (id) => {
      await dbUpdateRedemptionStatus(id, 'rejected');
      reload();
    },
  };

  // When a child opens their screen, show PIN first if set
  const openChildScreen = (id) => {
    const child = data.children.find(c => c.id === id);
    if (child?.pin) {
      setPinChild(id);
      return;
    }
    enterChildScreen(id);
  };

  const enterChildScreen = (id) => {
    const currentApproved = data.tasks.filter(t => t.childId === id && t.status === "approved" && shouldKeepCompletedVisible(t, getTodayISO())).map(t => t.id);
    const prev = prevApproved[id] || [];
    const newlyApproved = currentApproved.filter(tid => !prev.includes(tid));
    const newCoins = newlyApproved.reduce((sum, tid) => {
      const t = data.tasks.find(x => x.id === tid);
      return sum + (t ? t.coins : 0);
    }, 0);
    setPrevApproved(p => ({ ...p, [id]: currentApproved }));
    setActiveKid(id);
    setKidTab("tasks");
    setScreen("child");
    if (newCoins > 0) {
      setTimeout(() => {
        playCoinBurst(Math.min(newCoins, 8));
        setShowCoins({ childId: id, amount: newCoins });
      }, 400);
    }
  };

  const goHome = () => { setScreen("home"); setActiveKid(null); };

  if (loading) return (
    <>
      <style>{CSS}</style>
      <div style={{ minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"linear-gradient(160deg,#f0f4ff 0%,#e8e4ff 100%)", gap:20 }}>
        <div style={{ fontSize:64 }}>🌟</div>
        <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:24, fontWeight:800, color:"#6c63ff" }}>GezinsPlanner</div>
        <div style={{ fontSize:14, color:"#6b7280", fontWeight:600 }}>Even laden...</div>
        <div style={{ width:48, height:48, border:"4px solid #e8e4ff", borderTopColor:"#6c63ff", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </>
  );

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        {screen === "home" && (
          <HomeScreen data={data} onSelectKid={openChildScreen} onParent={() => setPinParent(true)} playDrumroll={playDrumroll} getLifetimeCoinsForChild={getLifetimeCoinsForChild} />
        )}

        {screen === "child" && (
          <>
            <header className="hdr">
              <div className="logo">🌟 GezinsPlanner</div>
              <button className="back-btn" onClick={goHome}>← Terug</button>
            </header>
            <main className="main">
              <ChildView
                data={data} db={db} activeKid={activeKid}
                kidTab={kidTab} setKidTab={setKidTab}
                playTaskDone={playTaskDone}
                playAllDone={playAllDone}
                playSpend={playSpend}
                onAllDone={() => { setShowFeest(true); }}
                coinTargetRef={coinTargetRef}
                getLifetimeCoinsForChild={getLifetimeCoinsForChild}
              />
            </main>
          </>
        )}

        {screen === "parent" && (
          <>
            <header className="hdr">
              <div className="logo">🌟 GezinsPlanner</div>
              <button className="back-btn" onClick={goHome}>← Terug</button>
            </header>
            <main className="main">
              <ParentView data={data} db={db} tab={tab} setTab={setTab} setModal={setModal} parentPin={parentPin} />
            </main>
          </>
        )}

        {/* Flying coins animation when returning to child screen with new approved coins */}
        {showCoins && (
          <FlyingCoins
            coins={showCoins.amount}
            targetRef={coinTargetRef}
            onDone={() => setShowCoins(null)}
          />
        )}

        {showFeest && (
          <FeestOverlay
            childName={activeKidName}
            onClose={() => setShowFeest(false)}
          />
        )}

        {levelUpEvent && (
          <LevelUpOverlay
            event={levelUpEvent}
            onClose={() => setLevelUpEvent(null)}
          />
        )}

        {modal && <Modal modal={modal} setModal={setModal} data={data} db={db} />}

        {pinChild && (() => {
          const child = data.children.find(c => c.id === pinChild);
          const th = getChildTheme(child);
          return (
            <PinScreen
              child={child}
              theme={th}
              onSuccess={() => { setPinChild(null); enterChildScreen(pinChild); }}
              onCancel={() => setPinChild(null)}
            />
          );
        })()}

        {pinParent && (
          <ParentPinOverlay
            expectedPin={parentPin}
            onSuccess={() => { setPinParent(false); setScreen("parent"); }}
            onCancel={() => setPinParent(false)}
          />
        )}
      </div>
    </>
  );
}

// ─── THERMOMETER ───────────────────────────────────────────────────────────────
function Thermometer({ children, onReveal, onReset, playDrumroll }) {
  if (children.length < 2) return null;
  const [a, b] = children;
  const thA = getChildTheme(a);
  const thB = getChildTheme(b);

  const [revealed,   setRevealed]   = useState(false);
  const [progress,   setProgress]   = useState(0);
  const [showWinner, setShowWinner] = useState(false);
  const rafRef = useRef(null);

  // SVG afmetingen
  const SVG_W   = 500;
  const TUBE_H  = 26;
  const AXIS_H  = 40;
  const PAD     = 4;
  const TUBE_L  = SVG_W - PAD * 2;

  const yA      = 0;
  const yAxis   = yA + TUBE_H + 4;
  const yB      = yAxis + AXIS_H;
  const SVG_H   = yB + TUBE_H + 4;
  const yTickMid = yAxis + AXIS_H / 2;

  // Schaal = totaal coins samen
  const totalCoins = a.coins + b.coins || 1;
  const topVal     = Math.ceil(totalCoins / 10) * 10 || 10;
  const ticks      = [0, topVal*0.25, topVal*0.5, topVal*0.75, topVal].map(Math.round);

  // Doelwaardes (pixels)
  const fillA = (a.coins / topVal) * TUBE_L;
  const fillB = (b.coins / topVal) * TUBE_L;

  const balanced = a.coins === b.coins;

  // Beide balken lopen SAMEN op tot het minimum van de twee.
  // Pas daarna loopt de grotere balk door — zodat het verschil pas zichtbaar wordt
  // op het moment dat het er ook echt is.
  const minCoins  = Math.min(a.coins, b.coins);
  const maxCoins  = Math.max(a.coins, b.coins);
  const minFill   = (minCoins / topVal) * TUBE_L;
  const maxFill   = (maxCoins / topVal) * TUBE_L;

  // Fase 1: beide lopen samen op (0 → minFill). Duurt progress 0 → splitPoint.
  // Fase 2: de grotere loopt door (minFill → maxFill). Duurt progress splitPoint → 1.
  const splitPoint = maxCoins > 0 ? minCoins / maxCoins : 1; // breekpunt in progress

  const calcFill = (targetFill) => {
    if (progress <= splitPoint) {
      // Beide gaan gelijk op naar minFill
      return splitPoint > 0 ? (progress / splitPoint) * minFill : 0;
    } else {
      // Na breekpunt: minFill-balk blijft, maxFill-balk loopt door
      const phaseT = (progress - splitPoint) / (1 - splitPoint || 1);
      if (targetFill === minFill) return minFill;
      return minFill + phaseT * (maxFill - minFill);
    }
  };

  const animFillA  = calcFill(fillA);
  const animFillB  = calcFill(fillB);
  const liveCoinsA = Math.round(a.coins * progress);
  const liveCoinsB = Math.round(b.coins * progress);
  const liveLeader = liveCoinsA > liveCoinsB ? a : liveCoinsA < liveCoinsB ? b : null;

  const handleReveal = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setRevealed(true);
    setProgress(0);
    setShowWinner(false);
    if (playDrumroll) playDrumroll(3000);
    const DURATION = 3000;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min((now - start) / DURATION, 1);
      // Lineair — geen easing, zodat beide balken echt gelijkmatig oplopen
      setProgress(t);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        setShowWinner(true);
        if (onReveal) onReveal();
      }
    };
    rafRef.current = requestAnimationFrame(step);
  };

  const handleReset = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setRevealed(false);
    setProgress(0);
    setShowWinner(false);
    if (onReset) onReset();
  };

  return (
    <div style={{
      background: "linear-gradient(145deg,rgba(255,255,255,.95) 0%,rgba(248,246,255,.98) 100%)",
      backdropFilter: "blur(20px)",
      borderRadius: 32,
      border: "1.5px solid rgba(255,255,255,1)",
      boxShadow: "0 20px 60px rgba(108,99,255,.12),0 4px 16px rgba(0,0,0,.06),inset 0 1px 0 rgba(255,255,255,.8)",
      padding: "20px 20px 18px",
      marginBottom: 28,
      width: "100%",
      maxWidth: 520,
      animation: "popIn .5s .2s cubic-bezier(.34,1.56,.64,1) both",
      position: "relative",
      overflow: "hidden",
      textAlign: "center",
    }}>

      {/* Shimmer */}
      <div style={{ position:"absolute", inset:0, pointerEvents:"none",
        background:"radial-gradient(ellipse at 10% 50%,rgba(217,70,168,.05) 0%,transparent 55%),radial-gradient(ellipse at 90% 50%,rgba(37,99,235,.05) 0%,transparent 55%)" }} />

      {/* Titel */}
      <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:15, fontWeight:800, color:"#475569", marginBottom:14,
        display:"flex", alignItems:"center", justifyContent:"center", gap:7 }}>
        <span>🌡️</span> Wie staat er voor?
      </div>

      {/* Naamkaartjes */}
      <div style={{ display:"flex", gap:10, marginBottom:14, position:"relative", zIndex:1 }}>
        <div style={{ flex:1, display:"flex", alignItems:"center", gap:10,
          background:thA.pri+"16", borderRadius:16, padding:"10px 14px",
          border:`2px solid ${thA.pri}35`, boxShadow:`0 4px 14px ${thA.pri}20` }}>
          <div style={{ fontSize:28 }}>{getChildAvatar(a)}</div>
          <div>
            <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:14, fontWeight:800, color:thA.pri }}>{a.name}</div>
            <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:22, fontWeight:900, color:thA.pri, lineHeight:1,
              filter: showWinner ? "none" : "blur(8px)", transition:"filter .5s ease",
              userSelect:"none" }}>
              {a.coins} <span style={{ fontSize:12, opacity:.7 }}>🪙</span>
            </div>
          </div>
        </div>
        <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"flex-end", gap:10,
          background:thB.pri+"16", borderRadius:16, padding:"10px 14px",
          border:`2px solid ${thB.pri}35`, boxShadow:`0 4px 14px ${thB.pri}20`,
          flexDirection:"row-reverse" }}>
          <div style={{ fontSize:28 }}>{getChildAvatar(b)}</div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:14, fontWeight:800, color:thB.pri }}>{b.name}</div>
            <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:22, fontWeight:900, color:thB.pri, lineHeight:1,
              filter: showWinner ? "none" : "blur(8px)", transition:"filter .5s ease",
              userSelect:"none" }}>
              {b.coins} <span style={{ fontSize:12, opacity:.7 }}>🪙</span>
            </div>
          </div>
        </div>
      </div>

      {/* SVG: balk A — schaal — balk B */}
      <svg width="100%" viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        style={{ display:"block", overflow:"visible", position:"relative", zIndex:1 }}>
        <defs>
          <linearGradient id="tFillA" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={thA.pri} stopOpacity=".85" />
            <stop offset="100%" stopColor={thA.pri} stopOpacity="1" />
          </linearGradient>
          <linearGradient id="tFillB" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={thB.pri} stopOpacity=".85" />
            <stop offset="100%" stopColor={thB.pri} stopOpacity="1" />
          </linearGradient>
          <linearGradient id="tGlass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,.28)" />
            <stop offset="60%" stopColor="rgba(255,255,255,.04)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
          <clipPath id="tClipA">
            <rect x={PAD} y={yA} width={TUBE_L} height={TUBE_H} rx={TUBE_H/2} />
          </clipPath>
          <clipPath id="tClipB">
            <rect x={PAD} y={yB} width={TUBE_L} height={TUBE_H} rx={TUBE_H/2} />
          </clipPath>
        </defs>

        {/* ── BALK A (boven schaal) ── */}
        <rect x={PAD} y={yA} width={TUBE_L} height={TUBE_H} rx={TUBE_H/2}
          fill={thA.pri+"14"} stroke={thA.pri+"30"} strokeWidth={1.5} />
        <rect x={PAD} y={yA} width={revealed ? animFillA : 0} height={TUBE_H}
          fill="url(#tFillA)" clipPath="url(#tClipA)" />        <rect x={PAD} y={yA} width={TUBE_L} height={TUBE_H} rx={TUBE_H/2}
          fill="url(#tGlass)" pointerEvents="none" />
        <rect x={PAD} y={yA} width={TUBE_L} height={TUBE_H} rx={TUBE_H/2}
          fill="none" stroke="rgba(255,255,255,.5)" strokeWidth={1.5} />

        {/* ── SCHAAL in het midden ── */}
        {/* Horizontale as-lijn */}
        <line x1={PAD} y1={yTickMid} x2={PAD+TUBE_L} y2={yTickMid}
          stroke="#e2e8f0" strokeWidth={1.5} />
        {ticks.map((val) => {
          const x      = PAD + (val / topVal) * TUBE_L;
          const isMid  = val === ticks[2];
          const tickH  = isMid ? 10 : 6;
          return (
            <g key={val}>
              {/* Tick strekt zowel omhoog als omlaag vanuit de as */}
              <line x1={x} y1={yTickMid - tickH/2} x2={x} y2={yTickMid + tickH/2}
                stroke={isMid ? "#64748b" : "#94a3b8"}
                strokeWidth={isMid ? 2 : 1} strokeLinecap="round" />
              <text x={x} y={yTickMid + 1}
                textAnchor="middle" dominantBaseline="middle"
                fontSize={isMid ? 14 : 12} fontWeight="800"
                fontFamily="'Baloo 2',cursive"
                fill={isMid ? "#475569" : "#94a3b8"}>
                {val}
              </text>
            </g>
          );
        })}

        {/* ── BALK B (onder schaal) ── */}
        <rect x={PAD} y={yB} width={TUBE_L} height={TUBE_H} rx={TUBE_H/2}
          fill={thB.pri+"14"} stroke={thB.pri+"30"} strokeWidth={1.5} />
        <rect x={PAD} y={yB} width={revealed ? animFillB : 0} height={TUBE_H}
          fill="url(#tFillB)" clipPath="url(#tClipB)" />
        <rect x={PAD} y={yB} width={TUBE_L} height={TUBE_H} rx={TUBE_H/2}
          fill="url(#tGlass)" pointerEvents="none" />
        <rect x={PAD} y={yB} width={TUBE_L} height={TUBE_H} rx={TUBE_H/2}
          fill="none" stroke="rgba(255,255,255,.5)" strokeWidth={1.5} />

      </svg>

      {/* Onthul knop of live leider */}
      <div style={{ marginTop:14, textAlign:"center" }}>
        {!revealed ? (
          <button onClick={handleReveal} style={{
            fontFamily:"'Baloo 2',cursive", fontSize:15, fontWeight:800,
            padding:"11px 28px", borderRadius:50, border:"none", cursor:"pointer",
            background:"linear-gradient(135deg,#f59e0b,#f97316)",
            color:"#fff", boxShadow:"0 6px 20px rgba(245,158,11,.4)",
            display:"inline-flex", alignItems:"center", gap:8,
            transition:"transform .15s, box-shadow .15s",
          }}
          onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow="0 10px 28px rgba(245,158,11,.5)"}}
          onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow="0 6px 20px rgba(245,158,11,.4)"}}>
            🎉 Onthul de score!
          </button>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
            <div style={{
              fontFamily:"'Baloo 2',cursive", fontSize:15, fontWeight:800,
              padding:"9px 22px", borderRadius:50, display:"inline-block",
              transition:"background .3s, color .3s, border-color .3s, transform .3s",
              background: !liveLeader ? "#fef3c733" : (liveLeader===a ? thA.pri+"22" : thB.pri+"22"),
              color: !liveLeader ? "#f59e0b" : (liveLeader===a ? thA.pri : thB.pri),
              border:`2px solid ${!liveLeader ? "#f59e0b55" : (liveLeader===a ? thA.pri+"55" : thB.pri+"55")}`,
              transform: showWinner ? "scale(1.08)" : "scale(1)",
              boxShadow: showWinner ? `0 6px 24px ${!liveLeader ? "#f59e0b33" : (liveLeader===a ? thA.pri+"44" : thB.pri+"44")}` : "none",
            }}>
              {!liveLeader
                ? "🤝 Gelijk!"
                : showWinner
                  ? `🏆 ${liveLeader.name} wint met ${liveLeader===a ? a.coins : b.coins} 🪙!`
                  : `${liveLeader.avatar} ${liveLeader.name} staat voor!`
              }
            </div>
            {showWinner && (
              <button onClick={handleReset} style={{
                background:"none", border:"none", fontSize:12, color:"#94a3b8",
                fontFamily:"'Baloo 2',cursive", fontWeight:700, cursor:"pointer",
              }}>↺ Opnieuw</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


// ─── HOME SCREEN ───────────────────────────────────────────────────────────────
function HomeScreen({ data, onSelectKid, onParent, playDrumroll, getLifetimeCoinsForChild }) {
  const d = new Date();
  const [coinsRevealed, setCoinsRevealed] = useState(false);
  return (
    <div className="home">
      {/* Achtergrond decoratie blobs */}
      <div className="home-bg-deco">
        <div className="home-bg-blob" style={{ width:500, height:500, background:"#d946a8", top:-150, left:-150 }} />
        <div className="home-bg-blob" style={{ width:400, height:400, background:"#2563eb", bottom:-100, right:-100 }} />
        <div className="home-bg-blob" style={{ width:300, height:300, background:"#f59e0b", top:"40%", left:"40%" }} />
      </div>

      {/* Banner */}
      <div className="home-banner">
        <div className="home-logo">🌟 GezinsPlanner</div>
        <div className="home-sub">Jouw dagelijkse takenapp!</div>
        <div className="home-date">
          <span className="home-date-day">{DAGEN[d.getDay()]}</span>
          <span style={{ color:"var(--bor)" }}>·</span>
          <span className="home-date-full">{d.getDate()} {MAANDEN[d.getMonth()]} {d.getFullYear()}</span>
        </div>
      </div>

      <div className="home-label">👇 Tik op jouw naam!</div>

      {/* Kindkaarten */}
      <div className="home-kids">
        {data.children.map(c => {
          const th = getChildTheme(c);
          const homeVisibleTasks = dedupeVisibleTasks(data.tasks.filter(t =>
            t.childId === c.id &&
            !isRecurringTemplateTask(t) &&
            t.date <= today &&
            getTaskRemainingCoins(t, today) > 0 &&
            shouldKeepCompletedVisible(t, today) &&
            (t.status !== "pending" || isTaskVisibleForChildNow(t))
          ));
          const todayDone = homeVisibleTasks.filter(t => t.status !== "pending").length;
          const todayTotal = homeVisibleTasks.length;
          const levelInfo = getLevelInfo(getLifetimeCoinsForChild(c));
          return (
            <div key={c.id} className="home-kid"
              style={{ border: `3px solid ${th.pri}44` }}
              onClick={() => onSelectKid(c.id)}>
              {/* Gekleurde top */}
              <div className="home-kid-top" style={{ background: th.hdr }}>
                <div className="home-kid-av">{getChildAvatar(c)}</div>
                <div className="home-kid-name">{c.name}</div>
                <div className="home-kid-deco">{th.headerDeco.slice(0,4).join("")}</div>
              </div>
              {/* Witte bottom */}
              <div className="home-kid-bottom">
                <div className="home-kid-coins" style={{
                  filter: coinsRevealed ? "none" : "blur(6px)",
                  transition: "filter .5s ease",
                  userSelect: "none",
                }}>🪙 {c.coins} <span style={{ fontSize:14, color:"var(--t2)", fontWeight:700 }}>coins</span></div>
                <div style={{ marginTop: 8, background: "#f8fafc", border: `2px solid ${th.pri}22`, borderRadius: 14, padding: "10px 10px 8px" }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:6 }}>
                    <div style={{ fontWeight:900, color: th.priD, fontSize: 14 }}>🏅 Level {levelInfo.level} — {levelInfo.name}</div>
                    <div style={{ fontSize: 11, color: "var(--t2)", fontWeight: 800 }}>{levelInfo.coins} lifetime</div>
                  </div>
                  <div className="pb" style={{ height: 10, background: `${th.pri}22`, marginBottom: 5 }}>
                    <div className="pf" style={{ width: `${Math.round(levelInfo.progress * 100)}%`, background: th.hdr }} />
                  </div>
                  <div style={{ fontSize: 11, color: "var(--t2)", fontWeight: 700 }}>
                    {levelInfo.isMax ? "🏁 Max level bereikt" : `Nog ${levelInfo.remaining} coins tot level ${levelInfo.nextLevel}`}
                  </div>
                </div>
                {todayTotal > 0
                  ? <div className="home-kid-tasks">{todayDone}/{todayTotal} taken gedaan vandaag</div>
                  : <div className="home-kid-tasks">Geen taken vandaag 🎉</div>
                }
                <button className="home-kid-cta" style={{ background: th.hdr, boxShadow: th.hdrShadow }}>
                  Laten we gaan! →
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <Thermometer children={data.children} onReveal={() => setCoinsRevealed(true)} onReset={() => setCoinsRevealed(false)} playDrumroll={playDrumroll} />

      <button className="home-parent-btn" onClick={onParent}>🔑 Ouder inloggen</button>
    </div>
  );
}

// ─── CHILD VIEW ────────────────────────────────────────────────────────────────
function ChildView({ data, db, activeKid, kidTab, setKidTab, playTaskDone, playAllDone, playSpend, onAllDone, coinTargetRef, getLifetimeCoinsForChild }) {
  const cur = data.children.find(c => c.id === activeKid);
  const todayNow = getTodayISO();
  const activeTasks = dedupeVisibleTasks(data.tasks
    .filter(t =>
      t.childId === activeKid &&
      !isRecurringTemplateTask(t) &&
      t.date <= todayNow &&
      getTaskRemainingCoins(t, todayNow) > 0 &&
      shouldKeepCompletedVisible(t, todayNow) &&
      (t.status !== "pending" || isTaskVisibleForChildNow(t))
    ))
    .sort((a, b) => {
      const sectionDiff = CHILD_TASK_SECTIONS.findIndex(s => s.key === getTaskSectionKey(a)) - CHILD_TASK_SECTIONS.findIndex(s => s.key === getTaskSectionKey(b));
      if (sectionDiff !== 0) return sectionDiff;
      if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.title.localeCompare(b.title, "nl");
    });
  const tasksBySection = CHILD_TASK_SECTIONS.reduce((acc, section) => {
    acc[section.key] = activeTasks.filter(t => getTaskSectionKey(t) === section.key);
    return acc;
  }, {});
  const missedTasks = data.tasks
    .filter(t =>
      t.childId === activeKid &&
      !isRecurringTemplateTask(t) &&
      t.status === "pending" &&
      t.date < todayNow &&
      getTaskRemainingCoins(t, todayNow) > 0
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  const doneCount = activeTasks.filter(t => t.status !== "pending").length;
  const prog = activeTasks.length > 0 ? Math.round((doneCount / activeTasks.length) * 100) : 0;
  const allDone = activeTasks.length > 0 && activeTasks.every(t => t.status !== "pending");

  const [feitje]  = useState(() => FEITJES[Math.floor(Math.random() * FEITJES.length)]);
  const [coinPop, setCoinPop] = useState(false);
  const prevCoins    = useRef(cur?.coins ?? 0);
  const prevDoneCount = useRef(doneCount);
  const celebFired   = useRef(false);

  const d = new Date();
  const dagNaam  = DAGEN[d.getDay()];
  const volledig = `${d.getDate()} ${MAANDEN[d.getMonth()]} ${d.getFullYear()}`;

  // animate coin counter when coins change
  useEffect(() => {
    if (cur && cur.coins !== prevCoins.current) {
      setCoinPop(true);
      prevCoins.current = cur.coins;
      setTimeout(() => setCoinPop(false), 500);
    }
  }, [cur?.coins]);

  // detect when ALL tasks just became done → fire celebration once
  useEffect(() => {
    if (allDone && !celebFired.current && doneCount > prevDoneCount.current) {
      celebFired.current = true;
      setTimeout(() => {
        playAllDone();
        onAllDone();
      }, 400);
    }
    prevDoneCount.current = doneCount;
  }, [doneCount, allDone]);

  // reset if child changes
  useEffect(() => {
    celebFired.current = false;
    prevDoneCount.current = doneCount;
  }, [activeKid]);

  if (!cur) return null;
  const th = getChildTheme(cur);
  const levelInfo = getLevelInfo(getLifetimeCoinsForChild(cur));

  return (
    <div style={{ background: th.bg, minHeight: "100vh", margin: "-24px -20px", padding: "24px 20px" }}>

      {/* Deco strip */}
      <div className="kid-deco-strip">
        {th.headerDeco.map((d, i) => (
          <span key={i} className="kid-deco-float" style={{ "--df": `${1.5 + i * 0.3}s` }}>{d}</span>
        ))}
      </div>

      {/* Kid header */}
      <div className="kh" style={{ background: th.hdr, boxShadow: th.hdrShadow }}>
        <div className="kh-left">
          <div style={{ fontSize: 64, lineHeight: 1, filter: "drop-shadow(0 4px 10px rgba(0,0,0,.2))" }}>{getChildAvatar(cur)}</div>
          <div>
            <div style={{ fontFamily: "'Baloo 2',cursive", fontSize: 34, fontWeight: 800, lineHeight: 1.1, marginBottom: 8, color: "#fff" }}>
              {th.greeting}, {cur.name}! 👋
            </div>
            {activeTasks.length > 0 && (
              <div style={{ minWidth: 200 }}>
                <div style={{ fontSize: 13, opacity: .9, marginBottom: 4, color: "#fff" }}>{doneCount} van {activeTasks.length} taken gedaan</div>
                <div className="pb" style={{ background: "rgba(255,255,255,.25)" }}>
                  <div className="pf" style={{ width: `${prog}%`, background: th.progressColor }} />
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="kh-right" ref={coinTargetRef} style={{ background: "rgba(255,255,255,.18)", border: "2px solid rgba(255,255,255,.3)" }}>
          <div className="kh-coins-label" style={{ color: "rgba(255,255,255,.85)" }}>🪙 Mijn coins</div>
          <div className={`kh-coins-val ${coinPop ? "pop" : ""}`} style={{ color: "#fff" }}>
            {cur.coins}
          </div>
        </div>
      </div>

      <div style={{ background:"#fff", border:`2px solid ${th.pri}33`, boxShadow:`0 8px 24px ${th.pri}12`, borderRadius:20, padding:"14px 16px", marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, marginBottom:8, flexWrap:"wrap" }}>
          <div style={{ fontWeight:900, fontSize:18, color: th.priD }}>🏅 Level {levelInfo.level} — {levelInfo.name}</div>
          <div style={{ fontSize:12, color:"var(--t2)", fontWeight:800 }}>{levelInfo.coins} lifetime coins</div>
        </div>
        <div className="pb" style={{ height: 14, background: `${th.pri}22`, marginBottom: 8 }}>
          <div className="pf" style={{ width: `${Math.round(levelInfo.progress * 100)}%`, background: th.hdr }} />
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", gap:10, flexWrap:"wrap", fontSize:12, fontWeight:700, color:"var(--t2)" }}>
          <span>{levelInfo.isMax ? "🏁 Max level bereikt" : `Nog ${levelInfo.remaining} coins tot level ${levelInfo.nextLevel} — ${levelInfo.nextName}`}</span>
          <span>{Math.round(levelInfo.progress * 100)}% voortgang</span>
        </div>
      </div>

      {/* Datum + Feitje */}
      <div className="kid-info-row">
        <div className="kid-date-card" style={{ border: `2px solid ${th.pri}33`, background: "#fff" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: th.pri, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 6 }}>📅 Vandaag</div>
          <div className="kid-date-card-day" style={{ color: th.pri }}>{dagNaam}</div>
          <div className="kid-date-card-full">{volledig}</div>
        </div>
        <div className="kid-fact-card" style={{ border: `2px solid ${th.pri}33`, background: "#fff" }}>
          <div className="kid-fact-emoji">{feitje.emoji}</div>
          <div>
            <div className="kid-fact-label" style={{ color: th.pri }}>🤩 Wist je dat...</div>
            <div className="kid-fact-text">{feitje.feit}</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs" style={{ background: "rgba(255,255,255,.6)" }}>
        <button className={`tab ${kidTab === "tasks"   ? "on" : ""}`}
          style={kidTab === "tasks"   ? { color: th.pri } : {}}
          onClick={() => setKidTab("tasks")}>{th.taskIcon} Mijn Taken</button>
        <button className={`tab ${kidTab === "rewards" ? "on" : ""}`}
          style={kidTab === "rewards" ? { color: th.pri } : {}}
          onClick={() => setKidTab("rewards")}>{th.rewardIcon} Beloningen</button>
        <button className={`tab ${kidTab === "missed" ? "on" : ""}`}
          style={kidTab === "missed" ? { color: th.pri } : {}}
          onClick={() => setKidTab("missed")}>⏰ Gemist{missedTasks.length ? ` (${missedTasks.length})` : ""}</button>
        <button className={`tab ${kidTab === "purchases" ? "on" : ""}`}
          style={kidTab === "purchases" ? { color: th.pri } : {}}
          onClick={() => setKidTab("purchases")}>📜 Geschiedenis</button>
      </div>

      {kidTab === "tasks" && (
        <div>
          <div className="st" style={{ marginBottom: 14, color: th.priD }}>Mijn taken per moment {th.taskIcon}</div>
          {activeTasks.length === 0 ? (
            <div className="emp"><div className="ei">🎉</div><div className="et">Geen actieve taken op dit moment — vrij spel!</div></div>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {CHILD_TASK_SECTIONS.map(section => {
                const sectionTasks = tasksBySection[section.key] || [];
                return (
                  <div key={section.key} style={{ background: "#ffffffcc", border: `2px solid ${th.pri}22`, borderRadius: 18, padding: 14, boxShadow: `0 4px 14px ${th.pri}10` }}>
                    <div style={{ fontWeight: 900, fontSize: 15, color: th.priD, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 20 }}>{section.emoji}</span>
                      <span>{section.title}</span>
                      <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--t2)" }}>{sectionTasks.length}</span>
                    </div>
                    {sectionTasks.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--t2)", padding: "6px 2px" }}>{section.empty}</div>
                    ) : (
                      <div style={{ display: "grid", gap: 10 }}>
                        {sectionTasks.map(t => (
                          <KidTask key={t.id} task={t} db={db} playTaskDone={playTaskDone} childName={cur.name} theme={th} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {kidTab === "missed" && (
        <div>
          <div className="st" style={{ marginBottom: 8, color: th.priD }}>Gemiste taken ⏰</div>
          <div style={{ fontSize: 13, color: "var(--t2)", marginBottom: 12 }}>
            Het verval wordt per taak berekend als <strong>max coins ÷ aantal dagen</strong>. De taak blijft geldig op de startdag en de opgegeven dagen erna; zodra hij op <strong>0 coins</strong> komt, verdwijnt hij automatisch.
          </div>
          {missedTasks.length === 0
            ? <div className="emp"><div className="ei">😌</div><div className="et">Geen gemiste taken — netjes!</div></div>
            : missedTasks.map(t => (
                <KidTask key={t.id} task={t} db={db} playTaskDone={playTaskDone} childName={cur.name} theme={th} isMissed />
              ))
          }
        </div>
      )}

      {kidTab === "rewards" && (
        <div>
          <div className="st" style={{ marginBottom: 6, color: th.priD }}>Beloningen {th.rewardIcon}</div>
          {(() => {
            const reserved = data.redemptions
              .filter(r => r.childId === cur.id && r.status === "pending")
              .reduce((s, r) => s + r.cost, 0);
            const available = cur.coins - reserved;
            return (
              <>
                <div style={{ fontSize: 13, color: "var(--t2)", marginBottom: 6 }}>
                  Jij hebt <strong style={{ color: th.pri }}>{cur.coins} coins</strong> 🪙
                  {reserved > 0 && <span style={{ color:"#f59e0b", fontWeight:700 }}> · {reserved} gereserveerd · <strong style={{ color: th.pri }}>{available} beschikbaar</strong></span>}
                </div>
                <div className="ga">
                  {data.rewards.filter(r => rewardVisibleForChild(r, cur.id)).map(r => {
                    const rewardMeta = parseRewardDesc(r.desc);
                    const can = available >= r.cost;
                    return (
                      <div key={r.id}
                        className={`rc ${!can ? "rca" : ""}`}
                        style={can ? { border: `3px solid ${th.pri}55`, background: "#fff" } : {}}
                        onClick={() => { if (can) { db.redeem(cur.id, r.id); playSpend(); } }}>
                        <div style={{ fontSize: 44, marginBottom: 8 }}>{r.emoji}</div>
                        <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 3 }}>{r.title}</div>
                        <div style={{ fontSize: 12, color: "var(--t2)", marginBottom: 9 }}>{rewardMeta.visibleDesc}</div>
                        <div style={{ fontSize: 19, fontWeight: 900, color: "var(--yel)" }}>🪙 {r.cost}</div>
                        {can
                          ? <button className="btn bsm" style={{ marginTop: 10, background: th.hdr, color: "#fff", border: "none", boxShadow: `0 3px 12px ${th.pri}44` }}>Aanvragen! {th.rewardIcon}</button>
                          : <div style={{ fontSize: 11, color: "var(--red)", marginTop: 8, fontWeight: 700 }}>Nog {r.cost - available} coins nodig</div>
                        }
                      </div>
                    );
                  })}
                  {data.rewards.filter(r => rewardVisibleForChild(r, cur.id)).length === 0 && <div className="emp" style={{ gridColumn: "1/-1" }}><div className="ei">{th.rewardIcon}</div><div className="et">Nog geen beloningen voor jou</div></div>}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {kidTab === "purchases" && (() => {
        const myRedemptions = data.redemptions
          .filter(r => r.childId === cur.id)
          .sort((a, b) => b.date.localeCompare(a.date));
        return (
          <div>
            <div className="st" style={{ marginBottom: 14, color: th.priD }}>Mijn Aankopen 🛍️</div>
            {myRedemptions.length === 0 ? (
              <div className="emp"><div className="ei">🛍️</div><div className="et">Je hebt nog niets aangevraagd</div></div>
            ) : myRedemptions.map(r => (
              <div key={r.id} style={{
                display:"flex", alignItems:"center", gap:12, padding:"12px 14px",
                borderRadius:14, marginBottom:8, background:"#fff",
                border:`2px solid ${r.status==="approved" ? "#10b981" : r.status==="rejected" ? "#ef4444" : th.pri+"44"}`,
                boxShadow:`0 2px 10px ${th.pri}12`,
              }}>
                <div style={{ fontSize:34 }}>{r.rewardEmoji}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:800, fontSize:15 }}>{r.rewardTitle}</div>
                  <div style={{ fontSize:12, color:"var(--t2)", marginTop:2 }}>📅 {r.date} · 🪙 {r.cost} coins</div>
                </div>
                {r.status === "approved" && <span style={{ background:"#d1fae5", color:"#065f46", borderRadius:50, padding:"4px 12px", fontSize:12, fontWeight:800, whiteSpace:"nowrap" }}>✅ Goedgekeurd!</span>}
                {r.status === "rejected" && <span style={{ background:"#fee2e2", color:"#991b1b", borderRadius:50, padding:"4px 12px", fontSize:12, fontWeight:800, whiteSpace:"nowrap" }}>❌ Afgewezen</span>}
                {r.status === "pending"  && <span style={{ background:th.pri+"18", color:th.pri, borderRadius:50, padding:"4px 12px", fontSize:12, fontWeight:800, whiteSpace:"nowrap" }}>⏳ In behandeling</span>}
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

// ─── KID TASK ──────────────────────────────────────────────────────────────────
function KidTask({ task, db, playTaskDone, childName, theme, isMissed = false }) {
  const done = task.status === "done";
  const appr = task.status === "approved";
  const [shake,    setShake]   = useState(false);
  const [showSlay, setShowSlay]= useState(false);
  const th = theme || DEFAULT_THEME;
  const isNevah = /^(névah|nevah|neoah|neva?h)$/i.test((childName || "").trim());
  const taskMeta = parseTaskDesc(task.desc, task.coins);
  const taskEmoji = getTaskDisplayEmoji(task);
  const daysLeft = getTaskDaysLeft(task, today);
  const dayPartLabel = getDayPartLabel(taskMeta.dayPart);
  const currentCoins = task.status === "pending" ? getTaskRemainingCoins(task, today) : Math.max(0, Number(task.coins || taskMeta.lockedCoins || 0));

  const handleCheck = () => {
    if (done || appr) return;
    db.markDone(task.id);
    playTaskDone();
    setShake(true);
    setTimeout(() => setShake(false), 500);
    if (isNevah) {
      setShowSlay(true);
      setTimeout(() => setShowSlay(false), 1000);
    }
  };

  return (
    <div
      className={`kt ${shake ? "shake" : ""}`}
      style={{
        position: "relative",
        background: appr || done ? th.taskDoneBg : "#fff",
        borderColor: appr || done ? th.taskDoneBorder : th.pri + "44",
        boxShadow: `0 2px 12px ${th.pri}18`,
      }}
    >
      {showSlay && <div className="slay-popup">💅 Slay Girl! ✨</div>}
      <div
        className={`kc ${done || appr ? "kcd" : ""}`}
        onClick={handleCheck}
        style={{
          background:   done || appr ? th.pri : "#fff",
          borderColor:  done || appr ? th.pri : th.pri + "66",
          color: "#fff",
          fontSize: 20,
        }}
      >
        {(done || appr) ? "✓" : ""}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 800, fontSize: 16, textDecoration: appr ? "line-through" : "none", color: appr ? "var(--t2)" : "#1e2340", display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 20, lineHeight: 1 }}>{taskEmoji}</span><span>{task.title}</span></div>
        {taskMeta.visibleDesc && <div style={{ fontSize: 12, color: "var(--t2)" }}>{taskMeta.visibleDesc}</div>}
        {!done && !appr && (
          <div style={{ fontSize: 11, color: isMissed ? "#b45309" : "var(--t2)", fontWeight: 700, marginTop: 3 }}>
            📅 Startdatum {task.date} · {getDayPartConfig(taskMeta.dayPart).emoji} {dayPartLabel} · {daysLeft === 1 ? "⚠️ Laatste dag" : `⏳ Nog ${daysLeft} dag${daysLeft === 1 ? "" : "en"} over`}
          </div>
        )}
        {isMissed && !done && !appr && (
          <div style={{ fontSize: 11, color: "#b45309", fontWeight: 700, marginTop: 3 }}>
            ⏰ Gemist sinds {task.date} · {taskMeta.baseDecay} coin{taskMeta.baseDecay === 1 ? "" : "s"} verval per gemiste dag
            {taskMeta.lastDecay !== taskMeta.baseDecay ? ` · laatste verval ${taskMeta.lastDecay}` : ""}
          </div>
        )}
        {done && taskMeta.requiresParentApproval && <div style={{ fontSize: 11, color: "#d97706", fontWeight: 700, marginTop: 3 }}>⏳ Wacht op goedkeuring van ouder</div>}
        {appr && <div style={{ fontSize: 11, color: th.pri, fontWeight: 700, marginTop: 3 }}>{taskMeta.requiresParentApproval ? "✅ Goedgekeurd! Coins ontvangen!" : "✅ Meteen afgerond! Coins ontvangen!"}</div>}
      </div>
      <div style={{ fontWeight: 900, color: "var(--yel)", fontSize: 21, display: "flex", alignItems: "center", gap: 3 }}>🪙{currentCoins}</div>
    </div>
  );
}

// ─── PARENT VIEW ───────────────────────────────────────────────────────────────

function ParentDashboard({ data, db, setModal, setTab }) {
  const todayNow = getTodayISO();
  const now = new Date();
  const pendingApprovals = data.tasks.filter(t => t.status === "done");
  const pendingRedemptions = data.redemptions.filter(r => r.status === "pending" && !isPenaltyRedemption(r));

  const softBg = "radial-gradient(circle at top left, #18233f 0%, #11182e 42%, #0c1225 100%)";
  const shell = { background: softBg, border: '1px solid rgba(125,156,255,0.18)', borderRadius: 28, padding: 20, boxShadow: '0 28px 60px rgba(6,12,30,0.45)', color: '#eef2ff' };
  const panel = { background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.025))', border: '1px solid rgba(148,163,184,0.18)', borderRadius: 24, boxShadow: '0 12px 30px rgba(0,0,0,0.18)' };

  const visibleOpenTasksForChild = (childId) => dedupeVisibleTasks(
    data.tasks.filter(t => {
      if (t.childId !== childId) return false;
      if (isRecurringTemplateTask(t)) return false;
      if (t.status !== 'pending') return false;
      if (getTaskRemainingCoins(t, todayNow) <= 0) return false;
      if (!shouldKeepCompletedVisible(t, todayNow)) return false;
      return isTaskVisibleForChildNow(t, now);
    })
  );

  const approvedThisWeekForChild = (childId) => data.tasks.filter(t => {
    if (t.childId !== childId || t.status !== 'approved') return false;
    const info = parseTaskDesc(t.desc, t.coins);
    const anchor = info.approvedOn || info.doneOn || t.date;
    return diffDays(anchor, todayNow) <= 6;
  });

  const nearlyExpiredWeekly = dedupeVisibleTasks(
    data.tasks.filter(t => {
      if (isRecurringTemplateTask(t)) return false;
      if (t.status !== 'pending') return false;
      const info = parseTaskDesc(t.desc, t.coins);
      if (info.dayPart !== 'weekly') return false;
      const daysLeft = getTaskDaysLeft(t, todayNow);
      return daysLeft > 0 && daysLeft <= 2;
    })
  ).sort((a,b)=> getTaskDaysLeft(a, todayNow)-getTaskDaysLeft(b,todayNow));

  const recentActivities = [
    ...data.tasks.filter(t => t.status === 'approved').map(t => {
      const ch = data.children.find(c => c.id === t.childId);
      const info = parseTaskDesc(t.desc, t.coins);
      const when = info.approvedOn || info.doneOn || t.date;
      return { key:`task-${t.id}`, date: when, emoji:'✅', color:'#86efac', text: `${ch?.name || 'Kind'} rondde ${t.title.toLowerCase()} af`, meta:`+${t.coins} coins` };
    }),
    ...data.redemptions.filter(r => r.status === 'approved' && !isPenaltyRedemption(r)).map(r => {
      const ch = data.children.find(c => c.id === r.childId);
      return { key:`red-${r.id}`, date:r.date, emoji:r.rewardEmoji || '🎁', color:'#f9a8d4', text:`${ch?.name || 'Kind'} kocht ${String(r.rewardTitle || '').toLowerCase()}`, meta:`-${r.cost} coins` };
    })
  ].sort((a,b)=> String(b.date).localeCompare(String(a.date))).slice(0,5);

  const childCards = data.children.map((child, idx) => {
    const life = getChildLifetimeCoinsValue(child, data.lifetimeCoinsMap || {});
    const level = getLevelInfo(life);
    const openTasks = visibleOpenTasksForChild(child.id);
    const approvals = pendingApprovals.filter(t => t.childId === child.id).length;
    const weeklyDone = approvedThisWeekForChild(child.id);
    const weeklyCoins = weeklyDone.reduce((sum,t)=> sum + Number(t.coins || 0), 0);
    const theme = idx % 2 === 0
      ? { glow:'rgba(56,189,248,0.34)', border:'rgba(59,130,246,0.45)', accent:'#60a5fa', accent2:'#93c5fd', badgeBg:'rgba(59,130,246,0.14)' }
      : { glow:'rgba(244,114,182,0.30)', border:'rgba(236,72,153,0.42)', accent:'#f472b6', accent2:'#f9a8d4', badgeBg:'rgba(236,72,153,0.13)' };
    const progressWidth = `${Math.max(8, Math.round(level.progress * 100))}%`;
    return { child, life, level, openTasks, approvals, weeklyDone, weeklyCoins, theme, progressWidth };
  });

  const attentionItems = [];
  if (pendingApprovals.length) {
    attentionItems.push({ key:'tasks', emoji:'📝', title:`${pendingApprovals.length} taak${pendingApprovals.length > 1 ? 'en' : ''} wachten op goedkeuring`, tone:'#fcd34d', onClick:()=>setTab('approve') });
  }
  if (pendingRedemptions.length) {
    attentionItems.push({ key:'reds', emoji:'🛍️', title:`${pendingRedemptions.length} aankoop${pendingRedemptions.length > 1 ? 'en' : ''} wachten op goedkeuring`, tone:'#c4b5fd', onClick:()=>setTab('purchases') });
  }
  nearlyExpiredWeekly.slice(0,2).forEach((task) => {
    const ch = data.children.find(c => c.id === task.childId);
    const daysLeft = getTaskDaysLeft(task, todayNow);
    attentionItems.push({ key:`wk-${task.id}`, emoji:'⏰', title:`${ch?.name || 'Kind'} · ${task.title}`, subtitle: daysLeft === 1 ? 'Laatste dag om af te ronden' : `Nog ${daysLeft} dagen over`, tone:'#fb7185', onClick:()=>setTab('tasks') });
  });
  if (!attentionItems.length) {
    attentionItems.push({ key:'none', emoji:'✨', title:'Alles loopt netjes', subtitle:'Geen dringende acties voor vandaag', tone:'#86efac' });
  }

  const quickAction = (label, emoji, onClick, glow) => (
    <button onClick={onClick} style={{ ...panel, cursor:'pointer', padding:'16px 18px', textAlign:'left', color:'#eef2ff', background:`linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02)), ${glow}`, display:'flex', alignItems:'center', gap:12, borderRadius:18, border:'1px solid rgba(255,255,255,0.14)' }}>
      <span style={{ fontSize:22 }}>{emoji}</span><span style={{ fontWeight:800, fontSize:16 }}>{label}</span>
    </button>
  );

  return (
    <div style={shell}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:16, flexWrap:'wrap', marginBottom:18 }}>
        <div>
          <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:38, fontWeight:800, lineHeight:1, marginBottom:4, color:'#c7d2fe' }}>Ouder Dashboard</div>
          <div style={{ color:'rgba(226,232,240,0.78)', fontSize:16 }}>Overzicht van Kylian & Névah</div>
        </div>
        <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
          <button className="btn" style={{ background:'rgba(15,23,42,0.75)', color:'#e2e8f0', border:'1px solid rgba(148,163,184,0.22)' }} onClick={()=>setTab('settings')}>⚙️ Instellingen</button>
          <button className="btn" style={{ background:'linear-gradient(135deg, rgba(34,197,94,0.18), rgba(16,185,129,0.18))', color:'#dcfce7', border:'1px solid rgba(34,197,94,0.35)' }} onClick={()=>setModal({ type:'task' })}>➕ Nieuwe taak</button>
          <button className="btn" style={{ background:'linear-gradient(135deg, rgba(168,85,247,0.18), rgba(236,72,153,0.18))', color:'#f5d0fe', border:'1px solid rgba(232,121,249,0.35)' }} onClick={()=>setTab('rewards')}>🎁 Beloningen</button>
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))', gap:18, marginBottom:18 }}>
        {childCards.map(({ child, life, level, openTasks, approvals, weeklyDone, weeklyCoins, theme, progressWidth }) => (
          <div key={child.id} style={{ ...panel, padding:18, border:`1px solid ${theme.border}`, boxShadow:`0 0 0 1px ${theme.border} inset, 0 0 24px ${theme.glow}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', gap:16, alignItems:'center', marginBottom:12 }}>
              <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                <div style={{ width:72, height:72, borderRadius:'50%', background:theme.badgeBg, display:'grid', placeItems:'center', fontSize:40, boxShadow:`0 0 0 3px ${theme.border}, 0 0 22px ${theme.glow}` }}>{getChildAvatar(child)}</div>
                <div>
                  <div style={{ fontSize:20, fontWeight:800 }}>{child.name}</div>
                  <div style={{ color:theme.accent2, fontWeight:800, fontSize:14 }}>Level {level.level} — {level.name}</div>
                </div>
              </div>
              <div style={{ minWidth:70, textAlign:'center', padding:'10px 12px', borderRadius:18, background:theme.badgeBg, border:`1px solid ${theme.border}` }}>
                <div style={{ fontSize:12, color:'#cbd5e1' }}>Level</div>
                <div style={{ fontSize:28, fontWeight:900, color:theme.accent }}>{level.level}</div>
              </div>
            </div>
            <div style={{ marginBottom:14, padding:'14px 14px 12px', borderRadius:18, background:'rgba(15,23,42,0.48)', border:'1px solid rgba(148,163,184,0.14)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', gap:10, marginBottom:8, fontWeight:800 }}>
                <span>{life} / {level.isMax ? level.coins : level.nextMin} lifetime coins</span>
                <span style={{ color:theme.accent }}>{Math.round(level.progress * 100)}%</span>
              </div>
              <div style={{ height:12, borderRadius:999, background:'rgba(255,255,255,0.08)', overflow:'hidden' }}>
                <div style={{ width:progressWidth, height:'100%', borderRadius:999, background:`linear-gradient(90deg, ${theme.accent}, ${theme.accent2})`, boxShadow:`0 0 14px ${theme.glow}` }} />
              </div>
              <div style={{ marginTop:8, color:'rgba(226,232,240,0.88)', fontSize:13 }}>{level.isMax ? 'Max level bereikt' : `Nog ${level.remaining} lifetime coins tot level ${level.nextLevel}`}</div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:10 }}>
              {[
                { label:'coins', value:child.coins, emoji:'🪙', tone:'#fbbf24' },
                { label:'open taken', value:openTasks.length, emoji:'📋', tone:'#93c5fd' },
                { label:'goedk.', value:approvals, emoji:'✅', tone:'#86efac' },
              ].map(stat => (
                <div key={stat.label} style={{ padding:'12px 10px', borderRadius:16, background:'rgba(15,23,42,0.44)', border:'1px solid rgba(148,163,184,0.14)' }}>
                  <div style={{ fontSize:12, color:'rgba(226,232,240,0.84)', marginBottom:4 }}>{stat.emoji} {stat.label}</div>
                  <div style={{ fontWeight:900, fontSize:26, color:stat.tone }}>{stat.value}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(260px, 1fr))', gap:18, marginBottom:18 }}>
        <div style={{ ...panel, padding:18, minHeight:250 }}>
          <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:18, fontWeight:800, marginBottom:14 }}>📅 Weekvoortgang</div>
          <div style={{ display:'grid', gap:14 }}>
            {childCards.map(({ child, weeklyDone, weeklyCoins, theme }) => {
              const doneCount = weeklyDone.length;
              const progress = Math.min(1, doneCount / 7);
              return (
                <div key={`weekly-${child.id}`} style={{ padding:14, borderRadius:18, background:'rgba(15,23,42,0.44)', border:'1px solid rgba(148,163,184,0.14)' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, marginBottom:10 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}><span style={{ fontSize:26 }}>{getChildAvatar(child)}</span><span style={{ fontSize:18, fontWeight:800 }}>{child.name}</span></div>
                    <div style={{ fontWeight:800, color:'#fcd34d' }}>+{weeklyCoins} coins</div>
                  </div>
                  <div style={{ height:10, borderRadius:999, background:'rgba(255,255,255,0.07)', overflow:'hidden', marginBottom:8 }}><div style={{ width:`${Math.max(6, Math.round(progress*100))}%`, height:'100%', background:`linear-gradient(90deg, ${theme.accent}, ${theme.accent2})`, borderRadius:999 }} /></div>
                  <div style={{ color:'rgba(226,232,240,0.86)', fontSize:13 }}>{doneCount} afgeronde taken deze week</div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ ...panel, padding:18, minHeight:250 }}>
          <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:18, fontWeight:800, marginBottom:14 }}>⚡ Snelle acties</div>
          <div style={{ display:'grid', gap:12 }}>
            {quickAction('Nieuwe taak', '➕', ()=>setModal({ type:'task' }), 'linear-gradient(135deg, rgba(59,130,246,0.14), rgba(14,165,233,0.08))')}
            {quickAction('Weektaken bekijken', '📅', ()=>setTab('tasks'), 'linear-gradient(135deg, rgba(236,72,153,0.12), rgba(168,85,247,0.08))')}
            {quickAction('Beloning toevoegen', '🎁', ()=>setModal({ type:'reward' }), 'linear-gradient(135deg, rgba(245,158,11,0.14), rgba(251,191,36,0.08))')}
            {quickAction('Coins aanpassen', '🪙', ()=>setTab('kids'), 'linear-gradient(135deg, rgba(34,197,94,0.14), rgba(16,185,129,0.08))')}
          </div>
        </div>

        <div style={{ ...panel, padding:18, minHeight:250 }}>
          <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:18, fontWeight:800, marginBottom:14 }}>💡 Vandaag aandacht</div>
          <div style={{ display:'grid', gap:12 }}>
            {attentionItems.slice(0,4).map(item => (
              <button key={item.key} onClick={item.onClick} style={{ textAlign:'left', padding:'14px 14px', borderRadius:18, border:`1px solid ${item.tone}33`, background:'rgba(15,23,42,0.46)', color:'#eef2ff', cursor:item.onClick?'pointer':'default' }}>
                <div style={{ fontWeight:800 }}>{item.emoji} {item.title}</div>
                {item.subtitle && <div style={{ fontSize:13, color:'rgba(226,232,240,0.84)', marginTop:4 }}>{item.subtitle}</div>}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))', gap:18 }}>
        <div style={{ ...panel, padding:18 }}>
          <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:18, fontWeight:800, marginBottom:14 }}>🧾 Recente activiteit</div>
          {recentActivities.length === 0 ? (
            <div style={{ color:'rgba(226,232,240,0.84)', fontSize:14 }}>Nog geen recente activiteit zichtbaar.</div>
          ) : (
            <div style={{ display:'grid', gap:12 }}>
              {recentActivities.map(item => (
                <div key={item.key} style={{ display:'flex', gap:12, alignItems:'flex-start', paddingBottom:12, borderBottom:'1px solid rgba(148,163,184,0.12)' }}>
                  <div style={{ width:34, height:34, borderRadius:'50%', background:`${item.color}22`, display:'grid', placeItems:'center', fontSize:18 }}>{item.emoji}</div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:700 }}>{item.text}</div>
                    <div style={{ fontSize:13, color:'rgba(226,232,240,0.68)', marginTop:3 }}>{item.meta}</div>
                  </div>
                  <div style={{ fontSize:12, color:'rgba(226,232,240,0.58)', whiteSpace:'nowrap' }}>{item.date}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ ...panel, padding:18 }}>
          <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:18, fontWeight:800, marginBottom:14 }}>📌 Vandaag gepland</div>
          <div style={{ display:'grid', gap:12 }}>
            {childCards.map(({ child, openTasks }) => (
              <button key={`planned-${child.id}`} onClick={()=>setTab('tasks')} style={{ textAlign:'left', padding:'15px 16px', borderRadius:18, border:'1px solid rgba(148,163,184,0.16)', background:'rgba(15,23,42,0.44)', color:'#eef2ff', display:'flex', justifyContent:'space-between', alignItems:'center', gap:14 }}>
                <div style={{ display:'flex', alignItems:'center', gap:12 }}><span style={{ fontSize:26 }}>{getChildAvatar(child)}</span><div><div style={{ fontWeight:800 }}>{child.name}</div><div style={{ fontSize:13, color:'rgba(226,232,240,0.68)' }}>{openTasks.length} actieve taken zichtbaar</div></div></div>
                <div style={{ fontWeight:900, color:'#c7d2fe' }}>{openTasks.length}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ParentView({ data, db, tab, setTab, setModal, parentPin }) {
  const pending             = data.tasks.filter(t => t.status === "done");
  const pendingRedemptions  = data.redemptions.filter(r => r.status === "pending");
  const getChild = (id) => data.children.find(c => c.id === id);
  const headerPanel = {
    background: 'linear-gradient(180deg, rgba(12,22,48,0.84), rgba(16,24,39,0.72))',
    border: '1px solid rgba(148,163,184,0.16)',
    borderRadius: 24,
    padding: '18px 20px',
    boxShadow: '0 24px 60px rgba(2,6,23,.18), inset 0 1px 0 rgba(255,255,255,.04)'
  };

  return (
    <div className={tab === "dashboard" ? "" : "parent-quiet"}>
      {tab === "dashboard" ? (
        <ParentDashboard data={data} db={db} setModal={setModal} setTab={setTab} />
      ) : (
        <div style={{ ...headerPanel, marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
            <div>
              <h1 style={{ fontFamily: "'Baloo 2',cursive", fontSize: 30, fontWeight: 800, marginBottom: 4, color:'#eef2ff' }}>Ouderportaal ✨</h1>
              <p style={{ color: "#dce7f5", fontSize: 14 }}>Zelfde rustige dashboardstijl, maar met focus op overzicht en sneller beheren.</p>
            </div>
            {(pending.length > 0 || pendingRedemptions.length > 0) && (
              <div style={{ display:"flex", flexDirection:"column", gap:8, minWidth:240 }}>
                {pending.length > 0 && (
                  <div style={{ background: "rgba(245,158,11,.12)", border: "1px solid rgba(245,158,11,.24)", borderRadius: 16, padding: "9px 14px", fontWeight: 700, fontSize: 13, color: "#fcd34d" }}>
                    ⏳ {pending.length} taak{pending.length > 1 ? "en" : ""} wacht op goedkeuring
                  </div>
                )}
                {pendingRedemptions.length > 0 && (
                  <div style={{ background: "rgba(217,70,168,.12)", border: "1px solid rgba(217,70,168,.22)", borderRadius: 16, padding: "9px 14px", fontWeight: 700, fontSize: 13, color: "#f9a8d4" }}>
                    🛍️ {pendingRedemptions.length} aankoop{pendingRedemptions.length > 1 ? "en" : ""} wacht op goedkeuring
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="tabs" style={{ marginTop: tab === 'dashboard' ? 18 : 0, background:'rgba(15,23,42,.72)', padding:6, borderRadius:999, border:'1px solid rgba(148,163,184,.20)', width:'100%', overflowX:'auto', flexWrap:'nowrap' }}>
        {[
          ["dashboard", "📊 Dashboard"],
          ["tasks",   "📋 Taken"],
          ["approve", `✅ Goedkeuren${pending.length ? ` (${pending.length})` : ""}`],
          ["kids",    "👶 Kinderen"],
          ["rewards", "🎁 Beloningen"],
          ["purchases", `🛍️ Aankopen${pendingRedemptions.length ? ` (${pendingRedemptions.length})` : ""}`],
          ["settings",  "⚙️ Instellingen"],
        ].map(([k,l]) => (
          <button
            key={k}
            className={`tab ${tab === k ? "on" : ""}`}
            onClick={() => setTab(k)}
            style={{
              borderRadius: 999,
              padding: '12px 18px',
              border: 'none',
              whiteSpace:'nowrap',
              background: tab === k ? 'linear-gradient(135deg, rgba(99,102,241,.28), rgba(59,130,246,.18))' : 'transparent',
              color: tab === k ? '#ffffff' : '#dce7f5',
              boxShadow: tab === k ? 'inset 0 0 0 1px rgba(129,140,248,.26), 0 8px 20px rgba(15,23,42,.18)' : 'none',
              fontWeight: 800,
              minWidth: 'fit-content'
            }}
          >{l}</button>
        ))}
      </div>
      {tab === "tasks"     && <TasksTab     data={data} db={db} setModal={setModal} getChild={getChild} />}
      {tab === "approve"   && <ApproveTab   data={data} db={db} pending={pending}   getChild={getChild} />}
      {tab === "kids"      && <KidsTab      data={data} db={db} setModal={setModal} />}
      {tab === "rewards"   && <RewardsTab   data={data} db={db} setModal={setModal} />}
      {tab === "purchases" && <PurchasesTab data={data} db={db} getChild={getChild} />}
      {tab === "settings"  && <SettingsTab data={data} db={db} parentPin={parentPin} />}
    </div>
  );
}

function TasksTab({ data, db, setModal, getChild }) {
  const [filter, setFilter] = useState("all");
  const [showHistory, setShowHistory] = useState(false);
  const todayNow = getTodayISO();
  const pagePanel = { background:'linear-gradient(180deg, rgba(15,23,42,.78), rgba(15,23,42,.6))', border:'1px solid rgba(148,163,184,.14)', borderRadius:22, padding:18, boxShadow:'0 18px 40px rgba(2,6,23,.14)' };

  const tasks = [...data.tasks]
    .filter(t => (filter === "all" || t.childId === filter))
    .filter((task) => {
      const info = parseTaskDesc(task.desc, task.coins);
      const isGeneratedRecurringTask = !isRecurringTemplateTask(task) && !!info.recurrenceSourceId;
      if (isGeneratedRecurringTask) return false;
      if (task.status === "template") return true;
      if (task.status === "pending") return true;
      if (shouldKeepCompletedVisible(task, todayNow)) return true;
      if (showHistory && (task.status === "done" || task.status === "approved") && !isTaskOlderThanHistoryWindow(task, todayNow)) return true;
      return false;
    })
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return String(a.title || "").localeCompare(String(b.title || ""));
    });

  const statusEl = (s) => {
    if (s === "template") return <span className="bd" style={{ background: "rgba(139,92,246,.18)", color: "#c4b5fd", border:'1px solid rgba(139,92,246,.22)' }}>🔁 Sjabloon</span>;
    if (s === "pending") return <span className="bd" style={{ background:'rgba(59,130,246,.18)', color:'#bfdbfe', border:'1px solid rgba(59,130,246,.20)' }}>Te doen</span>;
    if (s === "done") return <span className="bd" style={{ background:'rgba(245,158,11,.16)', color:'#fcd34d', border:'1px solid rgba(245,158,11,.22)' }}>⏳ Wacht</span>;
    return <span className="bd" style={{ background:'rgba(34,197,94,.16)', color:'#86efac', border:'1px solid rgba(34,197,94,.22)' }}>✅ Klaar</span>;
  };

  const getValidityLabel = (task) => {
    const info = parseTaskDesc(task.desc, task.coins);
    const recurrenceType = getRecurringType(task);
    if (recurrenceType === "daily") return "Geldig op die dag";
    if (recurrenceType === "weekly" || info.dayPart === "weekly") return `${info.durationDays} ${info.durationDays === 1 ? 'dag' : 'dagen'} om af te ronden`;
    return `${info.durationDays} ${info.durationDays === 1 ? 'dag' : 'dagen'} geldig`;
  };

  const getCoinLabel = (task) => {
    const info = parseTaskDesc(task.desc, task.coins);
    return `🪙${task.status === "template" ? info.maxCoins : task.coins}`;
  };

  const FilterChip = ({ active, onClick, children }) => (
    <button onClick={onClick} style={{ border:'none', borderRadius:999, padding:'10px 14px', fontWeight:800, cursor:'pointer', background: active ? 'linear-gradient(135deg, rgba(99,102,241,.26), rgba(59,130,246,.16))' : 'rgba(255,255,255,.075)', color: active ? '#ffffff' : '#dce7f5', boxShadow: active ? 'inset 0 0 0 1px rgba(129,140,248,.22)' : 'inset 0 0 0 1px rgba(148,163,184,.12)' }}>{children}</button>
  );

  return (
    <div style={{ marginTop:18, display:'grid', gap:16 }}>
      <div style={pagePanel}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap', marginBottom:16 }}>
          <div>
            <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:24, fontWeight:800 }}>Alle Taken</div>
            <div style={{ color:'rgba(226,232,240,.68)', fontSize:14 }}>Kalmer overzicht met betere filtering en minder visuele ruis.</div>
          </div>
          <button className="btn bp" style={{ borderRadius:16, boxShadow:'0 10px 24px rgba(99,102,241,.18)' }} onClick={() => setModal({ type: "task" })}>+ Nieuwe Taak</button>
        </div>
        <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
          <FilterChip active={showHistory} onClick={() => setShowHistory(v => !v)}>{showHistory ? "📚 Geschiedenis aan" : "📚 Geschiedenis uit"}</FilterChip>
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>Alle kinderen</FilterChip>
          {data.children.map(c => <FilterChip key={c.id} active={filter === c.id} onClick={() => setFilter(c.id)}>{getChildAvatar(c)} {c.name}</FilterChip>)}
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="emp" style={{ ...pagePanel }}><div className="ei">📋</div><div className="et">Geen geplande taken zichtbaar.</div></div>
      ) : (
        tasks.map(t => {
          const ch = getChild(t.childId);
          const info = parseTaskDesc(t.desc, t.coins);
          const recurrenceType = getRecurringType(t);
          return (
            <div key={t.id} style={{ ...pagePanel, padding:16, display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
              <div style={{ flex: 1, minWidth:220 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 800, fontSize: 16 }}>{t.title}</span>{statusEl(t.status)}
                </div>
                <div style={{ fontSize: 13, color: 'rgba(226,232,240,.84)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {ch && <span>{ch.avatar} {ch.name}</span>}
                  <span>📅 {t.date}</span>
                  <span>{getDayPartConfig(info.dayPart).emoji} {getDayPartLabel(info.dayPart)}</span>
                  <span>⏳ {getValidityLabel(t)}</span>
                  <span>{info.requiresParentApproval ? "👨‍👩‍👧 Ouder keurt goed" : "⚡ Direct klaar"}</span>
                  {recurrenceType !== "none" && <span>🔁 {getRecurringLabel(t)}</span>}
                </div>
                {info.visibleDesc && <div style={{ fontSize: 12, color: 'rgba(226,232,240,.58)', marginTop: 6 }}>💬 {info.visibleDesc}</div>}
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:12, marginLeft:'auto' }}>
                <span style={{ fontWeight: 900, color: '#fcd34d', fontSize: 15, whiteSpace: 'nowrap' }}>{getCoinLabel(t)} <span style={{ fontSize: 11, color: 'rgba(226,232,240,.52)' }}>/ {info.maxCoins}</span></span>
                {t.status === "pending" ? <button className="btn bh bsm" style={{ color: "var(--red)", borderRadius:14, background:'rgba(255,255,255,.05)', border:'1px solid rgba(248,113,113,.18)' }} onClick={() => db.delTask(t.id)}>🗑</button> : <span style={{ width: 40, textAlign: "center", opacity: 0.45, fontSize: 16 }}>🔒</span>}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function ApproveTab({ data, db, pending, getChild }) {
  const panel = { background:'linear-gradient(180deg, rgba(15,23,42,.78), rgba(15,23,42,.6))', border:'1px solid rgba(148,163,184,.14)', borderRadius:22, padding:18, boxShadow:'0 18px 40px rgba(2,6,23,.14)' };
  return (
    <div style={{ marginTop:18 }}>
      <div style={{ ...panel, marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
          <div>
            <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:24, fontWeight:800 }}>Taken Goedkeuren ✅</div>
            <div style={{ color:'rgba(226,232,240,.68)', fontSize:14 }}>Rustig overzicht van alles wat nog jouw akkoord nodig heeft.</div>
          </div>
          <div style={{ padding:'10px 14px', borderRadius:16, background:'rgba(245,158,11,.10)', border:'1px solid rgba(245,158,11,.22)', color:'#fbbf24', fontWeight:800 }}>{pending.length} open</div>
        </div>
      </div>
      {pending.length === 0
        ? <div className="emp" style={{ ...panel }}><div className="ei">🎉</div><div className="et">Niets te goedkeuren!</div></div>
        : <div style={{ display:'grid', gap:14 }}>{pending.map(t => {
          const ch = getChild(t.childId);
          const info = parseTaskDesc(t.desc, t.coins);
          return (
            <div key={t.id} style={{ ...panel, padding:16, display:'flex', gap:14, alignItems:'center', flexWrap:'wrap' }}>
              <div style={{ width:52, height:52, borderRadius:'50%', display:'grid', placeItems:'center', background:'rgba(59,130,246,.12)', fontSize:28 }}>{ch?.avatar || "🧒"}</div>
              <div style={{ flex:1, minWidth:160 }}>
                <div style={{ fontWeight:800, fontSize:17, marginBottom:4 }}>{t.title}</div>
                <div style={{ fontSize:13, color:'rgba(226,232,240,.84)', display:'flex', gap:10, flexWrap:'wrap' }}>
                  <span>{ch?.name}</span><span>📅 {t.date}</span><span>{getDayPartConfig(info.dayPart).emoji} {getDayPartLabel(info.dayPart)}</span><span>🪙 {t.coins}</span>
                </div>
              </div>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                <button className="btn bg bsm" style={{ borderRadius:14, boxShadow:'0 10px 24px rgba(16,185,129,.12)' }} onClick={() => db.approve(t.id)}>✅ Goedkeuren</button>
                <button className="btn bh bsm" style={{ color: "var(--red)", borderRadius:14, background:'rgba(255,255,255,.05)', border:'1px solid rgba(248,113,113,.22)' }} onClick={() => db.reject(t.id)}>↩ Terug</button>
              </div>
            </div>
          );
        })}</div>
      }
    </div>
  );
}

function KidsTab({ data, db, setModal }) {
  const [pinDrafts, setPinDrafts] = useState({});
  const [coinDrafts, setCoinDrafts] = useState({});
  const [penaltyDrafts, setPenaltyDrafts] = useState({});
  const [penaltyReasons, setPenaltyReasons] = useState({});

  const pinValue = (child) => pinDrafts[child.id] ?? child.pin ?? "";
  const coinValue = (child) => coinDrafts[child.id] ?? String(child.coins ?? 0);
  const penaltyValue = (child) => penaltyDrafts[child.id] ?? "";
  const penaltyReasonValue = (child) => penaltyReasons[child.id] ?? "";

  return (
    <div>
      <div style={{ marginTop:18, marginBottom:16, background:'linear-gradient(180deg, rgba(15,23,42,.78), rgba(15,23,42,.6))', border:'1px solid rgba(148,163,184,.14)', borderRadius:22, padding:18, display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap', boxShadow:'0 18px 40px rgba(2,6,23,.14)' }}><div><div style={{ fontFamily:"'Baloo 2',cursive", fontSize:24, fontWeight:800 }}>Kinderen 👶</div><div style={{ color:'rgba(226,232,240,.68)', fontSize:14 }}>Beheer pins, coins, levels en correcties zonder rommelig gedoe.</div></div><button className="btn bp" style={{ borderRadius:16, boxShadow:'0 10px 24px rgba(99,102,241,.18)' }} onClick={() => setModal({ type: "child" })}>+ Toevoegen</button></div>
      <div className="g3">
        {data.children.map(c => (
          <div key={c.id} className="card dark-form" style={{ textAlign: "center", background:'linear-gradient(180deg, rgba(15,23,42,.78), rgba(15,23,42,.62))', border:'1px solid rgba(148,163,184,.14)', boxShadow:'0 18px 40px rgba(2,6,23,.14)', borderRadius:22, color:'#eef2ff' }}>
            <div style={{ fontSize: 52, marginBottom: 6 }}>{getChildAvatar(c)}</div>
            <div style={{ fontFamily: "'Baloo 2',cursive", fontSize: 19, fontWeight: 800 }}>{c.name}</div>
            <div style={{ fontSize: 21, fontWeight: 900, color: "var(--yel)", margin: "7px 0" }}>🪙 {c.coins}</div>
            <div style={{ fontSize: 12, color: 'rgba(226,232,240,.86)', marginBottom: 12 }}>
              {data.tasks.filter(t => t.childId === c.id && t.status === "approved").length} taken voltooid
            </div>

            <div className="fg" style={{ textAlign: "left", marginBottom: 10 }}>
              <label className="fl">Nieuwe kind-PIN (4 cijfers)</label>
              <input className="fi" inputMode="numeric" maxLength={4} value={pinValue(c)} onChange={e => setPinDrafts(s => ({ ...s, [c.id]: e.target.value.replace(/\D/g, "").slice(0, 4) }))} placeholder="1234" />
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button className="btn bp bsm" style={{ flex: 1 }} onClick={() => db.updateChildPin(c.id, pinValue(c))} disabled={!/^\d{4}$/.test(pinValue(c))}>PIN opslaan</button>
            </div>

            <div className="fg" style={{ textAlign: "left", marginBottom: 10 }}>
              <label className="fl">Coins instellen</label>
              <input className="fi" inputMode="numeric" value={coinValue(c)} onChange={e => setCoinDrafts(s => ({ ...s, [c.id]: e.target.value.replace(/\D/g, "") }))} placeholder="0" />
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <button className="btn bg bsm" style={{ flex: 1 }} onClick={() => db.setChildCoins(c.id, coinValue(c))}>Coins opslaan</button>
              <button className="btn bh bsm" style={{ flex: 1 }} onClick={() => { setCoinDrafts(s => ({ ...s, [c.id]: "0" })); db.setChildCoins(c.id, 0); }}>Reset coins</button>
            </div>

            <div style={{ borderTop:"1px dashed var(--line)", margin:"10px 0 12px" }} />
            <div style={{ fontFamily: "'Baloo 2',cursive", fontSize: 16, fontWeight: 800, marginBottom: 8, color: "#fdba74", textShadow:'0 1px 0 rgba(0,0,0,.15)' }}>⚠️ Straf / ecoins afpakken</div>
            <div className="fg" style={{ textAlign: "left", marginBottom: 10 }}>
              <label className="fl">Aantal ecoins om af te pakken</label>
              <input className="fi" inputMode="numeric" value={penaltyValue(c)} onChange={e => setPenaltyDrafts(s => ({ ...s, [c.id]: e.target.value.replace(/\D/g, "") }))} placeholder="1" />
            </div>
            <div className="fg" style={{ textAlign: "left", marginBottom: 10 }}>
              <label className="fl">Reden</label>
              <input className="fi" value={penaltyReasonValue(c)} onChange={e => setPenaltyReasons(s => ({ ...s, [c.id]: e.target.value }))} placeholder="Bijv. ongeoorloofd gedrag" />
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <button
                className="btn bsm"
                style={{ flex: 1, background:'rgba(251,146,60,.12)', color:'#fff7ed', border:'2px solid rgba(251,146,60,.44)', boxShadow:'0 10px 24px rgba(251,146,60,.08)' }}
                onClick={async () => {
                  await db.takeCoins(c.id, penaltyValue(c), penaltyReasonValue(c));
                  setPenaltyDrafts(s => ({ ...s, [c.id]: "" }));
                  setPenaltyReasons(s => ({ ...s, [c.id]: "" }));
                }}
                disabled={!(Number(penaltyValue(c)) > 0) || !String(penaltyReasonValue(c) || "").trim()}
              >➖ Ecoins afpakken</button>
            </div>
            <div style={{ fontSize: 12, color: '#fdba74', marginBottom: 12, lineHeight:1.45 }}>Het kind ziet deze straf met reden terug in zijn geschiedenis.</div>

            <button className="btn bh bsm" style={{ color: '#fecaca', borderColor:'rgba(248,113,113,.32)', background:'rgba(127,29,29,.12)' }} onClick={() => db.delChild(c.id)}>Verwijder</button>
          </div>
        ))}
        {data.children.length === 0 && <div className="emp" style={{ gridColumn: "1/-1" }}><div className="ei">👶</div><div className="et">Nog geen kinderen</div></div>}
      </div>
    </div>
  );
}

function SettingsTab({ data, db, parentPin }) {
  const [pinDraft, setPinDraft] = useState(parentPin || DEFAULT_PARENT_PIN);
  useEffect(() => { setPinDraft(parentPin || DEFAULT_PARENT_PIN); }, [parentPin]);
  return (
    <div>
      <div style={{ marginTop:18, marginBottom:16, background:'linear-gradient(180deg, rgba(15,23,42,.78), rgba(15,23,42,.6))', border:'1px solid rgba(148,163,184,.14)', borderRadius:22, padding:18, boxShadow:'0 18px 40px rgba(2,6,23,.14)' }}><div style={{ fontFamily:"'Baloo 2',cursive", fontSize:24, fontWeight:800, color:'#eef2ff' }}>Instellingen ⚙️</div><div style={{ color:'rgba(226,232,240,.82)', fontSize:14 }}>Kleine controlekamer voor oudercode en globale resets.</div></div>
      <div className="g2">
        <div className="card dark-form" style={{ background:'linear-gradient(180deg, rgba(15,23,42,.78), rgba(15,23,42,.62))', border:'1px solid rgba(148,163,184,.14)', boxShadow:'0 18px 40px rgba(2,6,23,.14)', color:'#eef2ff' }}>
          <div style={{ fontFamily: "'Baloo 2',cursive", fontSize: 18, fontWeight: 800, marginBottom: 10, color:'#eef2ff' }}>🔐 Ouder login</div>
          <div className="fg">
            <label className="fl">Oudercode (6 cijfers)</label>
            <input className="fi" inputMode="numeric" maxLength={6} value={pinDraft} onChange={e => setPinDraft(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="258000" />
          </div>
          <div style={{ fontSize: 12, color: 'rgba(226,232,240,.9)', marginBottom: 12 }}>Deze oudercode wordt via Supabase gedeeld tussen apparaten.</div>
          <button className="btn bp" onClick={() => db.updateParentPin(pinDraft)} disabled={!/^\d{6}$/.test(pinDraft)}>6-cijferige code opslaan</button>
        </div>
        <div className="card dark-form" style={{ background:'linear-gradient(180deg, rgba(15,23,42,.78), rgba(15,23,42,.62))', border:'1px solid rgba(148,163,184,.14)', boxShadow:'0 18px 40px rgba(2,6,23,.14)', color:'#eef2ff' }}>
          <div style={{ fontFamily: "'Baloo 2',cursive", fontSize: 18, fontWeight: 800, marginBottom: 10, color:'#eef2ff' }}>🪙 Coins beheren</div>
          <div style={{ fontSize: 13, color: 'rgba(226,232,240,.82)', marginBottom: 14, lineHeight:1.5 }}>Handig als alle coins per ongeluk op 0 zijn gekomen of je opnieuw wilt beginnen.</div>
          <button className="btn bh" style={{ color: '#fecaca', borderColor:'rgba(248,113,113,.24)', background:'rgba(127,29,29,.12)' }} onClick={() => db.resetAllCoins()}>Reset alle coins naar 0</button>
          <div style={{ fontSize: 12, color: 'rgba(241,245,249,.92)', marginTop: 10 }}>Per kind aanpassen kan ook in het tabblad <strong>Kinderen</strong>.</div>
        </div>
      </div>
    </div>
  );
}

function RewardsTab({ data, db, setModal }) {
  return (
    <div>
      <div style={{ marginTop:18, marginBottom:16, background:'linear-gradient(180deg, rgba(15,23,42,.78), rgba(15,23,42,.6))', border:'1px solid rgba(148,163,184,.14)', borderRadius:22, padding:18, display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap', boxShadow:'0 18px 40px rgba(2,6,23,.14)' }}><div><div style={{ fontFamily:"'Baloo 2',cursive", fontSize:24, fontWeight:800 }}>Beloningen 🎁</div><div style={{ color:'rgba(226,232,240,.68)', fontSize:14 }}>Rustigere kaarten voor beloningen, met focus op prijs en doelgroep.</div></div><button className="btn bp" style={{ borderRadius:16, boxShadow:'0 10px 24px rgba(99,102,241,.18)' }} onClick={() => setModal({ type: "reward" })}>+ Beloning</button></div>
      <div className="ga">
        {data.rewards.map(r => {
          const rewardMeta = parseRewardDesc(r.desc);
          return (
          <div key={r.id} className="card" style={{ textAlign: "center", background:'linear-gradient(180deg, rgba(15,23,42,.78), rgba(15,23,42,.62))', border:'1px solid rgba(148,163,184,.14)', boxShadow:'0 18px 40px rgba(2,6,23,.14)', borderRadius:22, color:'#eef2ff' }}>
            <div style={{ fontSize: 44, marginBottom: 7 }}>{r.emoji}</div>
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 3 }}>{r.title}</div>
            <div style={{ fontSize: 12, color: "var(--t2)", marginBottom: 6 }}>{rewardMeta.visibleDesc}</div>
            <div style={{ fontSize: 11, color: "var(--pri)", fontWeight: 800, marginBottom: 9 }}>🎯 {getRewardTargetLabel(r, data.children)}</div>
            <div style={{ fontSize: 19, fontWeight: 900, color: "var(--yel)", marginBottom: 12 }}>🪙 {r.cost}</div>
            <button className="btn bh bsm" style={{ color: "var(--red)" }} onClick={() => db.delReward(r.id)}>Verwijder</button>
          </div>
        )})}
        {data.rewards.length === 0 && <div className="emp" style={{ gridColumn: "1/-1" }}><div className="ei">🎁</div><div className="et">Nog geen beloningen</div></div>}
      </div>
    </div>
  );
}

function PurchasesTab({ data, db, getChild }) {
  const [filter, setFilter] = useState("all");

  const sorted = [...data.redemptions]
    .filter(r => filter === "all" || r.childId === filter)
    .sort((a, b) => b.date.localeCompare(a.date));

  const pendingList  = sorted.filter(r => r.status === "pending" && !isPenaltyRedemption(r));
  const restList     = sorted.filter(r => r.status !== "pending" || isPenaltyRedemption(r));

  const headCard = {
    marginTop:18,
    marginBottom:16,
    background:'linear-gradient(180deg, rgba(88,100,124,.96), rgba(114,126,150,.88))',
    border:'1px solid rgba(148,163,184,.24)',
    borderRadius:22,
    padding:18,
    boxShadow:'0 12px 30px rgba(15,23,42,.10)'
  };
  const rowBase = {
    border:'1px solid rgba(148,163,184,.22)',
    borderRadius:20,
    flexWrap:'wrap',
    gap:8,
    boxShadow:'0 10px 24px rgba(15,23,42,.08)',
    color:'#1f2a44'
  };
  const chipBtn = (active) => ({
    background: active ? 'rgba(99,102,241,.18)' : 'rgba(107,114,128,.18)',
    color: '#f8fafc',
    border:'1px solid rgba(148,163,184,.24)'
  });

  const statusLabel = (r) => {
    if (isPenaltyRedemption(r)) return <span style={{ background:'rgba(251,146,60,.16)', color:'#9a3412', border:'1px solid rgba(251,146,60,.24)', borderRadius:50, padding:'2px 10px', fontSize:11, fontWeight:800 }}>⚠️ Straf uitgevoerd</span>;
    if (r.status === 'approved') return <span style={{ background:'rgba(34,197,94,.14)', color:'#166534', border:'1px solid rgba(34,197,94,.2)', borderRadius:50, padding:'2px 10px', fontSize:11, fontWeight:800 }}>✅ Goedgekeurd</span>;
    if (r.status === 'rejected') return <span style={{ background:'rgba(239,68,68,.14)', color:'#991b1b', border:'1px solid rgba(239,68,68,.18)', borderRadius:50, padding:'2px 10px', fontSize:11, fontWeight:800 }}>❌ Afgewezen</span>;
    return <span style={{ background:'rgba(245,158,11,.16)', color:'#92400e', border:'1px solid rgba(245,158,11,.22)', borderRadius:50, padding:'2px 10px', fontSize:11, fontWeight:800 }}>⏳ Wacht op goedkeuring</span>;
  };

  const RedemptionRow = ({ r }) => {
    const ch = getChild(r.childId);
    const penalty = isPenaltyRedemption(r);
    const bg = penalty
      ? 'linear-gradient(180deg, rgba(255,247,237,.96), rgba(255,237,213,.88))'
      : r.status === 'approved'
        ? 'linear-gradient(180deg, rgba(240,253,244,.96), rgba(220,252,231,.88))'
        : r.status === 'rejected'
          ? 'linear-gradient(180deg, rgba(254,242,242,.96), rgba(254,226,226,.88))'
          : 'linear-gradient(180deg, rgba(88,100,124,.96), rgba(114,126,150,.88))';
    return (
      <div className="tr" style={{ ...rowBase, background:bg }}>
        <div style={{ fontSize:32 }}>{r.rewardEmoji}</div>
        <div style={{ flex:1, minWidth:120 }}>
          <div style={{ fontWeight:800, fontSize:15, color:'#172033' }}>{penalty ? 'Ecoins afgepakt' : r.rewardTitle}</div>
          <div style={{ fontSize:12, color:'rgba(31,42,68,.78)', display:'flex', gap:8, marginTop:2, flexWrap:'wrap' }}>
            {ch && <span>{ch.avatar} {ch.name}</span>}
            <span>📅 {r.date}</span>
          </div>
          {penalty && <div style={{ fontSize:12, color:'#9a3412', marginTop:5, fontWeight:700 }}>Reden: {getPenaltyReason(r)}</div>}
          <div style={{ marginTop:5 }}>{statusLabel(r)}</div>
        </div>
        <div style={{ fontWeight:900, color: penalty ? '#c2410c' : '#7c5d00', fontSize:16, whiteSpace:'nowrap' }}>{penalty ? `➖ ${Math.abs(r.cost)}` : `🪙 ${r.cost}`}</div>
        {!penalty && r.status === 'pending' && (
          <div style={{ display:'flex', gap:6 }}>
            <button className="btn bg bsm" onClick={() => db.approveRedemption(r.id)}>✅ Goedkeuren</button>
            <button className="btn bsm" style={{ background:'rgba(239,68,68,.12)', color:'#991b1b', border:'1px solid rgba(239,68,68,.16)' }} onClick={() => db.rejectRedemption(r.id)}>❌ Afwijzen</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div style={headCard}><div style={{ fontFamily:"'Baloo 2',cursive", fontSize:24, fontWeight:800, color:'#1f2a44' }}>Aankopen & straffen 🛍️⚠️</div><div style={{ color:'rgba(31,42,68,.74)', fontSize:14 }}>Eén rustig overzicht voor goedkeuren, afwijzen en terugkijken.</div></div>

      <div className="frow" style={{ marginBottom:16 }}>
        <button className="btn bsm" style={chipBtn(filter==='all')} onClick={() => setFilter('all')}>Alle kinderen</button>
        {data.children.map(c => (
          <button key={c.id} className="btn bsm" style={chipBtn(filter===c.id)} onClick={() => setFilter(c.id)}>{getChildAvatar(c)} {c.name}</button>
        ))}
      </div>

      {pendingList.length > 0 && (
        <div style={{ marginBottom:20 }}>
          <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:15, fontWeight:800, color:'#1f2a44', marginBottom:10 }}>
            ⏳ Wacht op jouw goedkeuring
          </div>
          {pendingList.map(r => <RedemptionRow key={r.id} r={r} />)}
        </div>
      )}

      {restList.length > 0 && (
        <div>
          <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:15, fontWeight:800, color:'#1f2a44', marginBottom:10 }}>
            Eerder behandeld
          </div>
          {restList.map(r => <RedemptionRow key={r.id} r={r} />)}
        </div>
      )}

      {sorted.length === 0 && (
        <div className="emp"><div className="ei">🛍️</div><div className="et">Nog geen aanvragen</div></div>
      )}
    </div>
  );
}

// ─── MODALS ────────────────────────────────────────────────────────────────────
function Modal({ modal, setModal, data, db }) {
  const close = () => setModal(null);
  if (modal.type === "child")  return <AddChildModal  close={close} db={db} />;
  if (modal.type === "task")   return <AddTaskModal   close={close} db={db} children={data.children} />;
  if (modal.type === "reward") return <AddRewardModal close={close} db={db} children={data.children} />;
  return null;
}

function AddChildModal({ close, db }) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("🧒");
  const go = () => { if (name.trim()) { db.addChild({ name: name.trim(), avatar }); close(); } };
  return (
    <div className="ov" onClick={close}>
      <div className="mo" onClick={e => e.stopPropagation()}>
        <div className="mt">👶 Kind toevoegen</div>
        <div className="fg"><label className="fl">Naam</label>
          <input className="fi" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && go()} placeholder="Naam van het kind" autoFocus />
        </div>
        <div className="fg"><label className="fl">Avatar</label>
          <div className="ap">{AVATARS.map(a => <div key={a} className={`ao ${avatar === a ? "aon" : ""}`} onClick={() => setAvatar(a)}>{a}</div>)}</div>
        </div>
        <div className="ma">
          <button className="btn bh" onClick={close}>Annuleren</button>
          <button className="btn bp" onClick={go} disabled={!name.trim()}>Toevoegen</button>
        </div>
      </div>
    </div>
  );
}

function AddTaskModal({ close, db, children }) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [childId, setChildId] = useState(children[0]?.id || "");
  const [coins, setCoins] = useState(10);
  const [date, setDate] = useState(today);
  const [durationDays, setDurationDays] = useState(3);
  const [dayPart, setDayPart] = useState("allDay");
  const [recurrenceType, setRecurrenceType] = useState("none");
  const [requiresParentApproval, setRequiresParentApproval] = useState(true);
  const [manualEmoji, setManualEmoji] = useState("");
  const [emojiQuery, setEmojiQuery] = useState("");
  const BOTH_CHILDREN_VALUE = "__all_children__";
  const isDailyTemplate = recurrenceType === "daily";
  const isWeeklyTemplate = recurrenceType === "weekly";
  const effectiveDurationDays = isDailyTemplate ? 1 : Math.max(1, Number(durationDays) || 1);
  const effectiveDayPart = isWeeklyTemplate ? "weekly" : (dayPart === "weekly" ? "allDay" : dayPart);

  useEffect(() => {
    if (isDailyTemplate && durationDays !== 1) setDurationDays(1);
  }, [isDailyTemplate, durationDays]);

  useEffect(() => {
    if (isWeeklyTemplate && dayPart !== "weekly") {
      setDayPart("weekly");
      return;
    }
    if (!isWeeklyTemplate && dayPart === "weekly") {
      setDayPart("allDay");
    }
  }, [isWeeklyTemplate, dayPart]);

  const autoEmoji = getAutoTaskEmoji(title, desc, effectiveDayPart);
  const emojiSuggestions = Array.from(new Set([
    autoEmoji,
    ...searchEmojis(`${title} ${desc} ${emojiQuery}`),
    ...ALL_EMOJIS.slice(0, 12),
  ])).slice(0, 24);
  const selectedEmoji = (manualEmoji || "").trim();
  const effectiveTaskEmoji = selectedEmoji || autoEmoji;

  const go = async () => {
    if (!title.trim() || !childId) return;

    const createTaskPayload = (targetChildId) => ({
      title: title.trim(),
      desc: encodeTaskDesc(desc, {
        maxCoins: +coins,
        durationDays: effectiveDurationDays,
        recurrenceType,
        isTemplate: recurrenceType !== "none",
        recurrenceSourceId: null,
        dayPart: effectiveDayPart,
        requiresParentApproval,
        lockedCoins: null,
        taskEmoji: selectedEmoji,
      }),
      coins: +coins,
      date,
      childId: targetChildId,
      status: recurrenceType !== "none" ? "template" : "pending",
    });

    if (childId === BOTH_CHILDREN_VALUE) {
      await Promise.all(children.map((child) => db.addTask(createTaskPayload(child.id))));
    } else {
      await db.addTask(createTaskPayload(childId));
    }
    close();
  };

  return (
    <div className="ov" onClick={close}>
      <div className="mo" onClick={e => e.stopPropagation()}>
        <div className="mt">📋 Nieuwe Taak</div>
        {children.length === 0 ? (
          <p style={{ color: "var(--t2)" }}>Voeg eerst een kind toe.</p>
        ) : (
          <>
            <div className="fg"><label className="fl">Taaknaam</label>
              <input className="fi" value={title} onChange={e => setTitle(e.target.value)} placeholder="bv. Kamer opruimen" autoFocus />
            </div>
            <div className="fg"><label className="fl">Omschrijving (optioneel)</label>
              <textarea className="ft" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Extra uitleg..." />
            </div>
            <div className="fg">
              <label className="fl">Emoji bij de taak (optioneel)</label>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div className="fi" style={{ width: 74, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30, fontWeight: 800 }} title={selectedEmoji ? "Handmatig gekozen emoji" : "Automatisch gekozen emoji"}>{effectiveTaskEmoji}</div>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <input className="fi" value={emojiQuery} onChange={e => setEmojiQuery(e.target.value)} placeholder="Zoek emoji, bv. tanden, lezen, opruimen" />
                  <div style={{ fontSize: 11, color: "var(--t2)", marginTop: 6 }}>
                    Automatisch gekozen: <strong>{autoEmoji}</strong>{selectedEmoji ? <> · handmatige keuze actief: <strong>{selectedEmoji}</strong></> : <> · geen handmatige keuze, dus deze wordt gebruikt</>}
                  </div>
                </div>
                <button type="button" className="btn bh" onClick={() => setManualEmoji("")} disabled={!selectedEmoji}>Automatisch</button>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                {emojiSuggestions.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => setManualEmoji(emoji)}
                    title={`Gebruik ${emoji} voor deze taak`}
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 14,
                      border: manualEmoji === emoji ? "2px solid var(--pri)" : "1px solid var(--line)",
                      background: manualEmoji === emoji ? "color-mix(in srgb, var(--pri) 14%, white)" : "#fff",
                      cursor: "pointer",
                      fontSize: 22,
                      boxShadow: manualEmoji === emoji ? "0 6px 16px rgba(99,102,241,0.18)" : "none",
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
            <div className="fr">
              <div className="fg"><label className="fl">Kind</label>
                <select className="fs" value={childId} onChange={e => setChildId(e.target.value)}>
                  {children.length > 1 && <option value={BOTH_CHILDREN_VALUE}>👦👧 Beide kinderen</option>}
                  {children.map(c => <option key={c.id} value={c.id}>{getChildAvatar(c)} {c.name}</option>)}
                </select>
                <div style={{ fontSize: 11, color: "var(--t2)", marginTop: 6 }}>
                  {childId === BOTH_CHILDREN_VALUE ? "Er worden twee losse taken aangemaakt, één per kind." : "Deze taak wordt aan één kind toegewezen."}
                </div>
              </div>
              <div className="fg"><label className="fl">Startdatum</label>
                <input className="fi" type="date" value={date} onChange={e => setDate(e.target.value)} />
              </div>
            </div>
            <div className="fr">
              <div className="fg"><label className="fl">Dagdeel</label>
                <select className="fs" value={effectiveDayPart} onChange={e => setDayPart(normalizeDayPart(e.target.value))} disabled={isWeeklyTemplate}>
                  {DAY_PART_OPTIONS.filter(option => isWeeklyTemplate ? option.value === "weekly" : option.value !== "weekly").map(option => <option key={option.value} value={option.value}>{option.emoji} {option.label}</option>)}
                </select>
                <div style={{ fontSize: 11, color: "var(--t2)", marginTop: 6 }}>
                  {isWeeklyTemplate ? "Wekelijkse taken komen altijd in het blok Weektaken." : "Kies wanneer het kind deze taak op de dag ziet."}
                </div>
              </div>
              <div className="fg"><label className="fl">Herhaling</label>
                <select className="fs" value={recurrenceType} onChange={e => setRecurrenceType(e.target.value)}>
                  <option value="none">Eenmalig</option>
                  <option value="daily">Dagelijks</option>
                  <option value="weekly">Wekelijks</option>
                </select>
              </div>
            </div>
            <div className="fr">
              <div className="fg">
                <label className="fl">Goedkeuring nodig</label>
                <select className="fs" value={requiresParentApproval ? "yes" : "no"} onChange={e => setRequiresParentApproval(e.target.value === "yes")}>
                  <option value="yes">Ja, ouder moet goedkeuren</option>
                  <option value="no">Nee, direct definitief</option>
                </select>
              </div>
              {!isDailyTemplate ? (
                <div className="fg"><label className="fl">Beschikbaar in dagen</label>
                  <input className="fi" type="number" min="1" max="14" value={effectiveDurationDays} onChange={e => setDurationDays(Math.max(1, Math.min(14, Number(e.target.value) || 1)))} />
                </div>
              ) : (
                <div className="fg">
                  <label className="fl">Beschikbaar in dagen</label>
                  <div className="fi" style={{ display: "flex", alignItems: "center", color: "var(--t2)", background: "var(--bg2)" }}>Dagelijkse taken zijn altijd alleen geldig op die dag.</div>
                </div>
              )}
            </div>
            {!isDailyTemplate && (
              <div className="fg">
                <label className="fl">⏳ Aantal dagen beschikbaar: <strong>{effectiveDurationDays}</strong></label>
                <input type="range" min="1" max="14" value={effectiveDurationDays} onChange={e => setDurationDays(Number(e.target.value))} style={{ width: "100%", accentColor: "var(--pri)", cursor: "pointer" }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--t2)" }}>
                  <span>1 dag</span>
                  <span>{Math.floor(coins / Math.max(1, effectiveDurationDays))} coin verval per gemiste dag{coins % Math.max(1, effectiveDurationDays) !== 0 ? ` · laatste dag ${coins - (Math.floor(coins / Math.max(1, effectiveDurationDays)) * (Math.max(1, effectiveDurationDays) - 1))}` : ""}</span>
                  <span>14 dagen</span>
                </div>
              </div>
            )}
            <div className="fg">
              <label className="fl">🪙 Maximaal te verdienen coins: <strong>{coins}</strong></label>
              <input type="range" min="1" max="50" value={coins} onChange={e => setCoins(Number(e.target.value))} style={{ width: "100%", accentColor: "var(--pri)", cursor: "pointer" }} />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--t2)" }}><span>1</span><span>50</span></div>
            </div>
            <div style={{ fontSize: 12, color: "var(--t2)", marginTop: -4 }}>
              <>
                Start op <strong>{date}</strong> · emoji <strong>{effectiveTaskEmoji}</strong> · {getDayPartConfig(effectiveDayPart).emoji} {effectiveDayPart === "weekly" ? <>zichtbaar als <strong>weektaak</strong> in het weektaken-blok</> : <>zichtbaar vanaf <strong>{getDayPartLabel(effectiveDayPart).toLowerCase()}</strong></>}
                {recurrenceType === "none" ? (
                  <> · geldig op de startdag en de daaropvolgende <strong>{Math.max(0, effectiveDurationDays - 1)}</strong> dag{Number(effectiveDurationDays) === 1 ? "" : "en"} · op de dag daarna kan hij op 0 komen en verdwijnen.</>
                ) : recurrenceType === "daily" ? (
                  <> · dit wordt opgeslagen als <strong>dagelijks sjabloon</strong> en maakt alleen op die dag een losse taak aan. Dagelijkse taken zijn altijd maar <strong>1 dag</strong> geldig.</>
                ) : (
                  <> · dit wordt opgeslagen als <strong>wekelijks sjabloon</strong> en maakt per week één losse <strong>weektaak</strong> aan met een looptijd van <strong>{effectiveDurationDays}</strong> dag{effectiveDurationDays === 1 ? "" : "en"}.</>
                )}
                {!requiresParentApproval && <> · kind krijgt de coins direct bij afvinken.</>}
              </>
            </div>
          </>
        )}
        <div className="ma">
          <button className="btn bh" onClick={close}>Annuleren</button>
          {children.length > 0 && <button className="btn bp" onClick={go} disabled={!title.trim()}>Aanmaken</button>}
        </div>
      </div>
    </div>
  );
}

function AddRewardModal({ close, db, children }) {
  const [title,      setTitle]      = useState("");
  const [desc,       setDesc]       = useState("");
  const [cost,       setCost]       = useState(1);
  const [emoji,      setEmoji]      = useState("🎁");
  const [emojiPicked,setEmojiPicked]= useState(false); // gebruiker heeft handmatig gekozen
  const ALL_CHILDREN_VALUE = "__reward_all_children__";
  const [targetChildId, setTargetChildId] = useState(ALL_CHILDREN_VALUE);

  // Live emoji suggesties op basis van naam
  const suggestions = searchEmojis(title);
  const shown = suggestions.slice(0, 40);

  // Auto-selecteer eerste suggestie als gebruiker nog niet handmatig koos
  useEffect(() => {
    if (!emojiPicked && shown.length > 0) setEmoji(shown[0]);
  }, [title]);

  const pickEmoji = (e) => { setEmoji(e); setEmojiPicked(true); };

  const go = () => {
    if (title.trim()) {
      const targetChildIds = targetChildId === ALL_CHILDREN_VALUE ? [] : [targetChildId];
      db.addReward({ title: title.trim(), desc: encodeRewardDesc(desc, { targetChildIds }), cost: Math.max(1, Number(cost) || 1), emoji });
      close();
    }
  };

  return (
    <div className="ov" onClick={close}>
      <div className="mo" onClick={e => e.stopPropagation()}>
        <div className="mt">🎁 Beloning toevoegen</div>

        {/* Naam — eerst, want stuurt emoji-suggesties aan */}
        <div className="fg">
          <label className="fl">Naam van de beloning</label>
          <input
            className="fi" value={title} autoFocus
            onChange={e => { setTitle(e.target.value); setEmojiPicked(false); }}
            placeholder="bv. ijsje, bioscoop, gamen..."
          />
        </div>

        {/* Emoji suggesties */}
        <div className="fg">
          <label className="fl" style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <span>Kies een emoji</span>
            <span style={{ fontWeight:600, color:"var(--t2)", fontSize:11 }}>
              {title.trim() ? "✨ Gesorteerd op jouw naam" : "Alle emoji's"}
            </span>
          </label>

          {/* Grote geselecteerde emoji preview */}
          <div style={{
            display:"flex", alignItems:"center", gap:14, marginBottom:10,
            background:"var(--pri-l)", borderRadius:14, padding:"10px 16px",
            border:"2px solid var(--pri)"
          }}>
            <span style={{ fontSize:42 }}>{emoji}</span>
            <div>
              <div style={{ fontWeight:800, fontSize:13, color:"var(--pri)" }}>Geselecteerd</div>
              <div style={{ fontSize:11, color:"var(--t2)" }}>Tik hieronder om te wisselen</div>
            </div>
          </div>

          {/* Scrollbare emoji grid */}
          <div style={{
            display:"grid", gridTemplateColumns:"repeat(8,1fr)", gap:4,
            maxHeight:180, overflowY:"auto", padding:4,
            background:"var(--sur2)", borderRadius:12, border:"2px solid var(--bor)"
          }}>
            {shown.map((e,i) => (
              <div
                key={e+i}
                onClick={() => pickEmoji(e)}
                title={e}
                style={{
                  fontSize:26, cursor:"pointer", padding:6, borderRadius:9,
                  textAlign:"center", lineHeight:1, transition:"all .15s",
                  border: emoji === e ? "2px solid var(--pri)" : "2px solid transparent",
                  background: emoji === e ? "var(--pri-l)" : "transparent",
                  transform: emoji === e ? "scale(1.2)" : "scale(1)",
                }}
              >{e}</div>
            ))}
          </div>
          {title.trim() && shown.length === 0 && (
            <div style={{ fontSize:12, color:"var(--t2)", marginTop:6, textAlign:"center" }}>
              Geen matches — typ iets anders of kies handmatig hierboven
            </div>
          )}
        </div>

        <div className="fg">
          <label className="fl">Omschrijving (optioneel)</label>
          <input className="fi" value={desc} onChange={e => setDesc(e.target.value)} placeholder="bv. Eén bolletje ijs" />
        </div>

        <div className="fg">
          <label className="fl">Voor welk kind is deze beloning?</label>
          <select className="fs" value={targetChildId} onChange={e => setTargetChildId(e.target.value)}>
            <option value={ALL_CHILDREN_VALUE}>👦👧 Alle kinderen</option>
            {children.map(c => <option key={c.id} value={c.id}>{getChildAvatar(c)} {c.name}</option>)}
          </select>
          <div style={{ fontSize:12, color:"var(--t2)", marginTop:6 }}>
            {targetChildId === ALL_CHILDREN_VALUE ? "Deze beloning is zichtbaar voor alle kinderen." : "Deze beloning is alleen zichtbaar voor het gekozen kind."}
          </div>
        </div>

        <div className="fg">
          <label className="fl">🪙 Kosten: <strong>{cost}</strong></label>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 92px", gap:10, alignItems:"center" }}>
            <input
              type="range"
              min="1"
              max="200"
              step="1"
              value={cost}
              onChange={e => setCost(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
              style={{ width:"100%", accentColor:"var(--pri)", cursor:"pointer" }}
            />
            <input
              className="fi"
              type="number"
              min="1"
              max="200"
              step="1"
              value={cost}
              onChange={e => {
                const raw = e.target.value;
                if (raw === "") return setCost("");
                setCost(Math.max(1, Math.min(200, Number(raw) || 1)));
              }}
              onBlur={() => setCost(Math.max(1, Math.min(200, Number(cost) || 1)))}
              placeholder="1"
              style={{ textAlign:"center", fontWeight:800 }}
            />
          </div>
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"var(--t2)" }}>
            <span>1</span><span>50</span><span>100</span><span>150</span><span>200</span>
          </div>
        </div>

        <div className="ma">
          <button className="btn bh" onClick={close}>Annuleren</button>
          <button className="btn bp" onClick={go} disabled={!title.trim()}>
            {emoji} Aanmaken
          </button>
        </div>
      </div>
    </div>
  );
}
