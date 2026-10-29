// The search test set: a small library with the names that trip search up
// (accents, "&", "feat.", collaborations, remixes, duplicate copies, short
// titles) and queries the way DJs type them. Each case names the tracks that
// must come first (`top`: one of these is #1) and/or all appear in the first
// five (`all`), or that nothing may be called an exact match (`none`).

import type { LibTrack } from "../src/store";

type Row = [id: string, title: string, artist: string, album: string | null, genre: string, bpm: number, key: string];

const ROWS: Row[] = [
  ["t01", "Jealous", "Fireboy DML", "Laughter, Tears & Goosebumps", "Afrobeats", 100, "8A"],
  ["t02", "Jealous", "Fireboy DML", "Jealous - Single", "Afrobeats", 100, "8A"],
  ["t03", "Peru", "Fireboy DML & Ed Sheeran", "Peru (Remix)", "Afrobeats", 108, "9A"],
  ["t04", "Peru", "Fireboy DML", "Playboy", "Afrobeats", 108, "9A"],
  ["t05", "Ye", "Burna Boy", "Outside", "Afrobeats", 102, "8A"],
  ["t06", "Last Last", "Burna Boy", "Love, Damini", "Afrobeats", 86, "11B"],
  ["t07", "City Boys", "Burna Boy", "I Told Them...", "Afrobeats", 100, "4A"],
  ["t08", "Essence (feat. Tems)", "Wizkid", "Made in Lagos", "Afrobeats", 104, "7A"],
  ["t09", "Essence (Remix) [feat. Justin Bieber & Tems]", "Wizkid", "Made in Lagos (Deluxe)", "Afrobeats", 104, "7A"],
  ["t10", "Calm Down", "Rema", "Rave & Roses", "Afrobeats", 107, "11B"],
  ["t11", "Calm Down (with Selena Gomez)", "Rema & Selena Gomez", "Rave & Roses Ultra", "Afrobeats", 107, "11B"],
  ["t12", "Free Mind", "Tems", "For Broken Ears", "Afrobeats", 88, "2A"],
  ["t13", "Me & U", "Tems", "Me & U", "Afrobeats", 92, "5A"],
  ["t14", "Lonely at the Top", "Asake", "Work of Art", "Afrobeats", 112, "10A"],
  ["t15", "Terminator", "Asake", "Mr. Money with the Vibe", "Afrobeats", 112, "8A"],
  ["t16", "Sungba (Remix)", "Asake & Burna Boy", "Sungba (Remix)", "Afrobeats", 113, "6A"],
  ["t17", "Water", "Tyla", "Tyla", "Amapiano", 117, "5A"],
  ["t18", "Abalele", "Kabza De Small", "I Am the King of Amapiano", "Amapiano", 113, "8A"],
  ["t19", "Mnike", "Tyler ICU & Tumela_za", "Mnike", "Amapiano", 112, "3A"],
  ["t20", "Jerusalema (feat. Nomcebo Zikode)", "Master KG", "Jerusalema", "Afro House", 124, "5A"],
  ["t21", "Drive", "Black Coffee & David Guetta", "Subconsciously", "Afro House", 122, "4A"],
  ["t22", "Rush", "Ayra Starr", "19 & Dangerous", "Afrobeats", 98, "6A"],
  ["t23", "Commas", "Ayra Starr", "The Year I Turned 21", "Afrobeats", 101, "7A"],
  ["t24", "Love Nwantiti (Ah Ah Ah)", "CKay", "CKay the First", "Afrobeats", 93, "1A"],
  ["t25", "Halo", "Beyoncé", "I Am... Sasha Fierce", "Pop", 80, "12A"],
  ["t26", "CUFF IT", "Beyoncé", "RENAISSANCE", "Pop", 115, "1A"],
  ["t27", "Ojuelegba", "Wizkid", "Ayo", "Afrobeats", 96, "9A"],
  ["t28", "Joro", "Wizkid", "Joro", "Afrobeats", 100, "2A"],
  ["t29", "Fall", "Davido", "A Good Time", "Afrobeats", 106, "4A"],
  ["t30", "Unavailable (feat. Musa Keys)", "Davido", "Timeless", "Amapiano", 113, "9A"],
  ["t31", "Feel", "Davido", "Timeless", "Afrobeats", 102, "5A"],
  ["t32", "Ku Lo Sa", "Oxlade", "Ku Lo Sa", "Afrobeats", 101, "10A"],
  ["t33", "Buga (Lo Lo Lo)", "Kizz Daniel & Tekno", "Buga", "Afrobeats", 101, "4A"],
  ["t34", "Cough (Odo)", "Kizz Daniel", "Cough", "Afrobeats", 102, "8A"],
  ["t35", "Sability", "Ayra Starr", "The Year I Turned 21", "Afrobeats", 104, "3A"],
  ["t36", "Ginger Me", "Rema", "Rave & Roses", "Afrobeats", 95, "6A"],
  ["t37", "Bandana", "Fireboy DML & Asake", "Bandana", "Afrobeats", 103, "11A"],
  ["t38", "Kilometre", "Burna Boy", "Twice as Tall", "Afrobeats", 105, "7A"],
  ["t39", "Soweto", "Victony & Tempoe", "Soweto", "Afrobeats", 101, "8A"],
  ["t40", "Ngozi", "Crayon & Ayra Starr", "Ngozi", "Afrobeats", 104, "9A"],
  ["t41", "Holy Ghost", "Omah Lay", "Boy Alone", "Afrobeats", 99, "2A"],
  ["t42", "Godly", "Omah Lay", "What Have We Done", "Afrobeats", 104, "5A"],
  ["t43", "Understand", "Omah Lay", "Boy Alone", "Afrobeats", 103, "6A"],
  ["t44", "Dumebi", "Rema", "Rema", "Afrobeats", 101, "4A"],
  ["t45", "Iron Man", "Rema", "Rema", "Afrobeats", 97, "1A"],
  ["t46", "Ye (Remix)", "Burna Boy & Lil Durk", "Ye", "Afrobeats", 102, "8A"],
  ["t47", "Amapiano", "Asake & Olamide", "Mr. Money with the Vibe", "Amapiano", 112, "9A"],
  ["t48", "Electricity", "Pheelz & Davido", "Electricity", "Afrobeats", 104, "10A"],
  ["t49", "Finesse", "Pheelz & BNXN", "Finesse", "Afrobeats", 103, "2A"],
  ["t50", "Kpe Paso", "Wande Coal & Olamide", "Kpe Paso", "Afrobeats", 102, "6A"],
  ["t51", "Gqom Ting", "DJ Lag", "Uprise", "Gqom", 126, "3A"],
  ["t52", "Ongcwele", "Sizwe Mdlalose", "Ongcwele", "Gqom", 127, "5A"],
  ["t53", "Love Me JeJe", "Tems", "Born in the Wild", "Afrobeats", 96, "7A"],
  ["t54", "Jeje", "Diamond Platnumz", "Jeje", "Bongo Flava", 100, "8A"],
  ["t55", "Emiliana", "CKay", "Emiliana", "Afrobeats", 94, "4A"],
  ["t56", "Joha", "Asake", "Work of Art", "Afrobeats", 110, "9A"],
  ["t57", "Who's Dat Girl", "Ayra Starr & Rema", "19 & Dangerous", "Afrobeats", 102, "1A"],
  ["t58", "Lagos Love", "Various Artists", "Party Mix", "Afrobeats", 100, "8A"],
  ["t59", "Jealous Girl", "Lagos Band", "Jealous Girl", "Highlife", 120, "6A"],
  ["t60", "Remix Pack 1", "DJ Tools", "Tools", "Edits", 120, "1A"],
];

export const SEARCH_LIBRARY: LibTrack[] = ROWS.map(([id, title, artist, album, genre, bpm, key]) => ({
  id,
  title,
  artist,
  album,
  genre,
  bpm,
  key,
  duration_secs: 200,
}));

export interface SearchCase {
  q: string;
  /** One of these must be the first result. */
  top?: string[];
  /** All of these must be in the first five results. */
  all?: string[];
  /** Nothing may be returned as an exact match. */
  none?: true;
  why: string;
}

export const SEARCH_CASES: SearchCase[] = [
  // plain
  { q: "jealous fireboy", all: ["t01", "t02"], top: ["t01", "t02"], why: "both copies" },
  { q: "last last", top: ["t06"], why: "repeated word" },
  { q: "calm down rema", top: ["t10", "t11"], why: "two versions" },
  { q: "essence remix", top: ["t09"], why: "the remix, not the original" },
  { q: "free mind tems", top: ["t12"], why: "title + artist" },
  { q: "water tyla", top: ["t17"], why: "artist = album" },
  { q: "abalele", top: ["t18"], why: "one word" },
  { q: "drive black coffee", top: ["t21"], why: "artist in a collaboration" },
  { q: "terminator asake", top: ["t15"], why: "title + artist" },
  { q: "peru ed sheeran", top: ["t03"], why: "featured artist" },
  { q: "fall davido", top: ["t29"], why: "short title" },
  { q: "ye burna boy", top: ["t05", "t46"], why: "two-letter title" },
  { q: "commas", top: ["t23"], why: "one word" },
  { q: "joha", top: ["t56"], why: "one word" },
  { q: "dumebi rema", top: ["t44"], why: "title + artist" },
  { q: "ku lo sa", top: ["t32"], why: "two-letter words" },
  { q: "lonely at the top", top: ["t14"], why: "title with 'the'" },
  { q: "ojuelegba", top: ["t27"], why: "one word" },
  // accents, case, punctuation, "&"
  { q: "beyonce halo", top: ["t25"], why: "accent" },
  { q: "cuff it beyonce", top: ["t26"], why: "accent + caps" },
  { q: "BEYONCÉ", all: ["t25", "t26"], why: "caps + accent" },
  { q: "me and u tems", top: ["t13"], why: "'&' typed as 'and'" },
  { q: "me & u", top: ["t13"], why: "'&' as typed" },
  { q: "whos dat girl", top: ["t57"], why: "apostrophe dropped" },
  { q: "who's dat girl", top: ["t57"], why: "apostrophe kept" },
  { q: "mr money with the vibe", all: ["t15", "t47"], why: "album title" },
  { q: "i told them burna", top: ["t07"], why: "album + artist" },
  { q: "love nwantiti", top: ["t24"], why: "title before brackets" },
  { q: "buga lo lo lo", top: ["t33"], why: "words in brackets" },
  // filler words
  { q: "jealous by fireboy", top: ["t01", "t02"], why: "'by'" },
  { q: "the jealous song by fireboy", top: ["t01", "t02"], why: "'the', 'song', 'by'" },
  { q: "songs of tems", all: ["t12", "t13", "t53"], why: "'songs of'" },
  { q: "wizkid x tems", all: ["t08", "t09"], why: "'x' collaboration" },
  { q: "essence ft tems", all: ["t08", "t09"], why: "'ft'" },
  { q: "essence feat. tems", all: ["t08", "t09"], why: "'feat.'" },
  { q: "calm down feat selena gomez", top: ["t11"], why: "the version with Selena" },
  { q: "track ye by burna boy", top: ["t05", "t46"], why: "'track', 'by'" },
  // typos and squashed names
  { q: "fireboi jealous", top: ["t01", "t02"], why: "typo in the artist" },
  { q: "jealouse fireboy", top: ["t01", "t02"], why: "typo in the title" },
  { q: "burnaboy ye", top: ["t05", "t46"], why: "artist as one word" },
  { q: "wizkd essence", all: ["t08", "t09"], why: "missing letter" },
  { q: "ayra star rush", top: ["t22"], why: "missing letter" },
  { q: "asakee terminator", top: ["t15"], why: "extra letter" },
  { q: "omalay godly", top: ["t42"], why: "artist squashed with a typo" },
  { q: "davdio fall", top: ["t29"], why: "swapped letters" },
  { q: "kizz daniel bugga", top: ["t33"], why: "doubled letter" },
  // the start of a word
  { q: "unavail", top: ["t30"], why: "start of a title" },
  { q: "jerusalem master kg", top: ["t20"], why: "start of a word" },
  { q: "ojuelegb", top: ["t27"], why: "start of a word" },
  // genre and lists
  { q: "gqom", all: ["t51", "t52"], why: "genre and title" },
  { q: "fireboy dml", all: ["t01", "t02", "t03", "t04", "t37"], why: "every track by an artist" },
  // the remix shouldn't win over the original, and vice versa
  { q: "ye", top: ["t05"], why: "the plain title beats the remix" },
  // nothing like it
  { q: "metallica enter sandman", none: true, why: "not in the library" },
  { q: "zzzz", none: true, why: "nonsense" },
];
