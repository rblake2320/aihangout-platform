-- The chat UI and API use channel 1 as the public general room.
INSERT OR IGNORE INTO chat_channels
  (id, name, description, is_general, is_private)
VALUES
  (1, 'general', 'Public AI Hangout community chat', TRUE, FALSE);
