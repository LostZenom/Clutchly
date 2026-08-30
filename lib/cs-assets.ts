// Bundled CS2 assets pulled from the public cstracker.gg static CDN into /public/cs.
// Map icons are official Valve map icons; weapons are the standard CS2 equipment SVGs.

export const MAP_ICON_DIR = "/cs/maps/map_icon_";
export const WEAPON_ICON_DIR = "/cs/weapons/";

/** Map names we have an SVG icon for (filename = map_icon_<canonical name>.svg). */
const AVAILABLE_MAP_ICONS = new Set([
  "de_ancient",
  "de_anubis",
  "de_boulder",
  "de_cache",
  "de_dust2",
  "de_fachwerk",
  "de_inferno",
  "de_mirage",
  "de_nuke",
  "de_overpass",
  "de_stronghold",
  "de_train",
  "de_vertigo",
  "de_warden",
  "cs_italy",
  "cs_office",
  "cs_shelter",
  "cs_alpine",
]);

export function mapIconPath(map: string): string | null {
  const key = map.replace(/\./g, "");
  return AVAILABLE_MAP_ICONS.has(key) ? `${MAP_ICON_DIR}${key}.svg` : null;
}

export function prettyMapName(map: string): string {
  // "dust2" → "DUST 2": insert a space before digits so numbers read cleanly.
  return map
    .replace(/^de_/, "")
    .replace(/^cs_/, "")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .toUpperCase();
}

export interface WeaponGroup {
  label: string;
  weapons: string[];
}

/** Loadout broken into cstracker-style categories. Keys match the bundled SVG names. */
export const WEAPON_GROUPS: WeaponGroup[] = [
  {
    label: "Rifles",
    weapons: [
      "ak47",
      "m4a1_silencer",
      "m4a1",
      "galilar",
      "famas",
      "aug",
      "sg556",
    ],
  },
  {
    label: "Sniper",
    weapons: ["awp", "ssg08", "scar20", "g3sg1"],
  },
  {
    label: "SMG",
    weapons: ["mp9", "mp7", "mp5sd", "mac10", "bizon", "ump45", "p90"],
  },
  {
    label: "Shotgun",
    weapons: ["xm1014", "nova", "mag7", "sawedoff"],
  },
  {
    label: "Pistol",
    weapons: [
      "glock",
      "usp_silencer",
      "hkp2000",
      "p250",
      "fiveseven",
      "tec9",
      "cz75a",
      "deagle",
      "revolver",
      "elite",
    ],
  },
  {
    label: "Utility",
    weapons: [
      "smokegrenade",
      "flashbang",
      "hegrenade",
      "molotov",
      "incgrenade",
      "decoy",
      "taser",
      "c4",
    ],
  },
];

export function weaponIconPath(key: string): string {
  return `${WEAPON_ICON_DIR}${key}.svg`;
}

export function prettyWeaponName(key: string): string {
  const names: Record<string, string> = {
    ak47: "AK-47",
    awp: "AWP",
    m4a1_silencer: "M4A1-S",
    m4a1: "M4A4",
    galilar: "Galil AR",
    famas: "FAMAS",
    sg556: "SG 553",
    ssg08: "SSG 08",
    scar20: "SCAR-20",
    g3sg1: "G3SG1",
    bizon: "PP-Bizon",
    ump45: "UMP-45",
    p90: "P90",
    xm1014: "XM1014",
    nova: "Nova",
    mp9: "MP9",
    mp7: "MP7",
    mp5sd: "MP5-SD",
    mac10: "MAC-10",
    glock: "GLOCK",
    p250: "P250",
    usp_silencer: "USP-S",
    mag7: "MAG-7",
    sawedoff: "Sawed-Off",
    hkp2000: "P2000",
    fiveseven: "Five-SeveN",
    tec9: "Tec-9",
    cz75a: "CZ75-Auto",
    deagle: "Desert Eagle",
    elite: "Dual Berettas",
    smokegrenade: "Smoke",
    flashbang: "Flashbang",
    hegrenade: "HE Grenade",
    molotov: "Molotov",
    incgrenade: "Incendiary",
    decoy: "Decoy",
    taser: "Zeus x27",
    c4: "C4",
  };
  return (
    names[key] ??
    key
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}