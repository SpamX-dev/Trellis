import { useCallback, useEffect, useState } from 'react';
import type { User } from 'oidc-client-ts';
import { Alert, Button, Card, Form, Input, Layout, Modal, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { manager } from './auth';
import { api, type Actor, type Agent, type Commit, type Person, type Project, type TreeEntry } from './api';

const { Title, Text } = Typography;

/**
 * Корневой браузерный экран. Он выполняет OIDC-вход и показывает операции,
 * доступные подтверждённому человеку; все решения о правах принимает API.
 */
export function Workspace() {
  const [session, setSession] = useState<User | null | undefined>();
  const [me, setMe] = useState<Actor>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [agentName, setAgentName] = useState('');
  const [newToken, setNewToken] = useState('');
  const [tokenAgent, setTokenAgent] = useState<Agent>();
  const [tokenList, setTokenList] = useState<{ id: string; created_at: string }[]>([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (window.location.pathname === '/auth/logout-callback') {
          await manager.signoutRedirectCallback();
          window.history.replaceState({}, '', '/');
          if (active) setSession(null);
          return;
        }
        let user = window.location.pathname === '/auth/callback'
          ? await manager.signinRedirectCallback() : await manager.getUser();
        if (window.location.pathname === '/auth/callback') window.history.replaceState({}, '', '/');
        if (user?.expired) user = await manager.signinSilent();
        if (active) setSession(user && !user.expired ? user : null);
      } catch (reason) {
        if (active) { setError(String(reason)); setSession(null); }
      }
    })();
    return () => { active = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!session) return;
    const token = session.access_token;
    try {
      const [actor, list] = await Promise.all([api<Actor>(token, '/me'), api<Project[]>(token, '/projects')]);
      setMe(actor); setProjects(list); setError('');
      if (!selected && list[0]) setSelected(list[0].id);
      if (selected && !list.some((project) => project.id === selected)) setSelected(list[0]?.id);
      if (actor.kind === 'human') {
        const [knownPeople, knownAgents] = await Promise.all([
          api<Person[]>(token, '/people').catch(() => []),
          api<Agent[]>(token, '/agents').catch(() => []),
        ]);
        setPeople(knownPeople); setAgents(knownAgents);
      }
    } catch (reason) { setError(String(reason)); }
  }, [session, selected]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (session === undefined) return <div className="page"><Card>Подключение к Keycloak…</Card></div>;
  if (!session) return <div className="page"><Card style={{ maxWidth: 520, margin: '10vh auto' }}>
    <Title level={2}>Trellis</Title><p>Проекты, доступ и зафиксированные Git-снимки.</p>
    {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
    <Button type="primary" onClick={() => void manager.signinRedirect()}>Войти через Keycloak</Button>
  </Card></div>;

  const token = session.access_token;
  const project = projects.find((item) => item.id === selected);
  const owner = !!(project && me?.kind === 'human' && me.id === project.owner_person_id);

  async function createProject(values: { name: string; description?: string; ownerPersonId: string }) {
    try {
      const created = await api<Project>(token, '/projects', { method: 'POST', body: JSON.stringify(values) });
      setCreateOpen(false); createForm.resetFields(); await refresh(); setSelected(created.id);
    } catch (reason) { setError(String(reason)); await refresh(); }
  }

  async function createAgent() {
    try {
      const agent = await api<Agent>(token, '/agents', { method: 'POST', body: JSON.stringify({ name: agentName }) });
      const result = await api<{ token: string }>(token, `/agents/${agent.id}/tokens`, { method: 'POST' });
      setNewToken(result.token); setAgentName(''); await refresh();
    } catch (reason) { setError(String(reason)); }
  }

  async function showTokens(agent: Agent) {
    try {
      setTokenList(await api<{ id: string; created_at: string }[]>(token, `/agents/${agent.id}/tokens`));
      setTokenAgent(agent);
    } catch (reason) { setError(String(reason)); }
  }

  return <Layout className="page">
    <div className="topbar"><div><Title level={2} style={{ margin: 0 }}>Trellis</Title><Text type="secondary">{me?.username ?? session.profile.preferred_username}</Text></div>
      <Button onClick={() => void manager.signoutRedirect({ state: {} })}>Выйти</Button></div>
    {error && <Alert type="error" closable onClose={() => setError('')} message={error} style={{ marginBottom: 16 }} />}
    <div className="grid">
      <Card title="Проекты" extra={me?.admin && <Button type="primary" onClick={() => setCreateOpen(true)}>Создать</Button>}>
        <Table size="small" rowKey="id" pagination={false} dataSource={projects} columns={[{
          title: 'Название', dataIndex: 'name', render: (name: string, item: Project) => <Button type="link" onClick={() => setSelected(item.id)}>{name}</Button>,
        }, { title: 'Состояние', dataIndex: 'state', render: (state: string) => <Tag>{state}</Tag> }]} />
      </Card>
      {project ? <ProjectPanel key={project.id} token={token} project={project} me={me} people={people} agents={agents} owner={owner} refresh={refresh} onError={setError} />
        : <Card>Выберите проект. Доступ к содержимому появится после назначения владельца или участника.</Card>}
    </div>
    {me?.admin && <Card title="Учётные записи агентов" style={{ marginTop: 20 }}>
      <Space.Compact style={{ width: '100%', maxWidth: 440 }}><Input placeholder="Название агента" value={agentName} onChange={(event) => setAgentName(event.target.value)} />
        <Button type="primary" disabled={!agentName.trim()} onClick={() => void createAgent()}>Создать и выдать токен</Button></Space.Compact>
      <Table style={{ marginTop: 12 }} size="small" rowKey="id" pagination={false} dataSource={agents} columns={[
        { title: 'Агент', dataIndex: 'name' },
        { title: 'Состояние', dataIndex: 'enabled', render: (enabled: boolean) => enabled ? 'Активен' : 'Отключён' },
        { title: 'Действие', render: (_, agent: Agent) => <Space>
          <Button onClick={() => void showTokens(agent)}>Токены</Button>
          <Button onClick={async () => { try { const result = await api<{ token: string }>(token, `/agents/${agent.id}/tokens`, { method: 'POST' }); setNewToken(result.token); } catch (reason) { setError(String(reason)); } }} disabled={!agent.enabled}>Новый токен</Button>
          <Button onClick={async () => { try { await api(token, `/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !agent.enabled }) }); await refresh(); } catch (reason) { setError(String(reason)); } }}>{agent.enabled ? 'Отключить' : 'Включить'}</Button>
        </Space> },
      ]} />
    </Card>}
    <Modal title="Новый проект" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => void createForm.submit()}>
      <Form form={createForm} layout="vertical" onFinish={(values) => void createProject(values)}>
        <Form.Item name="name" label="Название" rules={[{ required: true }]}><Input maxLength={160} /></Form.Item>
        <Form.Item name="description" label="Описание"><Input.TextArea maxLength={4000} /></Form.Item>
        <Form.Item name="ownerPersonId" label="Владелец" rules={[{ required: true }]}><Select options={people.map((person) => ({ value: person.id, label: person.username }))} /></Form.Item>
      </Form>
    </Modal>
    <Modal title="Токен агента" open={!!newToken} onCancel={() => setNewToken('')} onOk={() => setNewToken('')}>
      <Alert type="warning" message="Скопируйте токен сейчас: сервер больше его не покажет." style={{ marginBottom: 12 }} />
      <Text code copyable>{newToken}</Text>
    </Modal>
    <Modal title={`Токены: ${tokenAgent?.name ?? ''}`} open={!!tokenAgent} onCancel={() => setTokenAgent(undefined)} footer={null}>
      <Table size="small" rowKey="id" pagination={false} dataSource={tokenList} columns={[
        { title: 'Создан', dataIndex: 'created_at', render: (value: string) => new Date(value).toLocaleString() },
        { title: 'Идентификатор', dataIndex: 'id', render: (value: string) => value.slice(0, 8) },
        { title: 'Действие', render: (_, item: { id: string }) => <Button danger onClick={async () => {
          if (!tokenAgent) return;
          try { await api(token, `/agents/${tokenAgent.id}/tokens/${item.id}`, { method: 'DELETE' }); await showTokens(tokenAgent); }
          catch (reason) { setError(String(reason)); }
        }}>Отозвать</Button> },
      ]} />
    </Modal>
  </Layout>;
}

/**
 * Карточка проекта разделяет административные действия, назначения владельца
 * и чтение репозитория. Ошибка доступа к Git показывается без обхода API.
 */
function ProjectPanel(props: { token: string; project: Project; me?: Actor; people: Person[]; agents: Agent[]; owner: boolean; refresh: () => Promise<void>; onError: (value: string) => void }) {
  const { token, project, me, people, agents, owner, refresh, onError } = props;
  const [members, setMembers] = useState<Person[]>([]);
  const [grants, setGrants] = useState<Agent[]>([]);
  const [personId, setPersonId] = useState<string>();
  const [agentId, setAgentId] = useState<string>();
  const [readError, setReadError] = useState('');
  const [head, setHead] = useState('');
  const [commits, setCommits] = useState<Commit[]>([]);
  const [ownerId, setOwnerId] = useState(project.owner_person_id);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm] = Form.useForm();

  const load = useCallback(async () => {
    if (project.state !== 'active' && project.state !== 'archived') return;
    try {
      const repository = await api<{ main: string }>(token, `/projects/${project.id}/repository`);
      setHead(repository.main);
      setCommits(await api<Commit[]>(token, `/projects/${project.id}/commits`));
      setReadError('');
    } catch (reason) { setReadError(String(reason)); }
    if (owner) {
      try {
        const [users, agents] = await Promise.all([
          api<Person[]>(token, `/projects/${project.id}/users`), api<Agent[]>(token, `/projects/${project.id}/agents`),
        ]);
        setMembers(users); setGrants(agents);
      } catch (reason) { onError(String(reason)); }
    }
  }, [token, project.id, project.state, owner, onError]);
  useEffect(() => { void load(); }, [load]);

  async function action(path: string, method: string, body?: unknown) {
    try {
      await api(token, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      await refresh(); await load();
    } catch (reason) { onError(String(reason)); }
  }

  return <Card title={project.name} extra={<Tag>{project.state}</Tag>}>
    <p>{project.description || 'Описание не задано'}</p><Text type="secondary">ID: {project.id}</Text>
    {me?.admin && <div style={{ marginTop: 16 }}><Space wrap>
      <Button onClick={() => { editForm.setFieldsValue({ name: project.name, description: project.description }); setEditOpen(true); }}>Настройки</Button>
      <Select style={{ width: 220 }} value={ownerId} onChange={setOwnerId} options={people.map((person) => ({ value: person.id, label: person.username }))} />
      <Button onClick={() => void action(`/projects/${project.id}`, 'PATCH', { ownerPersonId: ownerId })}>Назначить владельца</Button>
      {project.state === 'active' && <Button danger onClick={() => void action(`/projects/${project.id}/archive`, 'POST')}>Архивировать</Button>}
      {['failed', 'provisioning'].includes(project.state) && <Button onClick={() => void action(`/projects/${project.id}/retry`, 'POST')}>Повторить создание Git</Button>}
    </Space></div>}
    <Tabs style={{ marginTop: 16 }} items={[
      { key: 'repository', label: 'Репозиторий', children: readError ? <Alert type="warning" message={readError} /> : head ? <RepositoryViewer token={token} projectId={project.id} head={head} commits={commits} onError={onError} /> : <Text type="secondary">Репозиторий готовится</Text> },
      ...(owner ? [{ key: 'access', label: 'Доступ', children: <Space direction="vertical" style={{ width: '100%' }}>
        <Title level={5}>Люди</Title><Space><Select style={{ width: 240 }} placeholder="Уже входивший человек" value={personId} onChange={setPersonId} options={people.filter((p) => p.id !== project.owner_person_id && !members.some((m) => m.id === p.id)).map((p) => ({ value: p.id, label: p.username }))} /><Button disabled={!personId} onClick={() => void action(`/projects/${project.id}/users/${personId}`, 'PUT')}>Назначить user</Button></Space>
        <Table size="small" rowKey="id" pagination={false} dataSource={members} columns={[{ title: 'Логин', dataIndex: 'username' }, { title: 'Действие', render: (_, p: Person) => <Button danger onClick={() => void action(`/projects/${project.id}/users/${p.id}`, 'DELETE')}>Удалить</Button> }]} />
        <Title level={5}>Агенты</Title><Space><Select style={{ width: 240 }} placeholder="Агент" value={agentId} onChange={setAgentId} options={agents.filter((a) => a.enabled && !grants.some((g) => g.id === a.id)).map((a) => ({ value: a.id, label: a.name }))} /><Button disabled={!agentId} onClick={() => void action(`/projects/${project.id}/agents/${agentId}`, 'PUT')}>Разрешить</Button></Space>
        <Table size="small" rowKey="id" pagination={false} dataSource={grants} columns={[{ title: 'Агент', dataIndex: 'name' }, { title: 'Действие', render: (_, a: Agent) => <Button danger onClick={() => void action(`/projects/${project.id}/agents/${a.id}`, 'DELETE')}>Отозвать</Button> }]} />
      </Space> }] : []),
    ]} />
    <Modal title="Настройки проекта" open={editOpen} onCancel={() => setEditOpen(false)} onOk={() => void editForm.submit()}>
      <Form form={editForm} layout="vertical" onFinish={async (values) => { await action(`/projects/${project.id}`, 'PATCH', values); setEditOpen(false); }}>
        <Form.Item name="name" label="Название" rules={[{ required: true }]}><Input maxLength={160} /></Form.Item>
        <Form.Item name="description" label="Описание"><Input.TextArea maxLength={4000} /></Form.Item>
      </Form>
    </Modal>
  </Card>;
}

/**
 * Просмотрщик коммитов и Git-дерева читает только выбранный точный снимок.
 * Навигация выполняется по проверяемым сервером относительным путям.
 */
function RepositoryViewer(props: { token: string; projectId: string; head: string; commits: Commit[]; onError: (value: string) => void }) {
  const { token, projectId, head, commits, onError } = props;
  const [oid, setOid] = useState(head);
  const [path, setPath] = useState('');
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [blob, setBlob] = useState<{ path: string; content: string; mode: string }>();

  useEffect(() => {
    setBlob(undefined);
    void api<TreeEntry[]>(token, `/projects/${projectId}/commits/${oid}/tree?path=${encodeURIComponent(path)}`)
      .then(setTree).catch((reason) => onError(String(reason)));
  }, [token, projectId, oid, path, onError]);

  return <Space direction="vertical" style={{ width: '100%' }}>
    <Text>main: <Text code>{head}</Text></Text>
    <Select style={{ width: '100%' }} value={oid} onChange={(next) => { setOid(next); setPath(''); }} options={commits.map((commit) => ({ value: commit.oid, label: `${commit.subject} · ${commit.oid.slice(0, 10)} · ${new Date(commit.date).toLocaleString()}` }))} />
    <Space><Button disabled={!path} onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>Вверх</Button><Text className="path">/{path}</Text></Space>
    <Table size="small" rowKey="name" pagination={false} dataSource={tree} locale={{ emptyText: 'В этом коммите нет файлов' }} columns={[
      { title: 'Имя', dataIndex: 'name', render: (name: string, entry: TreeEntry) => <Button type="link" onClick={async () => {
        const next = [path, name].filter(Boolean).join('/');
        if (entry.type === 'tree') { setPath(next); return; }
        try { const result = await api<{ content: string; mode: string }>(token, `/projects/${projectId}/commits/${oid}/blob?path=${encodeURIComponent(next)}`); setBlob({ path: next, ...result }); }
        catch (reason) { onError(String(reason)); }
      }}>{entry.type === 'tree' ? '📁 ' : '📄 '}{name}</Button> },
      { title: 'Режим', dataIndex: 'mode' },
    ]} />
    {blob && <Card size="small" title={<span className="path">{blob.path}{blob.mode === '120000' ? ' (symlink, без перехода)' : ''}</span>}><pre className="blob">{blob.content}</pre></Card>}
  </Space>;
}
