-- Albums ("打包链接"): a titled, ordered list of uploaded files behind one share link.
CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- SHA-256 (hex) of the album's delete token; the token itself is only ever returned to the creator.
  delete_hash TEXT NOT NULL,
  -- HMAC of the creator's IP, same scheme as uploads, so purge-by-source also removes albums.
  source TEXT NOT NULL
);

CREATE TABLE album_files (
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  -- R2 key of the file: f/<id> (permanent) or t/<id> (temporary).
  file_key TEXT NOT NULL,
  PRIMARY KEY (album_id, position)
);

CREATE INDEX albums_source ON albums(source);
