CREATE TABLE people (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  username text NOT NULL,
  display_name text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
COMMENT ON TABLE people IS 'Люди, входившие через подтверждённого OIDC-провайдера; логин не задаёт идентичность.';

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE agents IS 'Учётные записи агентов Knowledge; проектные разрешения хранятся отдельно.';

CREATE TABLE agent_tokens (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE agent_tokens IS 'Хеши секретных токенов агентов; исходные значения не сохраняются.';

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_person_id uuid NOT NULL REFERENCES people(id),
  state text NOT NULL CHECK (state IN ('provisioning', 'failed', 'active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE projects IS 'Каталог проектов, владелец и состояние согласованного создания Git.';

CREATE TABLE project_users (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id),
  PRIMARY KEY (project_id, person_id)
);
COMMENT ON TABLE project_users IS 'Дополнительные люди с проектной ролью user.';

CREATE TABLE project_agents (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id),
  PRIMARY KEY (project_id, agent_id)
);
COMMENT ON TABLE project_agents IS 'Явные разрешения агентов на конкретные проекты.';
