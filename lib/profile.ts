import { cache } from "react";
import { prisma } from "@/lib/prisma";
import {
  CS2_APP_ID,
  getOwnedGame,
  getPlayerBans,
  getPlayerLevel,
  getPlayerSummaries,
} from "@/lib/steam";

export interface PlayerProfile {
  steam64: string;
  username: string;
  avatarUrl: string | null;
  country: string | null;
  profileUrl: string | null;
  isVACBanned: boolean;
  vacBans: number;
  gameBans: number;
  communityBanned: boolean;
  lastSeenAt: Date | null;
  level: number | null;
  /** Total CS2 playtime in hours, from Steam (null when hidden). */
  cs2Hours: number | null;
  /** CS2 playtime over the last 2 weeks, hours (null when hidden). */
  cs2Hours2Weeks: number | null;
}

/** Load everything known about a player. React.cache dedupes across the layout
 *  and page renders within a single request, so Steam isn't hit twice. */
export const getPlayer = cache(
  async (
    steam64: string,
  ): Promise<PlayerProfile> => {
    const user = await prisma.user.findUnique({ where: { steam64 } }).catch(() => null);
    const summaries = await getPlayerSummaries([steam64]).catch(() => [null]);
    const profile = summaries[0] ?? null;

    const [level, bans, ownedCs2] = await Promise.all([
      getPlayerLevel(steam64).catch(() => null),
      getPlayerBans([steam64]).catch(() => null),
      getOwnedGame(steam64, [CS2_APP_ID]).catch(() => null),
    ]);

    const cs2Hours = ownedCs2
      ? Math.round((ownedCs2.playtime_forever / 60) * 100) / 100
      : null;
    const cs2Hours2Weeks = ownedCs2?.playtime_2weeks
      ? Math.round((ownedCs2.playtime_2weeks / 60) * 100) / 100
      : null;

    const vacBans = bans?.NumberOfVACBans ?? (user?.isVACBanned ? 1 : 0);

    return {
      steam64,
      username: user?.username || profile?.personaname || steam64,
      avatarUrl: user?.avatarUrl || profile?.avatarfull || null,
      country: user?.country || profile?.countrycode || null,
      profileUrl: user?.profileUrl || profile?.profileurl || null,
      isVACBanned: vacBans > 0,
      vacBans,
      gameBans: bans?.NumberOfGameBans ?? 0,
      communityBanned: bans?.CommunityBanned ?? false,
      lastSeenAt: user?.lastSeenAt ?? null,
      level,
      cs2Hours,
      cs2Hours2Weeks,
    };
  },
);