-- Background instructions for FIRE COUNSEL AI (master rules + specialist
-- prompts). The TEXT is private: administrators import it in the Admin Studio;
-- it is never stored in this repository. The server also creates this table on
-- the first save, so running this migration is optional.
CREATE TABLE IF NOT EXISTS ai_instructions (
  key text PRIMARY KEY CHECK (char_length(key) BETWEEN 2 AND 60),
  content text NOT NULL CHECK (char_length(content) BETWEEN 20 AND 50000),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  updated_by text
);
