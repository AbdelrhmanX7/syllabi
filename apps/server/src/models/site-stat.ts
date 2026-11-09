import mongoose, { Schema } from "mongoose";

/**
 * Anonymous counts for the owner (`site_stats`): download-button clicks on the website and app opens
 * on tablets. No account, name, email or address is stored. `who` is a random id the app makes on
 * first launch, or (for website clicks) a one-way hash of the address + day, so one person clicking
 * five times in a day counts once. One row per (kind, who, day).
 */
export const SITE_STAT_KINDS = ["download_click", "app_open"] as const;
export type SiteStatKind = (typeof SITE_STAT_KINDS)[number];

export interface ISiteStat {
  kind: SiteStatKind;
  who: string;
  day: string;
  firstAt: Date;
  version: string | null;
  platform: string | null;
}

const SiteStatSchema = new Schema<ISiteStat>(
  {
    kind: { type: String, enum: SITE_STAT_KINDS, required: true },
    who: { type: String, required: true },
    day: { type: String, required: true },
    firstAt: { type: Date, required: true },
    version: { type: String, default: null },
    platform: { type: String, default: null },
  },
  { versionKey: false }
);
SiteStatSchema.index({ kind: 1, who: 1, day: 1 }, { unique: true });
SiteStatSchema.index({ kind: 1, day: 1 });

export const SiteStat = mongoose.models.SiteStat || mongoose.model<ISiteStat>("SiteStat", SiteStatSchema, "site_stats");
