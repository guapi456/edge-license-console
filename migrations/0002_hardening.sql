ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'enabled'
  CHECK (status IN ('enabled', 'disabled'));

ALTER TABLE sessions ADD COLUMN validation_challenge TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_projects_status ON projects(status);
