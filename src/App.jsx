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
async function fetchParentPinFromCloud() {
  const res = await supabase.from("rewards").select("id,title,description").eq("id", CLOUD_SETTINGS_REWARD_ID).maybeSingle();
  if (res.error) throw new Error(`loadParentPin: ${res.error.message}`);
  const raw = res.data?.description || "";
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return /^\d{6}$/.test(parsed?.parentPin || "") ? parsed.parentPin : null;
  } catch {
    return null;
  }
}
async function saveParentPinToCloud(pin) {
  const payload = { id: CLOUD_SETTINGS_REWARD_ID, title: CLOUD_SETTINGS_TITLE, description: JSON.stringify({ parentPin: pin }), cost: 999999, emoji: "🔐" };
  const res = await supabase.from("rewards").upsert(payload, { onConflict: "id" }).select("id").single();
  if (res.error) throw new Error(`saveParentPin: ${res.error.message}`);
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

  return { visibleDesc, maxCoins, durationDays, baseDecay, lastDecay, doneOn, approvedOn, recurrenceType, isTemplate, recurrenceSourceId, dayPart, requiresParentApproval, lockedCoins };
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

function searchEmojis(query) {
  if (!query || query.trim().length < 1) return ALL_EMOJIS.slice(0, 30);
  const q = query.toLowerCase().trim();
  const words = q.split(/\s+/);
  const scored = EMOJI_DB.map(item => {
    let score = 0;
    words.forEach(w => {
      if (item.t.includes(w)) score += w.length > 3 ? 3 : 1;
    });
    return { ...item, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  // always show some emojis even with no match
  if (scored.length === 0) return ALL_EMOJIS.slice(0, 30);
  return scored.map(x => x.e);
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
      [[523.25, 0, 0.12], [659.25, 0.1, 0.12], [783.99, 0.2, 0.12], [1046.5, 0.32, 0.25]].forEach(([freq, delay, dur]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.value = freq;
        const t = ctx.currentTime + delay;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.3, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.start(t); osc.stop(t + dur + 0.05);
      });
    } catch(e) {}
  }, [getCtx]);

  const playCoin = useCallback(async (index = 0) => {
    try {
      const ctx = await getCtx();
      if (!ctx) return;
      const delay = index * 0.12;
      // coin clink: short high sine with quick decay
      const freqs = [1318.5, 1567.98, 1760, 2093];
      const freq = freqs[index % freqs.length];
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "triangle";
      osc.frequency.value = freq;
      const t = ctx.currentTime + delay;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t); osc.stop(t + 0.4);
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
  .flying-coin{position:fixed;font-size:28px;pointer-events:none;z-index:9999;animation:flyCoin var(--dur) ease-out forwards}
  @keyframes flyCoin{
    0%  { transform:translate(0,0) scale(1) rotate(0deg);   opacity:1 }
    60% { transform:translate(var(--tx),var(--ty-mid)) scale(1.3) rotate(180deg); opacity:1 }
    100%{ transform:translate(var(--tx),var(--ty))    scale(0.4) rotate(360deg); opacity:0 }
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

  useEffect(() => {
    const count = Math.min(Math.max(Math.floor(coins / 3), 4), 10);
    const newParticles = Array.from({ length: count }, (_, i) => ({
      id: genId(),
      delay: i * 0.08,
      dur: 0.8 + Math.random() * 0.4,
      tx: (Math.random() - 0.5) * 220,
      tyMid: -(120 + Math.random() * 100),
      ty: -(200 + Math.random() * 80),
      startX: window.innerWidth * 0.3 + Math.random() * window.innerWidth * 0.4,
      startY: window.innerHeight * 0.55 + Math.random() * 80,
    }));
    setParticles(newParticles);

    const maxDur = (count - 1) * 80 + 1200 + 400;
    const timer = setTimeout(onDone, maxDur);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
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

// ─── APP ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,    setScreen]    = useState("home");
  const [data,      setData]      = useState(INIT);
  const [loading,   setLoading]   = useState(true);
  const [modal,     setModal]     = useState(null);
  const [activeKid, setActiveKid] = useState(null);
  const [tab,       setTab]       = useState("tasks");
  const [kidTab,    setKidTab]    = useState("tasks");
  const [prevApproved, setPrevApproved] = useState({});
  const [showCoins,    setShowCoins]    = useState(null);
  const activeKidName = data.children.find(c => c.id === activeKid)?.name || "";
  const { playTaskDone, playCoinBurst, playAllDone, playSpend, playDrumroll } = useSound();
  const coinTargetRef = useRef(null);
  const [showFeest, setShowFeest] = useState(false);
  const [pinChild,  setPinChild]  = useState(null);
  const [pinParent, setPinParent] = useState(false);
  const [parentPin, setParentPin] = useState(DEFAULT_PARENT_PIN);

  // ── Laad data uit Supabase bij opstarten ──
  useEffect(() => {
    Promise.allSettled([loadAll(), fetchParentPinFromCloud()])
      .then(([dataRes, pinRes]) => {
        if (dataRes.status === "fulfilled") setData(stripCloudSettingsFromData(dataRes.value));
        else console.error("Laad fout:", dataRes.reason);
        if (pinRes.status === "fulfilled" && /^\d{6}$/.test(pinRes.value || "")) {
          setParentPin(pinRes.value);
          setStoredParentPin(pinRes.value);
        } else {
          setParentPin(getStoredParentPin());
        }
        setLoading(false);
      })
      .catch(err => { console.error("Laad fout:", err); setParentPin(getStoredParentPin()); setLoading(false); });
  }, []);

  // ── Helper: herlaad alle data na een wijziging ──
  const reload = useCallback(() => Promise.allSettled([loadAll(), fetchParentPinFromCloud()])
    .then(([dataRes, pinRes]) => {
      if (dataRes.status === "fulfilled") setData(stripCloudSettingsFromData(dataRes.value));
      else console.error(dataRes.reason);
      if (pinRes.status === "fulfilled" && /^\d{6}$/.test(pinRes.value || "")) {
        setParentPin(pinRes.value);
        setStoredParentPin(pinRes.value);
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
      await saveParentPinToCloud(pin);
      setStoredParentPin(pin);
      setParentPin(pin);
      reload();
    },
    delChild: async (id) => {
      await dbDelChild(id);
      reload();
    },
    addTask: async (t) => {
      const id = genId();
      await dbAddTask({ id, status: t.status || 'pending', ...t });
      reload();
    },
    delTask: async (id) => {
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
        if (child) await dbUpdateChildCoins(child.id, child.coins + earnedCoins);
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
      if (child) await dbUpdateChildCoins(child.id, child.coins + approvedCoins);
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
          <HomeScreen data={data} onSelectKid={openChildScreen} onParent={() => setPinParent(true)} playDrumroll={playDrumroll} />
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
function HomeScreen({ data, onSelectKid, onParent, playDrumroll }) {
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
          const todayDone = data.tasks.filter(t => t.childId === c.id && !isRecurringTemplateTask(t) && t.date === today && t.status !== "pending").length;
          const todayTotal = data.tasks.filter(t => t.childId === c.id && !isRecurringTemplateTask(t) && t.date === today && (t.status !== "pending" || isTaskVisibleForChildNow(t))).length;
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
function ChildView({ data, db, activeKid, kidTab, setKidTab, playTaskDone, playAllDone, playSpend, onAllDone, coinTargetRef }) {
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
        <div style={{ fontWeight: 800, fontSize: 16, textDecoration: appr ? "line-through" : "none", color: appr ? "var(--t2)" : "#1e2340" }}>{task.title}</div>
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
function ParentView({ data, db, tab, setTab, setModal, parentPin }) {
  const pending             = data.tasks.filter(t => t.status === "done");
  const pendingRedemptions  = data.redemptions.filter(r => r.status === "pending");
  const getChild = (id) => data.children.find(c => c.id === id);

  return (
    <div>
      <div style={{ marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontFamily: "'Baloo 2',cursive", fontSize: 24, fontWeight: 800, marginBottom: 3 }}>Ouderoverzicht 👨‍👩‍👧</h1>
          <p style={{ color: "var(--t2)", fontSize: 13 }}>Beheer taken, kinderen en beloningen</p>
        </div>
        {(pending.length > 0 || pendingRedemptions.length > 0) && (
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {pending.length > 0 && (
              <div style={{ background: "var(--yel-l)", border: "2px solid var(--yel)", borderRadius: 10, padding: "7px 14px", fontWeight: 700, fontSize: 13, color: "#b45309" }}>
                ⏳ {pending.length} taak{pending.length > 1 ? "en" : ""} wacht op goedkeuring
              </div>
            )}
            {pendingRedemptions.length > 0 && (
              <div style={{ background: "#fce7ff", border: "2px solid #d946a8", borderRadius: 10, padding: "7px 14px", fontWeight: 700, fontSize: 13, color: "#a8157c" }}>
                🛍️ {pendingRedemptions.length} aankoop{pendingRedemptions.length > 1 ? "en" : ""} wacht op goedkeuring
              </div>
            )}
          </div>
        )}
      </div>
      <div className="tabs">
        {[
          ["tasks",   "📋 Taken"],
          ["approve", `✅ Goedkeuren${pending.length ? ` (${pending.length})` : ""}`],
          ["kids",    "👶 Kinderen"],
          ["rewards", "🎁 Beloningen"],
          ["purchases", `🛍️ Aankopen${pendingRedemptions.length ? ` (${pendingRedemptions.length})` : ""}`],
          ["settings",  "⚙️ Instellingen"],
        ].map(([k,l]) => (
          <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{l}</button>
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
  const tasks = [...data.tasks]
    .filter(t => (
      (filter === "all" || t.childId === filter) &&
      (
        t.status === "template" ||
        t.status === "pending" ||
        shouldKeepCompletedVisible(t, todayNow) ||
        (showHistory && (t.status === "done" || t.status === "approved") && !isTaskOlderThanHistoryWindow(t, todayNow))
      )
    ))
    .sort((a,b) => a.date.localeCompare(b.date));
  const statusEl = (s) => {
    if (s === "template") return <span className="bd" style={{ background: "#ede9fe", color: "#6d28d9" }}>🔁 Sjabloon</span>;
    if (s === "pending") return <span className="bd bbl">Te doen</span>;
    if (s === "done") return <span className="bd by">⏳ Wacht</span>;
    return <span className="bd bgn">✅ Klaar</span>;
  };
  return (
    <div>
      <div className="sh">
        <span className="st">Alle Taken</span>
        <button className="btn bp" onClick={() => setModal({ type: "task" })}>+ Nieuwe Taak</button>
      </div>
      <div className="frow">
        <button className={`btn bsm ${showHistory ? "bp" : "bh"}`} onClick={() => setShowHistory(v => !v)}>{showHistory ? "📚 Verberg geschiedenis" : "📚 Toon geschiedenis"}</button>
        <button className={`btn bsm ${filter === "all" ? "bp" : "bh"}`} onClick={() => setFilter("all")}>Alle kinderen</button>
        {data.children.map(c => (
          <button key={c.id} className={`btn bsm ${filter === c.id ? "bp" : "bh"}`} onClick={() => setFilter(c.id)}>{getChildAvatar(c)} {c.name}</button>
        ))}
      </div>


      {tasks.length === 0
        ? <div className="emp"><div className="ei">📋</div><div className="et">Geen losse taken — maak er een aan!</div></div>
        : tasks.map(t => {
          const ch = getChild(t.childId);
          return (
            <div key={t.id} className="tr">
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{t.title}</span>{statusEl(t.status)}
                                  </div>
                <div style={{ fontSize: 12, color: "var(--t2)", display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {ch && <span>{ch.avatar} {ch.name}</span>}
                  <span>📅 {t.date}</span>
                  <span>{getDayPartConfig(parseTaskDesc(t.desc, t.coins).dayPart).emoji} {getDayPartLabel(parseTaskDesc(t.desc, t.coins).dayPart)}</span>
                  <span>{parseTaskDesc(t.desc, t.coins).requiresParentApproval ? "👨‍👩‍👧 Ouder keurt goed" : "⚡ Direct klaar"}</span>
                  {getRecurringType(t) !== "none" && <span>🔁 {getRecurringLabel(t)}</span>}
                  {parseTaskDesc(t.desc, t.coins).visibleDesc && <span>💬 {parseTaskDesc(t.desc, t.coins).visibleDesc}</span>}
                </div>
              </div>
              <span style={{ fontWeight: 800, color: "var(--yel)", fontSize: 14, whiteSpace: "nowrap" }}>🪙{t.coins} <span style={{ fontSize: 11, color: "var(--t2)" }}>/ {parseTaskDesc(t.desc, t.coins).maxCoins}</span></span>
              <button className="btn bh bsm" style={{ color: "var(--red)" }} onClick={() => db.delTask(t.id)}>🗑</button>
            </div>
          );
        })
      }
    </div>
  );
}

function ApproveTab({ data, db, pending, getChild }) {
  return (
    <div>
      <div className="st" style={{ marginBottom: 14 }}>Taken Goedkeuren ✅</div>
      {pending.length === 0
        ? <div className="emp"><div className="ei">🎉</div><div className="et">Niets te goedkeuren!</div></div>
        : pending.map(t => {
          const ch = getChild(t.childId);
          return (
            <div key={t.id} className="pi">
              <div style={{ fontSize: 26 }}>{ch?.avatar || "🧒"}</div>
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{t.title}</div>
                <div style={{ fontSize: 12, color: "var(--t2)" }}>{ch?.name} · 📅 {t.date} · 🪙 {t.coins}</div>
              </div>
              <button className="btn bg bsm" onClick={() => db.approve(t.id)}>✅ Goedkeuren</button>
              <button className="btn bh bsm" style={{ color: "var(--red)" }} onClick={() => db.reject(t.id)}>↩ Terug</button>
            </div>
          );
        })
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
      <div className="sh">
        <span className="st">Kinderen 👶</span>
        <button className="btn bp" onClick={() => setModal({ type: "child" })}>+ Toevoegen</button>
      </div>
      <div className="g3">
        {data.children.map(c => (
          <div key={c.id} className="card" style={{ textAlign: "center" }}>
            <div style={{ fontSize: 52, marginBottom: 6 }}>{getChildAvatar(c)}</div>
            <div style={{ fontFamily: "'Baloo 2',cursive", fontSize: 19, fontWeight: 800 }}>{c.name}</div>
            <div style={{ fontSize: 21, fontWeight: 900, color: "var(--yel)", margin: "7px 0" }}>🪙 {c.coins}</div>
            <div style={{ fontSize: 12, color: "var(--t2)", marginBottom: 12 }}>
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
            <div style={{ fontFamily: "'Baloo 2',cursive", fontSize: 16, fontWeight: 800, marginBottom: 8, color: "#9a3412" }}>⚠️ Straf / ecoins afpakken</div>
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
                style={{ flex: 1, background:"#fff7ed", color:"#9a3412", border:"2px solid #fdba74" }}
                onClick={async () => {
                  await db.takeCoins(c.id, penaltyValue(c), penaltyReasonValue(c));
                  setPenaltyDrafts(s => ({ ...s, [c.id]: "" }));
                  setPenaltyReasons(s => ({ ...s, [c.id]: "" }));
                }}
                disabled={!(Number(penaltyValue(c)) > 0) || !String(penaltyReasonValue(c) || "").trim()}
              >➖ Ecoins afpakken</button>
            </div>
            <div style={{ fontSize: 12, color: "#9a3412", marginBottom: 12 }}>Het kind ziet deze straf met reden terug in zijn geschiedenis.</div>

            <button className="btn bh bsm" style={{ color: "var(--red)" }} onClick={() => db.delChild(c.id)}>Verwijder</button>
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
      <div className="sh"><span className="st">Instellingen ⚙️</span></div>
      <div className="g2">
        <div className="card">
          <div style={{ fontFamily: "'Baloo 2',cursive", fontSize: 18, fontWeight: 800, marginBottom: 10 }}>🔐 Ouder login</div>
          <div className="fg">
            <label className="fl">Oudercode (6 cijfers)</label>
            <input className="fi" inputMode="numeric" maxLength={6} value={pinDraft} onChange={e => setPinDraft(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="258000" />
          </div>
          <div style={{ fontSize: 12, color: "var(--t2)", marginBottom: 12 }}>Deze oudercode wordt via Supabase gedeeld tussen apparaten.</div>
          <button className="btn bp" onClick={() => db.updateParentPin(pinDraft)} disabled={!/^\d{6}$/.test(pinDraft)}>6-cijferige code opslaan</button>
        </div>
        <div className="card">
          <div style={{ fontFamily: "'Baloo 2',cursive", fontSize: 18, fontWeight: 800, marginBottom: 10 }}>🪙 Coins beheren</div>
          <div style={{ fontSize: 13, color: "var(--t2)", marginBottom: 14 }}>Handig als alle coins per ongeluk op 0 zijn gekomen of je opnieuw wilt beginnen.</div>
          <button className="btn bh" style={{ color: "var(--red)" }} onClick={() => db.resetAllCoins()}>Reset alle coins naar 0</button>
          <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 10 }}>Per kind aanpassen kan ook in het tabblad <strong>Kinderen</strong>.</div>
        </div>
      </div>
    </div>
  );
}

function RewardsTab({ data, db, setModal }) {
  return (
    <div>
      <div className="sh">
        <span className="st">Beloningen 🎁</span>
        <button className="btn bp" onClick={() => setModal({ type: "reward" })}>+ Beloning</button>
      </div>
      <div className="ga">
        {data.rewards.map(r => {
          const rewardMeta = parseRewardDesc(r.desc);
          return (
          <div key={r.id} className="card" style={{ textAlign: "center" }}>
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

  const statusLabel = (r) => {
    if (isPenaltyRedemption(r)) return <span style={{ background:"#fff7ed", color:"#9a3412", borderRadius:50, padding:"2px 10px", fontSize:11, fontWeight:800 }}>⚠️ Straf uitgevoerd</span>;
    if (r.status === "approved") return <span style={{ background:"#d1fae5", color:"#065f46", borderRadius:50, padding:"2px 10px", fontSize:11, fontWeight:800 }}>✅ Goedgekeurd</span>;
    if (r.status === "rejected") return <span style={{ background:"#fee2e2", color:"#991b1b", borderRadius:50, padding:"2px 10px", fontSize:11, fontWeight:800 }}>❌ Afgewezen</span>;
    return <span style={{ background:"#fef3c7", color:"#92400e", borderRadius:50, padding:"2px 10px", fontSize:11, fontWeight:800 }}>⏳ Wacht op goedkeuring</span>;
  };

  const RedemptionRow = ({ r }) => {
    const ch = getChild(r.childId);
    const penalty = isPenaltyRedemption(r);
    return (
      <div className="tr" style={{ background: penalty ? "#fff7ed" : r.status === "approved" ? "#f0fdf4" : r.status === "rejected" ? "#fff5f5" : "var(--sur2)", flexWrap:"wrap", gap:8 }}>
        <div style={{ fontSize:32 }}>{r.rewardEmoji}</div>
        <div style={{ flex:1, minWidth:120 }}>
          <div style={{ fontWeight:800, fontSize:15 }}>{penalty ? "Ecoins afgepakt" : r.rewardTitle}</div>
          <div style={{ fontSize:12, color:"var(--t2)", display:"flex", gap:8, marginTop:2, flexWrap:"wrap" }}>
            {ch && <span>{ch.avatar} {ch.name}</span>}
            <span>📅 {r.date}</span>
          </div>
          {penalty && <div style={{ fontSize:12, color:"#9a3412", marginTop:5, fontWeight:700 }}>Reden: {getPenaltyReason(r)}</div>}
          <div style={{ marginTop:5 }}>{statusLabel(r)}</div>
        </div>
        <div style={{ fontWeight:900, color: penalty ? "#c2410c" : "var(--yel)", fontSize:16, whiteSpace:"nowrap" }}>{penalty ? `➖ ${Math.abs(r.cost)}` : `🪙 ${r.cost}`}</div>
        {!penalty && r.status === "pending" && (
          <div style={{ display:"flex", gap:6 }}>
            <button className="btn bg bsm" onClick={() => db.approveRedemption(r.id)}>✅ Goedkeuren</button>
            <button className="btn bsm" style={{ background:"var(--red-l)", color:"var(--red)", border:"none" }} onClick={() => db.rejectRedemption(r.id)}>❌ Afwijzen</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="sh"><span className="st">Aankopen & straffen 🛍️⚠️</span></div>

      {/* Filter */}
      <div className="frow" style={{ marginBottom:16 }}>
        <button className={`btn bsm ${filter==="all"?"bp":"bh"}`} onClick={() => setFilter("all")}>Alle kinderen</button>
        {data.children.map(c => (
          <button key={c.id} className={`btn bsm ${filter===c.id?"bp":"bh"}`} onClick={() => setFilter(c.id)}>{getChildAvatar(c)} {c.name}</button>
        ))}
      </div>

      {/* Wacht op goedkeuring */}
      {pendingList.length > 0 && (
        <div style={{ marginBottom:20 }}>
          <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:15, fontWeight:800, color:"#92400e", marginBottom:10 }}>
            ⏳ Wacht op jouw goedkeuring
          </div>
          {pendingList.map(r => <RedemptionRow key={r.id} r={r} />)}
        </div>
      )}

      {/* Eerder behandeld */}
      {restList.length > 0 && (
        <div>
          <div style={{ fontFamily:"'Baloo 2',cursive", fontSize:15, fontWeight:800, color:"var(--t2)", marginBottom:10 }}>
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
                Start op <strong>{date}</strong> · {getDayPartConfig(effectiveDayPart).emoji} {effectiveDayPart === "weekly" ? <>zichtbaar als <strong>weektaak</strong> in het weektaken-blok</> : <>zichtbaar vanaf <strong>{getDayPartLabel(effectiveDayPart).toLowerCase()}</strong></>}
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
