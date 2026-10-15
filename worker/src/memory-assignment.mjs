// The unique Name ID is the assignment boundary, including across devices.
export async function assignedMemory(db, name) {
  const id = name.trim().toLowerCase();
  const randomMode = (crypto.getRandomValues(new Uint8Array(1))[0] & 1) ? 'shared' : 'isolated';
  await db.prepare(`INSERT OR IGNORE INTO memory_assignments(name_id, mode)
    VALUES(?, COALESCE((SELECT json_extract(payload, '$.memory_sharing_mode') FROM chat_turns
      WHERE speaker_lower = ? AND json_extract(payload, '$.memory_sharing_mode') IN ('shared','isolated') ORDER BY id DESC LIMIT 1), ?))`)
    .bind(id, id, randomMode).run();
  const row = await db.prepare('SELECT mode FROM memory_assignments WHERE name_id = ?').bind(id).first();
  if (!row || !['shared', 'isolated'].includes(row.mode)) throw new Error('Memory assignment unavailable');
  return row.mode;
}
export async function checkMemoryAssignment(db, name, mode) {
  const row = await db.prepare('SELECT mode FROM memory_assignments WHERE name_id = ?').bind(name.trim().toLowerCase()).first();
  return !row || row.mode === mode;
}
