import { describe, expect, it } from "vitest";
import { extractMediaRef, linkIn } from "../src/links";

// Mirrors apps/dj-sync/src/parser.rs tests.
function ok(input: string): string {
  const r = extractMediaRef(input);
  if (!r.ok) throw new Error(`${input}: ${r.reason}`);
  return r.media.url;
}

describe("extractMediaRef", () => {
  it("canonicalises spotify links", () => {
    expect(ok("https://open.spotify.com/intl-fr/track/4uLU6hMCjMI75M1A2tKUQC?si=abc")).toBe(
      "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
    );
    expect(ok(" spotify:playlist:37i9dQZF1DXcBWIGoYBM5M ")).toBe(
      "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    );
    const album = extractMediaRef("https://open.spotify.com/album/abc123");
    expect(album.ok && album.media.kind).toBe("spotify");
  });

  it("canonicalises youtube links and drops mix lists", () => {
    const want = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    expect(ok("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&t=42")).toBe(want);
    expect(ok("https://youtu.be/dQw4w9WgXcQ?si=x")).toBe(want);
    expect(ok("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(want);
    expect(ok("https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share")).toBe(want);
    expect(ok("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(want);
    expect(ok("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")).toBe(
      "https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
    );
    expect(ok("https://youtu.be/-ZJ8iqC4Jnc")).toBe("https://www.youtube.com/watch?v=-ZJ8iqC4Jnc");
  });

  it("canonicalises soundcloud links", () => {
    expect(ok("https://soundcloud.com/artist/some-track?si=abc")).toBe("https://soundcloud.com/artist/some-track");
    expect(ok("https://www.soundcloud.com/artist/some-track")).toBe("https://soundcloud.com/artist/some-track");
    expect(ok("https://m.soundcloud.com/artist/sets/warehouse-march")).toBe(
      "https://soundcloud.com/artist/sets/warehouse-march",
    );
    const track = extractMediaRef("https://soundcloud.com/artist/some-track");
    expect(track.ok && track.media.kind).toBe("soundcloud");
  });

  it("keeps soundcloud private-track secrets", () => {
    // Either secret form rides along: without it the link is useless.
    expect(ok("https://soundcloud.com/artist/some-track/s-Ab12Cd34")).toBe(
      "https://soundcloud.com/artist/some-track/s-Ab12Cd34",
    );
    expect(ok("https://soundcloud.com/artist/some-track?secret_token=s-Ab12Cd34")).toBe(
      "https://soundcloud.com/artist/some-track?secret_token=s-Ab12Cd34",
    );
    // …and a track whose slug starts with "s-" isn't mistaken for a token.
    expect(ok("https://soundcloud.com/artist/s-wave")).toBe("https://soundcloud.com/artist/s-wave");
  });

  it("rejects soundcloud non-track pages", () => {
    for (const bad of [
      "https://soundcloud.com/artist",
      "https://soundcloud.com/artist/sets",
      "https://soundcloud.com/artist/sets/",
      "https://soundcloud.com/discover/sets/charts-top:all-music",
      "https://soundcloud.com/artist/tracks",
      "https://soundcloud.com/artist/abc;rm",
      "https://on.soundcloud.com/xYz12",
    ]) {
      expect(extractMediaRef(bad).ok, bad).toBe(false);
    }
  });

  it("rejects everything else", () => {
    for (const bad of [
      "http://open.spotify.com/track/abc",
      "https://open.spotify.com/artist/abc",
      "https://open.spotify.com/track/abc;rm",
      "https://evil.example/watch?v=dQw4w9WgXcQ",
      "https://open.spotify.com.evil.example/track/abc",
      "https://www.youtube.com/watch",
      "https://www.youtube.com/watch?v=--exec",
      "https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ",
      "https://www.youtube.com/@channel",
      "--exec=rm -rf ~",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(extractMediaRef(bad).ok, bad).toBe(false);
    }
  });

  it("explains rejections like the Rust parser", () => {
    const r = extractMediaRef("https://evil.example/x");
    expect(!r.ok && r.reason).toBe('unsupported site "evil.example": send a Spotify, YouTube or SoundCloud link');
    const s = extractMediaRef("https://open.spotify.com/artist/abc");
    expect(!s.ok && s.reason).toBe("Spotify artist links aren't supported; send a track, album or playlist");
  });
});

describe("linkIn", () => {
  it("pulls the link out of share-sheet text", () => {
    expect(linkIn("Tanzania by Uncle Waffles https://open.spotify.com/track/abc?si=x")).toBe(
      "https://open.spotify.com/track/abc?si=x",
    );
    expect(linkIn("  spotify:track:abc  ")).toBe("spotify:track:abc");
    expect(linkIn("  no link here ")).toBe("no link here");
  });
});
