import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { Quest, AvatarState, ToastMessage, RewardItem, Achievement } from "../types";
import * as db from "../db/questifyDb";

interface GameContextType {
  quests: Quest[];
  avatar: AvatarState | null;
  purchasedRewards: string[];
  unlockedAchievements: string[];
  toasts: ToastMessage[];
  activeMonster: {
    name: string;
    type: "regular" | "boss";
    hpMax: number;
    hp: number;
    overdueCount: number;
  } | null;
  isLoading: boolean;
  addQuest: (title: string, diff: number, tags: string[], dueStr: string, dueTime?: number) => Promise<void>;
  toggleQuest: (id: number) => Promise<void>;
  deleteQuest: (id: number) => Promise<void>;
  buyReward: (reward: RewardItem) => Promise<boolean>;
  equipGear: (slot: "head" | "body" | "pet", itemId: string | undefined) => Promise<void>;
  selectClass: (className: string) => Promise<void>;
  changeTone: (tone: "playful" | "professional" | "silent") => Promise<void>;
  triggerSimulatedImport: (source: "jira" | "calendar" | "pr_merge") => Promise<void>;
  resetDemoData: () => Promise<void>;
  timeTravel: (hours: number) => Promise<void>;
  dealMonsterDamage: (damage: number) => void;
  pushToast: (tone: "success" | "info" | "error", title: string, msg: string) => void;
  dismissToast: (id: string) => void;
}

const GameContext = createContext<GameContextType | undefined>(undefined);

// Active Procrastination Monster at instant `now`, given the damage dealt to the current monster.
export function computeMonster(quests: Quest[], now: number, damage: number): GameContextType["activeMonster"] {
  const overdueCount = quests.filter((q) => isOverdue(q, now)).length;
  if (overdueCount === 0) return null;
  const isBoss = overdueCount >= 3;
  const hpMax = overdueCount * 100;
  return {
    name: isBoss ? "Scope-Creep Kraken (BOSS)" : "Bug Goblin",
    type: isBoss ? "boss" : "regular",
    hpMax,
    hp: Math.max(0, hpMax - damage),
    overdueCount,
  };
}

// Base reward of a newly created quest: questXP = 44 × difficulty (SRS v1.1, REQ-XP-07, REQ-XP-08)
export const XP_PER_DIFFICULTY = 44;

// Deadline bonus window: 0 ≤ h ≤ 4 hours before the deadline (REQ-XP-10)
export const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// round(x) = floor(x + 1/2) for x = num / den ≥ 0, computed exactly (REQ-XP-04, REQ-XP-05)
export function roundHalfUp(num: bigint, den: bigint): number {
  return Number((2n * num + den) / (2n * den));
}

// earnedXP = round(questXP × (1 + streakBonus) × deadlineMultiplier) with no intermediate rounding (REQ-XP-09…REQ-XP-12).
// streakBonus = min(0.05 × streak, 1) = min(streak, 20) / 20; deadlineMultiplier = 2 − msLeft / 4h inside the window, else 1.
export function calculateEarnedXp(questXp: number, streak: number, msLeft: number | null): number {
  const streakTwentieths = 20 + Math.min(Math.max(Math.trunc(streak), 0), 20);
  const inWindow = msLeft !== null && msLeft >= 0 && msLeft <= FOUR_HOURS_MS;
  const deadlineNumerator = inWindow ? 2 * FOUR_HOURS_MS - Math.round(msLeft as number) : FOUR_HOURS_MS;
  return roundHalfUp(
    BigInt(questXp) * BigInt(streakTwentieths) * BigInt(deadlineNumerator),
    20n * BigInt(FOUR_HOURS_MS)
  );
}

// earnedGold = round(earnedXP / 8) (REQ-FRG-03)
export function calculateEarnedGold(earnedXp: number): number {
  return roundHalfUp(BigInt(earnedXp), 8n);
}

// Deadline instant of a quest: the stored timestamp, or (for older data) the parsed display text.
export function getDeadline(q: Quest): number | null {
  if (typeof q.dueAt === "number" && Number.isFinite(q.dueAt)) return q.dueAt;
  const parsed = Date.parse(q.due);
  return Number.isNaN(parsed) ? null : parsed;
}

// Overdue = incomplete and either flagged overdue or its deadline is strictly earlier than `now`.
export function isOverdue(q: Quest, now: number): boolean {
  if (q.done) return false;
  const deadline = getDeadline(q);
  return q.overdue || (deadline !== null && deadline < now);
}

// Helper for Level curve: Fn = 100 * n^1.6 (XP required for Level n)
export function getXpRequiredForLevel(level: number): number {
  if (level <= 0) return 0;
  return Math.floor(100 * Math.pow(level, 1.6));
}

// Helper to calculate Level from Total XP
export function calculateLevelFromXp(totalXp: number): { level: number; xpInLevel: number; xpMaxForLevel: number } {
  let level = 1;
  while (totalXp >= getXpRequiredForLevel(level)) {
    level++;
  }
  level = level - 1; // current level
  if (level < 1) level = 1;

  const baseForCurrent = getXpRequiredForLevel(level);
  const baseForNext = getXpRequiredForLevel(level + 1);
  const xpInLevel = totalXp - baseForCurrent;
  const xpMaxForLevel = baseForNext - baseForCurrent;

  return {
    level,
    xpInLevel,
    xpMaxForLevel,
  };
}

export const REWARDS_LIBRARY: RewardItem[] = [
  { id: "hat-wizard", title: "Wizard Hat", description: "Cosmetic head gear for magic workflows.", cost: 100, currency: "gold", type: "head", previewValue: "🧙‍♂️" },
  { id: "hat-dragon", title: "Dragon Rider Helmet", description: "Ride the deadlines with armor protection.", cost: 250, currency: "gold", type: "head", previewValue: "🪖" },
  { id: "hat-crown", title: "Kanban Crown", description: "Show off your backlogs master prestige.", cost: 450, currency: "gold", type: "head", previewValue: "👑" },
  
  { id: "robe-wizard", title: "Workflow Robes", description: "Flow through sprints with ease.", cost: 120, currency: "gold", type: "body", previewValue: "👘" },
  { id: "armor-dragon", title: "Scale Plate Armor", description: "Protects against scope creep.", cost: 300, currency: "gold", type: "body", previewValue: "🛡️" },
  { id: "armor-knight", title: "Kanban Knight Mail", description: "Sturdy steel for daily combat.", cost: 500, currency: "gold", type: "body", previewValue: "⚔️" },

  { id: "pet-phoenix", title: "Pomodoro Phoenix", description: "Rises from the ashes of burned sprints.", cost: 3, currency: "token", type: "pet", previewValue: "🐦" },
  { id: "pet-squirrel", title: "Scrum Squirrel", description: "Hunts for nuts and resolves blockers.", cost: 5, currency: "token", type: "pet", previewValue: "🐿️" },
  { id: "pet-griffin", title: "Git Griffin", description: "Fierce guardian of the master branch.", cost: 10, currency: "token", type: "pet", previewValue: "🦁" },

  { id: "sfx-victory", title: "Victory SFX Pack", description: "Dynamic pixelated chords play on complete.", cost: 50, currency: "gold", type: "sfx", previewValue: "🔊 Epic Fanfare" },
  { id: "music-lofi", title: "Lofi Dungeon Beat", description: "Calm loop to focus and write code.", cost: 80, currency: "gold", type: "music", previewValue: "🎵 Lofi Beats" },
  { id: "music-synth", title: "Arcane Synthwave", description: "High-octane neon synth focus music.", cost: 150, currency: "gold", type: "music", previewValue: "🎵 Retro Synth" },
  { id: "boost-potion", title: "Time-Freeze Potion", description: "Instantly delay all deadlines by 24 hours.", cost: 40, currency: "gold", type: "boost", previewValue: "🧪 Time-Freeze Potion" }
];

export const ACHIEVEMENTS_LIBRARY: Omit<Achievement, "unlocked" | "progress">[] = [
  { id: "first-blood", title: "First Blood", desc: "Complete 1 quest", icon: "swords", rarity: "common" },
  { id: "streaker", title: "Streaker", desc: "7-day streak", icon: "flame", rarity: "rare" },
  { id: "bug-bane", title: "Bug-Bane", desc: "Complete 5 bug quests", icon: "bug", rarity: "rare" },
  { id: "night-coder", title: "Night Coder", desc: "Complete a quest after 2 AM local time", icon: "moon", rarity: "epic" },
  { id: "crunch-slayer", title: "Crunch-Slayer", desc: "Defeat a Boss Monster (3+ overdue quests)", icon: "skull", rarity: "epic" },
  { id: "guild-master", title: "Guild Master", desc: "Unlock 5 items from the Reward Forge", icon: "shield", rarity: "legendary" }
];

export const DEFAULT_AVATAR: AvatarState = {
  id: 1,
  level: 14,
  xp: 7496, // 6856 (Level 14 base) + 640
  gold: 1240,
  tokens: 6,
  streak: 7,
  class: "Wizard of Workflow",
  equippedHead: undefined,
  equippedBody: undefined,
  equippedPet: undefined,
  lastActiveDate: new Date().toISOString().split("T")[0],
  tone: "playful"
};

export const DEFAULT_QUESTS = (): Quest[] => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const today2pm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 0);
  const today5pm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0);
  const today6pm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0);

  return [
    {
      id: 1,
      title: "Morning stand-up",
      description: "Discuss daily goals and blockages",
      diff: 1,
      tags: ["daily"],
      due: yesterday.toLocaleString(),
      dueAt: yesterday.getTime(),
      done: true,
      xp: 40,
      gold: 5,
      overdue: false,
      createdAt: yesterday.getTime(),
      completedAt: yesterday.getTime()
    },
    {
      id: 2,
      title: "Review Ada's PR #412",
      description: "Approve database migrations and schemas",
      diff: 2,
      tags: ["code", "review"],
      due: today2pm.getTime() < now.getTime() ? "Today 2pm" : today2pm.toLocaleString(),
      ...(today2pm.getTime() < now.getTime() ? {} : { dueAt: today2pm.getTime() }),
      done: false,
      xp: 120,
      gold: 15,
      overdue: false,
      createdAt: now.getTime() - 2 * 60 * 60 * 1000
    },
    {
      id: 3,
      title: "Fix the login redirect bug",
      description: "Resolve redirection loop on OAuth cancellation",
      diff: 2,
      tags: ["bug"],
      due: today5pm.getTime() < now.getTime() ? "Today 5pm" : today5pm.toLocaleString(),
      ...(today5pm.getTime() < now.getTime() ? {} : { dueAt: today5pm.getTime() }),
      done: false,
      xp: 140,
      gold: 18,
      overdue: false,
      createdAt: now.getTime() - 1 * 60 * 60 * 1000
    },
    {
      id: 4,
      title: "Draft Q3 roadmap",
      description: "Outline core developer features for Q3",
      diff: 3,
      tags: ["planning"],
      due: today6pm.getTime() < now.getTime() ? "Today 6pm" : today6pm.toLocaleString(),
      ...(today6pm.getTime() < now.getTime() ? {} : { dueAt: today6pm.getTime() }),
      done: false,
      xp: 260,
      gold: 32,
      overdue: false,
      createdAt: now.getTime() - 3 * 60 * 60 * 1000
    },
    {
      id: 5,
      title: "Ship the changelog",
      description: "Publish changelog and notify product channels",
      diff: 3,
      tags: ["release"],
      due: yesterday.toLocaleString(),
      dueAt: yesterday.getTime(),
      done: false,
      xp: 300,
      gold: 38,
      overdue: true,
      createdAt: yesterday.getTime() - 4 * 60 * 60 * 1000
    }
  ];
};

export const GameProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [quests, setQuests] = useState<Quest[]>([]);
  const [avatar, setAvatar] = useState<AvatarState | null>(null);
  const [purchasedRewards, setPurchasedRewards] = useState<string[]>([]);
  const [unlockedAchievements, setUnlockedAchievements] = useState<string[]>([]);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // local combat state for procrastination monsters
  const [monsterDamage, setMonsterDamage] = useState(0);

  const pushToast = useCallback((tone: "success" | "info" | "error", title: string, msg: string) => {
    if (avatar?.tone === "silent") return;
    const id = Date.now().toString() + Math.random().toString();
    setToasts((prev) => [...prev, { id, tone, title, msg }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, [avatar?.tone]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Initialize DB and load state
  useEffect(() => {
    async function init() {
      try {
        await db.getDb();
        const loadedQuests = await db.getQuests();
        const loadedAvatar = await db.getAvatar();
        const loadedRewards = await db.getPurchasedRewards();
        const loadedAchievements = await db.getUnlockedAchievements();

        if (loadedQuests.length === 0 && !loadedAvatar) {
          // First boot: Seed database
          const seedQs = DEFAULT_QUESTS();
          for (const q of seedQs) {
            await db.saveQuest(q);
          }
          await db.saveAvatar(DEFAULT_AVATAR);
          await db.saveUnlockedAchievement("first-blood");
          await db.saveUnlockedAchievement("streaker");
          await db.saveUnlockedAchievement("night-coder");
          await db.savePurchasedReward("sfx-victory");

          setQuests(seedQs);
          setAvatar(DEFAULT_AVATAR);
          setUnlockedAchievements(["first-blood", "streaker", "night-coder"]);
          setPurchasedRewards(["sfx-victory"]);
        } else {
          setQuests(loadedQuests);
          setAvatar(loadedAvatar || DEFAULT_AVATAR);
          setPurchasedRewards(loadedRewards);
          setUnlockedAchievements(loadedAchievements);
        }
      } catch (err) {
        console.error("IndexedDB load error:", err);
      } finally {
        setIsLoading(false);
      }
    }
    init();
  }, []);

  // Compute active monsters from overdue quests
  const activeMonster = computeMonster(quests, Date.now(), monsterDamage);
  const overdueCount = activeMonster?.overdueCount ?? 0;

  // Handle damage to monster
  const dealMonsterDamage = useCallback((damage: number) => {
    setMonsterDamage((prev) => {
      const nextDamage = prev + damage;
      if (activeMonster && nextDamage >= activeMonster.hpMax) {
        pushToast("success", "Monster Slain!", "The procrastination beast has been defeated!");
      }
      return nextDamage;
    });
  }, [activeMonster, pushToast]);

  // Check achievements
  const checkAchievements = useCallback(async (
    currentQuests: Quest[],
    currentAvatar: AvatarState,
    currentRewards: string[],
    unlockedList: string[]
  ) => {
    const toUnlock: string[] = [];

    const completed = currentQuests.filter((q) => q.done);
    const completedCount = completed.length;

    // "First Blood"
    if (completedCount >= 1 && !unlockedList.includes("first-blood")) {
      toUnlock.push("first-blood");
    }

    // "Streaker"
    if (currentAvatar.streak >= 7 && !unlockedList.includes("streaker")) {
      toUnlock.push("streaker");
    }

    // "Bug-Bane" (5 bug tasks)
    const bugQuests = completed.filter((q) => q.tags.includes("bug")).length;
    if (bugQuests >= 5 && !unlockedList.includes("bug-bane")) {
      toUnlock.push("bug-bane");
    }

    // "Night Coder" (handled in completion trigger, but check here if exists)

    // "Guild Master" (unlock 5 items)
    if (currentRewards.length >= 5 && !unlockedList.includes("guild-master")) {
      toUnlock.push("guild-master");
    }

    if (toUnlock.length > 0) {
      const nextAchievements = [...unlockedList];
      for (const id of toUnlock) {
        nextAchievements.push(id);
        await db.saveUnlockedAchievement(id);
        const ach = ACHIEVEMENTS_LIBRARY.find((a) => a.id === id);
        
        // Award Guild Tokens for achievement unlock
        currentAvatar.tokens += 2;
        await db.saveAvatar(currentAvatar);
        
        pushToast(
          "success",
          "🏆 Achievement Unlocked!",
          `"${ach?.title}" · Unlocked! +2 Guild Tokens`
        );
      }
      setAvatar({ ...currentAvatar });
      setUnlockedAchievements(nextAchievements);
    }
  }, [pushToast]);

  // Recalculate monsters when overdue quests count changes
  useEffect(() => {
    setMonsterDamage(0);
  }, [overdueCount]);

  // Save/Create Quest
  const addQuest = useCallback(async (
    title: string,
    diff: number,
    tags: string[],
    dueStr: string,
    dueTime?: number
  ) => {
    const now = Date.now();
    const parsedDue = dueTime ? new Date(dueTime).toLocaleString() : dueStr;
    const isOverdue = dueTime ? dueTime < now : dueStr.toLowerCase().includes("yesterday");

    // questXP = 44 × difficulty, for Quest Builder and Quest Templates alike (REQ-XP-07, REQ-XP-08)
    const calculatedXp = XP_PER_DIFFICULTY * diff;
    const calculatedGold = calculateEarnedGold(calculatedXp);

    const newQuest: Quest = {
      id: now,
      title,
      diff,
      tags,
      due: parsedDue,
      ...(dueTime ? { dueAt: dueTime } : {}),
      done: false,
      xp: calculatedXp,
      gold: calculatedGold,
      overdue: isOverdue,
      createdAt: now,
    };

    const nextQuests = [newQuest, ...quests];
    await db.saveQuest(newQuest);
    setQuests(nextQuests);

    const tone = avatar?.tone || "playful";
    const msg = tone === "professional" 
      ? `Task "${title}" added.`
      : `"${title}" has been posted on the quest board!`;

    pushToast("info", "Quest Recruited", msg);
  }, [quests, avatar?.tone, pushToast]);

  // Complete/Undo Quest
  const toggleQuest = useCallback(async (id: number) => {
    if (!avatar) return;

    // One captured completion timestamp for everything this completion calculates (REQ-XP-06)
    const completionTs = Date.now();

    const nextQuests = quests.map((q) => {
      if (q.id !== id) return q;

      const nextDone = !q.done;
      let completedAt = undefined;
      if (nextDone) {
        completedAt = completionTs;
      }

      return {
        ...q,
        done: nextDone,
        completedAt,
      };
    });

    const toggledQuest = nextQuests.find((q) => q.id === id);
    if (!toggledQuest) return;

    await db.saveQuest(toggledQuest);
    setQuests(nextQuests);

    const nextAvatar = { ...avatar };

    if (toggledQuest.done) {
      // Calculate multipliers
      const base = toggledQuest.xp;
      
      // XP = Base × Difficulty × (1 + streak%) × Deadline pressure, exact (REQ-XP-05, REQ-XP-09…REQ-XP-12)
      // Here, Base is already difficulty-scaled in toggledQuest.xp = 44 × difficulty
      const deadline = getDeadline(toggledQuest);
      const finalXp = calculateEarnedXp(base, nextAvatar.streak, deadline === null ? null : deadline - completionTs);
      
      // Gold blocked if a Procrastination Monster is active
      // Monster state immediately before completion, at the completion timestamp (REQ-FRG-04).
      // Damage counts only for the same monster; a different overdue count means a fresh monster.
      const countBefore = computeMonster(quests, completionTs, 0)?.overdueCount ?? 0;
      const monsterBefore = computeMonster(quests, completionTs, countBefore === overdueCount ? monsterDamage : 0);
      const isGoldBlocked = monsterBefore !== null && monsterBefore.hp > 0;
      const finalGold = isGoldBlocked ? 0 : calculateEarnedGold(finalXp);

      // Apply changes to Avatar profile
      const oldTotalXp = nextAvatar.xp;
      const newTotalXp = oldTotalXp + finalXp;
      nextAvatar.xp = newTotalXp;
      nextAvatar.gold += finalGold;

      // Handle level up
      const oldLvl = calculateLevelFromXp(oldTotalXp).level;
      const newLvl = calculateLevelFromXp(newTotalXp).level;

      if (newLvl > oldLvl) {
        nextAvatar.level = newLvl;
        // Award Guild Tokens on Level Up
        const levelsGained = newLvl - oldLvl;
        nextAvatar.tokens += levelsGained;

        pushToast(
          "success",
          "🎉 LEVEL UP!",
          `Congratulations! You reached Level ${newLvl} and earned +${levelsGained} Guild Tokens!`
        );
      }

      // Triggers: check for Night Coder achievement
      if (toggledQuest.completedAt) {
        const date = new Date(toggledQuest.completedAt);
        const hours = date.getHours();
        if (hours >= 2 && hours < 5 && !unlockedAchievements.includes("night-coder")) {
          const nextAchs = [...unlockedAchievements, "night-coder"];
          await db.saveUnlockedAchievement("night-coder");
          setUnlockedAchievements(nextAchs);
          nextAvatar.tokens += 2;
          pushToast(
            "success",
            "🏆 Achievement Unlocked!",
            `"Night Coder" · Completed quest after 2 AM! +2 Guild Tokens`
          );
        }
      }

      // Slaying monster checks
      if (toggledQuest.overdue) {
        dealMonsterDamage(100);
        
        // If it was a Boss Monster (3+ overdue quests)
        if (overdueCount >= 3 && !unlockedAchievements.includes("crunch-slayer")) {
          const nextAchs = [...unlockedAchievements, "crunch-slayer"];
          await db.saveUnlockedAchievement("crunch-slayer");
          setUnlockedAchievements(nextAchs);
          nextAvatar.tokens += 2;
          pushToast(
            "success",
            "🏆 Achievement Unlocked!",
            `"Crunch-Slayer" · Defeated a Boss Monster! +2 Guild Tokens`
          );
        }
      }

      await db.saveAvatar(nextAvatar);
      setAvatar(nextAvatar);

      const tone = nextAvatar.tone;
      const successTitle = tone === "professional" ? "Task Completed" : "Quest Completed!";
      const successMsg = tone === "professional"
        ? `+${finalXp} XP.${isGoldBlocked ? " (Gold rewards blocked)" : ` +${finalGold} Gold.`}`
        : `Victory! Earned +${finalXp} XP · ${isGoldBlocked ? "❌ Gold rewards blocked by monster!" : `+${finalGold} Gold ⚔️`}`;

      pushToast("success", successTitle, successMsg);
      checkAchievements(nextQuests, nextAvatar, purchasedRewards, unlockedAchievements);

    } else {
      // Undo completion: subtract raw XP and Gold
      const rawXp = toggledQuest.xp;
      const rawGold = Math.round(rawXp / 8);

      nextAvatar.xp = Math.max(0, nextAvatar.xp - rawXp);
      nextAvatar.gold = Math.max(0, nextAvatar.gold - rawGold);
      const { level: revisedLvl } = calculateLevelFromXp(nextAvatar.xp);
      nextAvatar.level = revisedLvl;

      await db.saveAvatar(nextAvatar);
      setAvatar(nextAvatar);

      pushToast("info", "Quest Un-done", `Quest status reset. XP/Gold adjusted.`);
    }
  }, [quests, avatar, activeMonster, overdueCount, monsterDamage, unlockedAchievements, purchasedRewards, dealMonsterDamage, pushToast, checkAchievements]);

  // Delete Quest
  const deleteQuest = useCallback(async (id: number) => {
    const nextQuests = quests.filter((q) => q.id !== id);
    await db.deleteQuest(id);
    setQuests(nextQuests);
    pushToast("info", "Quest Deleted", "Quest removed from your log.");
  }, [quests, pushToast]);

  // Buy Reward from Forge
  const buyReward = useCallback(async (reward: RewardItem) => {
    if (!avatar) return false;

    const nextAvatar = { ...avatar };

    if (reward.currency === "gold") {
      if (nextAvatar.gold < reward.cost) {
        pushToast("error", "Insufficient Gold", `You need ${reward.cost} Gold to buy this item.`);
        return false;
      }
      nextAvatar.gold -= reward.cost;
    } else {
      if (nextAvatar.tokens < reward.cost) {
        pushToast("error", "Insufficient Guild Tokens", `You need ${reward.cost} Tokens to buy this item.`);
        return false;
      }
      nextAvatar.tokens -= reward.cost;
    }

    if (reward.type === "boost" && reward.id === "boost-potion") {
      // Time-Freeze boost delays all incomplete deadlines by 24 hours
      const nextQuests = quests.map((q) => {
        if (q.done) return q;
        const current = getDeadline(q);
        const dueTime = (current ?? Date.now()) + 24 * 60 * 60 * 1000;
        return {
          ...q,
          due: new Date(dueTime).toLocaleString(),
          dueAt: dueTime,
          overdue: false,
        };
      });

      for (const q of nextQuests) {
        await db.saveQuest(q);
      }
      setQuests(nextQuests);
      pushToast("success", "🧪 Potions Consumed!", "All active deadlines pushed by 24 hours!");
    } else {
      // unlock cosmetic item
      const nextRewards = [...purchasedRewards, reward.id];
      await db.savePurchasedReward(reward.id);
      setPurchasedRewards(nextRewards);

      pushToast("success", "Forge Unlocked!", `Purchased "${reward.title}"! Equippable now.`);
      checkAchievements(quests, nextAvatar, nextRewards, unlockedAchievements);
    }

    await db.saveAvatar(nextAvatar);
    setAvatar(nextAvatar);
    return true;
  }, [avatar, quests, purchasedRewards, unlockedAchievements, pushToast, checkAchievements]);

  // Equip Gear
  const equipGear = useCallback(async (slot: "head" | "body" | "pet", itemId: string | undefined) => {
    if (!avatar) return;

    const nextAvatar = { ...avatar };
    if (slot === "head") nextAvatar.equippedHead = itemId;
    else if (slot === "body") nextAvatar.equippedBody = itemId;
    else if (slot === "pet") nextAvatar.equippedPet = itemId;

    await db.saveAvatar(nextAvatar);
    setAvatar(nextAvatar);
    pushToast("info", "Gear Equipped", "Your avatar cosmetics have been updated.");
  }, [avatar, pushToast]);

  // Select Avatar Class
  const selectClass = useCallback(async (className: string) => {
    if (!avatar) return;

    const nextAvatar = { ...avatar, class: className };
    await db.saveAvatar(nextAvatar);
    setAvatar(nextAvatar);
    pushToast("info", "Class Changed", `Class updated to ${className}.`);
  }, [avatar, pushToast]);

  // Change Tone Preference
  const changeTone = useCallback(async (tone: "playful" | "professional" | "silent") => {
    if (!avatar) return;

    const nextAvatar = { ...avatar, tone };
    await db.saveAvatar(nextAvatar);
    setAvatar(nextAvatar);

    if (tone !== "silent") {
      pushToast("info", "Tone Updated", `Notifications tone set to ${tone}.`);
    }
  }, [avatar, pushToast]);

  // Import Integrations Simulation
  const triggerSimulatedImport = useCallback(async (source: "jira" | "calendar" | "pr_merge") => {
    const now = Date.now();

    if (source === "jira") {
      // Import 2 quests representing Jira backlog items
      const q1: Quest = {
        id: now,
        title: "Jira: [AUTH-120] Setup Token Expiry Check",
        diff: 2,
        tags: ["jira", "auth"],
        due: new Date(now + 2 * 60 * 60 * 1000).toLocaleString(),
        dueAt: now + 2 * 60 * 60 * 1000,
        done: false,
        xp: 110,
        gold: 14,
        overdue: false,
        createdAt: now,
      };

      const q2: Quest = {
        id: now + 1,
        title: "Jira: [UI-88] Align Avatar Alignment on Dashboard",
        diff: 1,
        tags: ["jira", "ui"],
        due: new Date(now + 24 * 60 * 60 * 1000).toLocaleString(),
        dueAt: now + 24 * 60 * 60 * 1000,
        done: false,
        xp: 50,
        gold: 6,
        overdue: false,
        createdAt: now,
      };

      await db.saveQuest(q1);
      await db.saveQuest(q2);
      setQuests((prev) => [q1, q2, ...prev]);
      pushToast("success", "Jira Synchronized", "Imported 2 issues as active quests.");

    } else if (source === "calendar") {
      // Import a meeting quest due today
      const meetingQuest: Quest = {
        id: now,
        title: "Calendar: Lunch Sync with Product Team",
        diff: 1,
        tags: ["calendar", "meeting"],
        due: new Date(now + 1 * 60 * 60 * 1000).toLocaleString(),
        dueAt: now + 1 * 60 * 60 * 1000,
        done: false,
        xp: 40,
        gold: 5,
        overdue: false,
        createdAt: now,
      };

      await db.saveQuest(meetingQuest);
      setQuests((prev) => [meetingQuest, ...prev]);
      pushToast("success", "Calendar Imported", "Synced 'Lunch Sync with Product Team' into quests.");

    } else if (source === "pr_merge") {
      // Auto-complete the first matching code or review quest as if a PR merged
      const codeQuest = quests.find((q) => !q.done && (q.tags.includes("code") || q.tags.includes("review")));
      if (codeQuest) {
        await toggleQuest(codeQuest.id);
        pushToast("success", "PR Merged successfully!", `Auto-completed quest: "${codeQuest.title}" via webhook.`);
      } else {
        pushToast("info", "PR Merge Check", "No active Code/Review quests found to resolve.");
      }
    }
  }, [quests, toggleQuest, pushToast]);

  // Reset Demo Data
  const resetDemoData = useCallback(async () => {
    setIsLoading(true);
    try {
      await db.clearAllData();
      const seedQs = DEFAULT_QUESTS();
      for (const q of seedQs) {
        await db.saveQuest(q);
      }
      await db.saveAvatar(DEFAULT_AVATAR);
      await db.saveUnlockedAchievement("first-blood");
      await db.saveUnlockedAchievement("streaker");
      await db.saveUnlockedAchievement("night-coder");
      await db.savePurchasedReward("sfx-victory");

      setQuests(seedQs);
      setAvatar(DEFAULT_AVATAR);
      setUnlockedAchievements(["first-blood", "streaker", "night-coder"]);
      setPurchasedRewards(["sfx-victory"]);
      setMonsterDamage(0);

      pushToast("success", "Demo Resetted", "All data has been reset to defaults.");
    } catch (err) {
      console.error(err);
      pushToast("error", "Reset Failed", "Could not reset browser IndexedDB.");
    } finally {
      setIsLoading(false);
    }
  }, [pushToast]);

  // Time Travel (Simulate overdue quest)
  const timeTravel = useCallback(async (hours: number) => {
    // subtract time from active quests due dates to make them overdue
    const msToSubtract = hours * 60 * 60 * 1000;
    const nextQuests = quests.map((q) => {
      if (q.done) return q;

      const current = getDeadline(q);
      const nextDueTimestamp = current !== null ? current - msToSubtract : Date.now() - 10000; // default slightly past now

      return {
        ...q,
        due: new Date(nextDueTimestamp).toLocaleString(),
        dueAt: nextDueTimestamp,
        overdue: nextDueTimestamp < Date.now(),
      };
    });

    for (const q of nextQuests) {
      await db.saveQuest(q);
    }
    setQuests(nextQuests);
    pushToast("info", "🕰️ Time Travel Active", `Shifted deadlines back by ${hours} hours. Refreshing monster states.`);
  }, [quests, pushToast]);

  return (
    <GameContext.Provider
      value={{
        quests,
        avatar,
        purchasedRewards,
        unlockedAchievements,
        toasts,
        activeMonster,
        isLoading,
        addQuest,
        toggleQuest,
        deleteQuest,
        buyReward,
        equipGear,
        selectClass,
        changeTone,
        triggerSimulatedImport,
        resetDemoData,
        timeTravel,
        dealMonsterDamage,
        pushToast,
        dismissToast,
      }}
    >
      {children}
    </GameContext.Provider>
  );
};

export const useGame = () => {
  const context = useContext(GameContext);
  if (context === undefined) {
    throw new Error("useGame must be used within a GameProvider");
  }
  return context;
};
