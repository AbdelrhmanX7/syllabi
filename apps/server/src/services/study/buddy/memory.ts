import { Types } from "mongoose";
import { BUDDY_MEMORY_MAX, StudyBuddyMemory } from "@/models/study/buddy";

/** Notes handed to an expert each turn (the class's newest first, then the general ones). */
export const BUDDY_MEMORY_READ = 10;

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** What the buddy remembers about this student: this class's notes and the class-less ones, newest first. */
export async function readBuddyMemory(userId: Types.ObjectId, classId: Types.ObjectId | null): Promise<string[]> {
  const rows = await StudyBuddyMemory.find({ userId, classId: classId ? { $in: [classId, null] } : null }, { notes: 1, classId: 1 }).lean();
  const own = rows.find((row) => classId && String(row.classId) === String(classId))?.notes ?? [];
  const general = rows.find((row) => !row.classId)?.notes ?? [];
  const newest = (notes: typeof own) => [...notes].sort((a, b) => +new Date(b.at) - +new Date(a.at)).map((note) => note.text);
  return [...new Set([...newest(own), ...newest(general)])].slice(0, BUDDY_MEMORY_READ);
}

/** Adds notes (a repeat of an existing one only refreshes its date); returns the ones kept. */
export async function rememberForBuddy(userId: Types.ObjectId, classId: Types.ObjectId | null, texts: string[], by: string, now = new Date()): Promise<string[]> {
  const fresh = texts.map((text) => text.replace(/\s+/g, " ").trim().slice(0, 200)).filter((text) => text.length >= 8);
  if (!fresh.length) return [];
  const row = await StudyBuddyMemory.findOne({ userId, classId }).lean();
  const notes = [...(row?.notes ?? [])];
  for (const text of fresh) {
    const at = notes.findIndex((note) => norm(note.text) === norm(text));
    if (at >= 0) notes[at] = { ...notes[at]!, at: now };
    else notes.push({ text, at: now, by });
  }
  const kept = notes.sort((a, b) => +new Date(a.at) - +new Date(b.at)).slice(-BUDDY_MEMORY_MAX);
  await StudyBuddyMemory.updateOne({ userId, classId }, { $set: { notes: kept } }, { upsert: true });
  return fresh;
}

export async function forgetBuddyMemory(userId: Types.ObjectId, classId: Types.ObjectId | null, text: string): Promise<void> {
  await StudyBuddyMemory.updateOne({ userId, classId }, { $pull: { notes: { text } } });
}
