import type { Db } from '../db.js';
import { UsersRepo, TokensRepo, DeviceCodesRepo, AuditRepo, TenantKeysRepo } from './auth.js';
import { ClientsRepo, ClientMembersRepo, OrgsRepo, GithubReposRepo, OAuthStatesRepo } from './clients.js';
import { ProvidersRepo, ModelsRepo, BindingsRepo, SkillsRepo, PoliciesRepo } from './ai.js';
import { ProjectsRepo, TasksRepo } from './projects.js';
import { KnowledgeSourcesRepo, CustomAgentsRepo } from './knowledge.js';
import { CompileControlRepo } from './compile-control.js';
import { HarnessRepo } from './harness.js';
import {
  SessionsRepo,
  EventsRepo,
  MessagesRepo,
  WorkspaceRepo,
  DeploysRepo,
  ConfirmationsRepo,
  UsageRepo,
  DocsRepo,
  TodosRepo,
  NotesRepo,
  PermissionsRepo,
  LimitsRepo,
  ArtifactsRepo,
} from './sessions.js';

export interface Repos {
  harness: HarnessRepo;
  compileControl: CompileControlRepo;
  users: UsersRepo;
  tokens: TokensRepo;
  deviceCodes: DeviceCodesRepo;
  audit: AuditRepo;
  tenantKeys: TenantKeysRepo;
  clients: ClientsRepo;
  clientMembers: ClientMembersRepo;
  orgs: OrgsRepo;
  github: GithubReposRepo;
  oauthStates: OAuthStatesRepo;
  providers: ProvidersRepo;
  models: ModelsRepo;
  bindings: BindingsRepo;
  skills: SkillsRepo;
  policies: PoliciesRepo;
  projects: ProjectsRepo;
  tasks: TasksRepo;
  knowledge: KnowledgeSourcesRepo;
  customAgents: CustomAgentsRepo;
  sessions: SessionsRepo;
  events: EventsRepo;
  messages: MessagesRepo;
  workspace: WorkspaceRepo;
  deploys: DeploysRepo;
  confirmations: ConfirmationsRepo;
  usage: UsageRepo;
  docs: DocsRepo;
  todos: TodosRepo;
  notes: NotesRepo;
  permissions: PermissionsRepo;
  limits: LimitsRepo;
  artifacts: ArtifactsRepo;
}

export function createRepos(db: Db): Repos {
  return {
    harness: new HarnessRepo(db),
    compileControl: new CompileControlRepo(db),
    users: new UsersRepo(db),
    tokens: new TokensRepo(db),
    deviceCodes: new DeviceCodesRepo(db),
    audit: new AuditRepo(db),
    tenantKeys: new TenantKeysRepo(db),
    clients: new ClientsRepo(db),
    clientMembers: new ClientMembersRepo(db),
    orgs: new OrgsRepo(db),
    github: new GithubReposRepo(db),
    oauthStates: new OAuthStatesRepo(db),
    providers: new ProvidersRepo(db),
    models: new ModelsRepo(db),
    bindings: new BindingsRepo(db),
    skills: new SkillsRepo(db),
    policies: new PoliciesRepo(db),
    projects: new ProjectsRepo(db),
    tasks: new TasksRepo(db),
    knowledge: new KnowledgeSourcesRepo(db),
    customAgents: new CustomAgentsRepo(db),
    sessions: new SessionsRepo(db),
    events: new EventsRepo(db),
    messages: new MessagesRepo(db),
    workspace: new WorkspaceRepo(db),
    deploys: new DeploysRepo(db),
    confirmations: new ConfirmationsRepo(db),
    usage: new UsageRepo(db),
    docs: new DocsRepo(db),
    todos: new TodosRepo(db),
    notes: new NotesRepo(db),
    permissions: new PermissionsRepo(db),
    limits: new LimitsRepo(db),
    artifacts: new ArtifactsRepo(db),
  };
}
export * from './auth.js';
export * from './clients.js';
export * from './ai.js';
export * from './projects.js';
export * from './knowledge.js';
export * from './sessions.js';
