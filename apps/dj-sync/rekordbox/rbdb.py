"""dj-sync's bridge to Rekordbox's library database (master.db), via pyrekordbox.

dj-sync (Rust) runs this with JSON in and JSON out:

    rbdb.py [--db PATH] status
    rbdb.py [--db PATH] apply            < {"ops": [...]}
    rbdb.py [--db PATH] playlists
    rbdb.py [--db PATH] search QUERY [--limit N]
    rbdb.py [--db PATH] snapshot         (read-only: playlists + track index)

`apply` runs every op in ONE transaction and commits once at the end; any
failure rolls everything back, so the library never ends up half-changed.
Ops are idempotent (re-applying them never duplicates tracks or entries).
Writing is refused while Rekordbox is running — dj-sync queues changes and
applies them after Rekordbox quits, and snapshots master.db first.

Exit codes: 0 ok, 1 error (nothing written), 3 Rekordbox is running.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from pyrekordbox import MasterDatabase
from pyrekordbox.utils import get_rekordbox_pid

FOLDER, PLAYLIST = 1, 0
DEFAULT_FOLDER = "DJ Sync"


def out(payload: dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, default=str))
    sys.exit(code)


def open_db(path: str | None) -> MasterDatabase:
    return MasterDatabase(path=path) if path else MasterDatabase()


# ---------- lookups ----------


def find_content(db: MasterDatabase, op: dict[str, Any]):
    if op.get("content_id"):
        return db.get_content(ID=str(op["content_id"])).first()
    if op.get("path"):
        return db.get_content(FolderPath=str(Path(op["path"]))).first()
    raise ValueError("op needs `path` or `content_id`")


def playlists_named(db: MasterDatabase, name: str) -> list:
    return [p for p in db.get_playlist(Name=name).all() if p.Attribute == PLAYLIST]


def find_playlist(db: MasterDatabase, name: str):
    found = playlists_named(db, name)
    if not found:
        raise ValueError(f"no playlist named {name!r}")
    if len(found) > 1:
        # Prefer the one dj-sync manages.
        folder = ensure_folder(db, DEFAULT_FOLDER, create=False)
        for p in found:
            if folder is not None and p.ParentID == folder.ID:
                return p
    return found[0]


def ensure_folder(db: MasterDatabase, name: str, create: bool = True):
    for p in db.get_playlist(Name=name).all():
        if p.Attribute == FOLDER and p.ParentID in (None, "root", "0", 0):
            return p
    return db.create_playlist_folder(name) if create else None


def named(db: MasterDatabase, getter: str, adder: str, name: str | None, **extra):
    """Find-or-create an artist / album / genre by name."""
    if not name:
        return None
    hit = getattr(db, getter)(Name=name).first()
    return hit if hit is not None else getattr(db, adder)(name, **extra)


# ---------- ops ----------


def op_add_track(db: MasterDatabase, op: dict[str, Any]) -> dict[str, Any]:
    path = Path(op["path"])
    existing = db.get_content(FolderPath=str(path)).first()
    if existing is not None:
        return {"content_id": str(existing.ID), "created": False}
    if not path.is_file():
        raise ValueError(f"file not found: {path}")

    artist = named(db, "get_artist", "add_artist", op.get("artist"))
    album = named(db, "get_album", "add_album", op.get("album"), artist=artist)
    genre = named(db, "get_genre", "add_genre", op.get("genre"))
    fields: dict[str, Any] = {
        "Title": op.get("title") or path.stem,
        "ArtistID": artist.ID if artist else None,
        "AlbumID": album.ID if album else None,
        "GenreID": genre.ID if genre else None,
        "ReleaseYear": op.get("year"),
        "Length": op.get("duration_secs"),
        "BitRate": op.get("bitrate_kbps"),
        "SampleRate": op.get("sample_rate"),
        "Commnt": op.get("comment"),
    }
    content = db.add_content(path, **{k: v for k, v in fields.items() if v is not None})
    return {"content_id": str(content.ID), "created": True}


def op_ensure_playlist(db: MasterDatabase, op: dict[str, Any]) -> dict[str, Any]:
    name = op["name"]
    found = playlists_named(db, name)
    if found:
        return {"playlist_id": str(find_playlist(db, name).ID), "created": False}
    folder = ensure_folder(db, op.get("folder") or DEFAULT_FOLDER)
    playlist = db.create_playlist(name, parent=folder)
    return {"playlist_id": str(playlist.ID), "created": True}


def op_add_to_playlist(db: MasterDatabase, op: dict[str, Any]) -> dict[str, Any]:
    playlist = find_playlist(db, op["playlist"])
    content = find_content(db, op)
    if content is None:
        raise ValueError(f"track not in library: {op.get('path') or op.get('content_id')}")
    already = db.get_playlist_songs(PlaylistID=playlist.ID, ContentID=content.ID).first()
    if already is not None:
        return {"added": False}
    db.add_to_playlist(playlist, content)
    return {"added": True}


def op_remove_from_playlist(db: MasterDatabase, op: dict[str, Any]) -> dict[str, Any]:
    playlist = find_playlist(db, op["playlist"])
    content = find_content(db, op)
    if content is None:
        return {"removed": False}
    song = db.get_playlist_songs(PlaylistID=playlist.ID, ContentID=content.ID).first()
    if song is None:
        return {"removed": False}
    db.remove_from_playlist(playlist, song)
    return {"removed": True}


def op_rename_playlist(db: MasterDatabase, op: dict[str, Any]) -> dict[str, Any]:
    playlist = find_playlist(db, op["name"])
    if playlist.Name == op["new_name"]:
        return {"renamed": False}
    db.rename_playlist(playlist, op["new_name"])
    return {"renamed": True}


def op_delete_playlist(db: MasterDatabase, op: dict[str, Any]) -> dict[str, Any]:
    found = playlists_named(db, op["name"])
    if not found:
        return {"deleted": False}
    db.delete_playlist(find_playlist(db, op["name"]))
    return {"deleted": True}


OPS = {
    "add_track": op_add_track,
    "ensure_playlist": op_ensure_playlist,
    "add_to_playlist": op_add_to_playlist,
    "remove_from_playlist": op_remove_from_playlist,
    "rename_playlist": op_rename_playlist,
    "delete_playlist": op_delete_playlist,
}


# ---------- commands ----------


def cmd_status(db: MasterDatabase) -> None:
    pls = db.get_playlist().all()
    out({
        "ok": True,
        "tracks": db.get_content().count(),
        "playlists": sum(1 for p in pls if p.Attribute == PLAYLIST),
        "rekordbox_running": bool(get_rekordbox_pid()),
    })


def cmd_apply(db: MasterDatabase) -> None:
    request = json.load(sys.stdin)
    ops = request.get("ops", [])
    if get_rekordbox_pid():
        out({"ok": False, "rekordbox_running": True, "error": "Rekordbox is running"}, 3)
    results = []
    try:
        for i, op in enumerate(ops):
            handler = OPS.get(op.get("op"))
            if handler is None:
                raise ValueError(f"unknown op {op.get('op')!r}")
            try:
                results.append(handler(db, op))
            except Exception as e:  # name the op that failed
                raise RuntimeError(f"op {i} ({op.get('op')}): {e}") from e
        if ops:
            db.commit()
    except Exception as e:
        db.session.rollback()
        out({"ok": False, "error": str(e), "applied": 0}, 1)
    out({"ok": True, "applied": len(ops), "results": results})


def cmd_playlists(db: MasterDatabase) -> None:
    pls = db.get_playlist().all()
    by_id = {str(p.ID): p for p in pls}

    def path_of(p) -> list[str]:
        parts, seen = [], set()
        parent = by_id.get(str(p.ParentID))
        while parent is not None and str(parent.ID) not in seen:
            seen.add(str(parent.ID))
            parts.insert(0, parent.Name)
            parent = by_id.get(str(parent.ParentID))
        return parts

    rows = []
    for p in pls:
        if p.Attribute != PLAYLIST:
            continue
        rows.append({
            "id": str(p.ID),
            "name": p.Name,
            "folder": "/".join(path_of(p)),
            "tracks": db.get_playlist_songs(PlaylistID=p.ID).count(),
        })
    out({"ok": True, "playlists": rows})


def track_row(c) -> dict[str, Any]:
    return {
        "id": str(c.ID),
        "title": c.Title,
        "artist": c.ArtistName,
        "genre": c.GenreName,
        "bpm": (c.BPM or 0) / 100 or None,
        "key": c.KeyName,
        "path": c.FolderPath,
    }


def cmd_snapshot(db: MasterDatabase) -> None:
    """Everything ChatGPT needs to browse the library, read-only (safe while
    Rekordbox is open). `path` stays on this Mac; dj-sync strips it before
    sharing the snapshot."""
    pls = db.get_playlist().all()
    by_id = {str(p.ID): p for p in pls}

    def folder_of(p) -> str:
        parts, seen = [], set()
        parent = by_id.get(str(p.ParentID))
        while parent is not None and str(parent.ID) not in seen:
            seen.add(str(parent.ID))
            parts.insert(0, parent.Name)
            parent = by_id.get(str(parent.ParentID))
        return "/".join(parts)

    playlists = []
    for p in sorted(pls, key=lambda p: (folder_of(p), p.Name or "")):
        if p.Attribute != PLAYLIST:
            continue
        songs = db.get_playlist_songs(PlaylistID=p.ID).all()
        songs.sort(key=lambda s: s.TrackNo or 0)
        playlists.append({
            "id": str(p.ID),
            "name": p.Name,
            "folder": folder_of(p),
            "track_ids": [str(s.ContentID) for s in songs],
        })

    tracks = []
    for c in db.get_content().all():
        tracks.append({
            "id": str(c.ID),
            "title": c.Title,
            "artist": c.ArtistName,
            "album": c.AlbumName,
            "genre": c.GenreName,
            "bpm": round(c.BPM / 100, 2) if c.BPM else None,
            "key": c.KeyName,
            "duration_secs": c.Length,
            "path": c.FolderPath,
        })
    tracks.sort(key=lambda t: t["id"])
    out({"ok": True, "playlists": playlists, "tracks": tracks})


def cmd_search(db: MasterDatabase, query: str, limit: int) -> None:
    hits = db.search_content(query)[:limit]
    out({"ok": True, "tracks": [track_row(c) for c in hits]})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", help="master.db path (default: Rekordbox's own)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("apply")
    sub.add_parser("playlists")
    sub.add_parser("snapshot")
    search = sub.add_parser("search")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=25)
    args = parser.parse_args()

    try:
        db = open_db(args.db)
    except Exception as e:
        out({"ok": False, "error": f"can't open Rekordbox library: {e}"}, 1)
    try:
        if args.cmd == "status":
            cmd_status(db)
        elif args.cmd == "apply":
            cmd_apply(db)
        elif args.cmd == "playlists":
            cmd_playlists(db)
        elif args.cmd == "snapshot":
            cmd_snapshot(db)
        elif args.cmd == "search":
            cmd_search(db, args.query, args.limit)
    finally:
        db.close()


if __name__ == "__main__":
    main()
